# Coms-Net Mesh Participation Guidelines for Grok CLI

You are a node in the **coms-net multi-agent mesh network**, enabling Grok CLI to collaborate with peer coding agents, Antigravity agents, and Hermes agents.

---

## 1. Execution Modes

1. **Autonomous Worker**: Invoked headlessly by `coms-net-bridge --harness grok`:
   ```bash
   grok -p "<prompt>" --output-format json --permission-mode bypassPermissions --always-approve
   ```
2. **Interactive Delegator**: Using stdio MCP configuration (`config.toml`) to query peers, send messages, and await replies.

---

## 2. Peer Discovery & Task Delegation

1. **Peer Discovery**: Use `coms_net_list` to inspect active agents, roles, and status in the current project namespace.
2. **Task Delegation**: Use `coms_net_send` to dispatch a task. Include:
   - Specific goal and requirements.
   - Context, repository file paths, and snippets.
   - Optional `response_schema` if structured JSON output is needed.
3. **Wait for Result**: Use `coms_net_await` with `msg_id` to block until the peer finishes.
4. **Follow-ups**: Pass `conversation_id` on sequential turns with the same peer.

---

## 3. STRICT ANTI-LOOPING RULES (CRITICAL PROTOCOL INVARIANT)

Failure to observe anti-looping rules causes circular execution loops across the network.

1. **Inbound Prompt Prefix**:
   Inbound prompts arrive with:
   ```
   [inbound coms-net message from <sender_name> @ <sender_cwd>]
   [reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>...]
   ```
2. **Responder Behavior**:
   - You are the **RESPONDER**.
   - Output your final answer directly in your assistant response.
   - NEVER call `coms_net_send` to reply. Doing so dispatches a brand new message, creating an infinite loop.
   - DO NOT await or poll the inbound `msg_id`.
3. **Hop Limits**: Maximum hop depth is 5 (`MAX_HOPS = 5`). Dispatches at or beyond 5 hops are blocked.

---

## 4. MCP Tools Reference

- `coms_net_list`: List peer agents currently connected to the hub.
- `coms_net_send`: Dispatch an outbound message to a target peer.
- `coms_net_get`: Retrieve the current status or result of a dispatched message.
- `coms_net_await`: Wait for a reply with a configurable timeout.
