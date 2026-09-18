/**
 * src/bridge/executors/aider.ts
 *
 * Dedicated ITurnExecutor adapter for Aider AI pair programming CLI (`aider --message`).
 * Runs Aider in headless, non-interactive mode without automatic git commits or streaming.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  InboundPromptEvent,
  TurnExecutionResult,
  ITurnExecutor,
} from "../../protocol/types.ts";
import { redactToken } from "../../protocol/errors.ts";
import { formatInboundPrompt, normalizeTurnResponse } from "../turn-executor.ts";

const execFileAsync = promisify(execFile);

export interface AiderTurnExecutorOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  yes?: boolean;
  autoCommits?: boolean;
  stream?: boolean;
  git?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export class AiderTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly yes: boolean;
  private readonly autoCommits: boolean;
  private readonly stream: boolean;
  private readonly git: boolean;
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: AiderTurnExecutorOptions = {}) {
    this.binaryPath = options.binaryPath || process.env.AIDER_BIN_PATH || "aider";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.yes = options.yes ?? true;
    this.autoCommits = options.autoCommits ?? false;
    this.stream = options.stream ?? false;
    this.git = options.git ?? false;
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

    const args: string[] = ["--message", formattedPrompt];

    if (this.yes) {
      args.push("--yes");
    }
    if (!this.autoCommits) {
      args.push("--no-auto-commits");
    }
    if (!this.stream) {
      args.push("--no-stream");
    }
    if (!this.git) {
      args.push("--no-git");
    }
    if (this.model) {
      args.push("--model", this.model);
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
      return this.parseOutput(stdout, stderr, duration_seconds, event.conversation_id);
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
            event.conversation_id
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
    }
  }

  private parseOutput(
    stdout: string,
    stderr: string,
    duration_seconds: number,
    fallbackConvId?: string
  ): TurnExecutionResult {
    const trimmed = stdout.trim();
    if (!trimmed && stderr.trim()) {
      return {
        response: "",
        error: redactToken(stderr.trim()),
      };
    }

    // Try extracting JSON if stdout contains structured JSON
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
        const candidate = parsed.response ?? parsed.result ?? parsed.message ?? parsed.content;
        if (candidate !== undefined && candidate !== null) {
          const finalResponse = normalizeTurnResponse(candidate);
          let usage = parsed.usage;
          if (!usage) {
            usage = this.extractTokenUsage(stderr + "\n" + stdout);
          }
          let parsedError: string | undefined;
          if (parsed.error) {
            parsedError = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? JSON.stringify(parsed.error));
          } else if (parsed.status && parsed.status !== "SUCCESS") {
            parsedError = `Turn completed with status: ${parsed.status}`;
          }
          return {
            response: finalResponse || trimmed,
            error: parsedError ? redactToken(parsedError) : undefined,
            conversation_id: parsed.conversation_id ?? fallbackConvId,
            duration_seconds: parsed.duration_seconds ?? duration_seconds,
            usage,
          };
        }
      } catch {
        // Fall back to plain text
      }
    }

    const usage = this.extractTokenUsage(stderr + "\n" + stdout);

    return {
      response: trimmed,
      conversation_id: fallbackConvId,
      duration_seconds,
      usage,
    };
  }

  private extractTokenUsage(output: string): TurnExecutionResult["usage"] {
    // Match "Tokens: 1,234 sent, 567 received" or "Tokens: 1.2k sent, 350 received"
    const match = output.match(/Tokens:\s*([0-9.,kKmM]+)\s*sent,\s*([0-9.,kKmM]+)\s*received/i);
    if (match) {
      const inTok = this.parseTokenNumber(match[1]);
      const outTok = this.parseTokenNumber(match[2]);
      if (inTok !== undefined && outTok !== undefined) {
        return {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: inTok + outTok,
        };
      }
    }

    // Match "input_tokens": 123, "output_tokens": 456
    const jsonIn = output.match(/["']?input_tokens["']?\s*:\s*(\d+)/i);
    const jsonOut = output.match(/["']?output_tokens["']?\s*:\s*(\d+)/i);
    if (jsonIn && jsonOut) {
      const inTok = parseInt(jsonIn[1], 10);
      const outTok = parseInt(jsonOut[1], 10);
      return {
        input_tokens: inTok,
        output_tokens: outTok,
        total_tokens: inTok + outTok,
      };
    }

    return undefined;
  }

  private parseTokenNumber(str: string): number | undefined {
    const clean = str.replace(/,/g, "").trim().toLowerCase();
    if (clean.endsWith("k")) {
      const val = parseFloat(clean.slice(0, -1));
      return isNaN(val) ? undefined : Math.round(val * 1000);
    }
    if (clean.endsWith("m")) {
      const val = parseFloat(clean.slice(0, -1));
      return isNaN(val) ? undefined : Math.round(val * 1_000_000);
    }
    const val = parseInt(clean, 10);
    return isNaN(val) ? undefined : val;
  }
}
