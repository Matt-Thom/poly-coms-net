# Coms-Net Multi-Agent Collaboration Rules for Claude Code

You are participating in the **coms-net multi-agent mesh network**, enabling collaboration between Claude Code, Antigravity agents, Hermes agents, and specialized automated workers across projects.

Follow these rules when interacting with peer agents or responding to inbound network messages.

---

## 1. Peer Discovery & Agent Selection

1. **Discover Peers Before Dispatching**: Always invoke `mcp__coms_net__coms_net_list` (or `coms_net_list`) before delegating tasks or sending inquiries. Do not guess or assume agent names or availability.
2. **Examine Metadata**: Review peer metadata returned by `coms_net_list`:
   - `name`: The unique agent identifier within the project namespace.
   - `purpose`: The specialized capability, expertise, or role of the agent.
   - `model`: The underlying LLM powering the agent (e.g. `claude-sonnet-4-6`, `hermes-3-llama-3.1-70b`).
   - `status`: Only delegate tasks to agents with `status: "online"`. Avoid targeting agents marked `stale` or `offline`.
3. **Task Matching**: Route subtasks to agents whose declared `purpose` and model capabilities best match the workload (e.g. route code reviews to review specialists, deep search to research agents).

---

## 2. Outbound Task Delegation (`coms_net_send` & `coms_net_await`)

1. **Self-Contained Prompts**: Provide complete, clear context in the `prompt` parameter of `mcp__coms_net__coms_net_send`. Peer agents run in separate process spaces or remote environments; they do not share your in-memory conversation history or temporary variables unless explicitly provided. Include:
   - Specific objectives and constraints.
   - File paths (use absolute or repository-relative paths).
   - Relevant code snippets or error logs.
   - Expected output format.
2. **Structured Outputs**: When you require programmatic results (e.g. JSON test matrices, lint findings), supply a valid JSON Schema in `response_schema`.
3. **Response Retrieval Workflow**:
   - **Primary (Blocking)**: Call `mcp__coms_net__coms_net_await(msg_id, timeout_ms)` immediately after sending to wait for the responder's result. Use a reasonable timeout (e.g., 60,000 ms to 180,000 ms depending on task complexity).
   - **Secondary (Polling)**: Use `mcp__coms_net__coms_net_get(msg_id)` only if you need to perform local computing or filesystem modifications while the peer works concurrently.
4. **Stateful Dialogues**: When engaging in multi-turn exchanges with the same peer, preserve and reuse the returned or initial `conversation_id`.

---

## 3. STRICT ANTI-LOOPING RULES (CRITICAL PROTOCOL INVARIANT)

Failure to observe anti-looping rules will trigger recursive agent execution loops, quota exhaustion, and message cascading failure across the network.

1. **NEVER Call `coms_net_send` to Reply to Inbound Messages**:
   - When an inbound prompt is delivered to you, it will be prefixed with:
     `[inbound coms-net message from <sender_name> @ <sender_cwd>]`
     `[reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>...]`
   - You are the **RESPONDER**, not the initiator.
   - **Formulate your answer directly in your assistant message text.** The bridge turn executor automatically captures your final turn output and submits it back to the hub.
   - Calling `coms_net_send` in response to an inbound prompt initiates a **NEW, SEPARATE outbound message**, triggering an infinite ping-pong loop between agents.
2. **DO NOT Await or Poll Inbound Message IDs**:
   - The `msg_id` referenced in an inbound prompt belongs to the *sender's* outbound message record.
   - Calling `coms_net_await` or `coms_net_get` on an inbound `msg_id` will deadlock or fail.
3. **Hop Limit Awareness**:
   - The coms-net mesh strictly enforces a maximum hop limit of 5 (`MAX_HOPS = 5`).
   - If an agent delegates a sub-subtask, `hops` is incremented. At `hops >= 5`, message dispatch is aborted with `HopLimitExceededError`.
   - Never chain message delegations indefinitely.

---

## 4. MCP Tools Reference

When running Claude Code connected to coms-net MCP:
- `mcp__coms_net__coms_net_list`: List active peer agents in the project namespace.
- `mcp__coms_net__coms_net_send`: Dispatch outbound task or prompt to a peer agent.
- `mcp__coms_net__coms_net_get`: Poll the status and response of a dispatched message.
- `mcp__coms_net__coms_net_await`: Long-poll / block until the recipient agent replies.

---

## 5. Headless Worker Mode

When acting as an autonomous bridge worker, Claude Code is invoked via:
```bash
claude -p "<prompt>" --output-format json --dangerously-skip-permissions
```
In this mode, standard output is parsed for response text and token usage metrics by `ClaudeCodeTurnExecutor`.
