# Poly Coms-Net (`poly-coms-net`)

[![Node.js](https://img.shields.io/badge/Node.js-≥22.13.0-brightgreen.svg)](https://nodejs.org/)
[![Multi-Harness](https://img.shields.io/badge/Harnesses-Antigravity%20%7C%20Pi%20%7C%20Claude%20Code%20%7C%20Codex%20%7C%20Aider%20%7C%20Grok%20%7C%20Hermes-blue.svg)](#overview)
[![Zero Dependencies](https://img.shields.io/badge/Runtime_Dependencies-0-success.svg)](#zero-runtime-dependency-architecture)
[![Tests](https://img.shields.io/badge/Tests-488_Passing-brightgreen.svg)](#testing)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**Poly Coms-Net** is the poly-harness integration and autonomous bridge engine for the **coms-net multi-agent mesh network**. It connects heterogeneous coding agent harnesses—including Google Antigravity (`agy`), [Pi Coding Agent](https://github.com/mariozechner/pi-coding-agent), Claude Code, OpenAI Codex, Aider, Grok CLI, and Nous Research Hermes Agent—into a decentralized, peer-to-peer agent pool where peers discover each other, delegate structured cross-agent prompts, await responses, and autonomously execute inbound turns.

> **Origins & Attribution**: Originally created and conceptualized by **IndyDevDan** in [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code), extending the multi-agent mesh communication protocol and extension patterns for autonomous coding agents.

---

## Table of Contents

- [Overview](#overview)
- [Architecture & Data Flow](#architecture--data-flow)
- [Zero-Runtime-Dependency Architecture](#zero-runtime-dependency-architecture)
- [Supported Harnesses & Adapters](#supported-harnesses--adapters)
- [Prerequisites & Environment](#prerequisites--environment)
- [Installation](#installation)
- [Quickstart Guide](#quickstart-guide)
  - [1. Connect via Antigravity Plugin (Recommended)](#1-connect-via-antigravity-plugin-recommended)
  - [2. Register MCP Server Manually (`agy mcp add`)](#2-register-mcp-server-manually-agy-mcp-add)
  - [3. Run the Autonomous Bridge Daemon for Any Harness](#3-run-the-autonomous-bridge-daemon-for-any-harness)
  - [4. End-to-End Walkthrough (3-Terminal Setup)](#4-end-to-end-walkthrough-3-terminal-setup)
- [CLI Reference: `coms-net-bridge`](#cli-reference-coms-net-bridge)
  - [Options & Flags](#options--flags)
  - [Harness Metadata Defaults](#harness-metadata-defaults)
  - [Environment Variables](#environment-variables)
- [Justfile Automation Recipes](#justfile-automation-recipes)
- [Harness Configuration Templates (`templates/`)](#harness-configuration-templates-templates)
  - [Claude Code (`templates/claude/`)](#claude-code-templatesclaude)
  - [OpenAI Codex (`templates/codex/`)](#openai-codex-templatescodex)
  - [Aider (`templates/aider/`)](#aider-templatesaider)
  - [Grok CLI (`templates/grok/`)](#grok-cli-templatesgrok)
  - [Hermes Agent (`templates/hermes/`)](#hermes-agent-templateshermes)
- [MCP Tools Reference](#mcp-tools-reference)
  - [`coms_net_list`](#1-coms_net_list)
  - [`coms_net_send`](#2-coms_net_send)
  - [`coms_net_get`](#3-coms_net_get)
  - [`coms_net_await`](#4-coms_net_await)
- [Multi-Agent Collaboration Scenarios](#multi-agent-collaboration-scenarios)
  - [Scenario A: Antigravity Agent Delegating to a Pi Agent](#scenario-a-antigravity-agent-delegating-to-a-pi-agent)
  - [Scenario B: Heterogeneous Poly-Harness Pipeline (Hermes → Claude → Codex)](#scenario-b-heterogeneous-poly-harness-pipeline-hermes--claude--codex)
- [Security & Anti-Looping Discipline](#security--anti-looping-discipline)
  - [POSIX Mode 0600 Security Enforcement](#posix-mode-0600-security-enforcement)
  - [Strict Anti-Looping Envelope & Hop Counter](#strict-anti-looping-envelope--hop-counter)
  - [Credential Redaction & Error Masking Protection](#credential-redaction--error-masking-protection)
- [Testing](#testing)
  - [Running the Test Suite](#running-the-test-suite)
  - [Granular Test Suites](#granular-test-suites)
  - [Build Verification & Type Checking](#build-verification--type-checking)
- [Documentation](#documentation)
- [Acknowledgments](#acknowledgments)
- [License](#license)

---

## Overview

The `coms-net` mesh protocol establishes flat, bidirectional agent-to-agent communication without centralized orchestrator hierarchies or prompt loss. Unlike rigid top-down frameworks, any agent on the network can discover peers, delegate specialized subtasks, await structured replies, and execute inbound turns dispatched by other agents.

`poly-coms-net` extends this protocol across seven distinct agent harnesses, enabling unified multi-agent teams where each tool runs its preferred execution environment while sharing a single communication fabric.

### Key Capabilities

- **Poly-Harness Compatibility**: First-class turn execution adapters for Google Antigravity (`agy`), Claude Code (`claude`), OpenAI Codex (`codex`), Aider (`aider`), Grok CLI (`grok`), Nous Research Hermes Agent (`hermes`), and Pi Coding Agent.
- **Autonomous Headless Bridge**: The `coms-net-bridge` daemon registers on the hub, maintains heartbeat tracking, listens to Server-Sent Events (SSE), and dispatches turns non-interactively to the selected harness CLI.
- **Stdio MCP Server with Push Subscription**: `coms-net-mcp` exposes the four standard tools (`coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`) over JSON-RPC 2.0 stdio, with an internal SSE listener for sub-millisecond push-based response resolution.
- **Strict Anti-Looping Safeguards**: Architectural envelope tagging prevents LLM recursive self-delegation, while an enforced hop counter (`MAX_HOPS = 5`) rejects runaway cascading loops.
- **Fast 3-Way Concurrent Await**: `coms_net_await` concurrently races local SSE push events, HTTP server long-polling (`GET /v1/messages/:msg_id/await`), and client timeouts, releasing underlying sockets immediately upon resolution.
- **Automated Hub Self-Healing**: Resilient SSE stream reconnects automatically with exponential backoff and jitter, while heartbeat tracking auto-recovers from 404 session expirations.
- **Zero Runtime Dependencies**: Built entirely on native Node.js 22 built-in modules (`fetch`, `node:http`, `node:child_process`, `node:crypto`, `node:readline`).

---

## Architecture & Data Flow

```
                           ┌─────────────────────────────────────────┐
                           │           coms-net Server Hub           │
                           │       (REST API + SSE Broadcasts)       │
                           └────────────────────┬────────────────────┘
                                                │
                         HTTP REST & SSE Events │
             ┌──────────────────────────────────┴──────────────────────────────────┐
             │                                                                     │
┌────────────▼────────────────────────┐                     ┌──────────────────────▼────────────────────┐
│      Pi Agent (Reference Peer)      │                     │                BridgeDaemon               │
│  - ~/.pi/coms-net/                  │                     │  - Hub Discovery (server.json / env)      │
│  - extensions/coms-net.ts           │                     │  - 10s Heartbeat Loop & Presence          │
│  - Reactive UI & Pool Widget        │                     │  - SSE Event Stream Reconnection          │
└─────────────────────────────────────┘                     │  - FIFO Turn Queue (maxConcurrentTurns: 1)│
                                                            │  - Anti-loop header (formatInboundPrompt) │
                                                            │  - Schema validator & JSON extractor      │
                                                            │  - POST /v1/messages/:msg_id/response     │
                                                            └──────────────────────┬────────────────────┘
                                                                                   │
                                                      ITurnExecutor.execute(InboundPromptEvent)
                                                                                   │
                     ┌──────────────────────┬──────────────────────┬───────────────┴──────┬──────────────────────┐
                     │                      │                      │                      │                      │
                     ▼                      ▼                      ▼                      ▼                      ▼
           ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
           │ ClaudeCodeTurn   │   │ CodexTurn        │   │ AiderTurn        │   │ GrokTurn         │   │ HermesTurn       │
           │ Executor         │   │ Executor         │   │ Executor         │   │ Executor         │   │ Executor         │
           │ (claude -p)      │   │ (codex exec)     │   │ (aider -m)       │   │ (grok -p)        │   │ (hermes -z)      │
           └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
                     │                      │                      │                      │                      │
                     └──────────────────────┴──────────────────────┼──────────────────────┴──────────────────────┘
                                                                   │
                                                      ┌────────────┴────────────┐
                                                      │ AgyCli / MockTurn       │
                                                      │ Executors               │
                                                      │ (agy -p / in-memory)    │
                                                      └─────────────────────────┘
```

---

## Zero-Runtime-Dependency Architecture

`poly-coms-net` ships with **0 production runtime dependencies** (`package.json` `"dependencies": {}`).

Every subsystem is engineered directly on native Node.js 22 built-ins:
- **Transport & Networking**: Native global `fetch` and `node:http` for REST calls and streaming Server-Sent Events (SSE).
- **Process Orchestration**: `node:child_process` (`execFile`, `spawn`) with an explicit 20MB `maxBuffer` to prevent truncation of verbose LLM output.
- **Cryptographic Identifiers**: `node:crypto` generating 26-character Crockford Base32 ULIDs without third-party libraries.
- **Stream Decoding**: Incremental chunk parser (`SseParser`) handling arbitrary TCP fragmentation, mixed CRLF/LF normalization, and multi-byte UTF-8 byte boundary splits.
- **Stdio Framing**: `node:readline` managing strict line-delimited JSON-RPC 2.0 stdio framing for MCP clients.
- **TypeScript Stripping**: Native Node.js 22 `--experimental-strip-types` used for development and testing without intermediate transpile steps.

---

## Supported Harnesses & Adapters

| Harness | CLI Flag | Subprocess Command | Input Mechanism | Token & Metric Parsing | Primary Use Case |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **Antigravity** | `-H antigravity` | `agy -p "$prompt" --output-format json --dangerously-skip-permissions` | CLI Argument | JSON output (`usage.total_tokens`, `cost`) | Google Gemini models, IDE & CLI agents |
| **Claude Code** | `-H claude` | `claude -p "$prompt" --output-format json` | CLI Argument | JSON output (`usage.input_tokens`, `output_tokens`) | Anthropic Claude models, complex reasoning |
| **OpenAI Codex** | `-H codex` | `codex exec --sandbox workspace-write` | CLI Argument / NDJSON | NDJSON event stream with usage stats | OpenAI GPT-5 & Codex models, sandboxed execution |
| **Aider** | `-H aider` | `aider --message "$prompt" --yes --no-auto-commits --no-stream --no-git` | CLI Argument | Stderr regex parsing (`tokens: X in, Y out`) | Git-aware AI pair programming & targeted edits |
| **Grok CLI** | `-H grok` | `grok -p "$prompt" --output-format json --always-approve` | CLI Argument | JSON output (`usage.prompt_tokens`, `completion_tokens`) | xAI Grok models, rapid generation |
| **Hermes Agent**| `-H hermes` | `hermes -z "$prompt" --usage-file <tmp> --accept-hooks --yolo --in --resume` | CLI Argument | Dedicated JSON usage report file lifecycle | Nous Research open-weights, function calling |
| **Mock** | `-H mock` / `--mock`| In-memory simulated execution | Fast callback | Custom canned response, simulated latency/error | Offline CI/CD testing, hermetic unit tests |

---

## Prerequisites & Environment

1. **Node.js**: Version **>= 22.13.0** (required for native `--experimental-strip-types` and global `fetch`):
   ```bash
   node --version
   ```
2. **Coding Agent CLI**: At least one of the supported harness CLIs installed in `$PATH` (e.g. `agy`, `claude`, `codex`, `aider`, `grok`, or `hermes`), or run in hermetic `--mock` mode.
3. **Coms-Net Hub**: A running coms-net hub server. Connect using any of three approaches:
   - **Option A: Local Reference Hub (Bun)**:
     ```bash
     cd ~/Code/pi-coms-net
     bun scripts/coms-net-server.ts
     ```
     Hub credentials are auto-discovered from `~/.pi/coms-net/projects/default/server.json` and `server.secret.json` (must be POSIX mode `0600`).
   - **Option B: Remote or Custom Hub via Environment**:
     ```bash
     export PI_COMS_NET_SERVER_URL="http://127.0.0.1:34567"
     export PI_COMS_NET_AUTH_TOKEN="your-secret-bearer-token"
     export PI_COMS_NET_PROJECT="default"
     ```
   - **Option C: Hermetic Mock Mode (No Hub Required)**:
     Run `coms-net-bridge -H mock` or pass `--mock` for local offline verification without any running hub.

---

## Installation

### Step 1: Clone the Repository
```bash
git clone git@github.com:Matt-Thom/poly-coms-net.git
cd poly-coms-net
```

### Step 2: Install Development Dependencies
```bash
npm install
```

### Step 3: Build the TypeScript Binaries
```bash
npm run build
```

Build outputs:
- `dist/index.js` & `dist/index.d.ts`: Core protocol, client, discovery, and bridge exports
- `dist/cli.js`: Bridge daemon entrypoint
- `dist/mcp/server.js`: Stdio MCP JSON-RPC 2.0 server
- `dist/bridge/executors/`: Harness turn executors (Claude, Codex, Aider, Grok, Hermes, Antigravity, Mock)
- `bin/coms-net-bridge.js`: Executable wrapper for the bridge daemon
- `bin/coms-net-mcp.js`: Executable wrapper for the stdio MCP server

### Step 4: Verify the Installation
Run the complete automated test suite (488 tests across 103 suites):
```bash
npm test
```

### Step 5: (Optional) Link Binaries Globally
```bash
npm link
```

---

## Quickstart Guide

### 1. Connect via Antigravity Plugin (Recommended)

The bundled plugin at `.agents/plugins/coms-net/` automatically registers the MCP server, mesh collaboration rules (`rules/AGENTS.md`), and collaboration skills (`skills/coms-net-collab`):

```bash
# Validate plugin manifest
npm run validate:plugin

# Launch interactive Antigravity session with coms-net
just agy
# Or with docked real-time cmux monitor:
just agy-live
```

---

### 2. Register MCP Server Manually (`agy mcp add`)

Register the MCP server directly into your local or global Antigravity configuration:
```bash
agy mcp add coms-net node $(pwd)/dist/mcp/server.js
# Or using the linked wrapper:
agy mcp add coms-net coms-net-mcp
```

Verify with:
```bash
agy mcp list
```

---

### 3. Run the Autonomous Bridge Daemon for Any Harness

Run a bridge worker that registers on the hub, receives tasks from other agents, and executes turns using your preferred agent harness:

```bash
# Antigravity worker (default)
just bridge-antigravity

# Claude Code worker
just bridge-claude

# OpenAI Codex worker
just bridge-codex

# Aider worker
just bridge-aider

# Grok CLI worker
just bridge-grok

# Hermes Agent worker
just bridge-hermes

# Hermetic Mock worker (no hub or agent CLI required)
just bridge-mock
```

---

### 4. End-to-End Walkthrough (3-Terminal Setup)

| Terminal | Role | Command |
| :--- | :--- | :--- |
| **Terminal 1** | **Coms-Net Hub** | `bun scripts/coms-net-server.ts` (or remote hub) |
| **Terminal 2** | **Bridge Worker (`claude-worker`)** | `just bridge-claude --name claude-worker --purpose "Review specialist"` |
| **Terminal 3** | **Interactive Session (`lead-agent`)** | `just agy` |

#### Step 1: Peer Discovery
In **Terminal 3**, ask your lead agent:
```text
User: Check what agents are online on coms-net.
```
The agent calls `coms_net_list` and discovers `claude-worker`:
```text
1 peer(s):
● claude-worker (claude-sonnet-4-6) 0% — Review specialist
```

#### Step 2: Task Delegation
```text
User: Ask claude-worker to review src/protocol/discovery.ts for path traversal risks and await the response.
```
The lead agent executes:
1. `coms_net_send(target: "claude-worker", prompt: "Review src/protocol/discovery.ts...")` → receives `msg_id: "01M2Y9..."`.
2. `coms_net_await(msg_id: "01M2Y9...")` → blocks awaiting the worker's reply.

#### Step 3: Headless Execution & Delivery
In **Terminal 2**, `claude-worker` receives the inbound SSE event, formats the anti-looping envelope, runs `claude -p`, captures output and token usage, and posts the response back to `/v1/messages/:msg_id/response`.

#### Step 4: Result Synthesis
In **Terminal 3**, `coms_net_await` unblocks via SSE push, and the lead agent synthesizes Claude's review findings for the user.

---

## CLI Reference: `coms-net-bridge`

```bash
$ coms-net-bridge [options]
```

### Options & Flags

| Flag | Short | Default | Description |
| :--- | :---: | :---: | :--- |
| `-H, --harness <name>` | `-H` | `"antigravity"` | Turn execution harness: `antigravity`, `claude`, `codex`, `aider`, `grok`, `hermes`, `mock`. |
| `-p, --project <name>` | `-p` | `"default"` | Target project namespace (overridden by `$PI_COMS_NET_PROJECT`). |
| `-u, --server-url <url>`| `-u` | *auto-discovered*| Coms-net hub URL (overridden by `$PI_COMS_NET_SERVER_URL`). |
| `-t, --auth-token <token>`| `-t`| *auto-discovered*| Hub authorization Bearer token (overridden by `$PI_COMS_NET_AUTH_TOKEN`). |
| `-n, --name <name>` | `-n` | `<harness>-<host>` | Agent name to register on the hub. Collisions automatically receive numeric suffixes. |
| `--purpose <text>` | | *harness default* | Agent purpose description visible in `coms_net_list`. |
| `-m, --model <model>` | `-m` | *harness default* | LLM model override passed to the harness turn executor. |
| `--cwd <path>` | | *process cwd* | Working directory context where harness commands execute. |
| `--mock` | | `false` | Run in hermetic mock mode using `MockTurnExecutor` (equivalent to `-H mock`). |
| `--mock-response <text>`| | `"Mock response..."` | Canned response text returned in `--mock` mode. |
| `--max-turns <n>` | | `1` | Maximum concurrent turn executions handled by the FIFO queue. |
| `--heartbeat-ms <n>` | | `10000` | Heartbeat pulse interval in milliseconds (default: 10s). |
| `--explicit` | | `false` | Mark agent as explicit/hidden (omitted from general discovery). |
| `-P, --peers` | `-P` | `false` | Query active mesh peer roster box and exit immediately. |
| `--status` | | `false` | Display hub connectivity and peer roster box and exit. |
| `-h, --help` | `-h` | | Display help message and exit. |
| `-v, --version` | `-v` | | Display version number and exit. |

### Harness Metadata Defaults

When `-H <harness>` is selected without explicit `--model`, `--purpose`, or `--name`, the bridge applies sensible defaults:

| Harness | Name Prefix | Default Model | Default Provider | Runtime | Neon Color |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `antigravity` | `antigravity` | `gemini-2.5-pro` | `google` | `antigravity` | Hash-derived |
| `claude` | `claude` | `claude-sonnet-4-6` | `anthropic` | `claude` | Hash-derived |
| `codex` | `codex` | `gpt-5.3-codex` | `openai` | `codex` | Hash-derived |
| `aider` | `aider` | `claude-3-7-sonnet`| `openai` | `aider` | Hash-derived |
| `grok` | `grok` | `grok-4.6` | `xai` | `grok` | Hash-derived |
| `hermes` | `hermes` | `hermes-3-llama-3.1-70b` | `nousresearch` | `hermes` | `#C792EA` |
| `mock` | `mock` | `mock-model` | `mock` | `mock` | Hash-derived |

### Environment Variables

| Variable | Precedence | Description |
| :--- | :---: | :--- |
| `PI_COMS_NET_PROJECT` | CLI `-p` > Env > Default | Project namespace (`"default"`). |
| `PI_COMS_NET_SERVER_URL`| CLI `-u` > Env > `server.json` | Coms-net hub base URL. |
| `PI_COMS_NET_AUTH_TOKEN`| CLI `-t` > Env > `server.secret.json` | Hub authorization Bearer token. |
| `PI_COMS_NET_DIR` | Env > Default | Discovery directory root (default: `~/.pi/coms-net`). |
| `AGY_BIN_PATH` | Env > Default | Custom path to `agy` executable. |

---

## Justfile Automation Recipes

`poly-coms-net` includes ready-to-run automation recipes via [just](https://github.com/casey/just):

```bash
# List all available recipes
just

# Core Development
just build             # Compile TypeScript to dist/
just test              # Run complete test suite (488 tests)
just peers             # Query online peers on current mesh
just monitor           # Live terminal pool monitor (auto-refreshing)

# Interactive Sessions
just agy               # Run Antigravity CLI connected to active mesh
just agy-live          # Run Antigravity CLI with docked cmux monitor pane
just claude-mesh       # Launch Claude Code interactive session connected to coms-net
just hermes-mesh       # Launch Hermes Agent interactive session connected to coms-net

# Dedicated Bridge Workers
just bridge-antigravity [args]  # Start Antigravity bridge worker
just bridge-claude [args]       # Start Claude Code bridge worker
just bridge-codex [args]        # Start OpenAI Codex bridge worker
just bridge-aider [args]        # Start Aider bridge worker
just bridge-grok [args]         # Start Grok CLI bridge worker
just bridge-hermes [args]       # Start Hermes Agent bridge worker
just bridge-mock [args]         # Start hermetic mock worker (offline CI)
```

---

## Harness Configuration Templates (`templates/`)

Pre-built configuration snippets, MCP registrations, and instruction files for external harnesses are organized in `templates/`:

### Claude Code (`templates/claude/`)
- `settings.json`: Configuration template with MCP server registration and permission rules.
- `mcp_config.json`: Ready-to-pass config file for `claude --mcp-config templates/claude/mcp_config.json`.
- `CLAUDE.md`: System instructions enforcing anti-looping rules and tool discovery conventions.

### OpenAI Codex (`templates/codex/`)
- `config.toml`: Codex settings with sandbox definitions and execution policies.
- `mcp.json`: Model Context Protocol server configuration for Codex.
- `CODEX.md`: Agent behavior guidelines and anti-looping protocol.

### Aider (`templates/aider/`)
- `.aider.conf.yml`: Headless execution defaults (`--yes`, `--no-auto-commits`, `--no-git`, `--no-stream`).
- `CONVENTIONS.md`: Pair-programming rules and mesh delegation standards.

### Grok CLI (`templates/grok/`)
- `config.toml`: Non-interactive execution profile and permissions.
- `hooks.json`: Lifecycle hook configurations (`PreToolUse`, `Stop`).
- `GROK.md`: Anti-looping and peer delegation instructions.

### Hermes Agent (`templates/hermes/`)
- `hermes-config-snippet.yaml`: YAML configuration block for `~/.hermes/config.yaml`.
- `setup-mcp.sh`: Automated installer script (`./setup-mcp.sh --dry-run` or `./setup-mcp.sh`) running `hermes mcp add`.
- `AGENTS.md`: Instruction guide documenting `mcp__coms_net__*` namespaced tools and anti-looping safeguards.

---

## MCP Tools Reference

The stdio MCP server (`coms-net-mcp`) registers four standard tools:

### 1. `coms_net_list`
Discovers active peer agents registered on the coms-net hub for the current project.
- **Arguments**:
  - `project` (*string*, optional): Namespace project name. Defaults to active project.
  - `include_explicit` (*boolean*, optional): When `true`, includes hidden/explicit agents.
- **Output**:
  ```text
  3 peer(s):
  ● claude-worker (sonnet-4-6) 12% — Security audit specialist
  ● codex-worker (gpt-5.3) 0% — Refactoring and optimization agent
  ~ hermes-agent (hermes-3) ?% — Nous Research autonomous worker
  ```
  *(Status indicators: `●` online, `~` stale, `✗` offline)*.

---

### 2. `coms_net_send`
Dispatches an outbound prompt to a target peer agent.
- **Arguments**:
  - `target` (*string*, **required**): Peer agent name (e.g. `"claude-worker"`) or 26-character ULID `session_id`.
  - `prompt` (*string*, **required**): Self-contained task description, file paths, constraints, and instructions.
  - `conversation_id` (*string*, optional): Thread identifier for continuing multi-turn dialogues.
  - `response_schema` (*object*, optional): JSON Schema enforcing structured JSON response validation.
- **Output**:
  ```text
  coms_net_send → claude-worker
  msg_id 01M2Y9D98D5PRX1X7CHG45DMQD
  hops 0
  ```
- **Anti-Loop Warning**: Never call `coms_net_send` to reply to an inbound message. Formulate your answer in normal assistant text.

---

### 3. `coms_net_get`
Performs a non-blocking status check on a previously dispatched message.
- **Arguments**:
  - `msg_id` (*string*, **required**): 26-character ULID returned by `coms_net_send`.
- **Output (Completed)**:
  ```text
  coms_net_get: complete
  Audit complete: No vulnerabilities identified.
  ```

---

### 4. `coms_net_await`
Blocks until the responder delivers an answer, or until the timeout expires.
- **Arguments**:
  - `msg_id` (*string*, **required**): 26-character ULID returned by `coms_net_send`.
  - `timeout_ms` (*number*, optional): Milliseconds before timing out (default: 1,800,000 ms / 30 minutes).
- **Execution Race**: Concurrently races local SSE push events, HTTP long-polling (`GET /v1/messages/:msg_id/await`), and client timers. Open network sockets are immediately aborted upon resolution.
- **Output**:
  ```json
  {
    "status": "complete",
    "response": "All 488 tests passed with 100% coverage."
  }
  ```

---

## Multi-Agent Collaboration Scenarios

### Scenario A: Antigravity Agent Delegating to a Pi Agent

```
[Antigravity Session]            [coms-net Hub]                  [Pi Agent: pi-reviewer]
         │                              │                                    │
         │  1. coms_net_list()          │                                    │
         ├─────────────────────────────►│                                    │
         │  ◄── [pi-reviewer (online)]  │                                    │
         │                              │                                    │
         │  2. coms_net_send("pi-rev")  │                                    │
         ├─────────────────────────────►│  3. SSE Broadcast: 'prompt'       │
         │  ◄── { msg_id: "01J7AB..." } ├───────────────────────────────────►│
         │                              │                                    │ 4. Turn execution
         │  5. coms_net_await("01J7AB") │                                    │    in Pi agent
         ├─────────────────────────────►│                                    │
         │   (3-way race waiting)       │  6. POST /messages/:id/response    │
         │                              │◄───────────────────────────────────┤
         │  7. SSE 'response' / HTTP    │                                    │
         │◄─────────────────────────────┤                                    │
         │                              │                                    │
         ▼ 8. Synthesize review         │                                    │
```

---

### Scenario B: Heterogeneous Poly-Harness Pipeline (Hermes → Claude → Codex)

Three specialized agents collaborate in an automated pipeline:
1. **Hermes Agent** (`hermes-worker`) plans architecture and delegates security review to **Claude Code** (`claude-worker`).
2. **Claude Code** reviews the specification, identifies performance bottlenecks, and delegates implementation to **OpenAI Codex** (`codex-worker`).
3. **OpenAI Codex** generates optimized TypeScript code and returns results back through the mesh.

```
┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
│       Hermes Agent        │      │        Claude Code        │      │       OpenAI Codex        │
│ Model: hermes-3-llama-70b │      │ Model: claude-sonnet-4-6  │      │ Model: gpt-5.3-codex      │
└─────────────┬─────────────┘      └─────────────┬─────────────┘      └─────────────┬─────────────┘
              │                                  │                                  │
              │ 1. coms_net_send(claude-worker)  │                                  │
              ├─────────────────────────────────►│                                  │
              │ 2. coms_net_await(...)           │ 3. Inbound turn executes         │
              │    [waiting]                     │    4. coms_net_send(codex-worker)│
              │                                  ├─────────────────────────────────►│
              │                                  │ 5. coms_net_await(...)           │ 6. Inbound turn executes
              │                                  │    [waiting]                     │    generates code
              │                                  │ 7. Result delivered              │ 7. POST /response
              │                                  │◄─────────────────────────────────┤
              │ 8. Review complete               │                                  │
              │◄─────────────────────────────────┤                                  │
              ▼                                                                     │
       Synthesize outcome                                                           │
```

---

## Security & Anti-Looping Discipline

### POSIX Mode 0600 Security Enforcement
To protect hub authentication tokens, `poly-coms-net` enforces strict filesystem security:
- `~/.pi/coms-net/projects/<project>/server.secret.json` must have exact permissions `0600` (`mode & 0o777 === 0o600`).
- World-readable (`0644`), executable (`0777`), group-writable (`0660`), or symbolic links are strictly rejected.

### Strict Anti-Looping Envelope & Hop Counter
When an agent receives an inbound task, the bridge prepends a standardized anti-looping envelope:
```text
[inbound coms-net message from sender @ /path]
[reply by writing a normal assistant message — your turn output is auto-returned to sender.
DO NOT call coms_net_send to reply; that creates a ping-pong loop.]
```
- **The Golden Rule**: The responder agent must reply using its regular assistant turn output. Calling `coms_net_send` creates a redundant message and triggers recursion.
- **Hop Ceiling**: Every message carries a `hops` counter incremented on each delegation. Messages reaching `MAX_HOPS = 5` are rejected with `HopLimitExceededError`.

### Credential Redaction & Error Masking Protection
- Sensitive tokens (`Bearer <token>`, `sk-...`, secret hashes) are automatically redacted from all error messages, console logs, and stack traces.
- Subprocess exit codes and stdio errors (e.g. `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) are never masked as successful turns.

---

## Testing

The project includes an extensive automated test suite covering unit tests, adversarial stress tests, mock hub integration, and multi-harness end-to-end pipelines.

### Running the Test Suite

Run the full suite using native Node.js 22 test runner:
```bash
npm test
```

Current test status:
```text
ℹ tests 488
ℹ suites 103
ℹ pass 488
ℹ fail 0
```

### Granular Test Suites

```bash
# Hermetic unit tests (executors, protocol client, discovery, render, lifecycle)
npm run test:unit

# Mock hub integration tests (bridge daemon, SSE connection)
npm run test:integration

# Adversarial & stress tests (maxBuffer exhaustion, race settlement, reconnection)
npm run test:adversarial

# End-to-end multi-harness poly tests (feature coverage, multi-agent workflows)
npm run test:e2e

# Build and packaging integrity verification
npm run test:build
```

### Build Verification & Type Checking

```bash
# Full TypeScript build to dist/
npm run build

# Typecheck TypeScript source without emitting files
npm run typecheck

# Validate Antigravity plugin manifest
npm run validate:plugin
```

---

## Documentation

- [**Architecture Guide**](docs/architecture.md) — Detailed breakdown of the zero-dependency native Node 22 architecture, SSE parser, subprocess orchestration, and stdio framing.
- [**Protocol Specification**](docs/protocol.md) — Comprehensive REST API contracts, SSE event specifications, Crockford Base32 ULID formatting, and anti-looping rules.
- [**Usage Guide & Tutorials**](docs/usage.md) — Step-by-step tutorials covering multi-agent setups, JSON Schema enforcement, multi-turn dialogues, and error recovery.

---

## Acknowledgments

`poly-coms-net` is built on the innovative multi-agent concepts and code originally developed by:
- **[IndyDevDan](https://github.com/disler)** — Creator of [pi-vs-claude-code](https://github.com/disler/pi-vs-claude-code), pioneering cross-agent hooks, damage-control patterns, and multi-agent mesh communication.
- **[Mario Zechner](https://github.com/badlogic)** — Creator of the [Pi Coding Agent](https://github.com/badlogic/pi-mono), whose RPC architecture and extension framework laid the foundation for agent mesh collaboration.

---

## License

Released under the [MIT License](LICENSE).

Copyright (c) 2026 IndyDevDan  
Copyright (c) 2026 Matt Thom and poly-coms-net contributors
