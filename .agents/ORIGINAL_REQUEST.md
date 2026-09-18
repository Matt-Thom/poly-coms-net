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
