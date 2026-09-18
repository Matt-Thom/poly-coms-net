/**
 * src/bridge/executors/codex.ts
 *
 * Dedicated ITurnExecutor adapter for OpenAI Codex CLI (`codex exec`).
 * Runs Codex in non-interactive mode with sandbox bypass and ephemeral session flags.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  InboundPromptEvent,
  TurnExecutionResult,
  ITurnExecutor,
} from "../../protocol/types.ts";
import { redactToken } from "../../protocol/errors.ts";
import { formatInboundPrompt, normalizeTurnResponse } from "../turn-executor.ts";

const execFileAsync = promisify(execFile);

export interface CodexTurnExecutorOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  sandbox?: string;
  ephemeral?: boolean;
  skipGitRepoCheck?: boolean;
  useJsonFormat?: boolean;
  outputFile?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class CodexTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly sandbox: string;
  private readonly ephemeral: boolean;
  private readonly skipGitRepoCheck: boolean;
  private readonly useJsonFormat: boolean;
  private readonly outputFile?: string;
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: CodexTurnExecutorOptions = {}) {
    this.binaryPath = options.binaryPath || process.env.CODEX_BIN_PATH || "codex";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.sandbox = options.sandbox ?? "danger-full-access";
    this.ephemeral = options.ephemeral ?? true;
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? true;
    this.useJsonFormat = options.useJsonFormat ?? true;
    this.outputFile = options.outputFile;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.env = options.env;
  }

  async execute(event: InboundPromptEvent): Promise<TurnExecutionResult> {
    const formattedPrompt = formatInboundPrompt(
      event.sender_name,
      "?",
      event.msg_id,
      event.prompt
    );

    const args: string[] = ["exec", formattedPrompt];

    let tempOutputFile: string | null = null;
    if (this.outputFile) {
      args.push("-o", this.outputFile);
    } else if (this.useJsonFormat) {
      args.push("--json");
    }

    if (this.sandbox) {
      args.push("--sandbox", this.sandbox);
    }
    if (this.ephemeral) {
      args.push("--ephemeral");
    }
    if (this.skipGitRepoCheck) {
      args.push("--skip-git-repo-check");
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    if (event.conversation_id) {
      args.push("--session", event.conversation_id);
    }

    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execFileAsync(this.binaryPath, args, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          ...this.env,
        },
      });

      const duration_seconds = (Date.now() - startTime) / 1000;
      return this.parseOutput(stdout, stderr, duration_seconds, event.conversation_id, tempOutputFile || this.outputFile);
    } catch (err: unknown) {
      const errorObj = err as {
        message?: string;
        code?: string | number;
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };

      if (errorObj?.killed) {
        return {
          response: "",
          error: `Turn execution timed out after ${this.timeoutMs}ms`,
        };
      }

      if (errorObj?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return {
          response: "",
          error: "Subprocess output exceeded maximum buffer limit (20MB)",
        };
      }

      if (errorObj?.code === "ENOENT") {
        return {
          response: "",
          error: `Harness binary '${this.binaryPath}' not found on PATH.`,
        };
      }

      const duration_seconds = (Date.now() - startTime) / 1000;
      if (errorObj?.stdout) {
        try {
          const parsedResult = this.parseOutput(
            errorObj.stdout,
            errorObj.stderr || "",
            duration_seconds,
            event.conversation_id,
            tempOutputFile || this.outputFile
          );
          if (!parsedResult.error) {
            const fallbackMsg =
              errorObj?.stderr?.trim() ||
              errorObj?.stdout?.trim() ||
              errorObj?.message ||
              `Subprocess failed with exit code ${errorObj?.code ?? 1}`;
            parsedResult.error = redactToken(fallbackMsg);
          } else {
            parsedResult.error = redactToken(parsedResult.error);
          }
          return parsedResult;
        } catch {
          // Fall through
        }
      }

      const errorMsg =
        errorObj?.stderr?.trim() ||
        errorObj?.stdout?.trim() ||
        errorObj?.message ||
        "Subprocess execution failed";
      return {
        response: "",
        error: redactToken(errorMsg),
      };
    } finally {
      if (tempOutputFile && fs.existsSync(tempOutputFile)) {
        try {
          fs.unlinkSync(tempOutputFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  private parseOutput(
    stdout: string,
    stderr: string,
    duration_seconds: number,
    fallbackConvId?: string,
    outputFilePath?: string
  ): TurnExecutionResult {
    // 1. If explicit output file was populated and exists, read it
    if (outputFilePath && fs.existsSync(outputFilePath)) {
      try {
        const fileContent = fs.readFileSync(outputFilePath, "utf8").trim();
        if (fileContent) {
          return {
            response: fileContent,
            duration_seconds,
            conversation_id: fallbackConvId,
          };
        }
      } catch {
        // Fall back to stdout parsing
      }
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        response: "",
        error: redactToken(stderr.trim() || "Empty output from Codex CLI"),
      };
    }

    // 2. Try parsing stdout as NDJSON (newline-delimited events)
    const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
    let extractedResponse = "";
    let extractedError: string | undefined;
    let extractedUsage: TurnExecutionResult["usage"];
    let convId = fallbackConvId;
    let hasJsonLines = false;

    for (const line of lines) {
      if ((line.startsWith("{") && line.endsWith("}")) || (line.startsWith("[") && line.endsWith("]"))) {
        try {
          const parsed = JSON.parse(line);
          hasJsonLines = true;

          if (parsed.session_id || parsed.conversation_id) {
            convId = parsed.session_id || parsed.conversation_id;
          }

          if (parsed.usage) {
            const inTok = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
            const outTok = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
            const total = parsed.usage.total_tokens ?? ((inTok || 0) + (outTok || 0));
            extractedUsage = {
              input_tokens: inTok,
              output_tokens: outTok,
              total_tokens: total,
            };
          }

          if (parsed.error) {
            extractedError = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? JSON.stringify(parsed.error));
          } else if (parsed.status && parsed.status !== "SUCCESS") {
            extractedError = `Turn completed with status: ${parsed.status}`;
          }

          if (parsed.response !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.response);
          } else if (parsed.content !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.content);
          } else if (parsed.message?.content !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.message.content);
          } else if (parsed.message !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.message);
          } else if (parsed.text !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.text);
          } else if (parsed.result !== undefined) {
            extractedResponse = normalizeTurnResponse(parsed.result);
          }
        } catch {
          // Not valid JSON line
        }
      }
    }

    if (hasJsonLines && (extractedResponse || extractedUsage || extractedError)) {
      return {
        response: extractedResponse || trimmed,
        error: extractedError ? redactToken(extractedError) : undefined,
        conversation_id: convId,
        duration_seconds,
        usage: extractedUsage,
      };
    }

    // 3. Try parsing single JSON block in stdout
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        const rawResp = parsed.response ?? parsed.content ?? parsed.message?.content ?? parsed.message ?? parsed.text ?? parsed.result;
        const resp = rawResp !== undefined ? normalizeTurnResponse(rawResp) : "";
        let err: string | undefined;
        if (parsed.error) {
          err = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? JSON.stringify(parsed.error));
        } else if (parsed.status && parsed.status !== "SUCCESS") {
          err = `Turn completed with status: ${parsed.status}`;
        }
        let usage: TurnExecutionResult["usage"];
        if (parsed.usage) {
          const inTok = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
          const outTok = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
          usage = {
            input_tokens: inTok,
            output_tokens: outTok,
            total_tokens: parsed.usage.total_tokens ?? ((inTok || 0) + (outTok || 0)),
          };
        }
        return {
          response: resp || trimmed,
          error: err ? redactToken(err) : undefined,
          conversation_id: parsed.session_id || parsed.conversation_id || fallbackConvId,
          duration_seconds: parsed.duration_seconds ?? duration_seconds,
          usage,
        };
      } catch {
        // Fall back to plain text
      }
    }

    // 4. Default plain text response
    return {
      response: trimmed,
      conversation_id: fallbackConvId,
      duration_seconds,
    };
  }
}
