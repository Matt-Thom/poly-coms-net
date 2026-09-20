/**
 * src/protocol/client.ts
 *
 * Authenticated HTTP REST Client for coms-net hub.
 * Implements all 9 REST endpoints, Bearer auth injection, AbortController timeouts,
 * unref timers, dual-signal cancellation, and 2-stage connectivity validation.
 */

import type {
  AgentCard,
  HealthResponse,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  ListAgentsParams,
  ListAgentsResponse,
  SendRequest,
  SendResponse,
  GetMessageResponse,
  AwaitMessageParams,
  AwaitMessageResponse,
  ResponseSubmitRequest,
  DeleteAgentParams,
  ConnectivityValidation,
} from "./types.ts";
import {
  ComsNetError,
  ComsNetHttpError,
  ConnectionRefusedError,
  RequestTimeoutError,
  parseHttpError,
  redactToken,
} from "./errors.ts";

export * from "./errors.ts";

export interface ClientConfig {
  baseUrl: string;
  authToken: string;
  project?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  retries?: number;
}

export class ComsNetClient {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly project: string;
  readonly defaultTimeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ClientConfig) {
    if (!config.baseUrl) {
      throw new ComsNetError("ComsNetClient requires baseUrl");
    }
    // Strip trailing slash for consistent URL joins
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authToken = config.authToken || "";
    this.project = config.project ?? "default";
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Core request dispatcher with header injection, timeout orchestration,
   * error classification, and token scrubbing.
   */
  async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    opts?: RequestOptions,
    isPublic = false
  ): Promise<T> {
    const url = `${this.baseUrl}${urlPath}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...opts?.headers,
    };

    if (!isPublic && this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      serializedBody = JSON.stringify(body);
    }

    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const ac = new AbortController();
    let timer: NodeJS.Timeout | null = null;

    if (timeoutMs > 0 && timeoutMs !== Infinity) {
      timer = setTimeout(() => {
        ac.abort(new RequestTimeoutError(method, urlPath, timeoutMs, this.authToken));
      }, timeoutMs);
      try {
        (timer as { unref?: () => void }).unref?.();
      } catch {
        // Ignore environments where unref is not supported
      }
    }

    let removeExternalAbort: (() => void) | null = null;
    if (opts?.signal) {
      if (opts.signal.aborted) {
        if (timer) clearTimeout(timer);
        ac.abort(opts.signal.reason);
      } else {
        const onAbort = () => ac.abort(opts.signal?.reason);
        opts.signal.addEventListener("abort", onAbort, { once: true });
        removeExternalAbort = () => opts.signal?.removeEventListener("abort", onAbort);
      }
    }

    let resp: Response;
    let rawText: string;
    try {
      resp = await this.fetchFn(url, {
        method,
        headers,
        body: serializedBody,
        signal: ac.signal,
      });

      // Guard response body read against timeout & abort
      if (ac.signal.aborted) {
        try {
          resp.body?.cancel?.().catch?.(() => {});
        } catch {
          // ignore
        }
        throw ac.signal.reason ?? new RequestTimeoutError(method, urlPath, timeoutMs, this.authToken);
      }

      const bodyPromise = resp.text();
      rawText = await (ac.signal.aborted
        ? (() => {
            try {
              resp.body?.cancel?.().catch?.(() => {});
            } catch {
              // ignore
            }
            return Promise.reject(
              ac.signal.reason ??
                new RequestTimeoutError(method, urlPath, timeoutMs, this.authToken)
            );
          })()
        : new Promise<string>((resolve, reject) => {
            const onAbort = () => {
              try {
                resp.body?.cancel?.().catch?.(() => {});
              } catch {
                // ignore
              }
              reject(
                ac.signal.reason ??
                  new RequestTimeoutError(method, urlPath, timeoutMs, this.authToken)
              );
            };
            ac.signal.addEventListener("abort", onAbort, { once: true });
            bodyPromise.then(
              (txt) => {
                ac.signal.removeEventListener("abort", onAbort);
                resolve(txt);
              },
              (err) => {
                ac.signal.removeEventListener("abort", onAbort);
                reject(err);
              }
            );
          }));
    } catch (err: unknown) {
      if (ac.signal.aborted && ac.signal.reason instanceof RequestTimeoutError) {
        throw ac.signal.reason;
      }
      if (opts?.signal?.aborted) {
        throw opts.signal.reason ?? new Error("Operation aborted");
      }
      if (ac.signal.aborted && !opts?.signal?.aborted) {
        throw ac.signal.reason instanceof RequestTimeoutError
          ? ac.signal.reason
          : new RequestTimeoutError(method, urlPath, timeoutMs, this.authToken);
      }
      throw this.classifyNetworkError(err, method, urlPath, timeoutMs);
    } finally {
      if (timer) clearTimeout(timer);
      if (removeExternalAbort) removeExternalAbort();
    }

    let parsed: unknown = null;
    let jsonText = rawText.trimStart();
    while (jsonText.startsWith(":")) {
      const newlineIdx = jsonText.indexOf("\n");
      if (newlineIdx === -1) {
        jsonText = "";
        break;
      }
      jsonText = jsonText.slice(newlineIdx + 1).trimStart();
    }
    jsonText = jsonText.trimEnd();
    if (jsonText.length > 0) {
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        parsed = rawText;
      }
    }

    if (!resp.ok) {
      throw parseHttpError(resp.status, parsed, method, urlPath, this.authToken);
    }

    return parsed as T;
  }

  // ━━ Public Endpoint Methods ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** GET /health (Unauthenticated liveness probe) */
  async getHealth(opts?: RequestOptions): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, { timeoutMs: 5_000, ...opts }, true);
  }

  /** POST /v1/agents/register (Agent presence registration & upsert) */
  async registerAgent(req: RegisterRequest, opts?: RequestOptions): Promise<RegisterResponse> {
    return this.request<RegisterResponse>("POST", "/v1/agents/register", req, opts);
  }

  /** POST /v1/agents/:session_id/heartbeat (Periodic liveness ping) */
  async sendHeartbeat(
    sessionId: string,
    req: HeartbeatRequest = {},
    opts?: RequestOptions
  ): Promise<{ ok: true }> {
    const path = `/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`;
    const payload: HeartbeatRequest = {
      project: this.project,
      ...req,
    };
    return this.request<{ ok: true }>("POST", path, payload, { timeoutMs: 5_000, ...opts });
  }

  /** GET /v1/agents (List active peer agents) */
  async listAgents(params?: ListAgentsParams, opts?: RequestOptions): Promise<ListAgentsResponse> {
    const qs = new URLSearchParams();
    qs.set("project", params?.project ?? this.project);
    if (params?.include_explicit) {
      qs.set("include_explicit", "true");
    }
    return this.request<ListAgentsResponse>("GET", `/v1/agents?${qs.toString()}`, undefined, opts);
  }

  /** Convenience wrapper matching IComsClient */
  async getAgents(
    project?: string,
    includeExplicit?: boolean,
    opts?: RequestOptions
  ): Promise<ListAgentsResponse> {
    return this.listAgents({ project: project ?? this.project, include_explicit: includeExplicit }, opts);
  }

  /** POST /v1/messages (Deliver outbound prompt) */
  async sendMessage(req: SendRequest, opts?: RequestOptions): Promise<SendResponse> {
    const payload: SendRequest = {
      project: this.project,
      ...req,
    };
    return this.request<SendResponse>("POST", "/v1/messages", payload, opts);
  }

  /** GET /v1/messages/:msg_id (Non-blocking status poll) */
  async getMessage(msgId: string, opts?: RequestOptions): Promise<GetMessageResponse> {
    const path = `/v1/messages/${encodeURIComponent(msgId)}`;
    return this.request<GetMessageResponse>("GET", path, undefined, opts);
  }

  /**
   * GET /v1/messages/:msg_id/await (HTTP long-poll wait)
   * Client network timeout is automatically set to timeout_ms + 5,000ms buffer.
   */
  async awaitMessage(
    msgId: string,
    params?: AwaitMessageParams | number,
    optsOrSignal?: RequestOptions | AbortSignal
  ): Promise<AwaitMessageResponse> {
    let timeoutMs = 30_000;
    let reqOpts: RequestOptions | undefined;

    if (typeof params === "number") {
      timeoutMs = params;
    } else if (params && typeof params.timeout_ms === "number") {
      timeoutMs = params.timeout_ms;
    }

    if (optsOrSignal) {
      if (optsOrSignal instanceof AbortSignal) {
        reqOpts = { signal: optsOrSignal };
      } else {
        reqOpts = optsOrSignal;
      }
    }

    const networkTimeout = timeoutMs + 5_000;
    const qs = new URLSearchParams({ timeout_ms: String(timeoutMs) });
    const path = `/v1/messages/${encodeURIComponent(msgId)}/await?${qs.toString()}`;

    const maxRetries = reqOpts?.retries ?? 0;
    let attempt = 0;
    while (true) {
      try {
        return await this.request<AwaitMessageResponse>(
          "GET",
          path,
          undefined,
          {
            ...reqOpts,
            timeoutMs: reqOpts?.timeoutMs ?? networkTimeout,
          }
        );
      } catch (err: unknown) {
        attempt++;
        if (
          attempt > maxRetries ||
          reqOpts?.signal?.aborted ||
          err instanceof RequestTimeoutError
        ) {
          throw err;
        }
        if (reqOpts?.signal?.aborted) {
          throw reqOpts.signal.reason ?? err;
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 100);
          if (reqOpts?.signal) {
            const onAbort = () => {
              clearTimeout(t);
              resolve();
            };
            reqOpts.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        if (reqOpts?.signal?.aborted) {
          throw reqOpts.signal.reason ?? err;
        }
      }
    }
  }

  /** POST /v1/messages/:msg_id/response (Submit assistant turn output) */
  async submitResponse(
    msgId: string,
    req: ResponseSubmitRequest,
    opts?: RequestOptions
  ): Promise<{ ok: true }> {
    const path = `/v1/messages/${encodeURIComponent(msgId)}/response`;
    const payload: ResponseSubmitRequest = {
      project: this.project,
      ...req,
    };
    return this.request<{ ok: true }>("POST", path, payload, opts);
  }

  /** DELETE /v1/agents/:session_id (Graceful unregister on exit) */
  async deleteAgent(
    sessionId: string,
    params?: DeleteAgentParams,
    opts?: RequestOptions
  ): Promise<{ ok: true }> {
    const qs = new URLSearchParams({ project: params?.project ?? this.project });
    const path = `/v1/agents/${encodeURIComponent(sessionId)}?${qs.toString()}`;
    return this.request<{ ok: true }>("DELETE", path, undefined, { timeoutMs: 2_000, ...opts });
  }

  // ━━ Diagnostics & Connectivity Verification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Validates both hub reachability and token authentication in two phases.
   */
  async validateConnectivity(opts?: RequestOptions): Promise<ConnectivityValidation> {
    let health: HealthResponse;
    try {
      health = await this.getHealth(opts);
    } catch (err) {
      if (err instanceof ConnectionRefusedError) {
        return {
          reachable: false,
          authenticated: false,
          error: `Hub unreachable at ${this.baseUrl}: connection refused`,
        };
      }
      return {
        reachable: false,
        authenticated: false,
        error: `Hub health check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      await this.listAgents({ project: this.project }, opts);
      return {
        reachable: true,
        authenticated: true,
        serverId: health.server_id,
        version: health.version,
        startedAt: health.started_at,
      };
    } catch (err) {
      if (err instanceof ComsNetHttpError && err.status === 401) {
        return {
          reachable: true,
          authenticated: false,
          serverId: health.server_id,
          version: health.version,
          startedAt: health.started_at,
          error: "Authentication failed: invalid Bearer token",
        };
      }
      return {
        reachable: true,
        authenticated: false,
        serverId: health.server_id,
        version: health.version,
        startedAt: health.started_at,
        error: `Authenticated probe failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ━━ Internal Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private classifyNetworkError(
    err: unknown,
    method: string,
    url: string,
    timeoutMs: number
  ): Error {
    if (err instanceof ComsNetError) return err;

    const errorObj = err as {
      name?: string;
      message?: string;
      code?: string;
      cause?: unknown;
    };
    const message = errorObj?.message ?? String(err);
    const causeObj = (errorObj?.cause && typeof errorObj.cause === "object"
      ? errorObj.cause
      : undefined) as {
      name?: string;
      message?: string;
      code?: string;
      cause?: unknown;
    } | undefined;

    const nested = (causeObj?.cause && typeof causeObj.cause === "object"
      ? causeObj.cause
      : undefined) as { name?: string; message?: string; code?: string } | undefined;

    const causeCode = causeObj?.code ?? nested?.code ?? errorObj?.code;

    if (
      causeCode === "ECONNREFUSED" ||
      message.includes("ECONNREFUSED") ||
      causeCode === "ENOTFOUND" ||
      message.includes("ENOTFOUND") ||
      causeCode === "EHOSTUNREACH" ||
      message.includes("EHOSTUNREACH") ||
      causeCode === "EADDRNOTAVAIL"
    ) {
      return new ConnectionRefusedError(
        `${this.baseUrl}${url}`,
        (causeObj as Error) ?? (err as Error),
        this.authToken
      );
    }

    const isAbortError =
      causeCode !== "ECONNABORTED" &&
      errorObj?.code !== "ECONNABORTED" &&
      (errorObj?.name === "AbortError" ||
        causeObj?.name === "AbortError" ||
        errorObj?.name === "TimeoutError" ||
        causeObj?.name === "TimeoutError" ||
        causeCode === "ABORT_ERR" ||
        message === "This operation was aborted" ||
        message === "The operation was aborted" ||
        message.includes("operation was aborted"));

    if (isAbortError) {
      return new RequestTimeoutError(method, url, timeoutMs, this.authToken);
    }

    // Retain underlying cause properties (code, name, message, nested cause)
    let details = message;
    if (causeObj) {
      const causeParts: string[] = [];
      if (causeObj.code) {
        causeParts.push(`code: ${causeObj.code}`);
      }
      if (causeObj.name && causeObj.name !== "Error" && causeObj.name !== causeObj.code) {
        causeParts.push(`name: ${causeObj.name}`);
      }
      if (causeObj.message && causeObj.message !== message) {
        causeParts.push(causeObj.message);
      }
      if (nested) {
        if (nested.code && nested.code !== causeObj.code) {
          causeParts.push(`cause code: ${nested.code}`);
        }
        if (nested.message && nested.message !== causeObj.message) {
          causeParts.push(`cause: ${nested.message}`);
        }
      } else if (typeof causeObj.cause === "string") {
        causeParts.push(`cause: ${causeObj.cause}`);
      }

      if (causeParts.length > 0) {
        details = `${message} (${causeParts.join(", ")})`;
      } else if (typeof errorObj.cause === "string") {
        details = `${message} (${errorObj.cause})`;
      }
    } else if (errorObj?.cause) {
      details = `${message} (${String(errorObj.cause)})`;
    }

    return new ComsNetError(
      redactToken(`Network request failed (${method} ${url}): ${details}`, this.authToken),
      this.authToken,
      causeCode
    );
  }
}
