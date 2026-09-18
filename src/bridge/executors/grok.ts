/**
 * src/bridge/executors/grok.ts
 *
 * Dedicated ITurnExecutor adapter for Grok CLI (`grok -p`).
 * Runs Grok in headless mode with `--output-format json`, `--always-approve`, and `--permission-mode bypassPermissions`.
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

export interface GrokTurnExecutorOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  alwaysApprove?: boolean;
  permissionMode?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface GrokJsonOutput {
  conversation_id?: string;
  session_id?: string;
  response?: unknown;
  result?: unknown;
  message?: unknown;
  status?: string;
  error?: unknown;
  duration_seconds?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    thinking_tokens?: number;
    total_tokens?: number;
  };
}

export class GrokTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly alwaysApprove: boolean;
  private readonly permissionMode?: string;
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: GrokTurnExecutorOptions = {}) {
    this.binaryPath = options.binaryPath || process.env.GROK_BIN_PATH || "grok";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.alwaysApprove = options.alwaysApprove ?? true;
    this.permissionMode = options.permissionMode ?? "bypassPermissions";
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

    const args: string[] = ["-p", formattedPrompt, "--output-format", "json"];

    if (this.alwaysApprove) {
      args.push("--always-approve");
    }
    if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    if (event.conversation_id) {
      args.push("--resume", event.conversation_id);
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

      const duration_seconds = (Date.now() - startTime) / 1000;

      if (errorObj?.killed) {
        return {
          response: "",
          error: `Turn execution timed out after ${this.timeoutMs}ms`,
          duration_seconds,
        };
      }

      // Catch maxBuffer before checking stdout
      if (errorObj?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return {
          response: "",
          error: "Subprocess output exceeded maximum buffer limit (20MB)",
          duration_seconds,
        };
      }

      if (errorObj?.code === "ENOENT") {
        return {
          response: "",
          error: `Harness binary '${this.binaryPath}' not found on PATH.`,
          duration_seconds,
        };
      }

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
        duration_seconds,
      };
    }
  }

  private parseOutput(
    stdout: string,
    stderr: string,
    fallbackDuration: number,
    fallbackConvId?: string
  ): TurnExecutionResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        response: "",
        error: redactToken(stderr.trim() || "Empty output from Grok CLI"),
        duration_seconds: fallbackDuration,
        conversation_id: fallbackConvId,
      };
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return {
        response: trimmed,
        duration_seconds: fallbackDuration,
        conversation_id: fallbackConvId,
      };
    }

    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    let parsed: GrokJsonOutput;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        response: trimmed,
        duration_seconds: fallbackDuration,
        conversation_id: fallbackConvId,
      };
    }

    const rawResponse = parsed.response ?? parsed.result ?? parsed.message ?? "";
    const response = normalizeTurnResponse(rawResponse);
    const conversation_id = parsed.conversation_id || parsed.session_id || fallbackConvId;
    const duration_seconds =
      parsed.duration_seconds ??
      (parsed.duration_ms !== undefined ? parsed.duration_ms / 1000 : fallbackDuration);

    let usage: TurnExecutionResult["usage"];
    if (parsed.usage) {
      const inTok = parsed.usage.input_tokens ?? parsed.usage.prompt_tokens;
      const outTok = parsed.usage.output_tokens ?? parsed.usage.completion_tokens;
      const total = parsed.usage.total_tokens ?? ((inTok || 0) + (outTok || 0));
      usage = {
        input_tokens: inTok,
        output_tokens: outTok,
        thinking_tokens: parsed.usage.thinking_tokens,
        total_tokens: total,
      };
    }

    const rawError = typeof parsed.error === "string"
      ? parsed.error
      : (parsed.error ? JSON.stringify(parsed.error) : undefined);

    if (parsed.status && parsed.status !== "SUCCESS") {
      const errorText = rawError || response || `Turn completed with status: ${parsed.status}`;
      return {
        response,
        error: redactToken(errorText),
        conversation_id,
        duration_seconds,
        usage,
      };
    }

    if (rawError) {
      return {
        response,
        error: redactToken(rawError),
        conversation_id,
        duration_seconds,
        usage,
      };
    }

    return {
      response,
      conversation_id,
      duration_seconds,
      usage,
    };
  }
}
