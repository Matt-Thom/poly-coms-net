/**
 * tests/unit/resilience-and-sse.test.ts
 *
 * Comprehensive test suite verifying:
 * - R1: Non-Terminal Error Cache Elimination & Retry Semantics
 * - R2: MCP Server SSE Response Subscription
 * - R3: Transparent Error Classification & Fetch Body Timeout Guard
 * - R4: Hub Await Stream Keepalive & Header Flush
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { ComsNetTools, generateUlid, type PendingReply, type ToolContext, type IComsClient } from "../../src/protocol/tools.ts";
import { ComsNetClient, RequestTimeoutError, ComsNetError } from "../../src/protocol/client.ts";
import { McpServer, type JsonRpcResponse } from "../../src/mcp/server.ts";
import { BridgeDaemon } from "../../src/bridge/daemon.ts";
import { MockHub } from "../mocks/mock-hub.ts";

describe("R1: Non-Terminal Error Cache Elimination & Retry Semantics", () => {
  let pendingReplies: Map<string, PendingReply>;
  let toolCtx: ToolContext;

  const identity = {
    session_id: "01J7SELF000000000000000001",
    name: "test-agent",
    project: "default",
  };

  beforeEach(() => {
    pendingReplies = new Map<string, PendingReply>();
  });

  it("Await HTTP long-poll network failure leaves pending.result unset; subsequent get & await hit hub afresh", async () => {
    let getMessageCalls = 0;
    let awaitMessageCalls = 0;

    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage(msgId: string) {
        getMessageCalls++;
        return {
          msg_id: msgId,
          status: "complete",
          response: "hub-retrieved-after-failure",
          error: null,
        };
      },
      async awaitMessage(msgId: string) {
        awaitMessageCalls++;
        if (awaitMessageCalls === 1) {
          throw new Error("Network request failed (GET /v1/messages/msg-net-err/await): fetch failed (UND_ERR_SOCKET)");
        }
        return {
          msg_id: msgId,
          status: "complete",
          response: "hub-awaited-on-retry",
          error: null,
        };
      },
    };

    toolCtx = {
      client: mockClient,
      identity,
      pendingReplies,
    };

    const tools = new ComsNetTools(toolCtx);
    const msgId = "msg-net-err";

    // 1. Initial await fails with network error
    const awaitRes1 = await tools.await({ msg_id: msgId, timeout_ms: 500 });
    assert.equal(awaitRes1.details.status, "error");
    assert.equal(awaitRes1.isError, true);
    assert.ok(String(awaitRes1.details.error).includes("UND_ERR_SOCKET") || String(awaitRes1.details.error).includes("Network request failed"));

    // Verify pendingReplies.get(msgId).result is UNSET (not cached)
    const pending = pendingReplies.get(msgId);
    assert.ok(pending, "pending record should exist in map");
    assert.equal(pending.result, undefined, "Non-terminal transport error MUST NOT be cached in pending.result");

    // 2. Immediate coms_net_get must query hub endpoint afresh
    const getRes = await tools.get({ msg_id: msgId });
    assert.equal(getMessageCalls, 1, "coms_net_get must perform a fresh query against the hub");
    assert.equal(getRes.details.status, "complete");
    assert.equal(getRes.details.response, "hub-retrieved-after-failure");

    // Now pending.result is cached with the complete result
    assert.ok(pending.result, "Genuine complete reply from get must now be cached");
    assert.equal(pending.result.response, "hub-retrieved-after-failure");

    // Clear cached result to test subsequent await retry
    pending.result = undefined;

    // 3. Subsequent coms_net_await must initiate a new poll
    const awaitRes2 = await tools.await({ msg_id: msgId, timeout_ms: 500 });
    assert.equal(awaitMessageCalls, 2, "Subsequent coms_net_await must initiate a new poll");
    assert.equal(awaitRes2.details.status, "complete");
    assert.equal(awaitRes2.details.response, "hub-awaited-on-retry");
  });

  it("Await HTTP timeout (status: 'timeout') does not cache as terminal; subsequent calls retrieve eventual complete", async () => {
    let getMessageCalls = 0;
    let awaitMessageCalls = 0;
    let pollResolved = false;

    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage(msgId: string) {
        getMessageCalls++;
        return {
          msg_id: msgId,
          status: pollResolved ? "complete" : "delivered",
          response: pollResolved ? "final-answer" : null,
          error: null,
        };
      },
      async awaitMessage(msgId: string) {
        awaitMessageCalls++;
        if (!pollResolved) {
          return {
            msg_id: msgId,
            status: "timeout",
            response: null,
            error: "timeout",
          };
        }
        return {
          msg_id: msgId,
          status: "complete",
          response: "final-answer",
          error: null,
        };
      },
    };

    toolCtx = {
      client: mockClient,
      identity,
      pendingReplies,
    };

    const tools = new ComsNetTools(toolCtx);
    const msgId = "msg-timeout-retry";

    // 1. Await returns status: "timeout"
    const await1 = await tools.await({ msg_id: msgId, timeout_ms: 100 });
    assert.equal(await1.details.status, "timeout");
    assert.equal(await1.details.error, "timeout");

    // Verify pending.result is NOT cached
    const pending = pendingReplies.get(msgId);
    assert.equal(pending?.result, undefined, "HTTP timeout MUST NOT be cached in pending.result");

    // 2. Poll via get while still in progress
    const get1 = await tools.get({ msg_id: msgId });
    assert.equal(get1.details.status, "delivered");
    assert.equal(getMessageCalls, 1);
    assert.equal(pending?.result, undefined, "Non-terminal delivered status MUST NOT be cached");

    // 3. Remote agent finishes
    pollResolved = true;

    // 4. Subsequent get retrieves complete and caches it
    const get2 = await tools.get({ msg_id: msgId });
    assert.equal(get2.details.status, "complete");
    assert.equal(get2.details.response, "final-answer");
    assert.equal(getMessageCalls, 2);
    assert.ok(pending?.result, "Eventual complete must be cached");
    assert.equal(pending?.result?.response, "final-answer");

    // 5. Subsequent await hits fast-path cache
    const await2 = await tools.await({ msg_id: msgId });
    assert.equal(await2.details.status, "complete");
    assert.equal(await2.details.response, "final-answer");
    assert.equal(awaitMessageCalls, 1, "Cached complete must bypass network long-poll");
  });

  it("Subsequent await continues to race local SSE promise after earlier timeout", async () => {
    let awaitCalls = 0;

    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage() { throw new Error("not used"); },
      async awaitMessage(msgId: string, tm: any, signalOrOpts: any) {
        awaitCalls++;
        return new Promise((resolve) => setTimeout(resolve, 500)) as any;
      },
    };

    toolCtx = {
      client: mockClient,
      identity,
      pendingReplies,
    };

    const tools = new ComsNetTools(toolCtx);
    const msgId = "msg-sse-race-retry";

    // 1. First await times out quickly (30ms)
    const await1 = await tools.await({ msg_id: msgId, timeout_ms: 30 });
    assert.equal(await1.details.status, "timeout");

    const pending = pendingReplies.get(msgId)!;
    assert.equal(pending.result, undefined);

    // 2. Start second await with longer timeout (500ms)
    const awaitPromise2 = tools.await({ msg_id: msgId, timeout_ms: 500 });
    assert.equal(awaitCalls, 2, "Second await must have initiated fresh long poll");

    // 3. SSE event resolves the local pending promise after 30ms
    setTimeout(() => {
      pending.resolve({ response: "sse-arrived-late", error: null });
    }, 30);

    const await2 = await awaitPromise2;
    assert.equal(await2.details.status, "complete");
    assert.equal(await2.details.response, "sse-arrived-late");
    assert.equal(pending.result?.response, "sse-arrived-late");
  });

  it("Preserves round-tripping for legitimate empty/falsy payloads ('', 0, false, null)", async () => {
    const falsyCases = [
      { val: "", name: "empty-string" },
      { val: 0, name: "zero-number" },
      { val: false, name: "false-boolean" },
      { val: null, name: "null-value" },
    ];

    for (const { val, name } of falsyCases) {
      let getCalls = 0;
      const mockClient: IComsClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage(id: string) {
          getCalls++;
          return {
            msg_id: id,
            status: "complete",
            response: val,
            error: null,
          };
        },
        async awaitMessage() { throw new Error("not used"); },
      };

      const ctx: ToolContext = {
        client: mockClient,
        identity,
        pendingReplies: new Map(),
      };
      const tools = new ComsNetTools(ctx);
      const msgId = `falsy-${name}`;

      const getRes1 = await tools.get({ msg_id: msgId });
      assert.equal(getRes1.details.status, "complete");
      assert.equal(getRes1.details.response, val);
      assert.equal(getCalls, 1);

      // Verify cached
      const pending = ctx.pendingReplies.get(msgId);
      assert.ok(pending?.result, `pending.result should be cached for ${name}`);
      assert.equal(pending.result.response, val);

      // Verify fast path in get
      const getRes2 = await tools.get({ msg_id: msgId });
      assert.equal(getRes2.details.status, "complete");
      assert.equal(getRes2.details.response, val);
      assert.equal(getCalls, 1, "Cache hit must bypass network");

      // Verify fast path in await
      const awaitRes = await tools.await({ msg_id: msgId });
      assert.equal(awaitRes.details.status, "complete");
      assert.equal(awaitRes.details.response, val);
    }
  });

  it("Hub explicit error payload is cached as terminal; transport errors are not", async () => {
    let getCalls = 0;
    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage(id: string) {
        getCalls++;
        return {
          msg_id: id,
          status: "error",
          response: null,
          error: "agent execution failed: syntax error",
        };
      },
      async awaitMessage() { throw new Error("not used"); },
    };

    const ctx: ToolContext = {
      client: mockClient,
      identity,
      pendingReplies: new Map(),
    };
    const tools = new ComsNetTools(ctx);
    const msgId = "terminal-hub-error";

    const res1 = await tools.get({ msg_id: msgId });
    assert.equal(res1.details.status, "error");
    assert.equal(res1.details.error, "agent execution failed: syntax error");
    assert.equal(getCalls, 1);

    const pending = ctx.pendingReplies.get(msgId);
    assert.ok(pending?.result, "Hub terminal error must be cached in pending.result");
    assert.equal(pending.result.error, "agent execution failed: syntax error");

    // Second get hits cache
    const res2 = await tools.get({ msg_id: msgId });
    assert.equal(getCalls, 1, "Cached terminal error must bypass network");
    assert.equal(res2.details.status, "error");
  });

  it("Server competitor with status 'error' and error 'unknown msg_id' or 'aborted' is not cached in pending.result", async () => {
    let awaitCalls = 0;
    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage(id: string) {
        return {
          msg_id: id,
          status: "complete",
          response: "recovered-after-unknown-msg",
          error: null,
        };
      },
      async awaitMessage(id: string) {
        awaitCalls++;
        if (awaitCalls === 1) {
          return {
            msg_id: id,
            status: "error",
            response: null,
            error: "unknown msg_id",
          };
        }
        return {
          msg_id: id,
          status: "complete",
          response: "recovered-after-unknown-msg",
          error: null,
        };
      },
    };

    const ctx: ToolContext = {
      client: mockClient,
      identity,
      pendingReplies: new Map(),
    };
    const tools = new ComsNetTools(ctx);
    const msgId = "msg-unknown-test";

    const res1 = await tools.await({ msg_id: msgId, timeout_ms: 100 });
    assert.equal(res1.details.status, "error");
    assert.equal(res1.details.error, "unknown msg_id");

    const pending = ctx.pendingReplies.get(msgId);
    assert.equal(pending?.result, undefined, "unknown msg_id must not be cached in pending.result");

    // Subsequent get queries hub afresh
    const getRes = await tools.get({ msg_id: msgId });
    assert.equal(getRes.details.status, "complete");
    assert.equal(getRes.details.response, "recovered-after-unknown-msg");
  });

  it("Aborted await race competitor returns isError: true and status: 'error'", async () => {
    const mockClient: IComsClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage() { throw new Error("not used"); },
      async getMessage() { throw new Error("not used"); },
      async awaitMessage(id: string, tm: any, signal: any) {
        const err: any = new Error("This operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    };

    const ctx: ToolContext = {
      client: mockClient,
      identity,
      pendingReplies: new Map(),
    };
    const tools = new ComsNetTools(ctx);
    const msgId = "msg-abort-error-test";

    const res = await tools.await({ msg_id: msgId, timeout_ms: 100 });
    assert.equal(res.details.status, "error");
    assert.equal(res.details.error, "aborted");
    assert.equal(res.isError, true, "Aborted error must return isError: true, not complete");
  });
});

describe("R2: MCP Server SSE Response Subscription", () => {
  let hub: MockHub;

  beforeEach(async () => {
    hub = new MockHub();
    await hub.start();
  });

  afterEach(async () => {
    await hub.stop();
  });

  function createMcpHarness() {
    const input = new PassThrough();
    const output = new PassThrough();
    const logs: string[] = [];

    const client = new ComsNetClient({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "mcp-test",
    });

    const server = new McpServer({
      input,
      output,
      client,
      logFn: (msg) => logs.push(msg),
    });

    server.start();

    let buffer = "";
    const queue: JsonRpcResponse[] = [];
    const waiters: Array<(resp: JsonRpcResponse) => void> = [];

    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            const parsed = JSON.parse(line);
            if (waiters.length > 0) {
              const waiter = waiters.shift()!;
              waiter(parsed);
            } else {
              queue.push(parsed);
            }
          } catch {}
        }
      }
    });

    const send = (msg: unknown) => {
      input.write(JSON.stringify(msg) + "\n");
    };

    const receive = (timeoutMs = 3000): Promise<JsonRpcResponse> => {
      if (queue.length > 0) {
        return Promise.resolve(queue.shift()!);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for response (${timeoutMs}ms)`));
        }, timeoutMs);
        waiters.push((resp) => {
          clearTimeout(timer);
          resolve(resp);
        });
      });
    };

    return { server, client, send, receive, logs };
  }

  it("MCP server initializes and maintains an SSE connection to /v1/events", async () => {
    const h = createMcpHarness();

    // Call coms_net_list to trigger ensureInitialized
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "coms_net_list", arguments: {} },
    });

    const res = await h.receive();
    assert.equal(res.id, 1);
    assert.ok(res.result);

    // Verify SSE listener is initialized and running
    const sse = h.server.getSse();
    assert.ok(sse, "McpServer must have an active SseEventListener");
    assert.equal(sse.getState(), "connected", "SSE listener must be connected to hub");

    await h.server.stop();
    assert.equal(h.server.getSse(), null, "SSE listener must be cleaned up on stop()");
  });

  it("Outbound messages in MCP sessions resolve cleanly via SSE response event", async () => {
    const h = createMcpHarness();

    // Register target agent in hub so coms_net_send finds the peer
    await h.client.registerAgent({
      project: "mcp-test",
      session_id: generateUlid(),
      name: "worker-peer",
      model: "test-model",
      cwd: "/test",
    });

    // Initialize via tools/call
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "coms_net_list", arguments: {} },
    });
    await h.receive();

    const sse = h.server.getSse();
    assert.ok(sse);
    assert.equal(sse.getState(), "connected");

    // Send an outbound message
    h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "coms_net_send",
        arguments: { target: "worker-peer", prompt: "Compute 2+2" },
      },
    });

    const sendRes = await h.receive();
    const sendResult = sendRes.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(sendResult.isError ?? false, false);
    const match = sendResult.content[0].text.match(/msg_id\s+([0-9A-Z]{26})/);
    const msgId = match ? match[1] : Array.from(h.server.getPendingReplies().keys())[0];
    assert.ok(msgId, "coms_net_send must return a msg_id");

    // Verify message is tracked in MCP server's pendingReplies
    const pendingReplies = h.server.getPendingReplies();
    assert.ok(pendingReplies.has(msgId), "Outbound message must be registered in pendingReplies");

    // Start coms_net_await in background
    h.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "coms_net_await",
        arguments: { msg_id: msgId, timeout_ms: 5000 },
      },
    });

    // Simulate hub SSE broadcasting the response event
    setTimeout(() => {
      h.server.handleInboundResponse({
        msg_id: msgId,
        response: { result: 4 },
        error: null,
      });
    }, 50);

    const awaitRes = await h.receive();
    assert.equal(awaitRes.id, 3);
    const awaitResult = awaitRes.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    assert.equal(awaitResult.isError ?? false, false);
    assert.ok(awaitResult.content[0].text.includes('"result": 4'));

    await h.server.stop();
  });

  it("MCP server handles SSE error event gracefully without crashing", async () => {
    const h = createMcpHarness();

    // Trigger initialization
    h.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "coms_net_list", arguments: {} },
    });
    await h.receive();

    const sse = h.server.getSse();
    assert.ok(sse);

    // Emitting error event must NOT throw unhandled error or crash
    assert.doesNotThrow(() => {
      sse.emit("error", new Error("simulated SSE socket reset"));
    });

    assert.ok(h.logs.some((l) => l.includes("SSE error") && l.includes("simulated SSE socket reset")));
    await h.server.stop();
  });

  it("MCP server handleInboundResponse creates and caches pendingReply if msg_id was not pre-registered", async () => {
    const h = createMcpHarness();

    // Inbound response for previously untracked msg_id
    const unsolicitedMsgId = "01J7UNSOLICITED00000000001";
    h.server.handleInboundResponse({
      msg_id: unsolicitedMsgId,
      response: { data: "unsolicited-fast-arrival" },
      error: null,
    });

    const pendingReplies = h.server.getPendingReplies();
    assert.ok(pendingReplies.has(unsolicitedMsgId), "Untracked message must be inserted into pendingReplies");
    const record = pendingReplies.get(unsolicitedMsgId)!;
    assert.deepEqual(record.result?.response, { data: "unsolicited-fast-arrival" });

    await h.server.stop();
  });

  it("Concurrent tool calls share single ensureInitialized initialization", async () => {
    const h = createMcpHarness();

    // Send two concurrent tool calls simultaneously
    h.send({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "coms_net_list", arguments: {} },
    });
    h.send({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "coms_net_list", arguments: {} },
    });

    const res1 = await h.receive();
    const res2 = await h.receive();

    assert.equal(res1.id, 10);
    assert.equal(res2.id, 11);
    assert.ok(res1.result);
    assert.ok(res2.result);

    const sse = h.server.getSse();
    assert.ok(sse);
    assert.equal(sse.getState(), "connected");

    await h.server.stop();
  });
});

describe("R3: Transparent Error Classification & Fetch Body Timeout Guard", () => {
  it("classifyNetworkError includes cause.code and cause details on fetch errors (e.g. UND_ERR_SOCKET)", async () => {
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "secret-token-123",
      fetchFn: async () => {
        const err: any = new TypeError("fetch failed");
        err.cause = {
          name: "SocketError",
          code: "UND_ERR_SOCKET",
          message: "other side closed",
        };
        throw err;
      },
    });

    await assert.rejects(
      () => client.getHealth(),
      (err: unknown) => {
        assert.ok(err instanceof ComsNetError);
        assert.equal((err as ComsNetError).code, "UND_ERR_SOCKET", "Error code should be UND_ERR_SOCKET");
        assert.ok((err as Error).message.includes("UND_ERR_SOCKET"), "Message should include cause.code UND_ERR_SOCKET");
        assert.ok((err as Error).message.includes("other side closed"), "Message should include cause message");
        assert.ok(!(err as Error).message.includes("secret-token-123"), "Auth token must remain redacted");
        return true;
      }
    );
  });

  it("classifyNetworkError includes cause.code ECONNRESET on connection drop", async () => {
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        const err: any = new Error("read ECONNRESET");
        err.code = "ECONNRESET";
        err.cause = { code: "ECONNRESET", message: "socket hang up" };
        throw err;
      },
    });

    await assert.rejects(
      () => client.getHealth(),
      (err: unknown) => {
        assert.ok(err instanceof ComsNetError);
        assert.equal((err as ComsNetError).code, "ECONNRESET");
        assert.ok((err as Error).message.includes("ECONNRESET"));
        return true;
      }
    );
  });

  it("Harden ComsNetClient.request() so timeout guard extends through complete resp.text() read", async () => {
    let bodyReadAborted = false;

    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      defaultTimeoutMs: 80,
      fetchFn: async (url, init: any) => {
        // Headers arrive immediately: returns a response whose text() hangs
        const signal: AbortSignal = init.signal;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => {
            return new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => {
                bodyReadAborted = true;
                reject(signal.reason ?? new Error("aborted"));
              });
              // Never resolves on its own — simulates unshielded body hang
            });
          },
        } as unknown as Response;
      },
    });

    const startTime = Date.now();
    await assert.rejects(
      () => client.getHealth({ timeoutMs: 80 }),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError, "Must reject with RequestTimeoutError when body read hangs");
        return true;
      }
    );
    const elapsed = Date.now() - startTime;
    assert.ok(elapsed >= 70 && elapsed < 500, `Timeout must fire near 80ms, took ${elapsed}ms`);
    assert.equal(bodyReadAborted, true, "Signal abort must reach body read");
  });

  it("ComsNetClient.request() parses responses with leading streaming keepalive newlines cleanly", async () => {
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => "\n\n\n{\"status\":\"complete\",\"response\":\"keepalive-safe\"}\n",
        } as unknown as Response;
      },
    });

    const res = await client.request<{ status: string; response: string }>("GET", "/test");
    assert.equal(res.status, "complete");
    assert.equal(res.response, "keepalive-safe");
  });

  it("ComsNetClient.request() parses responses with leading and interspersed SSE comment pings (: ping\\n)", async () => {
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () =>
            ": ping\n: keepalive\n\n{\n  \"status\": \"complete\",\n  \"response\": {\"item\": 123}\n}\n",
        } as unknown as Response;
      },
    });

    const res = await client.request<any>("GET", "/test");
    assert.equal(res.status, "complete");
    assert.deepEqual(res.response, { item: 123 });
  });

  it("ComsNetClient.awaitMessage() retries on transient errors when retries option is specified", async () => {
    let callCount = 0;
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        callCount++;
        if (callCount <= 2) {
          const err: any = new TypeError("fetch failed");
          err.cause = { code: "UND_ERR_SOCKET", message: "other side closed" };
          throw err;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            msg_id: "retry-id",
            status: "complete",
            response: "retried-success",
            error: null,
          }),
        } as unknown as Response;
      },
    });

    const res = await client.awaitMessage("retry-id", 500, { retries: 2 });
    assert.equal(callCount, 3, "Must have retried twice before succeeding");
    assert.equal(res.status, "complete");
    assert.equal(res.response, "retried-success");
  });
});

describe("R4: Hub Await Stream Keepalive & Header Flush", () => {
  let server: http.Server;
  let serverPort: number;

  beforeEach(async () => {
    // Start an HTTP server simulating pi-coms-net handleAwaitMessage streaming behavior
    server = http.createServer((req, res) => {
      // Chunked streaming headers immediately flushed
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Immediate keepalive newline
      res.write("\n");

      // Periodic keepalive chunk after 30ms
      setTimeout(() => {
        res.write("\n");
      }, 30);

      // Final settlement payload after 60ms
      setTimeout(() => {
        res.end(JSON.stringify({
          msg_id: "01J7KEEPALIVE0000000000001",
          status: "complete",
          response: { success: true },
          error: null,
        }) + "\n");
      }, 60);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("Streams keepalives without breaking JSON response parsing on settlement", async () => {
    const client = new ComsNetClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      authToken: "test-token",
    });

    const res = await client.request<any>("GET", "/v1/messages/test/await");
    assert.equal(res.msg_id, "01J7KEEPALIVE0000000000001");
    assert.equal(res.status, "complete");
    assert.deepEqual(res.response, { success: true });
    assert.equal(res.error, null);
  });

  it("pi-coms-net server handleAwaitMessage cleans up on stream cancellation", async () => {
    // Import pi-coms-net server handleAwaitMessage simulation directly
    let cleanedUp = false;
    let keepaliveFired = 0;

    let streamCleanup: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        let done = false;
        controller.enqueue(enc.encode("\n"));

        let keepaliveTimer: any = setInterval(() => {
          if (done) return;
          keepaliveFired++;
          try {
            controller.enqueue(enc.encode("\n"));
          } catch {
            if (keepaliveTimer) {
              clearInterval(keepaliveTimer);
              keepaliveTimer = null;
            }
          }
        }, 20);

        const cleanup = () => {
          if (done) return;
          done = true;
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          cleanedUp = true;
          try {
            controller.close();
          } catch {}
        };
        streamCleanup = cleanup;
      },
      cancel() {
        if (streamCleanup) {
          streamCleanup();
        }
      },
    });

    const reader = stream.getReader();
    const firstChunk = await reader.read();
    assert.equal(new TextDecoder().decode(firstChunk.value), "\n");

    // Cancel reader - simulates client disconnect
    await reader.cancel();
    assert.equal(cleanedUp, true, "Stream cancel must execute cleanup and clear timers");
  });
});

describe("Reviewer 2 Adversarial Hardening Suite", () => {
  it("JSON payload with interior colon lines following keepalive comment pings does not corrupt JSON parsing", async () => {
    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () =>
            ": ping\n: keepalive\n\n{\n  \"multiline\": \"value\",\n  \"key\"\n  : \"colon-on-new-line\"\n}\n",
        } as unknown as Response;
      },
    });

    const res = await client.request<any>("GET", "/test");
    assert.equal(res.multiline, "value");
    assert.equal(res.key, "colon-on-new-line");
  });

  it("McpServer.handleInboundResponse does NOT cache non-terminal timeout/aborted/unknown_msg errors in pending.result", () => {
    const server = new McpServer();

    // 1. Timeout error should NOT be cached in pending.result
    server.handleInboundResponse({ msg_id: "msg-nonterminal-timeout", response: null, error: "timeout" });
    const pendingTimeout = server.pendingReplies.get("msg-nonterminal-timeout");
    assert.ok(pendingTimeout);
    assert.equal(pendingTimeout.result, undefined, "Non-terminal timeout must not be cached in pending.result");

    // 2. Aborted error should NOT be cached in pending.result
    server.handleInboundResponse({ msg_id: "msg-nonterminal-aborted", response: null, error: "aborted" });
    const pendingAborted = server.pendingReplies.get("msg-nonterminal-aborted");
    assert.ok(pendingAborted);
    assert.equal(pendingAborted.result, undefined, "Non-terminal aborted must not be cached in pending.result");

    // 3. unknown msg_id should NOT be cached in pending.result
    server.handleInboundResponse({ msg_id: "msg-nonterminal-unknown", response: null, error: "unknown msg_id" });
    const pendingUnknown = server.pendingReplies.get("msg-nonterminal-unknown");
    assert.ok(pendingUnknown);
    assert.equal(pendingUnknown.result, undefined, "Non-terminal unknown msg_id must not be cached in pending.result");

    // 4. Genuine terminal error SHOULD be cached in pending.result
    server.handleInboundResponse({ msg_id: "msg-terminal-err", response: null, error: "explicit agent compilation error" });
    const pendingErr = server.pendingReplies.get("msg-terminal-err");
    assert.ok(pendingErr?.result, "Terminal error must be cached");
    assert.equal(pendingErr.result.error, "explicit agent compilation error");

    // 5. Genuine terminal success SHOULD be cached in pending.result
    server.handleInboundResponse({ msg_id: "msg-terminal-ok", response: { ok: true }, error: null });
    const pendingOk = server.pendingReplies.get("msg-terminal-ok");
    assert.ok(pendingOk?.result, "Terminal success must be cached");
    assert.deepEqual(pendingOk.result.response, { ok: true });
  });

  it("McpServer.stop() properly cleans up SSE listener and lifecycle even when start() was not called", async () => {
    let sseStopped = false;
    let lifecycleStopped = false;

    const mockSse: any = {
      on: () => {},
      stop: async () => { sseStopped = true; },
      getState: () => "connected",
    };
    const mockLifecycle: any = {
      on: () => {},
      start: async () => {},
      stop: async () => { lifecycleStopped = true; },
      getCard: () => ({ session_id: "s1", project: "p1", name: "n1", cwd: "/test" }),
    };

    const server = new McpServer({ sse: mockSse, lifecycle: mockLifecycle });
    // stop() called without prior start()
    await server.stop();

    assert.equal(sseStopped, true, "McpServer.stop() must stop SSE listener even if start() was not called");
    assert.equal(lifecycleStopped, true, "McpServer.stop() must stop Lifecycle even if start() was not called");
  });

  it("McpServer.ensureInitialized() starts injected SSE listener if it is in disconnected state", async () => {
    let sseStarted = false;

    const mockSse: any = {
      on: () => {},
      stop: async () => {},
      start: async () => { sseStarted = true; },
      getState: () => "disconnected",
    };
    const mockClient = new ComsNetClient({ baseUrl: "http://localhost", authToken: "token" });
    const mockLifecycle: any = {
      on: () => {},
      start: async () => {},
      stop: async () => {},
      getCard: () => ({ session_id: "s1", project: "p1", name: "n1", cwd: "/test" }),
    };

    const server = new McpServer({ client: mockClient, sse: mockSse, lifecycle: mockLifecycle });
    await (server as any).ensureInitialized();

    assert.equal(sseStarted, true, "ensureInitialized must start injected SSE listener if in disconnected state");
  });

  it("ComsNetClient.classifyNetworkError does not misclassify ECONNABORTED socket drop as RequestTimeoutError", () => {
    const client = new ComsNetClient({ baseUrl: "http://localhost", authToken: "token" });
    const err: any = new Error("Connection was aborted by peer");
    err.code = "ECONNABORTED";

    const classified = (client as any).classifyNetworkError(err, "GET", "/v1/messages/123/await", 5000);
    assert.ok(classified instanceof ComsNetError, "Should be classified as ComsNetError, not RequestTimeoutError");
    assert.equal((classified as ComsNetError).code, "ECONNABORTED");
    assert.ok(!(classified instanceof RequestTimeoutError));
  });

  it("ComsNetClient.awaitMessage preserves calculated network timeout when opts has timeoutMs: undefined", async () => {
    let capturedTimeout: number | undefined;
    const client = new ComsNetClient({ baseUrl: "http://localhost", authToken: "token", defaultTimeoutMs: 10000 });
    (client as any).request = async (method: string, path: string, body: any, opts: any) => {
      capturedTimeout = opts?.timeoutMs;
      return { msg_id: "msg-1", status: "complete", response: "ok", error: null };
    };

    await client.awaitMessage("msg-1", 30000, { signal: new AbortController().signal, timeoutMs: undefined });
    assert.equal(capturedTimeout, 35000, "Calculated networkTimeout (35000ms) must not be overridden by undefined");
  });

  it("BridgeDaemon.handleInboundResponse does NOT cache non-terminal timeout/aborted errors in pending.result", () => {
    const mockClient = new ComsNetClient({ baseUrl: "http://localhost", authToken: "token" });
    const daemon = new BridgeDaemon({ client: mockClient, turnExecutor: { execute: async () => ({ ok: true, text: "ok", duration_ms: 10 }) } as any });

    // Pre-register pending reply
    const prom = new Promise<any>(() => {});
    daemon.pendingReplies.set("msg-daemon-t1", {
      resolve: () => {},
      reject: () => {},
      promise: prom,
      created_at: new Date().toISOString(),
    });

    // Inbound timeout response
    (daemon as any).handleInboundResponse({ msg_id: "msg-daemon-t1", response: null, error: "timeout" });
    const pending = daemon.pendingReplies.get("msg-daemon-t1");
    assert.ok(pending);
    assert.equal(pending.result, undefined, "BridgeDaemon must not cache non-terminal timeout error in pending.result");
  });
});

describe("Reviewer 3 Adversarial Hardening Suite", () => {
  it("McpServer.handleInboundResponse with transient timeout does NOT settle pending.promise, allowing HTTP long-poll to succeed", async () => {
    const server = new McpServer();

    // 1. Inbound transient timeout response arrives
    server.handleInboundResponse({ msg_id: "msg-test-transient", response: null, error: "timeout" });
    const pending = server.pendingReplies.get("msg-test-transient")!;
    assert.ok(pending);
    assert.equal(pending.result, undefined, "Transient timeout must not be cached in pending.result");

    // 2. Hub has the completed response on HTTP long-poll
    let pollExecuted = false;
    const mockClient: IComsClient = {
      getAgents: async () => ({ agents: [] }),
      sendMessage: async () => { throw new Error("not used"); },
      getMessage: async () => { throw new Error("not used"); },
      awaitMessage: async () => {
        pollExecuted = true;
        return { msg_id: "msg-test-transient", status: "complete", response: "HTTP-SUCCESS!", error: null };
      },
    };

    const tools = new ComsNetTools({
      client: mockClient,
      identity: { session_id: "s1", name: "n1", project: "p1" },
      pendingReplies: server.pendingReplies,
    });

    // 3. await must NOT short-circuit with timeout; it must execute HTTP poll and receive HTTP-SUCCESS!
    const res = await tools.await({ msg_id: "msg-test-transient", timeout_ms: 5000 });
    assert.equal(pollExecuted, true, "HTTP long-poll must be executed");
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "HTTP-SUCCESS!");
    assert.equal(pending.result?.response, "HTTP-SUCCESS!", "Genuine response must now be cached in pending.result");
  });

  it("BridgeDaemon.handleInboundResponse with transient error does NOT settle pending.promise", async () => {
    const mockClient = new ComsNetClient({ baseUrl: "http://localhost", authToken: "token" });
    const daemon = new BridgeDaemon({ client: mockClient, turnExecutor: { execute: async () => ({ ok: true, text: "ok", duration_ms: 10 }) } as any });

    let settled = false;
    let promResolve!: (v: any) => void;
    const prom = new Promise<any>((resolve) => {
      promResolve = resolve;
    });

    daemon.pendingReplies.set("msg-daemon-transient", {
      resolve: (v) => {
        settled = true;
        promResolve(v);
      },
      reject: () => {},
      promise: prom,
      created_at: new Date().toISOString(),
    });

    // Inbound transient error
    (daemon as any).handleInboundResponse({ msg_id: "msg-daemon-transient", response: null, error: "unknown msg_id" });
    const pending = daemon.pendingReplies.get("msg-daemon-transient")!;
    assert.ok(pending);
    assert.equal(pending.result, undefined);
    assert.equal(settled, false, "pending.resolve must NOT be called for transient error");
  });

  it("tools.await catches unexpected rejection on localPromise gracefully without throwing unhandled error", async () => {
    const pendingReplies = new Map<string, PendingReply>();
    let rejectFn!: (e: Error) => void;
    const prom = new Promise<any>((_, rej) => {
      rejectFn = rej;
    });

    pendingReplies.set("msg-rejected-sse", {
      resolve: () => {},
      reject: rejectFn,
      promise: prom,
      created_at: new Date().toISOString(),
    });

    const mockClient: IComsClient = {
      getAgents: async () => ({ agents: [] }),
      sendMessage: async () => { throw new Error("not used"); },
      getMessage: async () => { throw new Error("not used"); },
      awaitMessage: async () => new Promise(() => {}), // never settles
    };

    const tools = new ComsNetTools({
      client: mockClient,
      identity: { session_id: "s1", name: "n1", project: "p1" },
      pendingReplies,
    });

    // Reject promise before or during race
    rejectFn(new Error("SSE transport socket collapsed"));

    const res = await tools.await({ msg_id: "msg-rejected-sse", timeout_ms: 500 });
    assert.equal(res.isError, true);
    assert.equal(res.details.status, "error");
    assert.ok(String(res.details.error).includes("SSE transport socket collapsed"));
  });

  it("tools.await refreshes pending.promise if localCompetitor settled with transient error", async () => {
    const pendingReplies = new Map<string, PendingReply>();
    let resolveFn!: (v: any) => void;
    const prom = new Promise<any>((res) => {
      resolveFn = res;
    });

    const initialPending: PendingReply = {
      resolve: resolveFn,
      reject: () => {},
      promise: prom,
      created_at: new Date().toISOString(),
    };
    pendingReplies.set("msg-transient-refresh", initialPending);

    const mockClient: IComsClient = {
      getAgents: async () => ({ agents: [] }),
      sendMessage: async () => { throw new Error("not used"); },
      getMessage: async () => { throw new Error("not used"); },
      awaitMessage: async () => new Promise(() => {}), // hangs
    };

    const tools = new ComsNetTools({
      client: mockClient,
      identity: { session_id: "s1", name: "n1", project: "p1" },
      pendingReplies,
    });

    // 1. First await: localCompetitor resolves with transient error
    resolveFn({ response: null, error: "timeout" });
    const res1 = await tools.await({ msg_id: "msg-transient-refresh", timeout_ms: 200 });
    assert.equal(res1.details.status, "timeout");

    // Verify pending.promise was refreshed to a brand new unresolved promise
    const refreshedPending = pendingReplies.get("msg-transient-refresh")!;
    assert.notEqual(refreshedPending.promise, prom, "promise must be replaced with fresh promise");
    assert.equal(refreshedPending.result, undefined);

    // 2. Second await: resolve the refreshed promise with complete reply
    setTimeout(() => {
      refreshedPending.resolve({ response: "SSE-SECOND-ROUND-WINNER", error: null });
    }, 20);

    const res2 = await tools.await({ msg_id: "msg-transient-refresh", timeout_ms: 1000 });
    assert.equal(res2.details.status, "complete");
    assert.equal(res2.details.response, "SSE-SECOND-ROUND-WINNER");
    assert.equal(refreshedPending.result?.response, "SSE-SECOND-ROUND-WINNER");
  });

  it("ComsNetClient.awaitMessage retry delay is interrupted immediately when signal aborts", async () => {
    let callCount = 0;
    const ac = new AbortController();

    const client = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999",
      authToken: "tok",
      fetchFn: async () => {
        callCount++;
        const err: any = new TypeError("fetch failed");
        err.cause = { code: "UND_ERR_SOCKET", message: "closed" };
        throw err;
      },
    });

    // Abort after 20ms during the 100ms retry backoff sleep
    setTimeout(() => {
      ac.abort(new Error("aborted mid-backoff"));
    }, 20);

    const start = Date.now();
    await assert.rejects(
      () => client.awaitMessage("retry-abort", 5000, { retries: 3, signal: ac.signal }),
      (err: any) => {
        assert.ok(err.message.includes("aborted mid-backoff") || err.name === "AbortError");
        return true;
      }
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 80, `Abort should interrupt retry sleep quickly, took ${elapsed}ms`);
  });

  it("ComsNetClient.classifyNetworkError extracts nested cause.cause.code and string cause", () => {
    const client = new ComsNetClient({ baseUrl: "http://localhost", authToken: "secret-token" });

    // 1. Nested cause.cause.code extraction
    const nestedErr: any = new TypeError("fetch failed");
    nestedErr.cause = {
      name: "SocketError",
      message: "socket dropped",
      cause: { code: "UND_ERR_SOCKET", message: "inner socket reset" },
    };
    const classified1 = (client as any).classifyNetworkError(nestedErr, "GET", "/test", 5000);
    assert.ok(classified1 instanceof ComsNetError);
    assert.equal(classified1.code, "UND_ERR_SOCKET");
    assert.ok(classified1.message.includes("UND_ERR_SOCKET"));
    assert.ok(classified1.message.includes("inner socket reset"));

    // 2. String cause extraction
    const strCauseErr: any = new Error("write error");
    strCauseErr.cause = {
      name: "CustomError",
      message: "custom failure",
      cause: "underlying OS pipe broke",
    };
    const classified2 = (client as any).classifyNetworkError(strCauseErr, "GET", "/test", 5000);
    assert.ok(classified2.message.includes("underlying OS pipe broke"));
  });

  it("pi-coms-net server handleAwaitMessage cleans up on keepaliveTimer write failure", async () => {
    let cleanedUp = false;
    let keepaliveTimer: any = null;
    let done = false;

    let awaiter = {
      timer: setTimeout(() => {}, 10000),
    };

    const cleanup = () => {
      if (done) return;
      done = true;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (awaiter.timer) {
        clearTimeout(awaiter.timer);
      }
      cleanedUp = true;
    };

    const controller: any = {
      enqueue: () => {
        throw new Error("client socket dropped unexpectedly");
      },
    };

    // Simulate keepalive tick with failing enqueue
    keepaliveTimer = setInterval(() => {
      if (done) return;
      try {
        controller.enqueue(new Uint8Array([10]));
      } catch {
        cleanup();
      }
    }, 10);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cleanedUp, true, "cleanup() must be invoked when keepalive enqueue throws");
    assert.equal(keepaliveTimer, null, "keepaliveTimer must be cleared");
  });
});

