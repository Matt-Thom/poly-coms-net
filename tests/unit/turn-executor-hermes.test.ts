/**
 * tests/unit/turn-executor-hermes.test.ts
 *
 * Hermetic unit tests for HermesTurnExecutor using temporary mock binaries.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HermesTurnExecutor,
  createTurnExecutor,
} from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("HermesTurnExecutor Hermetic Unit Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-test-"));

  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMHERMES00000000000000001",
    sender_session: "sender-session-hermes",
    sender_name: "hermes-peer",
    sender_project: "default",
    prompt: "Coordinate distributed training across peers.",
    conversation_id: "hermes-conv-555",
    hops: 0,
  };

  it("H1: should execute mock hermes -z, parse usage report file, and unlink temp file", async () => {
    const mockBin = path.join(tmpDir, "mock-hermes-success.sh");
    // Mock script parses --usage-file and writes JSON report, then emits stdout
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
usage_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --usage-file)
      usage_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -n "$usage_file" ]; then
  cat << 'EOF' > "$usage_file"
{
  "input_tokens": 1240,
  "output_tokens": 310,
  "total_tokens": 1550,
  "estimated_cost": 0.002,
  "model": "hermes-3-llama-3.1-70b"
}
EOF
fi

echo "Hermes agent turn complete: task planned."
`,
      { mode: 0o755 }
    );

    const executor = new HermesTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.error, undefined);
    assert.strictEqual(res.response, "Hermes agent turn complete: task planned.");
    assert.strictEqual(res.conversation_id, "hermes-conv-555");
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 1240);
    assert.strictEqual(res.usage.output_tokens, 310);
    assert.strictEqual(res.usage.total_tokens, 1550);

    // Verify temp usage file was cleaned up from os.tmpdir()
    const matchingFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`hermes-usage-${sampleEvent.msg_id}`));
    assert.strictEqual(matchingFiles.length, 0, "Usage file should be cleaned up in finally block");
  });

  it("H2: should verify command arguments include -z, anti-loop envelope, --accept-hooks, --yolo, --in, --resume", async () => {
    const mockBin = path.join(tmpDir, "mock-hermes-args.sh");
    const argsFile = path.join(tmpDir, "captured-hermes-args.txt");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
echo "$@" > "${argsFile}"
echo "Hermes response"
`,
      { mode: 0o755 }
    );

    const executor = new HermesTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      model: "hermes-3-llama-3.1-70b",
      provider: "nousresearch",
    });

    const res = await executor.execute(sampleEvent);
    assert.strictEqual(res.response, "Hermes response");

    const capturedArgs = fs.readFileSync(argsFile, "utf8");
    assert.ok(capturedArgs.includes("-z"));
    assert.ok(capturedArgs.includes("[inbound coms-net message from hermes-peer @ ?]"));
    assert.ok(capturedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"));
    assert.ok(capturedArgs.includes("--accept-hooks"));
    assert.ok(capturedArgs.includes("--yolo"));
    assert.ok(capturedArgs.includes(`--in ${tmpDir}`));
    assert.ok(capturedArgs.includes("--model hermes-3-llama-3.1-70b"));
    assert.ok(capturedArgs.includes("--provider nousresearch"));
    assert.ok(capturedArgs.includes("--resume hermes-conv-555"));
  });

  it("H3: should extract usage file even when execution exits with non-zero code", async () => {
    const mockBin = path.join(tmpDir, "mock-hermes-err.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
usage_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --usage-file)
      usage_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ -n "$usage_file" ]; then
  cat << 'EOF' > "$usage_file"
{
  "token_counts": {
    "prompt": 500,
    "completion": 50,
    "total": 550
  }
}
EOF
fi

>&2 echo "Execution halted: tool invocation failed"
exit 1
`,
      { mode: 0o755 }
    );

    const executor = new HermesTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("Execution halted: tool invocation failed"));
    assert.ok(res.usage);
    assert.strictEqual(res.usage.input_tokens, 500);
    assert.strictEqual(res.usage.output_tokens, 50);
    assert.strictEqual(res.usage.total_tokens, 550);
  });

  it("H4: should handle timeout cleanly and clean up temp usage file", async () => {
    const mockBin = path.join(tmpDir, "mock-hermes-sleep.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new HermesTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
      timeoutMs: 100,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("timed out after 100ms"));
    assert.strictEqual(res.response, "");

    const matchingFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`hermes-usage-${sampleEvent.msg_id}`));
    assert.strictEqual(matchingFiles.length, 0);
  });

  it("H5: should handle missing binary (ENOENT)", async () => {
    const executor = new HermesTurnExecutor({
      binaryPath: path.join(tmpDir, "missing-hermes-bin"),
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    assert.ok(res.error?.includes("not found on PATH"));
  });

  it("H6: should support schema validation on Hermes output", async () => {
    const mockBin = path.join(tmpDir, "mock-hermes-schema.sh");
    fs.writeFileSync(
      mockBin,
      `#!/bin/bash
cat << 'EOF'
\`\`\`json
{
  "tasks": ["peer_discovery", "work_partitioning"],
  "ready": true
}
\`\`\`
EOF
`,
      { mode: 0o755 }
    );

    const executor = new HermesTurnExecutor({
      binaryPath: mockBin,
      cwd: tmpDir,
    });

    const res = await executor.execute(sampleEvent);
    const validated = validateResponseSchema(res.response, { type: "object" });
    assert.strictEqual(validated.error, null);
    assert.deepStrictEqual(validated.payload, {
      tasks: ["peer_discovery", "work_partitioning"],
      ready: true,
    });
  });

  it("H7: should create HermesTurnExecutor via factory", () => {
    const executor = createTurnExecutor({
      harness: "hermes",
      model: "hermes-3-llama-3.1-70b",
      cwd: tmpDir,
      provider: "nousresearch",
    });

    assert.ok(executor instanceof HermesTurnExecutor);
  });
});
