/**
 * tests/unit/turn-executor-codex.test.ts
 *
 * Hermetic unit tests for CodexTurnExecutor using temporary mock binaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CodexTurnExecutor,
  createTurnExecutor,
} from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("CodexTurnExecutor Hermetic Unit Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-"));

  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMCODEX00000000000000001",
    sender_session: "sender-session-codex",
    sender_name: "codex-peer",
    sender_project: "default",
    prompt: "Generate a rust struct for an event bus.",
    conversation_id: "codex-sess-999",
    hops: 0,
  };

  it("X1: should execute mock codex CLI and parse NDJSON stream output with usage", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-stream.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{"type":"session_start","session_id":"codex-sess-999"}
{"type":"thinking","text":"Analyzing request"}
{"type":"message","content":"pub struct EventBus { subscribers: Vec<Sender> }"}
{"type":"turn_complete","usage":{"prompt_tokens":350,"completion_tokens":120,"total_tokens":470}}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response, "pub struct EventBus { subscribers: Vec<Sender> }");
    assert.strictEqual(res.conversation_id, "codex-sess-999");
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 350);
    assert.strictEqual(res.usage.output_tokens, 120);
    assert.strictEqual(res.usage.total_tokens, 470);
  });

  it("X2: should verify command arguments include anti-loop prompt, sandbox, and git bypass flags", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-args.sh");
    const argsFile = path.join(tmpDir, "captured-codex-args.txt");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "$@" > "${argsFile}"
echo '{"response":"OK"}'
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "OK");

    const capturedArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(capturedArgs.includes("exec"));
    assert.ok(capturedArgs.includes("[inbound coms-net message from codex-peer @ ?]"));
    assert.ok(capturedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"));
    assert.ok(capturedArgs.includes("--sandbox danger-full-access"));
    assert.ok(capturedArgs.includes("--ephemeral"));
    assert.ok(capturedArgs.includes("--skip-git-repo-check"));
    assert.ok(capturedArgs.includes("--session codex-sess-999"));
  });

  it("X3: should support reading response from explicit output file (-o)", async () => {
    const outFile = path.join(tmpDir, "codex-custom-out.txt");
    const mockBin = path.join(tmpDir, "mock-codex-outfile.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Response written to output file." > "${outFile}"
echo "Progress logged to stdout."
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      outputFile: outFile,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Response written to output file.");
    assert.strictEqual(res.error, undefined);
  });

  it("X4: should fallback to plain text stdout when output is not structured JSON", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-plain.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Plain text reply from codex model."
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Plain text reply from codex model.");
  });

  it("X5: should handle timeout cleanly", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-sleep.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 100,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("timed out after 100ms"));
    assert.strictEqual(res.response, "");
  });

  it("X6: should handle missing binary (ENOENT)", async () => {
    const executor = new CodexTurnExecutor({
      binaryPath: path.join(tmpDir, "missing-codex-binary"),
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("not found on PATH"));
  });

  it("X7: should support schema validation on response", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-schema.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{"response":"{\\"items\\":[\\"a\\",\\"b\\"]}"}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, null);
    assert.deepStrictEqual(validated.payload, { items: ["a", "b"] });
  });

  it("X8: should create CodexTurnExecutor via factory", () => {
    const executor = createTurnExecutor({
      harness: "codex",
      model: "gpt-5.3-codex",
      cwd: tmpDir,
      timeoutMs: 12000,
    });

    assert.ok(executor instanceof CodexTurnExecutor);
  });

  it("X9: should normalize structured content array in NDJSON to string response", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-content-array.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
{"content": [{"type": "text", "text": "Structured content chunk"}]}
EOF
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(typeof res.response, "string");
    assert.strictEqual(res.response, "Structured content chunk");
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, "response not valid JSON");
  });

  it("X10: should report error on non-zero exit code with stdout error message", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-fatal-exit.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "Fatal error: invalid API authentication key"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("Fatal error: invalid API authentication key"));
  });

  it("X11: should handle ERR_CHILD_PROCESS_STDIO_MAXBUFFER cleanly without masking failure", async () => {
    const mockBin = path.join(tmpDir, "mock-codex-flood.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
python3 -c "print('X' * (25 * 1024 * 1024))"
`,
      { mode: 0o755 }
    );

    const executor = new CodexTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error !== undefined && res.error.length > 0);
    assert.ok(res.error.includes("maximum buffer limit"));
  });
});
