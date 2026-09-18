/**
 * src/bridge/executors/hermes.ts
 *
 * Dedicated ITurnExecutor adapter for Nous Research Hermes Agent (`hermes -z`).
 * Runs Hermes in headless one-shot mode with `--usage-file`, `--accept-hooks`, `--yolo`, `--in`, and `--resume`.
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

export interface HermesTurnExecutorOptions {
  binaryPath?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  reasoning?: string;
  acceptHooks?: boolean;
  yolo?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface HermesUsageFileContent {
  token_counts?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  estimated_cost?: number;
  cost_usd?: number;
  model?: string;
  api_calls?: number;
}

export class HermesTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly provider?: string;
  private readonly reasoning?: string;
  private readonly acceptHooks: boolean;
  private readonly yolo: boolean;
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: HermesTurnExecutorOptions = {}) {
    this.binaryPath = options.binaryPath || process.env.HERMES_BIN_PATH || "hermes";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.provider = options.provider;
    this.reasoning = options.reasoning;
    this.acceptHooks = options.acceptHooks ?? true;
    this.yolo = options.yolo ?? true;
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

    const usageFile = path.join(
      os.tmpdir(),
      `hermes-usage-${event.msg_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    );

    const args: string[] = ["-z", formattedPrompt, "--usage-file", usageFile];

    if (this.acceptHooks) {
      args.push("--accept-hooks");
    }
    if (this.yolo) {
      args.push("--yolo");
    }
    args.push("--in", this.cwd);

    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.provider) {
      args.push("--provider", this.provider);
    }
    if (this.reasoning) {
      args.push("--reasoning", this.reasoning);
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
      const usage = this.readUsageReport(usageFile);

      return {
        response: normalizeTurnResponse(stdout.trim()),
        conversation_id: event.conversation_id,
        duration_seconds,
        usage,
      };
    } catch (err: unknown) {
      const errorObj = err as {
        message?: string;
        code?: string | number;
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };

      const duration_seconds = (Date.now() - startTime) / 1000;
      const usage = this.readUsageReport(usageFile);

      if (errorObj?.killed) {
        return {
          response: "",
          error: `Turn execution timed out after ${this.timeoutMs}ms`,
          usage,
          duration_seconds,
        };
      }

      if (errorObj?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return {
          response: "",
          error: "Subprocess output exceeded maximum buffer limit (20MB)",
          usage,
          duration_seconds,
        };
      }

      if (errorObj?.code === "ENOENT") {
        return {
          response: "",
          error: `Harness binary '${this.binaryPath}' not found on PATH.`,
        };
      }

      const errorMsg = errorObj?.stderr?.trim() || errorObj?.message || "Subprocess execution failed";
      return {
        response: errorObj?.stdout ? normalizeTurnResponse(errorObj.stdout.trim()) : "",
        error: redactToken(errorMsg),
        conversation_id: event.conversation_id,
        duration_seconds,
        usage,
      };
    } finally {
      if (fs.existsSync(usageFile)) {
        try {
          fs.unlinkSync(usageFile);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  private readUsageReport(usageFile: string): TurnExecutionResult["usage"] {
    if (!fs.existsSync(usageFile)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(usageFile, "utf8").trim();
      if (!content) return undefined;
      const parsed: HermesUsageFileContent = JSON.parse(content);

      const inTok = parsed.input_tokens ?? parsed.token_counts?.prompt;
      const outTok = parsed.output_tokens ?? parsed.token_counts?.completion;
      const total = parsed.total_tokens ?? parsed.token_counts?.total ?? ((inTok || 0) + (outTok || 0));

      if (inTok !== undefined || outTok !== undefined || total !== undefined) {
        return {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: total,
        };
      }
    } catch {
      // Ignore parse failure on corrupted usage file
    }
    return undefined;
  }
}
