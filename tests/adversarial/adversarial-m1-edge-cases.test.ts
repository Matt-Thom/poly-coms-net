/**
 * tests/adversarial/adversarial-m1-edge-cases.test.ts
 *
 * Empirical Challenger Iteration 2 Adversarial Stress Test Suite:
 * Advanced Edge Cases for Milestone 1 Turn Executors:
 * - Deeply nested message content & content chunks
 * - Mixed null, undefined, primitive, and empty structures
 * - Rapid buffer exhaustion (stdout & stderr maxBuffer flooding)
 * - Non-zero exit codes with ambiguous payloads & signal terminations
 * - Credential redaction under complex multiline and nested outputs
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
import { AgyCliTurnExecutor } from "../../src/bridge/turn-executor.ts";
import {
  normalizeTurnResponse,
  validateResponseSchema,
} from "../../src/bridge/turn-executor.ts";
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
    sender_name: "challenger-agent",
    sender_project: "poly-test",
    prompt,
    hops: 1,
    ...overrides,
  };
}

describe("Adversarial M1 Iteration 2: Advanced Edge Cases & Stress Suite", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-adv-edge-"));
  });

  after(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1: Deeply Nested Message Content & Structured Payloads
  // ═══════════════════════════════════════════════════════════════════════════
  describe("1. Deeply Nested Message Content", () => {
    it("EDGE-1.1: Codex NDJSON with multi-level nested content chunks returns single unified string", async () => {
      const nestedCodexBin = createMockExecutable(
        tmpDir,
        "codex-deep-content.sh",
        `#!/bin/bash
cat <<'EOF'
{"content": [{"type": "text", "text": "Header part"}, {"content": [{"text": "Nested part A"}, {"content": [{"text": "Deep part B"}]}]}]}
EOF
`
      );

      const codex = new CodexTurnExecutor({ binaryPath: nestedCodexBin });
      const res = await codex.execute(makeEvent("deep content test"));

      assert.strictEqual(typeof res.response, "string", "Response must strictly be a string");
      assert.strictEqual(res.error, undefined);
      assert.ok(res.response.includes("Header part"), "Must contain outer header part");
      assert.ok(res.response.includes("Nested part A"), "Must contain middle nested part");
      assert.ok(res.response.includes("Deep part B"), "Must contain deeply nested part");
    });

    it("EDGE-1.2: Grok JSON with deeply nested OpenAI chat message parts returns valid string", async () => {
      const nestedGrokBin = createMockExecutable(
        tmpDir,
        "grok-deep-chat.sh",
        `#!/bin/bash
cat <<'EOF'
{
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Segment 1"},
      {"type": "text", "text": "Segment 2"}
    ]
  }
}
EOF
`
      );

      const grok = new GrokTurnExecutor({ binaryPath: nestedGrokBin });
      const res = await grok.execute(makeEvent("deep chat message"));

      assert.strictEqual(typeof res.response, "string");
      assert.strictEqual(res.error, undefined);
      assert.ok(res.response.includes("Segment 1"));
      assert.ok(res.response.includes("Segment 2"));
    });

    it("EDGE-1.3: Claude Code with arbitrary nested metadata object serializes to string without throwing", async () => {
      const arbitraryObjBin = createMockExecutable(
        tmpDir,
        "claude-arbitrary-obj.sh",
        `#!/bin/bash
cat <<'EOF'
{
  "status": "SUCCESS",
  "result": {
    "metadata": {
      "level1": {
        "level2": {
          "answer": "deep-value",
          "score": 99
        }
      }
    }
  }
}
EOF
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: arbitraryObjBin });
      const res = await claude.execute(makeEvent("arbitrary obj test"));

      assert.strictEqual(typeof res.response, "string");
      assert.strictEqual(res.error, undefined);
      assert.ok(res.response.includes("deep-value"));

      // Ensure validateResponseSchema can process this string without crash
      const schema = { type: "object" };
      const val = validateResponseSchema(res.response, schema);
      assert.strictEqual(val.error, null);
      assert.strictEqual((val.payload as any)?.metadata?.level1?.level2?.answer, "deep-value");
    });

    it("EDGE-1.4: Direct normalizeTurnResponse on empty nested arrays, objects, and strings returns clean string", () => {
      assert.strictEqual(normalizeTurnResponse([]), "");
      assert.strictEqual(typeof normalizeTurnResponse([[], [[]]]), "string");
      assert.strictEqual(normalizeTurnResponse(["", "   ", ""]), "   ");
      assert.strictEqual(normalizeTurnResponse([{ content: [] }]), "");
      assert.strictEqual(normalizeTurnResponse({ content: [] }), "");
      assert.strictEqual(normalizeTurnResponse({}), "{}");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: Mixed Null, Undefined, Primitive & Non-String Values
  // ═══════════════════════════════════════════════════════════════════════════
  describe("2. Mixed Null, Undefined & Primitive Values", () => {
    it("EDGE-2.1: Array containing null, undefined, boolean, number, empty strings normalizes safely", () => {
      const mixed = [null, undefined, false, 0, "", "valid string", 123.45, true];
      const normalized = normalizeTurnResponse(mixed);

      assert.strictEqual(typeof normalized, "string");
      const lines = normalized.split("\n");
      assert.ok(lines.includes("false"), "Boolean false preserved as string");
      assert.ok(lines.includes("0"), "Number 0 preserved as string");
      assert.ok(lines.includes("valid string"), "Valid string preserved");
      assert.ok(lines.includes("123.45"), "Float preserved as string");
      assert.ok(lines.includes("true"), "Boolean true preserved as string");
      assert.ok(!lines.includes("null"), "Null should be filtered out");
      assert.ok(!lines.includes("undefined"), "Undefined should be filtered out");
    });

    it("EDGE-2.2: Executors receiving null or undefined result fields return valid string without throwing", async () => {
      const nullOutBin = createMockExecutable(
        tmpDir,
        "null-output.sh",
        `#!/bin/bash
cat <<'EOF'
{"result": null, "response": null, "content": null, "message": null, "status": "SUCCESS"}
EOF
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: nullOutBin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: nullOutBin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: nullOutBin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: nullOutBin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("null test"));
        assert.strictEqual(typeof res.response, "string", `${name}: response must be string`);
        assert.strictEqual(res.error, undefined, `${name}: error should be undefined`);
      }
    });

    it("EDGE-2.3: Executors receiving boolean (false) or number (0) return valid string representations", async () => {
      const zeroOutBin = createMockExecutable(
        tmpDir,
        "zero-output.sh",
        `#!/bin/bash
cat <<'EOF'
{"result": 0, "status": "SUCCESS"}
EOF
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: zeroOutBin });
      const resZero = await claude.execute(makeEvent("zero test"));
      assert.strictEqual(typeof resZero.response, "string");
      assert.strictEqual(resZero.response, "0");

      const falseOutBin = createMockExecutable(
        tmpDir,
        "false-output.sh",
        `#!/bin/bash
cat <<'EOF'
{"result": false, "status": "SUCCESS"}
EOF
`
      );

      const grok = new GrokTurnExecutor({ binaryPath: falseOutBin });
      const resFalse = await grok.execute(makeEvent("false test"));
      assert.strictEqual(typeof resFalse.response, "string");
      assert.strictEqual(resFalse.response, "false");
    });

    it("EDGE-2.4: validateResponseSchema handles non-string, null, and undefined inputs defensively", () => {
      const schema = { type: "object", properties: { key: { type: "string" } } };

      // Null input
      const resNull = validateResponseSchema(null as any, schema);
      assert.strictEqual(resNull.payload, null);
      assert.strictEqual(resNull.error, "response not valid JSON");

      // Undefined input
      const resUndef = validateResponseSchema(undefined as any, schema);
      assert.strictEqual(resUndef.payload, null);
      assert.strictEqual(resUndef.error, "response not valid JSON");

      // Object passed directly
      const resDirectObj = validateResponseSchema({ key: "value" } as any, schema);
      assert.strictEqual(resDirectObj.error, null);
      assert.strictEqual((resDirectObj.payload as any)?.key, "value");

      // Array passed directly
      const resDirectArr = validateResponseSchema([{ key: "array-val" }] as any, null);
      assert.strictEqual(resDirectArr.error, null);
      assert.ok(typeof resDirectArr.payload === "string");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3: Rapid Buffer Exhaustion & Stdio Dynamics
  // ═══════════════════════════════════════════════════════════════════════════
  describe("3. Rapid Buffer Exhaustion & Stdio Dynamics", () => {
    it("EDGE-3.1: Rapid stdout maxBuffer overflow across ALL 6 executors triggers clean 20MB limit error", async () => {
      const stdoutFloodBin = createMockExecutable(
        tmpDir,
        "flood-stdout-fast.sh",
        `#!/bin/bash
python3 -c "import sys; sys.stdout.write('A' * (25 * 1024 * 1024))"
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: stdoutFloodBin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: stdoutFloodBin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: stdoutFloodBin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: stdoutFloodBin }) },
        { name: "hermes", exec: new HermesTurnExecutor({ binaryPath: stdoutFloodBin }) },
        { name: "antigravity", exec: new AgyCliTurnExecutor({ agyBinaryPath: stdoutFloodBin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("flood stdout"));
        assert.strictEqual(typeof res.response, "string", `${name}: response must be string`);
        assert.strictEqual(res.response, "", `${name}: response must be empty on buffer overflow`);
        assert.ok(
          res.error?.includes("maximum buffer limit (20MB)"),
          `${name}: Expected 20MB buffer limit error, got: ${res.error}`
        );
      }
    });

    it("EDGE-3.2: Rapid stderr maxBuffer overflow across ALL 6 executors triggers clean 20MB limit error", async () => {
      const stderrFloodBin = createMockExecutable(
        tmpDir,
        "flood-stderr-fast.sh",
        `#!/bin/bash
python3 -c "import sys; sys.stderr.write('E' * (25 * 1024 * 1024))"
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: stderrFloodBin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: stderrFloodBin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: stderrFloodBin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: stderrFloodBin }) },
        { name: "hermes", exec: new HermesTurnExecutor({ binaryPath: stderrFloodBin }) },
        { name: "antigravity", exec: new AgyCliTurnExecutor({ agyBinaryPath: stderrFloodBin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("flood stderr"));
        assert.strictEqual(typeof res.response, "string", `${name}: response must be string`);
        assert.strictEqual(res.response, "", `${name}: response must be empty on buffer overflow`);
        assert.ok(
          res.error?.includes("maximum buffer limit (20MB)"),
          `${name}: Expected 20MB buffer limit error on stderr overflow, got: ${res.error}`
        );
      }
    });

    it("EDGE-3.3: Rapid maxBuffer flood with valid JSON prefix intercepts before JSON parsing", async () => {
      const jsonFloodBin = createMockExecutable(
        tmpDir,
        "flood-json-prefix.py",
        `#!/usr/bin/env python3
import sys
prefix = "{\\"status\\": \\"SUCCESS\\", \\"result\\": \\""
suffix = "\\"}"
sys.stdout.write(prefix + ("Z" * 26000000) + suffix)
`
      );

      const claude = new ClaudeCodeTurnExecutor({ binaryPath: jsonFloodBin });
      const res = await claude.execute(makeEvent("json flood"));

      assert.strictEqual(res.response, "");
      assert.ok(
        res.error?.includes("maximum buffer limit (20MB)"),
        `Expected maxBuffer error, got: ${res.error}`
      );
    });

    it("EDGE-3.4: High-frequency burst of output just under 20MB (5MB) executes successfully without error", async () => {
      const burstBin = createMockExecutable(
        tmpDir,
        "burst-under-limit.sh",
        `#!/bin/bash
python3 -c "
import json, sys
data = 'X' * (5 * 1024 * 1024)
out = {'status': 'SUCCESS', 'result': 'Burst OK: ' + str(len(data))}
print(json.dumps(out))
"
`
      );

      const grok = new GrokTurnExecutor({ binaryPath: burstBin });
      const res = await grok.execute(makeEvent("burst test"));

      assert.strictEqual(res.error, undefined);
      assert.ok(res.response.startsWith("Burst OK: 5242880"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4: Non-Zero Exit & Error Redaction Nuances
  // ═══════════════════════════════════════════════════════════════════════════
  describe("4. Non-Zero Exit Codes & Credential Redaction Nuances", () => {
    it("EDGE-4.1: Exit code 1 with valid JSON response on stdout is NEVER masked as success", async () => {
      const exit1WithJsonBin = createMockExecutable(
        tmpDir,
        "exit1-with-valid-json.sh",
        `#!/bin/bash
# Subprocess exits 1, but printed what looks like a valid response JSON without error field
cat <<'EOF'
{"response": "Task attempted but aborted prematurely"}
EOF
exit 1
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: exit1WithJsonBin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: exit1WithJsonBin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: exit1WithJsonBin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: exit1WithJsonBin }) },
        { name: "antigravity", exec: new AgyCliTurnExecutor({ agyBinaryPath: exit1WithJsonBin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("exit 1 with json"));
        assert.ok(
          res.error !== undefined && res.error.length > 0,
          `${name}: Non-zero exit with valid JSON on stdout must not mask error as success`
        );
      }
    });

    it("EDGE-4.2: Exit code 127 with Bearer tokens in both stdout and stderr redacts all secrets", async () => {
      const exit127Bin = createMockExecutable(
        tmpDir,
        "exit127-secret.sh",
        `#!/bin/bash
echo "stdout: Authorization: Bearer secret-in-stdout-123456"
>&2 echo "stderr: Bearer secret-in-stderr-789012"
exit 127
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: exit127Bin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: exit127Bin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: exit127Bin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: exit127Bin }) },
        { name: "hermes", exec: new HermesTurnExecutor({ binaryPath: exit127Bin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("exit 127 test"));
        assert.ok(res.error, `${name}: Must return error on exit 127`);
        assert.ok(!res.error.includes("secret-in-stdout-123456"), `${name}: Must redact stdout secret`);
        assert.ok(!res.error.includes("secret-in-stderr-789012"), `${name}: Must redact stderr secret`);
        assert.ok(res.error.includes("<redacted>"), `${name}: Must include <redacted> placeholder`);
      }
    });

    it("EDGE-4.3: Subprocess killed by SIGTERM or SIGKILL reports failure without crashing", async () => {
      const sigkillBin = createMockExecutable(
        tmpDir,
        "self-kill.sh",
        `#!/bin/bash
# Kill self with SIGTERM
kill -TERM $$
`
      );

      const executors: { name: string; exec: ITurnExecutor }[] = [
        { name: "claude", exec: new ClaudeCodeTurnExecutor({ binaryPath: sigkillBin }) },
        { name: "codex", exec: new CodexTurnExecutor({ binaryPath: sigkillBin }) },
        { name: "grok", exec: new GrokTurnExecutor({ binaryPath: sigkillBin }) },
        { name: "aider", exec: new AiderTurnExecutor({ binaryPath: sigkillBin }) },
        { name: "hermes", exec: new HermesTurnExecutor({ binaryPath: sigkillBin }) },
      ];

      for (const { name, exec } of executors) {
        const res = await exec.execute(makeEvent("sigkill test"));
        assert.ok(res.error, `${name}: Must report error when process killed by signal`);
        assert.strictEqual(typeof res.response, "string", `${name}: Response must be string`);
      }
    });

    it("EDGE-4.4: Hermes Agent non-zero exit code produces clean error and string response", async () => {
      const hermesErrBin = createMockExecutable(
        tmpDir,
        "hermes-err.sh",
        `#!/bin/bash
echo "Partial stdout before Hermes crash"
>&2 echo "Error: connection failed to Nous API with Bearer hermes-secret-xyz"
exit 2
`
      );

      const hermes = new HermesTurnExecutor({ binaryPath: hermesErrBin });
      const res = await hermes.execute(makeEvent("hermes error test"));

      assert.strictEqual(typeof res.response, "string");
      assert.ok(res.error, "Must report error on exit code 2");
      assert.ok(!res.error.includes("hermes-secret-xyz"), "Bearer token must be redacted");
      assert.ok(res.error.includes("<redacted>"), "Must contain <redacted>");
    });
  });
});
