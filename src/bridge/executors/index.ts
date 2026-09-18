/**
 * src/bridge/executors/index.ts
 *
 * Unified exports and factory for all coms-net turn execution engine adapters.
 */

import type { ITurnExecutor } from "../../protocol/types.ts";
import {
  AgyCliTurnExecutor,
  MockTurnExecutor,
  normalizeTurnResponse,
  normalizeStringResponse,
} from "../turn-executor.ts";
import { ClaudeCodeTurnExecutor, type ClaudeCodeTurnExecutorOptions } from "./claude.ts";
import { CodexTurnExecutor, type CodexTurnExecutorOptions } from "./codex.ts";
import { AiderTurnExecutor, type AiderTurnExecutorOptions } from "./aider.ts";
import { GrokTurnExecutor, type GrokTurnExecutorOptions } from "./grok.ts";
import { HermesTurnExecutor, type HermesTurnExecutorOptions } from "./hermes.ts";

export {
  ClaudeCodeTurnExecutor,
  type ClaudeCodeTurnExecutorOptions,
  CodexTurnExecutor,
  type CodexTurnExecutorOptions,
  AiderTurnExecutor,
  type AiderTurnExecutorOptions,
  GrokTurnExecutor,
  type GrokTurnExecutorOptions,
  HermesTurnExecutor,
  type HermesTurnExecutorOptions,
  normalizeTurnResponse,
  normalizeStringResponse,
};

export type SupportedHarness =
  | "antigravity"
  | "claude"
  | "codex"
  | "aider"
  | "grok"
  | "hermes"
  | "mock";

export const SUPPORTED_HARNESSES: readonly SupportedHarness[] = [
  "antigravity",
  "claude",
  "codex",
  "aider",
  "grok",
  "hermes",
  "mock",
] as const;

export interface CreateTurnExecutorOptions {
  harness: SupportedHarness;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  mockResponse?: string;
  env?: NodeJS.ProcessEnv;
  binaryPath?: string;
  permissionMode?: string;
  provider?: string;
}

/**
 * Factory function creating an ITurnExecutor instance matching the target harness.
 */
export function createTurnExecutor(options: CreateTurnExecutorOptions): ITurnExecutor {
  switch (options.harness) {
    case "mock":
      return new MockTurnExecutor({
        defaultResponse: options.mockResponse || "Mock response from Bridge",
      });

    case "antigravity":
      return new AgyCliTurnExecutor({
        agyBinaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
      });

    case "claude":
      return new ClaudeCodeTurnExecutor({
        binaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        permissionMode: options.permissionMode,
      });

    case "codex":
      return new CodexTurnExecutor({
        binaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
      });

    case "aider":
      return new AiderTurnExecutor({
        binaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
      });

    case "grok":
      return new GrokTurnExecutor({
        binaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        permissionMode: options.permissionMode,
      });

    case "hermes":
      return new HermesTurnExecutor({
        binaryPath: options.binaryPath,
        model: options.model,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        provider: options.provider,
      });

    default: {
      const exhaustiveCheck: never = options.harness;
      throw new Error(`Unsupported harness: ${exhaustiveCheck}`);
    }
  }
}
