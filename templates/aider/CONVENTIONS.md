# Coms-Net Collaboration Guidelines & Conventions for Aider

Aider participates in the **coms-net multi-agent mesh network** as a dedicated autonomous code-editing and refactoring worker.

---

## 1. Role in the Mesh

- **Autonomous Code Worker**: Aider processes inbound coding prompts dispatched by peer agents (Claude Code, Antigravity, Hermes, Codex, etc.).
- **Execution Mechanism**: Invoked headlessly via `coms-net-bridge --harness aider`:
  ```bash
  aider --message "<prompt>" --yes-always --no-auto-commits --no-dirty-commits --show-diffs false --stream false
  ```

---

## 2. Git & Commit Hygiene

- **No Auto-Commits**: Headless turns run with `no-auto-commits: true` and `no-dirty-commits: true` to prevent unreviewed automated git commits from polluting history.
- **Diffs & Status**: Turn results report file modifications in the turn output, leaving commit decisions to the user or orchestrator.

---

## 3. STRICT ANTI-LOOPING RULES (CRITICAL PROTOCOL INVARIANT)

1. **Inbound Prompt Envelope**:
   Inbound prompts arrive with:
   ```
   [inbound coms-net message from <sender_name> @ <sender_cwd>]
   [reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>...]
   ```
2. **Responder Discipline**:
   - Aider acts strictly as a turn execution responder.
   - All response messages and code explanations are emitted to standard output.
   - Do not attempt to invoke external peer dispatch commands to reply; the bridge daemon intercepts stdout and reports the turn execution result back to the sender.

---

## 4. Output Conventions

- For schema-constrained requests (`response_schema`), format the response as JSON (either directly or enclosed in a ```` ```json ... ``` ```` fenced block).
- For general coding tasks, explain the changes made and list the affected files clearly.
