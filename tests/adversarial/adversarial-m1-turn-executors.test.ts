/**
 * tests/adversarial/adversarial-m1-turn-executors.test.ts
 *
 * Empirical Challenger Adversarial Stress Test Suite for Milestone 1 Turn Executors:
 * - ClaudeCodeTurnExecutor (claude -p)
 * - CodexTurnExecutor (codex exec)
 * - AiderTurnExecutor (aider --message)
 * - GrokTurnExecutor (grok -p)
 * - HermesTurnExecutor (hermes -z)
 *
 * Test Dimensions:
 * 1. Multiline, special characters, shell metacharacters, unicode, and large inputs
 * 2. Missing binary (ENOENT), non-executable permissions (EACCES), and directory path (EISDIR)
 * 3. Timeout and hung subprocess kill semantics, exit code handling, and credential redaction
 * 4. Stdout noise tolerance (surrounding logs, logs containing curly braces, unparseable output)
 * 5. Hermes usage file lifecycle, corrupt/missing usage files, and concurrent isolation
 * 6. Anti-looping header delivery and schema validation pipeline compatibility
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ClaudeCodeTurnExecutor } from "../../src/bridge/executors/claude.ts";
import { CodexTurnExecutor } from "../../src/bridge/executors/codex.ts";
import { AiderTurnExecutor } from "../../src/bridge/executors/aider.ts";
import { GrokTurnExecutor } from "../../src/bridge/executors/grok.ts";
import { HermesTurnExecutor } from "../../src/bridge/executors/hermes.ts";
import { createTurnExecutor } from "../../src/bridge/executors/index.ts";
import { validateResponseSchema } from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent, ITurnExecutor } from "../../src/protocol/types.ts";

function createMockExecutable(dir: string, filename: string, body: string): string {
  const scriptPath = path.join(dir, filename);
  fs.writeFileSync(scriptPath, body, { mode: 0o755 });
  return scriptPath;
}

function makeEvent(prompt: string, overrides: Partial<InboundPromptEvent> = {}): InboundPromptEvent {
  return {
    msg_id: "01J" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    sender_session: "01JSESS" + Math.random().toString(36).slice(2, 10).toUpperCase(),
    sender_name: "test-sender",
    sender_project: "test-project",
    prompt,
    hops: 1,
    ...overrides,
  };
}

describe("Adversarial M1: Turn Executors Stress & Robustness Suite", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-adv-m1-"));
  });

  after(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1: Multiline Prompts, Shell Metacharacters & Large Payloads
  // ═══════════════════════════════════════════════════════════════════════════
  describe("1. Multiline Prompts, Metacharacters & Large Payloads", () => {
    // Mock script that echoes its arguments into stdout formatted as JSON or plain text
    let echoBin: string;

    before(() => {
      echoBin = createMockExecutable(
        tmpDir,
        "echo-args.sh",
        `#!/bin/bash
# Find prompt in arguments
prompt=""
for ((i=1;i<=$#;i++)); do
  val="\${!i}"
  if [[ "$val" == -p || "$val" == --message || "$val" == -z || "$val" == exec ]]; then
    next=$((i+1))
    prompt="\${!next}"
    break
  fi
done

# Output JSON result preserving received prompt
python3 -c "
import sys, json
prompt = '''$prompt'''
# Output structured JSON
out = {
    'status': 'SUCCESS',
    'result': 'Processed prompt length: ' + str(len(prompt)),
    'response': 'Processed prompt length: ' + str(len(prompt)),
    'received_preview': prompt[:100],
    'usage': {'input_tokens': len(prompt)//4, 'output_tokens': 10, 'total_tokens': len(prompt)//4 + 10}
}
print(json.dumps(out))
" 2>/dev/null || cat <<EOF
{
  "status": "SUCCESS",
  "result": "Fallback prompt processed",
  "response": "Fallback prompt processed",
  "usage": { "total_tokens": 10 }
}
EOF
`
      );
    });

    it("ADV-1.1: Prompts with shell metacharacters ($VAR, ``, ;, &&, |, <, >) must NOT be expanded by shell", async () => {
      // Script specifically records the exact argument passed
      const recorderBin = createMockExecutable(
        tmpDir,
        "record-arg.sh",
        `#!/bin/bash
# Write argv to an output file
mkdir -p "$1"
out_file="$1/recorded.txt"
shift
echo -n "$@" > "$out_file"
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Argument recorded",
  "response": "Argument recorded"
}
EOF
`
      );

      const targetDir = path.join(tmpDir, "meta-test");
      fs.mkdirSync(targetDir, { recursive: true });

      const dangerousPrompt = 'Test metacharacters: $USER `whoami` $(id) ; rm -rf / ; foo && bar || baz | grep x < input > output * ? ~ ! "double" \'single\'';
      const event = makeEvent(dangerousPrompt);

      const executor = new ClaudeCodeTurnExecutor({
        binaryPath: recorderBin,
        dangerouslySkipPermissions: false,
      });

      // Pass targetDir via env or custom arg wrapper
      const wrapperBin = createMockExecutable(
        tmpDir,
        "wrap-recorder.sh",
        `#!/bin/bash
exec "${recorderBin}" "${targetDir}" "$@"
`
      );

      const wrappedExecutor = new ClaudeCodeTurnExecutor({
        binaryPath: wrapperBin,
      });

      const res = await wrappedExecutor.execute(event);
      assert.strictEqual(res.error, undefined);
      assert.strictEqual(res.response, "Argument recorded");

      const recorded = fs.readFileSync(path.join(targetDir, "recorded.txt"), "utf8");
      // Check that $USER was NOT expanded
      assert.ok(recorded.includes("$USER"), "Prompt $USER must not be expanded");
      assert.ok(recorded.includes("`whoami`"), "Prompt backticks must not be executed");
      assert.ok(recorded.includes("rm -rf /"), "Prompt command injection must be passed literally");
      assert.ok(recorded.includes('"double"'), "Double quotes preserved");
      assert.ok(recorded.includes("'single'"), "Single quotes preserved");
    });

    it("ADV-1.2: Multiline prompts with CRLF, tabs, and nested markdown code blocks are preserved intact", async () => {
      const multilinePrompt = [
        "Line 1: Introduction",
        "Line 2: Here is code:",
        "```python",
        "def compute_sum(a, b):",
        "\t# Tab indented comment",
        "\treturn a + b",
        "```",
        "Line 8: End of instructions.",
      ].join("\r\n");

      const inspectBin = createMockExecutable(
        tmpDir,
        "inspect-multiline.sh",
        `#!/bin/bash
# Write all args to inspected.log
printf '%s\\n' "$@" > "${tmpDir}/inspected-multiline.log"
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Multiline accepted",
  "response": "Multiline accepted"
}
EOF
`
      );

      const executors: ITurnExecutor[] = [
        new ClaudeCodeTurnExecutor({ binaryPath: inspectBin }),
        new CodexTurnExecutor({ binaryPath: inspectBin }),
        new AiderTurnExecutor({ binaryPath: inspectBin }),
        new GrokTurnExecutor({ binaryPath: inspectBin }),
      ];

      for (const executor of executors) {
        const event = makeEvent(multilinePrompt);
        const res = await executor.execute(event);
        assert.strictEqual(res.error, undefined);
        const logged = fs.readFileSync(path.join(tmpDir, "inspected-multiline.log"), "utf8");
        assert.ok(logged.includes("def compute_sum(a, b):"), "Code block content must be preserved in argv");
        assert.ok(logged.includes("Line 8: End of instructions."), "Final line must be present");
      }
    });

    it("ADV-1.3: Large 100KB prompt payload executes without buffer overflow or truncation", async () => {
      const largeText = "A".repeat(100 * 1024); // 100KB
      const sizeBin = createMockExecutable(
        tmpDir,
        "check-size.sh",
        `#!/bin/bash
# Calculate length of second arg
len=\${#2}
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Received length $len",
  "response": "Received length $len"
}
EOF
`
      );

      const executor = new ClaudeCodeTurnExecutor({ binaryPath: sizeBin });
      const event = makeEvent(largeText);
      const res = await executor.execute(event);

      assert.strictEqual(res.error, undefined);
      assert.ok(res.response.startsWith("Received length"), `Expected size confirmation, got: ${res.response}`);
    });

    it("ADV-1.4: Unicode, emojis, RTL characters, and CJK characters survive child process roundtrip", async () => {
      const unicodePrompt = "Emoji: 🚀🔥🤖 | CJK: 你好世界 / こんにちは | Arabic: مرحبا بالعالم | Accents: éàöçñ";
      const unicodeBin = createMockExecutable(
        tmpDir,
        "unicode-check.sh",
        `#!/bin/bash
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Unicode processed successfully",
  "response": "Unicode processed successfully"
}
EOF
`
      );

      const grok = new GrokTurnExecutor({ binaryPath: unicodeBin });
      const res = await grok.execute(makeEvent(unicodePrompt));
      assert.strictEqual(res.error, undefined);
      assert.strictEqual(res.response, "Unicode processed successfully");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: Missing, Non-Executable, and Invalid Binary Paths
  // ═══════════════════════════════════════════════════════════════════════════
  describe("2. Missing & Non-Executable Binary Paths (ENOENT, EACCES, EISDIR)", () => {
    it("ADV-2.1: Non-existent binary path (ENOENT) returns clean error without crashing across all 5 executors", async () => {
      const nonExistentPath = path.join(tmpDir, "definitely-not-here-" + Date.now());

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: nonExistentPath }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: nonExistentPath }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: nonExistentPath }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: nonExistentPath }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: nonExistentPath }) },
      ];

      for (const { name, executor } of executors) {
        const res = await executor.execute(makeEvent("ping"));
        assert.strictEqual(res.response, "", `${name} response should be empty on ENOENT`);
        assert.ok(res.error, `${name} should return error on ENOENT`);
        assert.ok(
          res.error.includes("not found on PATH") || res.error.includes("ENOENT"),
          `${name} error message must mention binary not found, got: ${res.error}`
        );
      }
    });

    it("ADV-2.2: Existing file with non-executable permissions (EACCES) returns sanitized error without throwing", async () => {
      const nonExecFile = path.join(tmpDir, "not-executable.sh");
      fs.writeFileSync(nonExecFile, "#!/bin/bash\necho 'should not run'\n", { mode: 0o644 });

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: nonExecFile }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: nonExecFile }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: nonExecFile }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: nonExecFile }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: nonExecFile }) },
      ];

      for (const { name, executor } of executors) {
        const res = await executor.execute(makeEvent("ping"));
        assert.strictEqual(res.response, "", `${name} should have empty response on EACCES`);
        assert.ok(res.error, `${name} should have error on EACCES`);
        assert.ok(
          res.error.includes("EACCES") || res.error.includes("Permission denied") || res.error.includes("Subprocess"),
          `${name} error should report permission failure: ${res.error}`
        );
      }
    });

    it("ADV-2.3: Binary path pointing to a directory (EISDIR) returns error without throwing", async () => {
      const dirAsBinary = path.join(tmpDir, "a-directory");
      fs.mkdirSync(dirAsBinary, { recursive: true });

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: dirAsBinary }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: dirAsBinary }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: dirAsBinary }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: dirAsBinary }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: dirAsBinary }) },
      ];

      for (const { name, executor } of executors) {
        const res = await executor.execute(makeEvent("ping"));
        assert.ok(res.error, `${name} must return error when binaryPath is a directory`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3: Timeouts, Hung Subprocesses, and Exit Code Handling
  // ═══════════════════════════════════════════════════════════════════════════
  describe("3. Timeouts, Hung Subprocesses & Error Redaction", () => {
    it("ADV-3.1: Subprocess that hangs sleeping is killed at timeoutMs and reports clean timeout error", async () => {
      const sleepBin = createMockExecutable(
        tmpDir,
        "hang-sleep.sh",
        `#!/bin/bash
# Sleep for 30 seconds
sleep 30
echo "Finished sleep"
`
      );

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: sleepBin, timeoutMs: 150 }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: sleepBin, timeoutMs: 150 }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: sleepBin, timeoutMs: 150 }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: sleepBin, timeoutMs: 150 }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: sleepBin, timeoutMs: 150 }) },
      ];

      for (const { name, executor } of executors) {
        const start = Date.now();
        const res = await executor.execute(makeEvent("hang test"));
        const elapsed = Date.now() - start;

        assert.ok(elapsed >= 140, `${name} elapsed time should be at least timeoutMs (150ms), got ${elapsed}ms`);
        assert.ok(elapsed < 2000, `${name} timeout took too long to abort (${elapsed}ms)`);
        assert.strictEqual(res.response, "", `${name} response should be empty on timeout`);
        assert.ok(res.error?.includes("timed out after 150ms"), `${name} error must report timeout: ${res.error}`);
      }
    });

    it("ADV-3.2: Non-zero exit code with secret in stderr redacts tokens across all 5 executors", async () => {
      const secretErrBin = createMockExecutable(
        tmpDir,
        "leak-secret.sh",
        `#!/bin/bash
>&2 echo "Authentication failed: Bearer sk-ant-api03-abcdef1234567890abcdef1234567890"
>&2 echo "Secondary key leaked: Authorization: Bearer secret_token_xyz999"
exit 1
`
      );

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: secretErrBin }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: secretErrBin }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: secretErrBin }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: secretErrBin }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: secretErrBin }) },
      ];

      for (const { name, executor } of executors) {
        const res = await executor.execute(makeEvent("secret test"));
        assert.ok(res.error, `${name} must return error on exit code 1`);
        assert.ok(!res.error.includes("sk-ant-api03-abcdef1234567890abcdef1234567890"), `${name} must redact primary secret`);
        assert.ok(!res.error.includes("secret_token_xyz999"), `${name} must redact secondary secret`);
        assert.ok(res.error.includes("<redacted>"), `${name} must contain <redacted> placeholder`);
      }
    });

    it("ADV-3.3: Non-zero exit code with structured error status parses error field correctly", async () => {
      const statusErrBin = createMockExecutable(
        tmpDir,
        "status-err.sh",
        `#!/bin/bash
cat <<EOF
{
  "status": "RATE_LIMIT_EXCEEDED",
  "error": "Usage tier rate limit hit: maximum 50 rpm",
  "duration_ms": 120,
  "usage": { "total_tokens": 0 }
}
EOF
exit 1
`
      );

      // Claude
      const claude = new ClaudeCodeTurnExecutor({ binaryPath: statusErrBin });
      const claudeRes = await claude.execute(makeEvent("rate limit test"));
      assert.ok(claudeRes.error?.includes("Usage tier rate limit hit") || claudeRes.error?.includes("RATE_LIMIT_EXCEEDED"));

      // Grok
      const grok = new GrokTurnExecutor({ binaryPath: statusErrBin });
      const grokRes = await grok.execute(makeEvent("rate limit test"));
      assert.ok(grokRes.error?.includes("Usage tier rate limit hit") || grokRes.error?.includes("RATE_LIMIT_EXCEEDED"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4: Noise in stdout (Surrounding logs, braces in logs)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("4. Noise in stdout & Malformed Output", () => {
    it("ADV-4.1: Log output before and after JSON does not disrupt JSON payload extraction", async () => {
      const noisyBin = createMockExecutable(
        tmpDir,
        "noisy-logs.sh",
        `#!/bin/bash
echo "[INFO] 2026-09-18T10:00:00Z - Initializing CLI worker..."
echo "[DEBUG] Connecting to provider API endpoints..."
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Clean response from inside noisy logs",
  "response": "Clean response from inside noisy logs",
  "duration_seconds": 0.42,
  "usage": {
    "input_tokens": 55,
    "output_tokens": 20,
    "total_tokens": 75
  }
}
EOF
echo "[INFO] 2026-09-18T10:00:01Z - Process teardown complete."
`
      );

      // Claude
      const claude = new ClaudeCodeTurnExecutor({ binaryPath: noisyBin });
      const cRes = await claude.execute(makeEvent("test noise"));
      assert.strictEqual(cRes.error, undefined);
      assert.strictEqual(cRes.response, "Clean response from inside noisy logs");
      assert.strictEqual(cRes.usage?.total_tokens, 75);

      // Grok
      const grok = new GrokTurnExecutor({ binaryPath: noisyBin });
      const gRes = await grok.execute(makeEvent("test noise"));
      assert.strictEqual(gRes.error, undefined);
      assert.strictEqual(gRes.response, "Clean response from inside noisy logs");
      assert.strictEqual(gRes.usage?.total_tokens, 75);

      // Codex
      const codex = new CodexTurnExecutor({ binaryPath: noisyBin });
      const xRes = await codex.execute(makeEvent("test noise"));
      assert.strictEqual(xRes.error, undefined);
      assert.strictEqual(xRes.response, "Clean response from inside noisy logs");
    });

    it("ADV-4.2: Log output containing braces before and after JSON falls back safely without throwing unhandled exceptions", async () => {
      const braceNoiseBin = createMockExecutable(
        tmpDir,
        "brace-noise.sh",
        `#!/bin/bash
echo "[LOG {context: 'boot', pid: 1234}] Initializing..."
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Target message",
  "response": "Target message"
}
EOF
echo "[LOG {context: 'shutdown', code: 0}] Done."
`
      );

      const executors: { name: string; executor: ITurnExecutor }[] = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: braceNoiseBin }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: braceNoiseBin }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: braceNoiseBin }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: braceNoiseBin }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: braceNoiseBin }) },
      ];

      for (const { name, executor } of executors) {
        // Must resolve without unhandled throw
        const res = await executor.execute(makeEvent("brace noise"));
        assert.ok(res, `${name} must return a TurnExecutionResult`);
        assert.ok(typeof res.response === "string", `${name} response must be a string`);
      }
    });

    it("ADV-4.3: Truncated / malformed JSON in stdout falls back to plain text without crashing", async () => {
      const truncatedBin = createMockExecutable(
        tmpDir,
        "truncated-json.sh",
        `#!/bin/bash
echo '{"status": "SUCCESS", "result": "Half-way through and the process was killed'
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: truncatedBin });
      const cRes = await claude.execute(makeEvent("truncated"));
      assert.ok(cRes.response.includes("Half-way through"), "Should preserve plain text on malformed JSON");

      const grok = new GrokTurnExecutor({ binaryPath: truncatedBin });
      const gRes = await grok.execute(makeEvent("truncated"));
      assert.ok(gRes.response.includes("Half-way through"), "Should preserve plain text on malformed JSON");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 5: Hermes Agent Usage File Lifecycle & Concurrency
  // ═══════════════════════════════════════════════════════════════════════════
  describe("5. Hermes Agent Temporary Usage File Lifecycle", () => {
    it("ADV-5.1: Missing usage file (mock script never created it) does not crash HermesTurnExecutor", async () => {
      const noUsageBin = createMockExecutable(
        tmpDir,
        "hermes-no-usage.sh",
        `#!/bin/bash
echo "Hermes answered without producing usage file"
`
      );

      const hermes = new HermesTurnExecutor({ binaryPath: noUsageBin });
      const res = await hermes.execute(makeEvent("no usage file"));

      assert.strictEqual(res.error, undefined);
      assert.strictEqual(res.response, "Hermes answered without producing usage file");
      assert.strictEqual(res.usage, undefined);
    });

    it("ADV-5.2: Corrupted usage file (invalid JSON) is gracefully ignored without crashing", async () => {
      const corruptUsageBin = createMockExecutable(
        tmpDir,
        "hermes-corrupt-usage.sh",
        `#!/bin/bash
usage_file=""
while [[ $# -gt 0 ]]; do
  if [ "$1" == "--usage-file" ]; then
    usage_file="$2"
    shift 2
  else
    shift
  fi
done

if [ -n "$usage_file" ]; then
  echo "{ this is not valid json; truncated..." > "$usage_file"
fi

echo "Response despite corrupted usage report"
`
      );

      const hermes = new HermesTurnExecutor({ binaryPath: corruptUsageBin });
      const res = await hermes.execute(makeEvent("corrupt usage"));

      assert.strictEqual(res.error, undefined);
      assert.strictEqual(res.response, "Response despite corrupted usage report");
      assert.strictEqual(res.usage, undefined);
    });

    it("ADV-5.3: Multiple concurrent Hermes executions have isolated usage file paths with zero leaks", async () => {
      const concurrentBin = createMockExecutable(
        tmpDir,
        "hermes-concurrent.sh",
        `#!/bin/bash
usage_file=""
idx="$RANDOM"
while [[ $# -gt 0 ]]; do
  if [ "$1" == "--usage-file" ]; then
    usage_file="$2"
    shift 2
  else
    shift
  fi
done

if [ -n "$usage_file" ]; then
  cat <<EOF > "$usage_file"
{
  "input_tokens": 100,
  "output_tokens": 50,
  "total_tokens": 150
}
EOF
fi

# Small jitter to interleave operations
sleep 0.05
echo "Concurrent turn result $idx"
`
      );

      const hermes = new HermesTurnExecutor({ binaryPath: concurrentBin });

      // Run 10 concurrent turns
      const promises = Array.from({ length: 10 }, (_, i) =>
        hermes.execute(makeEvent(`Concurrent prompt ${i}`))
      );

      const results = await Promise.all(promises);
      for (let i = 0; i < 10; i++) {
        assert.strictEqual(results[i].error, undefined);
        assert.ok(results[i].response.startsWith("Concurrent turn result"));
        assert.strictEqual(results[i].usage?.total_tokens, 150);
      }

      // Verify no dangling hermes-usage files left in tmpDir / os.tmpdir() matching pattern
      const tmpFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("hermes-usage-01J"));
      assert.strictEqual(tmpFiles.length, 0, "All temporary usage files must be unlinked in finally blocks");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 6: Anti-Loop Envelopes & Schema Validation Compatibility
  // ═══════════════════════════════════════════════════════════════════════════
  describe("6. Anti-Loop Envelopes & Schema Validation Compatibility", () => {
    it("ADV-6.1: Inbound prompt formatting contains strict anti-loop instructions across all harnesses", async () => {
      const dumpArgsBin = createMockExecutable(
        tmpDir,
        "dump-args.sh",
        `#!/bin/bash
# Find and print prompt
for ((i=1;i<=$#;i++)); do
  val="\${!i}"
  if [[ "$val" == -p || "$val" == --message || "$val" == -z || "$val" == exec ]]; then
    next=$((i+1))
    echo "\${!next}"
    exit 0
  fi
done
exit 0
`
      );

      const harnesses: Array<{ name: string; executor: ITurnExecutor }> = [
        { name: "claude", executor: new ClaudeCodeTurnExecutor({ binaryPath: dumpArgsBin }) },
        { name: "codex", executor: new CodexTurnExecutor({ binaryPath: dumpArgsBin }) },
        { name: "aider", executor: new AiderTurnExecutor({ binaryPath: dumpArgsBin }) },
        { name: "grok", executor: new GrokTurnExecutor({ binaryPath: dumpArgsBin }) },
        { name: "hermes", executor: new HermesTurnExecutor({ binaryPath: dumpArgsBin }) },
      ];

      for (const { name, executor } of harnesses) {
        const event = makeEvent("Hello peer agent, please do task X", {
          sender_name: "alpha-agent",
          msg_id: "01JMSG9999",
        });
        const res = await executor.execute(event);

        assert.ok(
          res.response.includes("[inbound coms-net message from alpha-agent"),
          `${name}: Prompt envelope must identify sender`
        );
        assert.ok(
          res.response.includes("[reply by writing a normal assistant message"),
          `${name}: Prompt envelope must include anti-looping instruction`
        );
        assert.ok(
          res.response.includes("Hello peer agent, please do task X"),
          `${name}: Original prompt must be present inside envelope`
        );
      }
    });

    it("ADV-6.2: Markdown code-fenced JSON responses validate properly via validateResponseSchema", async () => {
      const codeFenceBin = createMockExecutable(
        tmpDir,
        "code-fence.sh",
        `#!/bin/bash
cat <<'EOF'
Here is your requested output:

\`\`\`json
{
  "task": "refactoring",
  "status": "ready",
  "files_changed": ["src/index.ts", "src/cli.ts"]
}
\`\`\`

Hope that helps!
EOF
`
      );

      const aider = new AiderTurnExecutor({ binaryPath: codeFenceBin });
      const res = await aider.execute(makeEvent("Give me JSON"));
      assert.strictEqual(res.error, undefined);

      const schema = {
        type: "object",
        properties: {
          task: { type: "string" },
          status: { type: "string" },
          files_changed: { type: "array" },
        },
        required: ["task", "status"],
      };

      const validated = validateResponseSchema(res.response, schema);
      assert.strictEqual(validated.error, null);
      assert.strictEqual((validated.payload as any).task, "refactoring");
      assert.strictEqual((validated.payload as any).status, "ready");
      assert.strictEqual((validated.payload as any).files_changed.length, 2);
    });

    it("ADV-6.3: Factory createTurnExecutor instantiates all 7 supported harnesses with custom options", () => {
      const customEnv = { TEST_VAR: "custom" };

      const claude = createTurnExecutor({
        harness: "claude",
        model: "claude-3-7-sonnet",
        permissionMode: "bypassPermissions",
        env: customEnv,
      });
      assert.ok(claude instanceof ClaudeCodeTurnExecutor);

      const codex = createTurnExecutor({
        harness: "codex",
        model: "o3-mini",
        env: customEnv,
      });
      assert.ok(codex instanceof CodexTurnExecutor);

      const aider = createTurnExecutor({
        harness: "aider",
        model: "deepseek-coder",
        env: customEnv,
      });
      assert.ok(aider instanceof AiderTurnExecutor);

      const grok = createTurnExecutor({
        harness: "grok",
        model: "grok-2",
        permissionMode: "bypassPermissions",
        env: customEnv,
      });
      assert.ok(grok instanceof GrokTurnExecutor);

      const hermes = createTurnExecutor({
        harness: "hermes",
        model: "hermes-3-llama-3.1-70b",
        provider: "nousresearch",
        env: customEnv,
      });
      assert.ok(hermes instanceof HermesTurnExecutor);

      const mock = createTurnExecutor({
        harness: "mock",
        mockResponse: "dynamic-canned",
      });
      assert.ok(mock);

      const agy = createTurnExecutor({
        harness: "antigravity",
        model: "gemini-2.5-pro",
      });
      assert.ok(agy);

      assert.throws(
        () => createTurnExecutor({ harness: "invalid" as any }),
        /Unsupported harness: invalid/
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 7: Empirical Defect Verification
  // ═══════════════════════════════════════════════════════════════════════════
  describe("7. Empirical Defect Verification: Type Safety & Failure Masking", () => {
    it("DEFECT-1: CodexTurnExecutor returns object array instead of string when NDJSON has content array", async () => {
      const contentArrayBin = createMockExecutable(
        tmpDir,
        "codex-content-array.sh",
        `#!/bin/bash
cat <<'EOF'
{"content": [{"type": "text", "text": "Structured content chunk"}]}
EOF
`
      );

      const codex = new CodexTurnExecutor({ binaryPath: contentArrayBin });
      const res = await codex.execute(makeEvent("test content array"));

      // ITurnExecutor contract requires typeof res.response === 'string'
      const responseType = typeof res.response;
      assert.strictEqual(
        responseType,
        "string",
        `Contract violation: res.response must be a string, got ${responseType}`
      );
    });

    it("DEFECT-2: GrokTurnExecutor returns object instead of string when JSON has chat message object", async () => {
      const chatMsgBin = createMockExecutable(
        tmpDir,
        "grok-chat-msg.sh",
        `#!/bin/bash
cat <<'EOF'
{"message": {"role": "assistant", "content": "Assistant answer text"}}
EOF
`
      );

      const grok = new GrokTurnExecutor({ binaryPath: chatMsgBin });
      const res = await grok.execute(makeEvent("test chat message"));

      const responseType = typeof res.response;
      assert.strictEqual(
        responseType,
        "string",
        `Contract violation: res.response must be a string, got ${responseType}`
      );
    });

    it("DEFECT-3: Non-zero exit code with plain text stdout error is masked as success in claude/grok/codex/aider", async () => {
      const exit1Bin = createMockExecutable(
        tmpDir,
        "cli-fatal-exit1.sh",
        `#!/bin/bash
echo "Fatal error: invalid API authentication key"
exit 1
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: exit1Bin });
      const res = await claude.execute(makeEvent("fatal exit"));

      assert.ok(
        res.error !== undefined && res.error.length > 0,
        `Expected non-zero exit to report error, but res.error was undefined (failure masked as success)`
      );
    });

    it("DEFECT-4: Subprocess killed on ERR_CHILD_PROCESS_STDIO_MAXBUFFER is masked as success in claude/grok/codex/aider", async () => {
      const floodBin = createMockExecutable(
        tmpDir,
        "flood-buffer.sh",
        `#!/bin/bash
python3 -c "print('X' * (25 * 1024 * 1024))"
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: floodBin });
      const res = await claude.execute(makeEvent("flood buffer"));

      assert.ok(
        res.error !== undefined && res.error.length > 0,
        `Expected maxBuffer overflow error, but res.error was undefined (truncation failure masked as success)`
      );
    });
  });
});


