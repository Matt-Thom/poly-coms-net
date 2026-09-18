# Project: poly-coms-net Multi-Harness Integration

## Architecture
`poly-coms-net` extends the multi-agent mesh communication network to support leading AI coding agent frameworks (Claude Code, OpenAI Codex, Aider, Grok CLI) and Hermes Agent as first-class peer delegators and autonomous bridge workers.

### System Components & Data Flow:
```
  +-------------------------------------------------------------------------+
  |                          coms-net Server Hub                            |
  +------------------------------------+------------------------------------+
                                       |
                                       | SSE /v1/events ("prompt")
                                       v
  +------------------------------------+------------------------------------+
  |                            BridgeDaemon                                 |
  |  - FIFO Turn Queue & Concurrency Management (maxConcurrentTurns: 1)     |
  |  - Anti-loop header formatting (formatInboundPrompt)                   |
  |  - Schema validation & Markdown fence extraction (validateResponseSchema)|
  |  - Turn result dispatch: POST /v1/messages/:msg_id/response             |
  +------------------------------------+------------------------------------+
                                       |
                   ITurnExecutor.execute(InboundPromptEvent)
                                       |
         +-----------------------------+-----------------------------+
         |                             |                             |
         v                             v                             v
+------------------+         +-------------------+         +-------------------+
|  ClaudeCodeTurn  |         |   CodexTurn       |         |   AiderTurn       |
|  Executor        |         |   Executor        |         |   Executor        |
|  (claude -p)     |         |   (codex exec)    |         |   (aider -m)      |
+------------------+         +-------------------+         +-------------------+
         |                             |                             |
         v                             v                             v
+------------------+         +-------------------+         +-------------------+
|  GrokTurn        |         |   HermesTurn      |         |  AgyCli / Mock    |
|  Executor        |         |   Executor        |         |  TurnExecutors    |
|  (grok -p)       |         |   (hermes -z)     |         |  (existing)       |
+------------------+         +-------------------+         +-------------------+
```

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Claude Code Adapter | Dedicated `ITurnExecutor` for `claude -p` headless turn execution with `--output-format json`, timeout handling, and token usage parsing | M1 | ORIGINAL_REQUEST R1 |
| F2 | OpenAI Codex Adapter | Dedicated `ITurnExecutor` for `codex exec` non-interactive execution with output capture and token parsing | M1 | ORIGINAL_REQUEST R1 |
| F3 | Aider Adapter | Dedicated `ITurnExecutor` for `aider --message` headless turn execution with `--yes`, `--no-auto-commits`, `--no-stream`, and `--no-git` | M1 | ORIGINAL_REQUEST R1 |
| F4 | Grok CLI Adapter | Dedicated `ITurnExecutor` for `grok -p` headless execution with `--output-format json`, `--always-approve`, and timeout handling | M1 | ORIGINAL_REQUEST R1 |
| F5 | Hermes Agent Adapter | Dedicated `ITurnExecutor` for `hermes -z` headless execution with `--usage-file`, `--accept-hooks`, `--yolo`, `--in`, and `--resume` | M1 | ORIGINAL_REQUEST R1, R2 |
| F6 | Anti-Looping Envelope | Formatting inbound prompts via `formatInboundPrompt` to prevent circular delegations across all harnesses | M1 | ORIGINAL_REQUEST R1 |
| F7 | Schema Validation | Validating direct JSON and markdown codeblock JSON via `validateResponseSchema` | M1 | ORIGINAL_REQUEST R1 |
| F8 | Hermes Metadata Config | Hermes default identity (`hermes-<host>`, runtime `"hermes"`, model `"hermes-3-llama-3.1-70b"`, provider `"nousresearch"`, neon `#C792EA`, custom purpose) | M1 | ORIGINAL_REQUEST R2 |
| F9 | Hermes Outbound MCP Config | Hermes MCP configuration template for `~/.hermes/config.yaml` / `hermes mcp add` connecting to `bin/coms-net-mcp.js` | M1 | ORIGINAL_REQUEST R2 |
| F10 | Multi-Harness Bridge CLI Option | Add `--harness` / `-H` option to `src/cli.ts` supporting `antigravity`, `claude`, `codex`, `aider`, `grok`, `hermes`, and `mock` | M2 | ORIGINAL_REQUEST R3 |
| F11 | Dynamic Bridge Instantiation & Routing | Route turn executor instantiation and metadata resolution based on `--harness` selection in `src/cli.ts` | M2 | ORIGINAL_REQUEST R3 |
| F12 | Ready-to-Use Harness Templates | Configuration templates, hook definitions, and instructions for Claude Code, Codex, Aider, Grok, and Hermes under `templates/` | M3 | ORIGINAL_REQUEST R4 |
| F13 | Justfile Automation Recipes | Starter recipes in `justfile` (`bridge-claude`, `bridge-codex`, `bridge-aider`, `bridge-grok`, `bridge-hermes`, `bridge-mock`) | M3 | ORIGINAL_REQUEST R4 |
| F14 | Hermetic Subprocess Unit Tests | Hermetic unit tests for all 5 new harness executors using isolated temporary mock scripts | M1 | ORIGINAL_REQUEST AC |
| F15 | CLI Argument Parsing Unit Tests | Unit tests verifying `--harness` and `-H` options, defaults, and error validation | M2 | ORIGINAL_REQUEST AC |
| F16 | Zero-Regression E2E Verification | Ensure all 304 existing tests pass without regression, all new tests pass, and `npm run build` succeeds | M4 | ORIGINAL_REQUEST AC |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Multi-Harness Turn Execution Engine & Hermes Adapter | Implement dedicated `ITurnExecutor` adapters for Claude Code, OpenAI Codex, Aider, Grok CLI, and Hermes Agent in `src/bridge/executors/` (and re-exported in `src/bridge/turn-executor.ts`), with anti-loop envelopes, timeout handling, error redaction, token usage extraction, Hermes metadata defaults, and comprehensive hermetic unit tests. | none | DONE |
| M2 | Unified Multi-Harness Bridge CLI | Enhance `src/cli.ts` with `--harness` / `-H` (`antigravity`, `claude`, `codex`, `aider`, `grok`, `hermes`, `mock`), validate inputs, route turn executor factory, resolve harness-specific metadata defaults, and write CLI argument parsing tests in `tests/unit/cli.test.ts`. | M1 | DONE |
| M3 | Ready-to-Use Harness Configs & Justfile Recipes | Create configuration templates and hook definitions under `templates/{claude,codex,aider,grok,hermes}/` and add `just bridge-*` recipes to `justfile`. | M2 | DONE |
| M4 | Final Verification & Zero-Regression Pass | Verify 100% pass rate on full test suite (existing 304 tests + all new unit and integration tests), clean build (`npm run build`), and execute E2E test suite. | M1, M2, M3 | DONE |

