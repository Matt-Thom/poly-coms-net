/**
 * tests/unit/turn-executor-claude.test.ts
 *
 * Hermetic unit tests for ClaudeCodeTurnExecutor using temporary mock binaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ClaudeCodeTurnExecutor,
  createTurnExecutor,
} from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("ClaudeCodeTurnExecutor Hermetic Unit Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));

  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMCLAUDE0000000000000001",
    sender_session: "sender-session-123",
    sender_name: "test-peer",
    sender_project: "default",
    prompt: "Please analyze the algorithm efficiency.",
    conversation_id: "claude-conv-abc",
    hops: 0,
  };

  it("C1: should execute mock claude CLI and parse JSON output with usage and duration", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-success.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "session_id": "claude-conv-abc",
  "result": "Algorithm efficiency analysis complete: O(n log n).",
  "status": "SUCCESS",
  "duration_ms": 1500,
  "usage": {
    "input_tokens": 800,
    "output_tokens": 250,
    "thinking_tokens": 50,
    "cache_read_tokens": 120,
    "total_tokens": 1050
  }
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response, "Algorithm efficiency analysis complete: O(n log n).");
    assert.strictEqual(res.conversation_id, "claude-conv-abc");
    assert.strictEqual(res.duration_seconds, 1.5);
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 800);
    assert.strictEqual(res.usage.output_tokens, 250);
    assert.strictEqual(res.usage.thinking_tokens, 50);
    assert.strictEqual(res.usage.cache_read_tokens, 120);
    assert.strictEqual(res.usage.total_tokens, 1050);
  });

  it("C2: should verify inbound prompt envelope contains anti-looping instructions", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-args.sh");
    const argsFile = path.join(tmpDir, "captured-args.txt");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "$@" > "${argsFile}"
cat << 'EOF'
{
  "result": "Envelope verified"
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Envelope verified");

    const capturedArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(capturedArgs.includes("[inbound coms-net message from test-peer @ ?]"));
    assert.ok(capturedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"));
    assert.ok(capturedArgs.includes("01JMCLAUDE0000000000000001"));
    assert.ok(capturedArgs.includes("--output-format json"));
    assert.ok(capturedArgs.includes("--dangerously-skip-permissions"));
    assert.ok(capturedArgs.includes("--resume claude-conv-abc"));
  });

  it("C3: should tolerate non-JSON stdout noise and extract embedded JSON block", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-noise.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "[DEBUG] Authenticating with Anthropic API..."
echo "[INFO] Session resumed: claude-conv-abc"
cat << 'EOF'
{
  "response": "Clean response surrounded by logs.",
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50
  }
}
EOF
echo "[DEBUG] Cleanup completed."
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Clean response surrounded by logs.");
    assert.strictEqual(res.usage?.input_tokens, 100);
    assert.strictEqual(res.usage?.output_tokens, 50);
    assert.strictEqual(res.usage?.total_tokens, 150);
  });

  it("C4: should extract error status when Claude CLI returns non-success or error", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-error.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "status": "RATE_LIMITED",
  "error": "Exceeded 50 requests per minute",
  "response": ""
}
EOF
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, "Exceeded 50 requests per minute");
  });

  it("C5: should handle timeout cleanly when process hangs", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-timeout.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 100,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("timed out after 100ms"));
    assert.strictEqual(res.response, "");
  });

  it("C6: should handle missing binary (ENOENT) gracefully", async () => {
    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: path.join(tmpDir, "non-existent-claude-binary"),
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("not found on PATH"));
    assert.strictEqual(res.response, "");
  });

  it("C7: should allow response to be schema-validated via validateResponseSchema", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-schema.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "result": "{\\"status\\":\\"SUCCESS\\",\\"score\\":95}",
  "usage": { "total_tokens": 120 }
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);

    const validated = validateResponseSchema(res.response, {
      type: "object",
      properties: { score: { type: "number" } },
    });
    assert.strictEqual(validated.error, null);
    assert.deepStrictEqual(validated.payload, { status: "SUCCESS", score: 95 });
  });

  it("C8: should create ClaudeCodeTurnExecutor via createTurnExecutor factory", () => {
    const executor = createTurnExecutor({
      harness: "claude",
      model: "claude-sonnet-4-6",
      cwd: tmpDir,
      timeoutMs: 10000,
      permissionMode: "bypassPermissions",
    });

    assert.ok(executor instanceof ClaudeCodeTurnExecutor);
  });

  it("C9: should normalize structured response array to string", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-result-array.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{
  "status": "SUCCESS",
  "result": [{"text": "Parsed block"}]
}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(typeof res.response, "string");
    assert.strictEqual(res.response, "Parsed block");
  });

  it("C10: should report error on non-zero exit code with plain text stdout", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-fatal-exit.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Fatal error: claude auth failed"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("Fatal error: claude auth failed"));
  });

  it("C11: should handle ERR_CHILD_PROCESS_STDIO_MAXBUFFER cleanly without masking failure", async () => {
    const mockBin = path.join(tmpDir, "mock-claude-flood.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
python3 -c "print('X' * (25 * 1024 * 1024))"
`,
      { mode: 0o755 }
    );

    const executor = new ClaudeCodeTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("maximum buffer limit"));
  });
});
