/**
 * tests/unit/turn-executor-aider.test.ts
 *
 * Hermetic unit tests for AiderTurnExecutor using temporary mock binaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  AiderTurnExecutor,
  createTurnExecutor,
} from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("AiderTurnExecutor Hermetic Unit Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aider-test-"));

  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMAIDER00000000000000001",
    sender_session: "sender-session-aider",
    sender_name: "aider-peer",
    sender_project: "default",
    prompt: "Refactor database connection pool.",
    hops: 0,
  };

  it("D1: should execute mock aider CLI and parse response text and token metrics from stderr", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-success.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
>&2 echo "Aider v0.60.0"
>&2 echo "Model: claude-3-7-sonnet with diff edit format"
echo "Refactoring completed: Pooled connection limit set to 20."
>&2 echo "Tokens: 1.2k sent, 350 received. Cost: $0.01 message, $0.01 session."
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response, "Refactoring completed: Pooled connection limit set to 20.");
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 1200);
    assert.strictEqual(res.usage.output_tokens, 350);
    assert.strictEqual(res.usage.total_tokens, 1550);
  });

  it("D2: should verify command arguments include anti-loop envelope, --yes, --no-auto-commits, --no-stream, --no-git", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-args.sh");
    const argsFile = path.join(tmpDir, "captured-aider-args.txt");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "$@" > "${argsFile}"
echo "Changes applied."
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Changes applied.");

    const capturedArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(capturedArgs.includes("--message"));
    assert.ok(capturedArgs.includes("[inbound coms-net message from aider-peer @ ?]"));
    assert.ok(capturedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"));
    assert.ok(capturedArgs.includes("--yes"));
    assert.ok(capturedArgs.includes("--no-auto-commits"));
    assert.ok(capturedArgs.includes("--no-stream"));
    assert.ok(capturedArgs.includes("--no-git"));
  });

  it("D3: should parse comma-formatted token numbers from stderr", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-tokens.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Done."
>&2 echo "Tokens: 2,450 sent, 890 received."
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Done.");
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 2450);
    assert.strictEqual(res.usage.output_tokens, 890);
    assert.strictEqual(res.usage.total_tokens, 3340);
  });

  it("D4: should handle error and redact sensitive tokens", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-err.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
>&2 echo "Error: Invalid API Key Bearer secret_live_token_12345"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "");
    assert.ok(res.error?.includes("<redacted>"));
    assert.ok(!res.error?.includes("secret_live_token_12345"));
  });

  it("D5: should handle timeout cleanly", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-sleep.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 100,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("timed out after 100ms"));
    assert.strictEqual(res.response, "");
  });

  it("D6: should handle missing binary (ENOENT)", async () => {
    const executor = new AiderTurnExecutor({
      binaryPath: path.join(tmpDir, "non-existent-aider"),
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("not found on PATH"));
  });

  it("D7: should support schema validation on fenced code block response", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-fence.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
I refactored the module. Here is the manifest:
\`\`\`json
{
  "files_changed": ["src/db.ts"],
  "tests_passed": true
}
\`\`\`
All done!
EOF
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, null);
    assert.deepStrictEqual(validated.payload, {
      files_changed: ["src/db.ts"],
      tests_passed: true,
    });
  });

  it("D8: should create AiderTurnExecutor via factory", () => {
    const executor = createTurnExecutor({
      harness: "aider",
      model: "claude-3-7-sonnet",
      cwd: tmpDir,
    });

    assert.ok(executor instanceof AiderTurnExecutor);
  });

  it("D9: should normalize chat message object in JSON to string response", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-chat-msg.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{"message": {"role": "assistant", "content": "Assistant answer text"}}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(typeof res.response, "string");
    assert.strictEqual(res.response, "Assistant answer text");
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, "response not valid JSON");
  });

  it("D10: should report error on non-zero exit code with stdout error message", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-fatal-exit.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Fatal error: git lock exists"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("Fatal error: git lock exists"));
  });

  it("D11: should handle ERR_CHILD_PROCESS_STDIO_MAXBUFFER cleanly without masking failure", async () => {
    const mockBin = path.join(tmpDir, "mock-aider-flood.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
python3 -c "print('X' * (25 * 1024 * 1024))"
`,
      { mode: 0o755 }
    );

    const executor = new AiderTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("maximum buffer limit"));
  });
});