---

## Interface Contracts

### 1. `ITurnExecutor` Interface Contract (`src/protocol/types.ts`)
```typescript
export interface InboundPromptEvent {
  msg_id: string;
  sender_session: string;
  sender_name: string;
  sender_project: string;
  prompt: string;
  conversation_id?: string;
  response_schema?: Record<string, unknown>;
  hops: number;
}

export interface TurnExecutionResult {
  response: string;
  error?: string;
  conversation_id?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export interface ITurnExecutor {
  execute(event: InboundPromptEvent): Promise<TurnExecutionResult>;
}
```

### 2. Turn Executor Common Options Contract
```typescript
export interface BaseSubprocessExecutorOptions {
  binaryPath?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
```

### 3. Factory Contract (`src/bridge/executors/index.ts` or `src/bridge/turn-executor.ts`)
```typescript
export type SupportedHarness =
  | "antigravity"
  | "claude"
  | "codex"
  | "aider"
  | "grok"
  | "hermes"
  | "mock";

export interface CreateTurnExecutorOptions {
  harness: SupportedHarness;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  mockResponse?: string;
  env?: NodeJS.ProcessEnv;
}

export function createTurnExecutor(options: CreateTurnExecutorOptions): ITurnExecutor;
```

### 4. CLI Argument Options Contract (`src/cli.ts`)
```typescript
export const SUPPORTED_HARNESSES: readonly SupportedHarness[] = [
  "antigravity",
  "claude",
  "codex",
  "aider",
  "grok",
  "hermes",
  "mock",
] as const;

export interface BridgeCliArgs {
  harness: SupportedHarness;
  project?: string;
  serverUrl?: string;
  authToken?: string;
  name?: string;
  purpose?: string;
  model?: string;
  mock: boolean;
  mockResponse?: string;
  cwd?: string;
  maxTurns?: number;
  heartbeatMs?: number;
  explicit?: boolean;
  peers: boolean;
  status: boolean;
  help: boolean;
  version: boolean;
}
```

---

## Code Layout
- `src/bridge/executors/`: Dedicated adapter files:
  - `claude.ts`: `ClaudeCodeTurnExecutor`
  - `codex.ts`: `CodexTurnExecutor`
  - `aider.ts`: `AiderTurnExecutor`
  - `grok.ts`: `GrokTurnExecutor`
  - `hermes.ts`: `HermesTurnExecutor`
  - `index.ts`: Unified export and `createTurnExecutor` factory
- `src/bridge/turn-executor.ts`: Re-exports all executors, `formatInboundPrompt`, `validateResponseSchema`, `AgyCliTurnExecutor`, `MockTurnExecutor`
- `src/cli.ts`: `--harness` / `-H` parsing, metadata defaults, factory dispatch
- `templates/`: Configuration templates and hook definitions:
  - `claude/`: `settings.json`, `mcp_config.json`
  - `codex/`: `config.toml`, `mcp.json`
  - `aider/`: `.aider.conf.yml`
  - `grok/`: `config.toml`, `hooks.json`
  - `hermes/`: `hermes-config-snippet.yaml`, `setup-mcp.sh`
- `justfile`: `bridge-*` automation recipes
- `tests/unit/`:
  - `turn-executor-claude.test.ts`
  - `turn-executor-codex.test.ts`
  - `turn-executor-aider.test.ts`
  - `turn-executor-grok.test.ts`
  - `turn-executor-hermes.test.ts`
  - `cli.test.ts` (extended with `--harness` / `-H` tests)
- `tests/e2e/`: Multi-harness end-to-end and integration verification
