# Original User Request

## 2026-09-18T05:44:46Z

Extend `poly-coms-net` to support the leading AI coding agent frameworks (Claude Code, OpenAI Codex, Aider, and Grok CLI) plus Hermes Agent, establishing a poly-harness multi-agent mesh where any agent can act as an autonomous worker or peer delegator.

Working directory: /home/matt/Code/poly-coms-net
Integrity mode: development

## Requirements

### R1. Multi-Harness Turn Execution Engine
Implement dedicated `ITurnExecutor` adapters for the target frameworks:
- **Claude Code** (`claude -p` / headless execution adapter)
- **OpenAI Codex** (`codex` CLI non-interactive execution adapter)
- **Aider** (`aider` CLI headless / non-interactive turn execution)
- **Grok CLI** (`grok` CLI non-interactive execution adapter)
- **Hermes Agent** (`hermes` CLI / headless execution adapter)

Each adapter must safely spawn the harness in headless mode, pass the anti-looping prompt envelope, capture response output, validate structured JSON schemas when requested, and handle errors and timeouts gracefully.

### R2. Hermes Agent Integration
Provide first-class integration for Nous Research Hermes Agent:
- Autonomous turn executor supporting Hermes' CLI execution flags.
- Default metadata configuration (agent name, model tagging, neon color palette assignment, and custom purpose).
- Outbound MCP tool configuration enabling Hermes sessions to discover peers and dispatch tasks to the coms-net hub.

### R3. Unified Multi-Harness Bridge CLI
Enhance `coms-net-bridge` (`src/cli.ts`) with a `--harness` / `-H` option (supporting `antigravity`, `claude`, `codex`, `aider`, `grok`, `hermes`, and `mock`), allowing any supported harness to be spun up as an autonomous coms-net bridge worker with a single command.

### R4. Ready-to-Use Harness Configuration & Starter Recipes
Provide configuration templates and `justfile` recipes for each harness:
- MCP server configs and hook definitions for Claude Code, Codex, Aider, Grok, and Hermes.
- `just` recipes to launch or bridge any harness into the mesh (e.g. `just bridge-claude`, `just bridge-hermes`, `just bridge-codex`).

## Acceptance Criteria

### Adapter Contracts & Execution
- [ ] Each target harness (`claude`, `codex`, `aider`, `grok`, `hermes`) has a verified implementation of `ITurnExecutor`.
- [ ] Inbound prompts correctly wrap anti-loop envelopes to prevent infinite delegation loops for all harnesses.
- [ ] `--harness` CLI argument correctly routes execution to the chosen harness adapter.

### Hermetic Testing & Regression Prevention
- [ ] Comprehensive unit tests for all 5 new harness executors with mocked process execution.
- [ ] CLI argument parsing tests for new `--harness` options.
- [ ] All existing 304 unit, integration, adversarial, and e2e tests continue to pass without regression.
- [ ] Clean build with `npm run build` (`tsc`).

## 2026-09-19T01:50:09Z

This is a single self-contained fix; keep it small and focused.
Fix coms-net client caching of non-terminal errors, wire MCP SSE response subscriptions, and harden await stream resilience and error classification across `poly-coms-net` and `pi-coms-net`.

Working directory: /home/matt/Code/poly-coms-net
Integrity mode: development

## Requirements

### R1. Non-Terminal Error Cache Elimination & Retry Semantics
In `src/protocol/tools.ts`:
- Ensure `pendingReplies.get(msgId).result` is ONLY populated for genuine terminal replies:
  - Valid SSE `response` payload.
  - HTTP `status === "complete"` or hub `status === "error"` with an explicit error payload.
- NEVER cache transient transport failures, socket drops, fetch aborts, or timeouts (`status === "timeout"`, `error === "timeout"`, `error === "aborted"`, `unknown msg_id` blips, or `Network request failed...`).
- When a transport failure or timeout occurs during `coms_net_await`, ensure a subsequent `coms_net_get` performs a fresh `GET /v1/messages/:id` query against the hub.
- Ensure any subsequent `coms_net_await` starts a fresh HTTP long-poll and continues to race the local SSE promise.
- Preserve round-tripping for legitimate empty/falsy payloads (`""`, `0`, `false`, `null`).

### R2. MCP Server SSE Response Subscription
In `src/mcp/server.ts`:
- Wire an active `SseEventListener` instance upon MCP client initialization (matching the bridge daemon architecture in `src/bridge/daemon.ts`).
- Listen for SSE `response` events and resolve `pendingReplies` when outbound requests complete.
- Ensure `coms_net_await` within MCP sessions (such as Grok CLI or Claude Code) can resolve immediately via SSE push without relying exclusively on the HTTP long-poll.
- Ensure proper cleanup of the SSE listener on shutdown.

### R3. Transparent Error Classification & Fetch Body Timeout Guard
In `src/protocol/client.ts`:
- Update `classifyNetworkError` so that underlying `err.cause` properties (including `code`, `name`, and nested `message`, e.g., `UND_ERR_SOCKET` or connection reset) are retained in the thrown error message.
- Harden `ComsNetClient.request()` so that the timeout guard extends through the complete response body read (`resp.text()`), avoiding unshielded hangs when headers flush before body data.
- (Optional/Resilience) Add transient retry capabilities to HTTP long-poll calls without duplicating message dispatch.

### R4. Hub Await Stream Keepalive & Header Flush
In `/home/matt/Code/pi-coms-net/scripts/coms-net-server.ts`:
- In `handleAwaitMessage`, flush HTTP response headers immediately with chunked/streaming headers.
- Transmit periodic keepalive bytes (e.g. newline or comment ping chunks every 15–30s) on the await ReadableStream to prevent intermediate socket timeouts and Node/undici drops while awaiting peer completion.

## Acceptance Criteria

### Cache Invariants & Retries
- [ ] Await HTTP long-poll network failure leaves `pending.result` unset; immediate `coms_net_get` queries the hub endpoint; subsequent `coms_net_await` initiates a new poll.
- [ ] Await HTTP timeout (`status: "timeout"`) does not cache as terminal; subsequent `get` or `await` can retrieve eventual `complete`.
- [ ] Genuine completed replies (including falsy values `""`, `0`, `false`, `null`) remain cached and short-circuit subsequent calls.

### MCP SSE Integration
- [ ] MCP server initializes and maintains an SSE connection to `/v1/events`.
- [ ] Outbound messages in MCP sessions resolve cleanly upon receiving SSE `response` events even if HTTP long-poll is disrupted.

### Diagnostics & Hub Keepalives
- [ ] `classifyNetworkError` includes `cause.code` and cause details on fetch errors (e.g., `UND_ERR_SOCKET`).
- [ ] Hub `handleAwaitMessage` streams keepalives without breaking JSON response parsing on settlement.
- [ ] All existing adversarial stress tests (`tests/adversarial/adversarial-stress.test.ts`), tools unit tests (`tests/unit/tools.test.ts`), and new regression suites pass.
