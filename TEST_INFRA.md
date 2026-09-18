# Poly-Coms-Net Test Infrastructure & Multi-Harness E2E Framework

## 1. Test Philosophy & Principles

The `poly-coms-net` testing infrastructure validates multi-agent mesh communication and multi-harness turn execution across heterogeneous AI coding agent frameworks. 

### Core Testing Principles:
1. **Opaque-Box, Requirement-Driven Verification**:
   Tests evaluate the system through public interfaces (`BridgeDaemon`, `ComsNetClient`, `ITurnExecutor`, CLI invocation) and observable protocol artifacts (HTTP status codes, SSE event streams, JSON envelopes, process exit codes) rather than white-box implementation details.
2. **100% Hermetic & CI-Isolated**:
   No external API keys, commercial cloud endpoints, or live LLM tokens are required. Network operations target an in-memory or loopback `MockHub` server, and subprocess execution exercises isolated mock scripts within temporary directories (`os.tmpdir()`).
3. **High-Fidelity Subprocess Realism**:
   Rather than stubbing Node.js `child_process.execFile` in memory, tests generate real executable shell scripts in sandboxed temporary environments. This rigorously verifies argument serialization, standard I/O streaming, buffer limits, signal handling (`SIGTERM`/`SIGKILL`), and exit code propagation.
4. **Anti-Looping Invariant Enforcement**:
   Every harness adapter must strictly wrap inbound prompts with anti-loop headers (`formatInboundPrompt`), ensuring peer workers never initiate circular outbound calls when responding to tasks.
5. **Deterministic Cleanup & Isolation**:
   Every test suite provisions dedicated project namespaces (`generateUlid()`), unique mock hub instances on ephemeral ports, and isolates filesystem state with `before()` and `after()` lifecycle hooks.

---

## 2. Test Architecture

```
                                  +---------------------------------------+
                                  |     node:test Test Runner             |
                                  |  (tests/e2e/multi-harness-poly.test.ts)|
                                  +-------------------+-------------------+
                                                      |
                         +----------------------------+----------------------------+
                         |                                                         |
                         v                                                         v
          +------------------------------+                          +------------------------------+
          |         MockHub Server       |                          |    BridgeDaemon Instances    |
          |  - HTTP REST Endpoints       | <====== HTTP / SSE ===== |  - AgentLifecycle & Heartbeat|
          |  - SSE Event Streaming       |                          |  - Inbound FIFO Turn Queue   |
          |  - ULID Message Store        |                          |  - Schema Validation         |
          +------------------------------+                          +--------------+---------------+
                                                                                   |
                                            +--------------------------------------+
                                            |
                                            v
                         +--------------------------------------+
                         |    ITurnExecutor Adapters            |
                         |  - Antigravity (agy -p)              |
                         |  - Claude Code (claude -p)           |
                         |  - OpenAI Codex (codex exec)         |
                         |  - Aider (aider -m)                  |
                         |  - Grok CLI (grok -p)                |
                         |  - Hermes Agent (hermes -z)          |
                         |  - Mock Turn Executor                |
                         +------------------+-------------------+
                                            |
                                            v
                         +--------------------------------------+
                         | Isolated Mock Binary Scripts         |
                         |  (Temp bash scripts with real CLI    |
                         |   flags, json output, usage files)   |
                         +--------------------------------------+
```

---

## 3. Four-Tier Testing Methodology

The E2E test suite (`tests/e2e/multi-harness-poly.test.ts`) is organized into four rigorous tiers:

### Tier 1: Feature Coverage (All Supported Harnesses)
Validates the primary execution path (happy path) for every supported AI harness adapter operating through `BridgeDaemon`:
- **Antigravity CLI**: Headless execution with `-p`, `--output-format json`, conversation tracking, and token usage parsing.
- **Claude Code**: Non-interactive `claude -p` execution with `--output-format json`, `--dangerously-skip-permissions`, duration, and token usage parsing.
- **OpenAI Codex**: Headless `codex exec` execution with `--sandbox danger-full-access`, `--ephemeral`, and token extraction.
- **Aider**: Headless `aider --message` execution with `--yes`, `--no-auto-commits`, `--no-stream`, `--no-git`.
- **Grok CLI**: Headless `grok -p` execution with `--output-format json`, `--always-approve`.
- **Hermes Agent**: Headless `hermes -z` execution with `--accept-hooks`, `--yolo`, `--usage-file` extraction, and cleanup.
- **Mock Executor**: Fast in-memory execution for baseline latency and control tests.

