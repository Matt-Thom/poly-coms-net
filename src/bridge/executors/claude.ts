/**
 * src/bridge/executors/claude.ts
 *
 * Dedicated ITurnExecutor adapter for Claude Code CLI (`claude -p`).
 * Runs Claude in headless mode with `--output-format json` and `--dangerously-skip-permissions`.
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

export interface ClaudeCodeTurnExecutorOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface ClaudeJsonOutput {
  session_id?: string;
  conversation_id?: string;
  result?: unknown;
  response?: unknown;
  error?: unknown;
  status?: string;
  duration_ms?: number;
  duration_seconds?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_input_tokens?: number;
    total_tokens?: number;
  };
}

export class ClaudeCodeTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly permissionMode?: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeTurnExecutorOptions = {}) {
    this.binaryPath = options.binaryPath || process.env.CLAUDE_BIN_PATH || "claude";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.permissionMode = options.permissionMode;
    this.dangerouslySkipPermissions = options.dangerouslySkipPermissions ?? true;
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

    if (this.dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
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

      return this.parseOutput(stdout, stderr, event.conversation_id);
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

      // Catch maxBuffer before checking stdout
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

      if (errorObj?.stdout) {
        try {
          const parsedResult = this.parseOutput(errorObj.stdout, errorObj.stderr || "", event.conversation_id);
          // If stdout did not contain a structured error, ensure failure is not masked as success
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
      };
    }
  }

  private parseOutput(
    stdout: string,
    stderr: string,
    fallbackConvId?: string
  ): TurnExecutionResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        response: "",
        error: redactToken(stderr.trim() || "Empty output from Claude Code CLI"),
      };
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return {
        response: trimmed,
      };
    }

    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    let parsed: ClaudeJsonOutput;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return {
        response: trimmed,
      };
    }

    const rawResponse = parsed.result ?? parsed.response ?? "";
    const response = normalizeTurnResponse(rawResponse);
    const conversation_id = parsed.session_id || parsed.conversation_id || fallbackConvId;
    const duration_seconds =
      parsed.duration_seconds ??
      (parsed.duration_ms !== undefined ? parsed.duration_ms / 1000 : undefined);

    let usage: TurnExecutionResult["usage"];
    if (parsed.usage) {
      const total =
        parsed.usage.total_tokens ??
        ((parsed.usage.input_tokens || 0) + (parsed.usage.output_tokens || 0));
      usage = {
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        thinking_tokens: parsed.usage.thinking_tokens,
        cache_read_tokens: parsed.usage.cache_read_tokens,
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
