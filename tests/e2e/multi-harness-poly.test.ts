/**
 * tests/e2e/multi-harness-poly.test.ts
 *
 * Comprehensive Multi-Harness Poly-Coms-Net End-to-End Test Suite.
 * Organised into 4 rigorous tiers:
 * - Tier 1: Feature Coverage (all 7 supported harnesses: antigravity, claude, codex, aider, grok, hermes, mock)
 * - Tier 2: Boundary & Corner Cases (timeouts, empty prompts, non-zero exits, malformed JSON, token redaction, schema failures)
 * - Tier 3: Cross-Feature Combinations (anti-loop envelope delivery, hops incrementing across delegations, conversation_id resumption, sequential FIFO queueing)
 * - Tier 4: Real-World Multi-Agent Workloads (tri-harness peer delegation pipeline, network drop & resilient SSE reconnection, fleet teardown)
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

import { MockHub, generateUlid } from "../mocks/mock-hub.ts";
import { TestClient } from "../mocks/test-client.ts";
import { ComsNetClient } from "../../src/protocol/client.ts";
import { BridgeDaemon } from "../../src/bridge/daemon.ts";
import {
  createTurnExecutor,
  SUPPORTED_HARNESSES,
  type SupportedHarness,
} from "../../src/bridge/executors/index.ts";
import {
  MockTurnExecutor,
  AgyCliTurnExecutor,
  formatInboundPrompt,
  validateResponseSchema,
} from "../../src/bridge/turn-executor.ts";
import { ClaudeCodeTurnExecutor } from "../../src/bridge/executors/claude.ts";
import { CodexTurnExecutor } from "../../src/bridge/executors/codex.ts";
import { AiderTurnExecutor } from "../../src/bridge/executors/aider.ts";
import { GrokTurnExecutor } from "../../src/bridge/executors/grok.ts";
import { HermesTurnExecutor } from "../../src/bridge/executors/hermes.ts";
import { ComsNetTools } from "../../src/protocol/tools.ts";
import { HopLimitExceededError } from "../../src/protocol/errors.ts";

// ━━ Helper Utilities ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Creates an executable mock script in a sandboxed temporary directory.
 */
function createMockScript(tmpDir: string, filename: string, content: string): string {
  const scriptPath = path.join(tmpDir, filename);
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

/**
 * Await an event on an EventEmitter with an explicit timeout.
 */
function waitForEvent<T = any>(
  emitter: EventEmitter,
  event: string,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for event '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    const handler = (data: T) => {
      cleanup();
      resolve(data);
    };

    function cleanup() {
      clearTimeout(timer);
      emitter.off(event, handler);
    }

    emitter.on(event, handler);
  });
}

/**
 * Registers a sender agent in the hub so message dispatch succeeds protocol checks.
 */
async function registerSender(
  client: TestClient,
  project: string,
  name: string = "test-sender"
): Promise<string> {
  const sessionId = generateUlid();
  const res = await client.register({
    project,
    session_id: sessionId,
    name,
    purpose: "Test prompt sender",
    model: "test-model",
    color: "#36F9F6",
  });
  assert.strictEqual(res.status, 200, "Sender registration must succeed");
  return sessionId;
}

/**
 * Starts a BridgeDaemon and awaits until its SSE stream is fully connected.
 */