### Tier 2: Boundary & Corner Cases
Tests the robustness, error recovery, and resilience of the multi-harness bridge:
- **Subprocess Timeout Enforcement**: Enforces `timeoutMs` killing hung processes and returning sanitized error diagnostics without crashing.
- **Empty & Whitespace Prompts**: Ensures graceful handling of empty or blank inbound messages.
- **Subprocess Non-Zero Exit Codes**: Validates that non-zero exits (code 1, code 127) extract stderr and report `TurnExecutionResult.error` cleanly.
- **Malformed & Truncated JSON**: Verifies resilience against syntax errors or non-JSON prefix/suffix logs in child process output.
- **Secret & Token Redaction**: Verifies that bearer tokens and authorization secrets in error messages are scrubbed via `redactToken`.
- **Schema Validation Failures**: Ensures invalid responses against a strict JSON Schema return `"response not valid JSON"` error payload.

### Tier 3: Cross-Feature Combinations
Validates the interaction of orthogonal protocol features across harnesses:
- **Anti-Looping Envelope Delivery**: Verifies that every adapter receives prompts wrapped with `[inbound coms-net message...]` preventing recursive delegation.
- **Hop Limit Tracking**: Verifies that `hops` increments correctly across multi-step turn delegation chains and triggers `HopLimitExceededError` at `hops >= 5`.
- **Conversation State Continuity**: Verifies that `conversation_id` is preserved and passed to successive turns across harnesses (e.g. `--conversation` or `--resume`).
- **Concurrent Turn Queuing**: Verifies that multiple rapid inbound messages are queued and executed sequentially adhering to `maxConcurrentTurns: 1`.

### Tier 4: Real-World Multi-Agent Workloads
Exercises distributed multi-agent collaboration pipelines using multiple heterogeneous bridge workers:
- **Heterogeneous Peer Delegation**: Orchestrator (Hermes) dispatches a code generation task to a worker (Claude Code) which in turn delegates test verification to a reviewer (Codex).
- **Structured Schema Exchange**: End-to-end exchange where the responder returns structured JSON validated by the sender against a JSON Schema.
- **Multi-Turn Stateful Dialogue**: A multi-turn conversation between two autonomous bridges maintaining conversation context across turns.
- **Network Resilience & Reconnection**: Verifies that a bridge daemon survives a simulated network disconnection, reconnects to the hub via SSE, and resumes message processing.

---

## 4. Feature Inventory & Verification Matrix

| Feature ID | Feature Name | Description | Verified In |
|------------|--------------|-------------|-------------|
| **F1** | Claude Code Adapter | `ClaudeCodeTurnExecutor` with `claude -p`, token parsing | Tier 1, Tier 3, Tier 4 |
| **F2** | OpenAI Codex Adapter | `CodexTurnExecutor` with `codex exec`, token parsing | Tier 1, Tier 3, Tier 4 |
| **F3** | Aider Adapter | `AiderTurnExecutor` with `aider -m`, git flags | Tier 1, Tier 2 |
| **F4** | Grok CLI Adapter | `GrokTurnExecutor` with `grok -p`, output-format | Tier 1, Tier 2 |
| **F5** | Hermes Agent Adapter | `HermesTurnExecutor` with `hermes -z`, usage-file | Tier 1, Tier 3, Tier 4 |
| **F6** | Anti-Loop Envelope | `formatInboundPrompt` wrapping across all adapters | Tier 1, Tier 2, Tier 3 |
| **F7** | Schema Validation | `validateResponseSchema` with JSON & codeblock extraction | Tier 2, Tier 4 |
| **F8** | Hermes Metadata | Identity defaults (`runtime: "hermes"`, `#C792EA`) | Tier 1, Tier 4 |
| **F9** | Outbound Tool Config | MCP tool configuration for peer delegation | Tier 3, Tier 4 |
| **F10** | Multi-Harness CLI | `--harness` / `-H` flag routing | Tier 1, Tier 3 |
| **F11** | Dynamic Bridge Routing | Factory instantiation based on harness option | Tier 1, Tier 4 |
| **F14** | Subprocess Isolation | Sandboxed mock script execution in temporary dirs | All Tiers |
| **F16** | Zero Regression | Full test suite regression prevention | All Tiers |

---

## 5. Coverage & Quality Thresholds

| Metric | Target Threshold | Description |
|--------|------------------|-------------|
| **Harness Coverage** | 100% (7/7) | All harnesses (`antigravity`, `claude`, `codex`, `aider`, `grok`, `hermes`, `mock`) tested |
| **Tier Coverage** | 100% (4/4) | Tiers 1, 2, 3, and 4 each contain dedicated test cases |
| **E2E Pass Rate** | 100% | 0 failures, 0 skipped tests |
| **Execution Isolation** | 100% | Zero dependencies on live external LLM APIs |
| **Token Scrubbing** | 100% | Sensitive tokens never leaked in error messages |

---

## 6. How to Run the Tests

```bash
# Run the complete multi-harness E2E test suite
node --test --experimental-strip-types tests/e2e/multi-harness-poly.test.ts

# Run all project test suites (unit, integration, adversarial, e2e)
npm test
```
