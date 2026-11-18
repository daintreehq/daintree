import crypto from "node:crypto";
import type { z } from "zod";
import {
  AGENT37_INSTANCE_ID,
  agent37ActionSchema,
  agent37BillingSchema,
  agent37DeletedSchema,
  agent37ErrorEnvelopeSchema,
  agent37InstanceListSchema,
  agent37InstanceSchema,
  agent37SshKeySchema,
  type Agent37Action,
  type Agent37Billing,
  type Agent37Instance,
} from "./agent37Schemas.js";

/** The one origin a packaged build sends an Agent 37 key to. */
export const AGENT37_PRODUCTION_API_URL = "https://api.agent37.com/v1";

/** Development builds may point at another Agent 37 (a local fake for tests); packaged builds never do. */
export const AGENT37_API_URL_ENV = "DAINTREE_AGENT37_API_URL";

const REQUEST_TIMEOUT_MS = 30_000;
/** A create answers only once the instance is running. */
const CREATE_TIMEOUT_MS = 5 * 60_000;
/** A start that has to move the instance to another host answers late, or with 202. */
const START_TIMEOUT_MS = 2 * 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
/** `try_again` lasts while a sleep checkpoint is written: tens of seconds on a large instance. */
const MAX_BUSY_ATTEMPTS = 10;
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * The Agent 37 API base URL this process may use. A packaged build always
 * answers production; a development build honours {@link AGENT37_API_URL_ENV}
 * when it is an http(s) URL. Accounts record the URL they were connected
 * against, so a key saved against production is never sent to an override.
 */
export function resolveAgent37ApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return AGENT37_PRODUCTION_API_URL;
  const override = env[AGENT37_API_URL_ENV]?.trim();
  if (!override) return AGENT37_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") return AGENT37_PRODUCTION_API_URL;
    // Origin and path only: a query, fragment or userinfo would swallow every request path.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return AGENT37_PRODUCTION_API_URL;
  }
}

/** Why an Agent 37 request failed, typed so callers never match on message text. */
export type Agent37ErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "payment-required"
  | "rate-limited"
  | "conflict"
  | "no-capacity"
  | "invalid-request"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "bad-response";

export class Agent37ApiError extends Error {
  constructor(
    readonly kind: Agent37ErrorKind,
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "Agent37ApiError";
  }

  /** The instance is mid-transition (a sleep checkpoint being written): the same call can succeed shortly. */
  get busy(): boolean {
    return this.code === "try_again";
  }
}

function kindForStatus(status: number, code: string | null): Agent37ErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment-required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  // Only `no_capacity` says a create was refused for room; any other 503 proves nothing.
  if (status === 503 && code === "no_capacity") return "no-capacity";
  if (status >= 500) return "server";
  return "invalid-request";
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS)) : null;
}

