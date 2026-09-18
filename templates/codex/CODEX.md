# Coms-Net Mesh Participation Guidelines for OpenAI Codex

You are operating as a node in the **coms-net multi-agent mesh network**, connecting OpenAI Codex with peer agents and automated bridge workers.

---

## 1. Role & Execution Modes

OpenAI Codex participates in coms-net in two modes:
1. **Interactive Delegator**: Using stdio MCP tools (`mcp.json` / `config.toml`) to query active peers, dispatch subtasks, and await results.
2. **Autonomous Bridge Worker**: Spawned by `coms-net-bridge --harness codex` using non-interactive execution:
   ```bash
   codex exec "<prompt>" --sandbox workspace-write --ask-for-approval never --skip-git-repo-check
   ```

---

## 2. Peer Discovery & Task Delegation

When delegating tasks across the mesh:
1. **Discover Active Peers**: Call `coms_net_list` to find online peers, their roles, models, and session IDs.
2. **Dispatch Prompt**: Call `coms_net_send` with clear context, file paths, and optional `response_schema`.
3. **Await Response**: Call `coms_net_await` with the returned `msg_id` and an appropriate timeout.
4. **Conversation Continuity**: Pass `conversation_id` on follow-up messages to maintain dialogue context.

---

## 3. STRICT ANTI-LOOPING RULES (CRITICAL PROTOCOL INVARIANT)

Failure to observe anti-looping rules causes infinite agent-to-agent delegation ping-pong.

1. **NEVER Call `coms_net_send` to Reply to Inbound Messages**:
   - Inbound tasks will arrive prefixed with:
     `[inbound coms-net message from <sender_name> @ <sender_cwd>]`
     `[reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>...]`
   - You are the **RESPONDER**.
   - Output your answer directly in your stdout / turn response text.
   - Calling `coms_net_send` initiates a brand-new message instead of replying, creating a cycle.
2. **DO NOT Await or Poll Inbound Message IDs**:
   - The `msg_id` belongs to the sender's outbound record; polling it will deadlock.
3. **Hop Limit**: Maximum hop depth is 5 (`MAX_HOPS = 5`). Dispatches exceeding this limit will fail.

---

## 4. MCP Tools Summary

- `coms_net_list`: Enumerate active mesh agents in the current project namespace.
- `coms_net_send`: Send an outbound task to an agent by session ID or name.
- `coms_net_get`: Check message status and retrieve response if completed.
- `coms_net_await`: Block until the target agent responds or timeout expires.
