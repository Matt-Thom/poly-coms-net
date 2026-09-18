/**
 * tests/unit/turn-executor-grok.test.ts
 *
 * Hermetic unit tests for GrokTurnExecutor using temporary mock binaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  GrokTurnExecutor,
  createTurnExecutor,
} from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("GrokTurnExecutor Hermetic Unit Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-test-"));

  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMGROK000000000000000001",
    sender_session: "sender-session-grok",
    sender_name: "grok-peer",
    sender_project: "default",
    prompt: "Optimize this SQL query.",
    conversation_id: "grok-conv-777",
    hops: 0,
  };

  it("G1: should execute mock grok CLI and parse JSON output with usage and duration", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-success.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "conversation_id": "grok-conv-777",
  "response": "Optimized SQL with indexed CTE.",
  "status": "SUCCESS",
  "duration_seconds": 0.85,
  "usage": {
    "input_tokens": 540,
    "output_tokens": 160,
    "thinking_tokens": 40,
    "total_tokens": 700
  }
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response, "Optimized SQL with indexed CTE.");
    assert.strictEqual(res.conversation_id, "grok-conv-777");
    assert.strictEqual(res.duration_seconds, 0.85);
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 540);
    assert.strictEqual(res.usage.output_tokens, 160);
    assert.strictEqual(res.usage.thinking_tokens, 40);
    assert.strictEqual(res.usage.total_tokens, 700);
  });

  it("G2: should verify command arguments include anti-loop envelope, --always-approve, and --permission-mode bypassPermissions", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-args.sh");
    const argsFile = path.join(tmpDir, "captured-grok-args.txt");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "$@" > "${argsFile}"
cat << 'EOF'
{
  "response": "Arguments verified"
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Arguments verified");

    const capturedArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(capturedArgs.includes("-p"));
    assert.ok(capturedArgs.includes("[inbound coms-net message from grok-peer @ ?]"));
    assert.ok(capturedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"));
    assert.ok(capturedArgs.includes("--output-format json"));
    assert.ok(capturedArgs.includes("--always-approve"));
    assert.ok(capturedArgs.includes("--permission-mode bypassPermissions"));
    assert.ok(capturedArgs.includes("--resume grok-conv-777"));
  });

  it("G3: should extract JSON even if stdout contains surrounding non-JSON noise", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-noise.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "[grok-cli] Initializing engine..."
cat << 'EOF'
{
  "response": "Clean grok output.",
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  }
}
EOF
echo "[grok-cli] Shutdown complete."
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Clean grok output.");
    assert.strictEqual(res.usage?.input_tokens, 100);
    assert.strictEqual(res.usage?.output_tokens, 50);
    assert.strictEqual(res.usage?.total_tokens, 150);
  });

  it("G4: should extract error when Grok returns non-success status", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-err.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "status": "FAILED",
  "error": "Context window exceeded 131072 tokens",
  "response": ""
}
EOF
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, "Context window exceeded 131072 tokens");
  });

  it("G5: should handle timeout cleanly", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-sleep.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 100,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("timed out after 100ms"));
    assert.strictEqual(res.response, "");
  });

  it("G6: should handle missing binary (ENOENT)", async () => {
    const executor = new GrokTurnExecutor({
      binaryPath: path.join(tmpDir, "non-existent-grok"),
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("not found on PATH"));
  });

  it("G7: should support schema validation on JSON string response", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-schema.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "response": "{\\"optimized\\":true,\\"index_name\\":\\"idx_users_email\\"}"
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, null);
    assert.deepStrictEqual(validated.payload, {
      optimized: true,
      index_name: "idx_users_email",
    });
  });

  it("G8: should create GrokTurnExecutor via factory", () => {
    const executor = createTurnExecutor({
      harness: "grok",
      model: "grok-4.6",
      cwd: tmpDir,
    });

    assert.ok(executor instanceof GrokTurnExecutor);
  });

  it("G9: should normalize chat message object in JSON to string response", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-chat-msg.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{"message": {"role": "assistant", "content": "Assistant answer text"}}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(typeof res.response, "string");
    assert.strictEqual(res.response, "Assistant answer text");
  });

  it("G10: should report error on non-zero exit code with stdout error message", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-fatal-exit.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Fatal error: grok auth failed"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("Fatal error: grok auth failed"));
  });

  it("G11: should handle ERR_CHILD_PROCESS_STDIO_MAXBUFFER cleanly without masking failure", async () => {
    const mockBin = path.join(tmpDir, "mock-grok-flood.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
python3 -c "print('X' * (25 * 1024 * 1024))"
`,
      { mode: 0o755 }
    );

    const executor = new GrokTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("maximum buffer limit"));
  });
});