/** Strips anything token-shaped from text that came back from Agent 37 before it is shown or logged. */
export function redactAgent37Text(text: string, apiKey?: string): string {
  const withoutKey = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  return (
    withoutKey
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      // Key-shaped runs after the documented prefix; error codes like `ssh_key_exists` don't start with `sk_`.
      .replace(/\bsk_[a-z]+_[A-Za-z0-9]{8,}/g, "[redacted]")
      .replace(/([?&](?:token|_token|key|sig|signature)=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 500)
  );
}

export interface Agent37RequestContext {
  apiKey: string;
  signal?: AbortSignal;
}

export interface Agent37CreateInstanceBody {
  template: string;
  type: string;
  resources: { cpu: number; memory: number; disk: number };
  name: string;
  metadata: Record<string, string>;
  auto_sleep: boolean;
  idle_timeout_seconds: number;
}

type FetchFn = typeof fetch;

export interface Agent37ClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function cancelled(): Agent37ApiError {
  return new Agent37ApiError("cancelled", "Cancelled", null, null);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireInstanceId(id: string): string {
  if (!AGENT37_INSTANCE_ID.test(id)) {
    throw new Agent37ApiError("invalid-request", "Not an Agent 37 instance id", null, null);
  }
  return id;
}

/**
 * How a request may be sent again: `never` (its outcome could double), or
 * `safe` (sending it twice is the same as once). A `safe` request is also
 * sent again for as long as Agent 37 says the instance is mid-transition,
 * which means nothing happened.
 */
type RetryPolicy = "never" | "safe";

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  retry: RetryPolicy;
  timeoutMs?: number;
}

/**
 * A narrow typed client for the parts of Agent 37's Sandbox API that Daintree
 * uses. Every request carries the account's key as a bearer token; a key is
 * bound to one workspace, so no request names a scope. Reads and idempotent
 * actions are retried with backoff; a create never is, since Agent 37 has no
 * idempotency key for it.
 */
export class Agent37Client {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: Agent37ClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async billing(ctx: Agent37RequestContext): Promise<Agent37Billing> {
    return this.call(ctx, { method: "GET", path: "/billing", retry: "safe" }, agent37BillingSchema);
  }

  /** Every instance in the key's workspace, newest first. Instances Daintree can't read are left out. */
  async listInstances(ctx: Agent37RequestContext): Promise<Agent37Instance[]> {
    const result = await this.call(
      ctx,
      { method: "GET", path: "/instances", retry: "safe" },
      agent37InstanceListSchema
    );
    const out: Agent37Instance[] = [];
    for (const raw of result.data) {
      const parsed = agent37InstanceSchema.safeParse(raw);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async getInstance(ctx: Agent37RequestContext, id: string): Promise<Agent37Instance> {
    return this.call(
      ctx,
      { method: "GET", path: `/instances/${requireInstanceId(id)}`, retry: "safe" },
      agent37InstanceSchema
    );
  }

  /** Answers once the instance is running. Never sent twice: nothing would recognise the second. */
  async createInstance(
    ctx: Agent37RequestContext,
    body: Agent37CreateInstanceBody
  ): Promise<Agent37Instance> {
    return this.call(
      ctx,
      {
        method: "POST",
        path: "/instances",
        body,
        retry: "never",
        timeoutMs: CREATE_TIMEOUT_MS,
      },
      agent37InstanceSchema
    );
  }

  /** Starts a stopped instance or wakes a sleeping one; a running one answers the same ack again. */
  async startInstance(ctx: Agent37RequestContext, id: string): Promise<Agent37Action> {
    return this.call(
      ctx,
      {
        method: "POST",
        path: `/instances/${requireInstanceId(id)}/start`,
        body: {},
        retry: "safe",
        timeoutMs: START_TIMEOUT_MS,
      },
      agent37ActionSchema
    );
  }

  /** Stopping a stopped instance answers the same ack again. */
  async stopInstance(ctx: Agent37RequestContext, id: string): Promise<Agent37Action> {
    return this.call(
      ctx,
      { method: "POST", path: `/instances/${requireInstanceId(id)}/stop`, body: {}, retry: "safe" },
      agent37ActionSchema
    );
  }

  async updateInstance(
    ctx: Agent37RequestContext,
    id: string,
    body: { name?: string | null }
  ): Promise<Agent37Instance> {
    return this.call(
      ctx,
      { method: "PATCH", path: `/instances/${requireInstanceId(id)}`, body, retry: "safe" },
      agent37InstanceSchema
    );
  }

  /**
   * Permanent. A repeat answers 404, so it is never sent twice from here, and
   * only an answer naming this instance as deleted counts as done.
   */
  async deleteInstance(ctx: Agent37RequestContext, id: string): Promise<void> {
    const answer = await this.call(
      ctx,
      { method: "DELETE", path: `/instances/${requireInstanceId(id)}`, retry: "never" },
      agent37DeletedSchema
    );
    if (answer.id !== id) {
      throw new Agent37ApiError(
        "bad-response",
        "Agent 37 confirmed deleting another instance than the one asked for",
        null,
        null
      );
    }
  }

  /**
   * Registers a public key with the key's workspace, where it opens every
   * instance. A key already registered is the same outcome: `created` says
   * which it was, and `at` is when Agent 37 says it registered a new one, in
   * its own epoch seconds.
   */
  async registerSshKey(
    ctx: Agent37RequestContext,
    publicKey: string,
    name: string
  ): Promise<{ created: boolean; at: number | null }> {
    if (/PRIVATE KEY/.test(publicKey)) {
      throw new Agent37ApiError("invalid-request", "Refusing to send a private key", null, null);
    }
    // Sent again here rather than in `call`: a key "already registered" after an attempt whose
    // answer was lost may be that attempt's own, and is then as new as one registered now.
    let unanswered = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const key = await this.call(
          ctx,
          {
            method: "POST",
            path: "/ssh-keys",
            body: { public_key: publicKey, name },
            retry: "never",
          },
          agent37SshKeySchema
        );
        return { created: true, at: key.created ?? null };
      } catch (error) {
        if (!(error instanceof Agent37ApiError)) throw error;
        if (error.code === "ssh_key_exists") return { created: unanswered, at: null };
        const lost =
          error.kind === "network" || error.kind === "timeout" || error.kind === "server";
        if (
          (!lost && error.kind !== "rate-limited") ||
          attempt + 1 >= MAX_ATTEMPTS ||
          ctx.signal?.aborted
        ) {
          throw error;
        }
        unanswered ||= lost;
        const backoff = Math.min(500 * 2 ** attempt, 4_000) + Math.random() * 250;
        await this.sleep(Math.max(backoff, error.retryAfterMs ?? 0), ctx.signal);
      }
    }
  }

  private async call<S extends z.ZodType>(
    ctx: Agent37RequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    let lastError: Agent37ApiError | null = null;
    const limit = request.retry === "never" ? 1 : MAX_BUSY_ATTEMPTS;
    for (let attempt = 0; attempt < limit; attempt++) {
      if (attempt > 0) {
        const backoff = lastError?.busy
          ? Math.min(2_000 * 2 ** (attempt - 1), 10_000)
          : Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
        await this.sleep(Math.max(backoff, lastError?.retryAfterMs ?? 0), ctx.signal);
      }
      try {
        return await this.once(ctx, request, schema);
      } catch (error) {
        if (!(error instanceof Agent37ApiError)) throw error;
        lastError = error;
        if (ctx.signal?.aborted) throw error;
        if (error.busy) continue;
        const transient =
          error.kind === "network" ||
          error.kind === "timeout" ||
          error.kind === "server" ||
          error.kind === "rate-limited";
        if (request.retry !== "safe" || !transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
      }
    }
    throw lastError!;
  }

  private async once<S extends z.ZodType>(
    ctx: Agent37RequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiKey}`,
      Accept: "application/json",
      "X-Request-Id": `dt_${crypto.randomBytes(8).toString("hex")}`,
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    // Already cancelled (while the key was read from the keychain, say): nothing is sent.
    if (ctx.signal?.aborted) throw cancelled();
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      request.timeoutMs ?? this.options.timeoutMs ?? REQUEST_TIMEOUT_MS
    );
    const onAbort = () => timeout.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: timeout.signal,
        redirect: "error",
      });
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof Agent37ApiError) throw error;
      if (ctx.signal?.aborted) throw cancelled();
      if (timeout.signal.aborted) {
        throw new Agent37ApiError("timeout", "Agent 37 didn't answer in time", null, null);
      }
      throw new Agent37ApiError("network", "Couldn't reach Agent 37", null, null);
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }

    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const envelope = agent37ErrorEnvelopeSchema.safeParse(json);
      let code: string | null = null;
      let message: string | null = null;
      if (envelope.success) {
        const error = envelope.data.error;
        code = typeof error === "string" ? error : (error.code ?? null);
        message =
          typeof error === "string" ? (envelope.data.message ?? null) : (error.message ?? null);
      }
      throw new Agent37ApiError(
        kindForStatus(response.status, code),
        redactAgent37Text(message ?? `Agent 37 answered ${response.status}`, ctx.apiKey),
        response.status,
        code,
        retryAfterMs(response.headers.get("retry-after"))
      );
    }
    if (schema === null) return undefined as z.infer<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new Agent37ApiError(
        "bad-response",
        "Agent 37 answered in a shape Daintree doesn't recognise",
        response.status,
        null
      );
    }
    return parsed.data;
  }
}

async function readBounded(response: Response): Promise<string> {
  const tooLarge = () =>
    new Agent37ApiError("bad-response", "Agent 37's answer was too large", response.status, null);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw tooLarge();
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) throw tooLarge();
  return new TextDecoder().decode(body);
}