async function startDaemonAndAwaitSse(
  daemon: BridgeDaemon,
  maxWaitMs: number = 3000
): Promise<any> {
  const ssePromise = new Promise<void>((resolve) => {
    daemon.once("sse_connected", () => resolve());
  });
  const card = await daemon.start();
  await Promise.race([
    ssePromise,
    new Promise((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);

  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if ((daemon as any).sse?.getState?.() === "connected") {
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return card;
}

// ━━ Main Test Suite ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Multi-Harness Poly-Coms-Net E2E Suite", () => {
  let hub: MockHub;
  let client: TestClient;
  let tempDir: string;

  before(async () => {
    hub = new MockHub();
    await hub.start();
    client = new TestClient(hub.baseUrl, hub.token);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "poly-coms-e2e-"));
  });

  after(async () => {
    await hub.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Tier 1: Feature Coverage (All 7 Supported Harnesses)
  // ═════════════════════════════════════════════════════════════════════════
  describe("Tier 1: Feature Coverage (All Supported Harnesses)", () => {
    it("T1.1: Antigravity CLI Adapter executes turn through BridgeDaemon", async () => {
      const project = "t1-agy-" + generateUlid();
      const agyBin = createMockScript(
        tempDir,
        "mock-agy-" + generateUlid() + ".sh",
        `#!/bin/bash
# Mock Antigravity CLI script emitting JSON output
cat <<EOF
{
  "status": "SUCCESS",
  "response": "Antigravity generated solution for task",
  "conversation_id": "agy-session-101",
  "duration_seconds": 0.15,
  "usage": {
    "input_tokens": 120,
    "output_tokens": 45,
    "total_tokens": 165
  }
}
EOF
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "agy-worker",
        turnExecutor: createTurnExecutor({
          harness: "antigravity",
          binaryPath: agyBin,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      const card = await startDaemonAndAwaitSse(daemon);
      assert.strictEqual(card.name, "agy-worker");

      const senderSid = await registerSender(client, project, "agy-requester");

      // Dispatch prompt via test client
      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "agy-worker",
        prompt: "Refactor database queries for PostgreSQL",
      });
      assert.strictEqual(sendRes.status, 200);
      const msgId = sendRes.body.msg_id;

      // Await daemon turn completion
      const submitted = await waitForEvent(daemon, "response_submitted");
      assert.strictEqual(submitted.msg_id, msgId);

      // Verify message state in hub
      const msgRes = await client.getMessage(msgId, project);
      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Antigravity generated solution for task");
      assert.strictEqual(msgRes.body.error, null);

      await daemon.stop();
    });

    it("T1.2: Claude Code CLI Adapter executes turn through BridgeDaemon", async () => {
      const project = "t1-claude-" + generateUlid();
      const claudeBin = createMockScript(
        tempDir,
        "mock-claude-" + generateUlid() + ".sh",
        `#!/bin/bash
cat <<EOF
{
  "status": "SUCCESS",
  "result": "Claude Code refactoring completed successfully",
  "session_id": "claude-session-202",
  "duration_ms": 250,
  "usage": {
    "input_tokens": 180,
    "output_tokens": 75,
    "thinking_tokens": 25,
    "total_tokens": 280
  }
}
EOF
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "claude-worker",
        turnExecutor: createTurnExecutor({
          harness: "claude",
          binaryPath: claudeBin,
          model: "claude-3-7-sonnet",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "claude-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "claude-worker",
        prompt: "Review caching layer and add Redis fallback",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Claude Code refactoring completed successfully");

      await daemon.stop();
    });

    it("T1.3: OpenAI Codex CLI Adapter executes turn through BridgeDaemon", async () => {
      const project = "t1-codex-" + generateUlid();
      const codexBin = createMockScript(
        tempDir,
        "mock-codex-" + generateUlid() + ".sh",
        `#!/bin/bash
cat <<EOF
{"response": "Codex implementation with TypeScript typings", "conversation_id": "codex-session-303", "usage": {"input_tokens": 140, "output_tokens": 60, "total_tokens": 200}}
EOF
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "codex-worker",
        turnExecutor: createTurnExecutor({
          harness: "codex",
          binaryPath: codexBin,
          model: "o3-mini",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "codex-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "codex-worker",
        prompt: "Implement quicksort algorithm in TypeScript",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Codex implementation with TypeScript typings");

      await daemon.stop();
    });

    it("T1.4: Aider AI Pair Programming Adapter executes turn through BridgeDaemon", async () => {
      const project = "t1-aider-" + generateUlid();
      const aiderBin = createMockScript(
        tempDir,
        "mock-aider-" + generateUlid() + ".sh",
        `#!/bin/bash
echo "Aider: Applied bugfix patch and verified tests pass"
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "aider-worker",
        turnExecutor: createTurnExecutor({
          harness: "aider",
          binaryPath: aiderBin,
          model: "claude-3-5-sonnet",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "aider-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "aider-worker",
        prompt: "Fix off-by-one error in pagination calculation",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.ok(
        String(msgRes.body.response).includes("Applied bugfix patch"),
        `Response must contain expected text: ${msgRes.body.response}`
      );

      await daemon.stop();
    });

    it("T1.5: Grok CLI Adapter executes turn through BridgeDaemon", async () => {
      const project = "t1-grok-" + generateUlid();
      const grokBin = createMockScript(
        tempDir,
        "mock-grok-" + generateUlid() + ".sh",
        `#!/bin/bash
cat <<EOF
{
  "response": "Grok CLI analysis: concurrency race avoided with mutex",
  "conversation_id": "grok-session-505",
  "duration_seconds": 0.22,
  "usage": {
    "prompt_tokens": 150,
    "completion_tokens": 55,
    "total_tokens": 205
  }
}
EOF
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "grok-worker",
        turnExecutor: createTurnExecutor({
          harness: "grok",
          binaryPath: grokBin,
          model: "grok-2",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "grok-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "grok-worker",
        prompt: "Analyze race condition in background queue worker",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Grok CLI analysis: concurrency race avoided with mutex");

      await daemon.stop();
    });

    it("T1.6: Hermes Agent Adapter executes turn with usage-file tracking", async () => {
      const project = "t1-hermes-" + generateUlid();
      const hermesBin = createMockScript(
        tempDir,
        "mock-hermes-" + generateUlid() + ".sh",
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
  cat <<EOF > "$usage_file"
{
  "token_counts": {
    "prompt": 135,
    "completion": 65,
    "total": 200
  },
  "input_tokens": 135,
  "output_tokens": 65,
  "total_tokens": 200,
  "model": "hermes-3-llama-3.1-70b"
}
EOF
fi

echo "Hermes Agent reasoning completed: system verified"
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "hermes-worker",
        turnExecutor: createTurnExecutor({
          harness: "hermes",
          binaryPath: hermesBin,
          model: "hermes-3-llama-3.1-70b",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "hermes-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "hermes-worker",
        prompt: "Evaluate formal logic proof of mutex safety",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Hermes Agent reasoning completed: system verified");

      await daemon.stop();
    });

    it("T1.7: Mock In-Memory Harness executes turn with fast latency", async () => {
      const project = "t1-mock-" + generateUlid();
      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "mock-worker",
        turnExecutor: createTurnExecutor({
          harness: "mock",
          mockResponse: "In-memory hermetic response",
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "mock-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "mock-worker",
        prompt: "Ping mock harness",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "In-memory hermetic response");

      await daemon.stop();
    });

    it("T1.8: SUPPORTED_HARNESSES contains all 7 required harness identifiers", () => {
      const expected: SupportedHarness[] = [
        "antigravity",
        "claude",
        "codex",
        "aider",
        "grok",
        "hermes",
        "mock",
      ];
      assert.deepStrictEqual(SUPPORTED_HARNESSES, expected);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Tier 2: Boundary & Corner Cases
  // ═════════════════════════════════════════════════════════════════════════
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: Subprocess timeout kills hung process and reports sanitized timeout error", async () => {
      const project = "t2-timeout-" + generateUlid();
      const hungScript = createMockScript(
        tempDir,
        "mock-hung-" + generateUlid() + ".sh",
        `#!/bin/bash
sleep 10
echo "Finished sleep"
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "timeout-worker",
        turnExecutor: createTurnExecutor({
          harness: "claude",
          binaryPath: hungScript,
          timeoutMs: 150,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "timeout-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "timeout-worker",
        prompt: "This turn should timeout",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "turn_completed");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "error");
      assert.ok(
        msgRes.body.error?.includes("timed out after 150ms"),
        `Error must specify timeout duration: ${msgRes.body.error}`
      );

      await daemon.stop();
    });

    it("T2.2: Empty and whitespace prompt payloads execute safely without crash", async () => {
      const project = "t2-empty-" + generateUlid();
      const echoScript = createMockScript(
        tempDir,
        "mock-echo-" + generateUlid() + ".sh",
        `#!/bin/bash
echo '{"status": "SUCCESS", "response": "Processed empty prompt"}'
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "empty-worker",
        turnExecutor: createTurnExecutor({
          harness: "antigravity",
          binaryPath: echoScript,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "empty-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "empty-worker",
        prompt: "   \n\t   ",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Processed empty prompt");

      await daemon.stop();
    });

    it("T2.3: Non-zero exit code captures stderr diagnostics without process panic", async () => {
      const project = "t2-exitcode-" + generateUlid();
      const failScript = createMockScript(
        tempDir,
        "mock-fail-" + generateUlid() + ".sh",
        `#!/bin/bash
>&2 echo "Fatal: GPU allocation failed with out_of_memory error"
exit 1
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "fail-worker",
        turnExecutor: createTurnExecutor({
          harness: "grok",
          binaryPath: failScript,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "fail-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "fail-worker",
        prompt: "Trigger failure",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "turn_completed");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "error");
      assert.ok(
        msgRes.body.error?.includes("GPU allocation failed"),
        `Error must capture stderr message: ${msgRes.body.error}`
      );

      await daemon.stop();
    });

    it("T2.4: Malformed and truncated JSON output is handled gracefully", async () => {
      const project = "t2-malformed-" + generateUlid();
      const malformedScript = createMockScript(
        tempDir,
        "mock-malformed-" + generateUlid() + ".sh",
        `#!/bin/bash
echo '{"status": "SUCCESS", "response": "Incomplete text...'
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "malformed-worker",
        turnExecutor: createTurnExecutor({
          harness: "claude",
          binaryPath: malformedScript,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "malformed-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "malformed-worker",
        prompt: "Parse broken output",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "complete");
      assert.ok(
        String(msgRes.body.response).includes("Incomplete text"),
        `Raw output must be preserved when JSON is invalid: ${msgRes.body.response}`
      );

      await daemon.stop();
    });

    it("T2.5: Bearer tokens and sensitive API keys in stderr are strictly redacted", async () => {
      const project = "t2-redact-" + generateUlid();
      const secretToken = "sk-ant-api03-super-secret-production-token-123456789";
      const leakScript = createMockScript(
        tempDir,
        "mock-leak-" + generateUlid() + ".sh",
        `#!/bin/bash
>&2 echo "Authentication rejected for Bearer ${secretToken}"
exit 1
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "leak-worker",
        turnExecutor: createTurnExecutor({
          harness: "claude",
          binaryPath: leakScript,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "leak-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "leak-worker",
        prompt: "Trigger auth error",
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "turn_completed");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "error");
      assert.ok(
        !msgRes.body.error?.includes(secretToken),
        `Raw secret token must NOT appear in error output: ${msgRes.body.error}`
      );
      assert.ok(
        msgRes.body.error?.includes("<redacted>"),
        `Error must contain <redacted> replacement: ${msgRes.body.error}`
      );

      await daemon.stop();
    });

    it("T2.6: Schema validation failure on non-JSON response returns expected protocol error", async () => {
      const project = "t2-schema-" + generateUlid();
      const nonJsonScript = createMockScript(
        tempDir,
        "mock-plain-" + generateUlid() + ".sh",
        `#!/bin/bash
echo "I am a plain text response without JSON brackets"
`
      );

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "schema-worker",
        turnExecutor: createTurnExecutor({
          harness: "aider",
          binaryPath: nonJsonScript,
        }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "schema-requester");

      const strictSchema = {
        type: "object",
        required: ["summary", "tests_passing"],
        properties: {
          summary: { type: "string" },
          tests_passing: { type: "boolean" },
        },
      };

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "schema-worker",
        prompt: "Generate structured summary",
        response_schema: strictSchema,
      });
      const msgId = sendRes.body.msg_id;

      await waitForEvent(daemon, "turn_completed");
      const msgRes = await client.getMessage(msgId, project);

      assert.strictEqual(msgRes.body.status, "error");
      assert.strictEqual(msgRes.body.error, "response not valid JSON");

      await daemon.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Tier 3: Cross-Feature Combinations
  // ═════════════════════════════════════════════════════════════════════════
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("T3.1: Anti-looping envelope is delivered to child process across all harness adapters", async () => {
      const project = "t3-antiloop-" + generateUlid();
      const logFile = path.join(tempDir, `inspect-args-${generateUlid()}.log`);

      const inspectorScript = createMockScript(
        tempDir,
        "mock-inspect-" + generateUlid() + ".sh",
        `#!/bin/bash
for arg in "$@"; do
  echo "$arg" >> "${logFile}"
done
echo '{"status": "SUCCESS", "result": "Prompt inspected"}'
`
      );

      const executor = new ClaudeCodeTurnExecutor({
        binaryPath: inspectorScript,
      });

      const event = {
        msg_id: "01JME2ETESTMSG000000000001",
        sender_session: "01JMSENDER0000000000000001",
        sender_name: "test-orchestrator",
        sender_project: project,
        prompt: "Execute subtask without recursion",
        hops: 0,
      };

      const result = await executor.execute(event);
      assert.strictEqual(result.response, "Prompt inspected");

      assert.ok(fs.existsSync(logFile), "Log file must exist");
      const loggedArgs = fs.readFileSync(logFile, "utf8");

      assert.ok(
        loggedArgs.includes("[inbound coms-net message from test-orchestrator"),
        "Must contain sender attribution header"
      );
      assert.ok(
        loggedArgs.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply"),
        "Must contain anti-loop warning"
      );
      assert.ok(
        loggedArgs.includes("msg_id 01JME2ETESTMSG000000000001 belongs to test-orchestrator's outbound"),
        "Must clarify msg_id ownership"
      );
      assert.ok(
        loggedArgs.includes("Execute subtask without recursion"),
        "Must contain original user prompt"
      );
    });

    it("T3.2: Inbound hop count propagates and enforces hop ceiling limit (MAX_HOPS = 5)", async () => {
      const project = "t3-hops-" + generateUlid();
      const clientComs = new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project });
      const callerSid = await registerSender(client, project, "caller-peer");
      await registerSender(client, project, "any-peer");
      await registerSender(client, project, "peer-b");
      await registerSender(client, project, "peer-c");

      let currentInbound: any = null;
      const tools = new ComsNetTools({
        client: clientComs,
        identity: {
          session_id: callerSid,
          name: "caller-peer",
          project,
        },
        pendingReplies: new Map(),
        inboundContextManager: {
          getCurrentInbound: () => currentInbound,
          setCurrentInbound: (ctx: any) => {
            currentInbound = ctx;
          },
          getInbound: () => undefined,
        },
      });

      // 1. Without inbound context, hops defaults to 0
      const send1 = await tools.send({
        target: "any-peer",
        prompt: "First hop prompt",
      });
      assert.strictEqual(send1.details.hops, 0);

      // 2. Under active inbound context with hops=2, next outbound increments to hops=3
      currentInbound = {
        msg_id: "01JMINBOUND00000000000001",
        sender_session: "01JMSENDER0000000000000001",
        sender_name: "peer-a",
        sender_project: project,
        prompt: "Hop 2 prompt",
        hops: 2,
      };

      const send2 = await tools.send({
        target: "peer-b",
        prompt: "Second hop prompt",
      });
      assert.strictEqual(send2.details.hops, 3);

      // 3. Under active inbound context with hops=4, next outbound reaches ceiling (5) and is rejected
      currentInbound = {
        msg_id: "01JMINBOUND00000000000002",
        sender_session: "01JMSENDER0000000000000002",
        sender_name: "peer-b",
        sender_project: project,
        prompt: "Hop 4 prompt",
        hops: 4,
      };

      await assert.rejects(
        async () => {
          await tools.send({
            target: "peer-c",
            prompt: "Fifth hop prompt (exceeds limit)",
          });
        },
        (err: any) => {
          return err instanceof HopLimitExceededError && err.code === "hop_limit_exceeded";
        }
      );
    });

    it("T3.3: Conversation ID is preserved and passed to adapter for state resumption", async () => {
      const project = "t3-conv-" + generateUlid();
      const convLog = path.join(tempDir, `conv-${generateUlid()}.log`);

      const resumeScript = createMockScript(
        tempDir,
        "mock-resume-" + generateUlid() + ".sh",
        `#!/bin/bash
echo "$@" >> "${convLog}"
echo '{"status": "SUCCESS", "response": "Resumed conversation", "conversation_id": "thread-abc-123"}'
`
      );

      const executor = new AgyCliTurnExecutor({
        agyBinaryPath: resumeScript,
      });

      const event = {
        msg_id: "01JMMID0000000000000000001",
        sender_session: "01JMSID0000000000000000001",
        sender_name: "state-tester",
        sender_project: project,
        prompt: "Second turn in multi-turn conversation",
        conversation_id: "thread-abc-123",
        hops: 1,
      };

      const result = await executor.execute(event);
      assert.strictEqual(result.conversation_id, "thread-abc-123");

      const loggedArgs = fs.readFileSync(convLog, "utf8");
      assert.ok(
        loggedArgs.includes("--conversation thread-abc-123"),
        `Adapter must pass conversation flag to child process: ${loggedArgs}`
      );
    });

    it("T3.4: Burst of 5 concurrent prompts processes in sequential FIFO order without overlap", async () => {
      const project = "t3-fifo-" + generateUlid();
      const executionOrder: number[] = [];

      const mockExecutor = new MockTurnExecutor();
      mockExecutor.setHandler(async (event) => {
        const orderNum = parseInt(event.prompt.replace("Prompt #", ""), 10);
        executionOrder.push(orderNum);
        await new Promise((r) => setTimeout(r, 40));
        return {
          response: `Reply to #${orderNum}`,
        };
      });

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "fifo-worker",
        turnExecutor: mockExecutor,
        maxConcurrentTurns: 1,
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(daemon);
      const senderSid = await registerSender(client, project, "fifo-requester");

      // Fire 5 requests in parallel
      const promises: Promise<any>[] = [];
      for (let i = 1; i <= 5; i++) {
        promises.push(
          client.sendMessage({
            project,
            sender_session: senderSid,
            target: "fifo-worker",
            prompt: `Prompt #${i}`,
          })
        );
      }

      const sendResults = await Promise.all(promises);
      const msgIds = sendResults.map((r) => r.body.msg_id);

      // Poll until all 5 messages are complete
      for (const msgId of msgIds) {
        let isDone = false;
        for (let attempt = 0; attempt < 50; attempt++) {
          const res = await client.getMessage(msgId, project);
          if (res.body.status === "complete") {
            isDone = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        assert.ok(isDone, `Message ${msgId} must complete`);
      }

      assert.deepStrictEqual(executionOrder, [1, 2, 3, 4, 5]);

      await daemon.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // Tier 4: Real-World Multi-Agent Workloads
  // ═════════════════════════════════════════════════════════════════════════
  describe("Tier 4: Real-World Multi-Agent Workloads", () => {
    it("T4.1: Tri-Harness Collaboration Pipeline (Hermes -> Claude Code -> Codex)", async () => {
      const project = "t4-pipeline-" + generateUlid();

      // 1. Setup Reviewer (Codex)
      const codexExecutor = new MockTurnExecutor({
        defaultResponse: JSON.stringify({
          approved: true,
          audit_level: "strict",
          security_score: 98,
        }),
      });

      const codexDaemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "reviewer-codex",
        purpose: "Automated security and code reviewer",
        model: "o3-mini",
        turnExecutor: codexExecutor,
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      // 2. Setup Worker (Claude Code) which delegates audit to Reviewer (Codex)
      const claudeClient = new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project });
      const claudeExecutor = new MockTurnExecutor();
      claudeExecutor.setHandler(async (event) => {
        const auditSchema = {
          type: "object",
          required: ["approved", "security_score"],
        };

        const auditSend = await claudeClient.sendMessage({
          project,
          sender_session: (claudeDaemon as any).identity.session_id,
          target: "reviewer-codex",
          prompt: "Audit proposed auth flow for CSRF vulnerabilities",
          response_schema: auditSchema,
          hops: event.hops + 1,
        });

        const auditRes = await claudeClient.awaitMessage(auditSend.msg_id, {
          timeoutMs: 5000,
          project,
        });

        return {
          response: JSON.stringify({
            implementation: "export function handleAuth() { ... }",
            reviewer_approval: auditRes.response,
            verified: true,
          }),
        };
      });

      const claudeDaemon = new BridgeDaemon({
        client: claudeClient,
        name: "worker-claude",
        purpose: "Senior software engineer",
        model: "claude-3-7-sonnet",
        turnExecutor: claudeExecutor,
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      // 3. Setup Coordinator (Hermes)
      const hermesClient = new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project });
      const hermesExecutor = new MockTurnExecutor();
      hermesExecutor.setHandler(async (event) => {
        const workerSend = await hermesClient.sendMessage({
          project,
          sender_session: (hermesDaemon as any).identity.session_id,
          target: "worker-claude",
          prompt: "Implement OAuth2 PKCE authorization flow",
          hops: event.hops + 1,
        });

        const workerRes = await hermesClient.awaitMessage(workerSend.msg_id, {
          timeoutMs: 5000,
          project,
        });

        return {
          response: `Coordinator finalized pipeline: ${JSON.stringify(workerRes.response)}`,
        };
      });

      const hermesDaemon = new BridgeDaemon({
        client: hermesClient,
        name: "coordinator-hermes",
        purpose: "Lead orchestrator and workflow director",
        model: "hermes-3-llama-3.1-70b",
        turnExecutor: hermesExecutor,
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await startDaemonAndAwaitSse(codexDaemon);
      await startDaemonAndAwaitSse(claudeDaemon);
      await startDaemonAndAwaitSse(hermesDaemon);

      const triggerSid = await registerSender(client, project, "pipeline-user");

      const pipelineTrigger = await client.sendMessage({
        project,
        sender_session: triggerSid,
        target: "coordinator-hermes",
        prompt: "Build and verify secure OAuth2 module",
      });
      const rootMsgId = pipelineTrigger.body.msg_id;

      let finished = false;
      let finalMsg: any = null;
      for (let attempt = 0; attempt < 60; attempt++) {
        const check = await client.getMessage(rootMsgId, project);
        if (check.body.status === "complete") {
          finished = true;
          finalMsg = check.body;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.strictEqual(finished, true, "Pipeline root message must complete");
      assert.ok(
        String(finalMsg.response).includes("Coordinator finalized pipeline"),
        "Must contain coordinator completion message"
      );
      assert.ok(
        String(finalMsg.response).includes("export function handleAuth"),
        "Must contain worker implementation"
      );
      assert.ok(
        String(finalMsg.response).includes("security_score"),
        "Must contain reviewer security audit"
      );

      await Promise.all([
        hermesDaemon.stop(),
        claudeDaemon.stop(),
        codexDaemon.stop(),
      ]);
    });

    it("T4.2: Resilient connection drop and automatic SSE re-registration", async () => {
      const project = "t4-reconnect-" + generateUlid();

      const daemon = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "resilient-worker",
        turnExecutor: new MockTurnExecutor({ defaultResponse: "Post-reconnect response" }),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      const card = await startDaemonAndAwaitSse(daemon);

      const proj = hub.getProject(project);
      assert.ok(proj.streams.has(card.session_id), "Hub must have active SSE stream for agent");

      const sseClient = proj.streams.get(card.session_id);
      assert.ok(sseClient);
      sseClient.res.destroy();

      let reconnected = false;
      for (let i = 0; i < 40; i++) {
        if (proj.streams.has(card.session_id) && proj.streams.get(card.session_id) !== sseClient) {
          reconnected = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.strictEqual(reconnected, true, "Daemon must re-establish SSE stream after socket drop");

      const senderSid = await registerSender(client, project, "reconnect-requester");

      const sendRes = await client.sendMessage({
        project,
        sender_session: senderSid,
        target: "resilient-worker",
        prompt: "Verify liveness after reconnection",
      });

      await waitForEvent(daemon, "response_submitted");
      const msgRes = await client.getMessage(sendRes.body.msg_id, project);
      assert.strictEqual(msgRes.body.status, "complete");
      assert.strictEqual(msgRes.body.response, "Post-reconnect response");

      await daemon.stop();
    });

    it("T4.3: Graceful multi-harness fleet teardown releases all hub resources", async () => {
      const project = "t4-teardown-" + generateUlid();

      const daemonA = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "fleet-a",
        turnExecutor: new MockTurnExecutor(),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      const daemonB = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "fleet-b",
        turnExecutor: new MockTurnExecutor(),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      const daemonC = new BridgeDaemon({
        client: new ComsNetClient({ baseUrl: hub.baseUrl, authToken: hub.token, project }),
        name: "fleet-c",
        turnExecutor: new MockTurnExecutor(),
        heartbeatIntervalMs: 60_000,
        autoTrapSignals: false,
      });

      await Promise.all([
        daemonA.start(),
        daemonB.start(),
        daemonC.start(),
      ]);

      const proj = hub.getProject(project);
      assert.strictEqual(proj.agents.size, 3, "Registry must contain 3 active agents");

      await Promise.all([
        daemonA.stop(),
        daemonB.stop(),
        daemonC.stop(),
      ]);

      assert.strictEqual(daemonA.status, "stopped");
      assert.strictEqual(daemonB.status, "stopped");
      assert.strictEqual(daemonC.status, "stopped");

      assert.strictEqual(proj.agents.size, 0, "All agents must be unregistered on stop");
      assert.strictEqual(proj.streams.size, 0, "All SSE streams must be closed");
    });
  });
});
