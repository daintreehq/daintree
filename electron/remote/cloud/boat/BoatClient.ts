import crypto from "node:crypto";
import type { z } from "zod";
import {
  BOAT_SANDBOX_ID,
  boatActionResponseSchema,
  boatCreateResponseSchema,
  boatErrorEnvelopeSchema,
  boatLimitsSchema,
  boatMeSchema,
  boatOrgListSchema,
  boatSandboxInfoSchema,
  boatSandboxListSchema,
  boatSandboxSchema,
  boatSshKeyResponseSchema,
  type BoatActionResponse,
  type BoatLimits,
  type BoatMe,
  type BoatOrg,
  type BoatSandbox,
  type BoatSshKeyResponse,
} from "./boatSchemas.js";

/** The one origin a packaged build sends a Boat key to. */
export const BOAT_PRODUCTION_API_URL = "https://boat.dev/api/v1";

/** Development builds may point at another Boat (a local fake for tests); packaged builds never do. */
export const BOAT_API_URL_ENV = "DAINTREE_BOAT_API_URL";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * The Boat API base URL this process may use. A packaged build always answers
 * production; a development build honours {@link BOAT_API_URL_ENV} when it is
 * an http(s) URL. Accounts record the URL they were connected against, so a
 * key saved against production is never sent to an override (see
 * CloudAccountService).
 */
export function resolveBoatApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return BOAT_PRODUCTION_API_URL;
  const override = env[BOAT_API_URL_ENV]?.trim();
  if (!override) return BOAT_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") return BOAT_PRODUCTION_API_URL;
    // Origin and path only: a query, fragment or userinfo would swallow every request path.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return BOAT_PRODUCTION_API_URL;
  }
}

/** Why a Boat request failed, typed so callers never match on message text. */
export type BoatErrorKind =
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

export class BoatApiError extends Error {
  constructor(
    readonly kind: BoatErrorKind,
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "BoatApiError";
  }

  /** The request may or may not have reached Boat: a mutation's outcome is unknown. */
  get outcomeUnknown(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "server";
  }
}

function kindForStatus(status: number): BoatErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment-required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate-limited";
  if (status === 503) return "no-capacity";
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

/** Strips anything token-shaped from text that came back from Boat before it is shown or logged. */
export function redactBoatText(text: string, apiKey?: string): string {
  // The exact key first: its format isn't documented beyond the prefix.
  const withoutKey = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  return (
    withoutKey
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      // A key-shaped run after Boat's prefixes; underscores excluded so error codes like `box_not_found` stay.
      .replace(/\b(?:boat|box)_[A-Za-z0-9-]{20,}/g, "[redacted]")
      .replace(/([?&](?:token|_token|key)=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 500)
  );
}

export interface BoatRequestContext {
  apiKey: string;
  /** The billing scope every request names explicitly: `personal` or an org id. */
  org: string;
  signal?: AbortSignal;
}

export interface BoatCreateSandboxBody {
  name: string;
  type?: string;
  ttlSeconds: number | null;
  labels?: Record<string, string>;
  environment?: string;
  snapshots: true;
  visibility?: "private";
}

type FetchFn = typeof fetch;

export interface BoatClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BoatApiError("cancelled", "Cancelled", null, null, null));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BoatApiError("cancelled", "Cancelled", null, null, null));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireSandboxId(id: string): string {
  if (!BOAT_SANDBOX_ID.test(id)) {
    throw new BoatApiError("invalid-request", "Not a Boat sandbox id", null, null, null);
  }
  return encodeURIComponent(id);
}

interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Safe to send again after a lost response or a 5xx/429. */
  retry: boolean;
}

/**
 * A narrow typed client for the parts of Boat's public v1 API that Daintree
 * uses. Every request carries the account's key as a bearer token and names
 * its billing scope, never relying on the wallet the account last chose on
 * Boat's website. Reads are retried with backoff; mutations are not, except
 * create, which is made safe to retry by its idempotency key.
 */
export class BoatClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: BoatClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async me(ctx: BoatRequestContext): Promise<BoatMe> {
    return this.call(ctx, { method: "GET", path: "/me", retry: true }, boatMeSchema);
  }

  async orgs(ctx: Omit<BoatRequestContext, "org">): Promise<BoatOrg[]> {
    const result = await this.call(
      { ...ctx, org: "" },
      { method: "GET", path: "/orgs", retry: true },
      boatOrgListSchema
    );
    return result.orgs;
  }

  async limits(ctx: BoatRequestContext): Promise<BoatLimits> {
    return this.call(ctx, { method: "GET", path: "/limits", retry: true }, boatLimitsSchema);
  }

  /**
   * Every sandbox in the scope, following the cursor to the end. Past
   * `maxPages` it fails rather than pass a partial list off as complete.
   */
  async listSandboxes(
    ctx: BoatRequestContext,
    maxPages = 50,
    label?: string
  ): Promise<BoatSandbox[]> {
    const out: BoatSandbox[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.call(
        ctx,
        {
          method: "GET",
          path: "/sandboxes",
          query: { limit: "100", cursor, label },
          retry: true,
        },
        boatSandboxListSchema
      );
      for (const raw of result.sandboxes) {
        const parsed = boatSandboxSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      }
      const next = result.pageInfo?.nextCursor;
      if (!result.pageInfo?.hasMore || !next) return out;
      cursor = next;
    }
    throw new BoatApiError(
      "bad-response",
      `This account has more than ${maxPages * 100} machines; Daintree can't list them all`,
      null,
      null,
      null
    );
  }

  /** One page of one sandbox: whether the key may read machines in this scope at all. */
  async probeSandboxes(ctx: BoatRequestContext): Promise<void> {
    await this.call(
      ctx,
      { method: "GET", path: "/sandboxes", query: { limit: "1" }, retry: true },
      boatSandboxListSchema
    );
  }

  async getSandbox(ctx: BoatRequestContext, sandboxId: string): Promise<BoatSandbox> {
    const result = await this.call(
      ctx,
      { method: "GET", path: `/sandboxes/${requireSandboxId(sandboxId)}`, retry: true },
      boatSandboxInfoSchema
    );
    return result.sandbox;
  }

  async createSandbox(
    ctx: BoatRequestContext,
    body: BoatCreateSandboxBody,
    idempotencyKey: string
  ): Promise<BoatSandbox> {
    const result = await this.call(
      ctx,
      {
        method: "POST",
        path: "/sandboxes",
        body: { ...body, org: ctx.org },
        headers: { "Idempotency-Key": idempotencyKey },
        retry: true,
      },
      boatCreateResponseSchema
    );
    return result.sandbox;
  }

  async resumeSandbox(
    ctx: BoatRequestContext,
    sandboxId: string,
    body: { ttlSeconds?: number | null; type?: string } = {}
  ): Promise<BoatActionResponse> {
    return this.call(
      ctx,
      {
        method: "POST",
        path: `/sandboxes/${requireSandboxId(sandboxId)}/resume`,
        body,
        retry: false,
      },
      boatActionResponseSchema
    );
  }

  /** A normal stop: Boat saves the disk first and refuses to discard work. Never forced from here. */
  async stopSandbox(ctx: BoatRequestContext, sandboxId: string): Promise<BoatActionResponse> {
    return this.call(
      ctx,
      {
        method: "POST",
        path: `/sandboxes/${requireSandboxId(sandboxId)}/stop`,
        body: {},
        // Stop is idempotent on Boat's side: a second call joins the pending stop.
        retry: true,
      },
      boatActionResponseSchema
    );
  }

  async updateSandbox(
    ctx: BoatRequestContext,
    sandboxId: string,
    body: { name?: string; ttlSeconds?: number | null }
  ): Promise<BoatSandbox> {
    const result = await this.call(
      ctx,
      {
        method: "PATCH",
        path: `/sandboxes/${requireSandboxId(sandboxId)}`,
        body,
        retry: false,
      },
      boatSandboxInfoSchema
    );
    return result.sandbox;
  }

  /** Permanent deletion. Boat's own confirmation header must name the sandbox. */
  async deleteSandbox(ctx: BoatRequestContext, sandboxId: string): Promise<void> {
    await this.call(
      ctx,
      {
        method: "DELETE",
        path: `/sandboxes/${requireSandboxId(sandboxId)}`,
        headers: { "X-Ascii-Confirm-Delete": sandboxId },
        retry: false,
      },
      null
    );
  }

  /** Authorizes a public key on the running sandbox and returns how to reach its sshd. */
  async authorizeSshKey(
    ctx: BoatRequestContext,
    sandboxId: string,
    publicKey: string
  ): Promise<BoatSshKeyResponse> {
    if (/PRIVATE KEY/.test(publicKey)) {
      throw new BoatApiError("invalid-request", "Refusing to send a private key", null, null, null);
    }
    return this.call(
      ctx,
      {
        method: "POST",
        path: `/sandboxes/${requireSandboxId(sandboxId)}/sshkey`,
        body: { key: publicKey },
        // Authorizing the same key twice is harmless.
        retry: true,
      },
      boatSshKeyResponseSchema
    );
  }

  private async call<S extends z.ZodType>(
    ctx: BoatRequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    let lastError: BoatApiError | null = null;
    const attempts = request.retry ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
        await this.sleep(Math.max(backoff, lastError?.retryAfterMs ?? 0), ctx.signal);
      }
      try {
        return await this.once(ctx, request, schema);
      } catch (error) {
        if (!(error instanceof BoatApiError)) throw error;
        lastError = error;
        const retriable =
          error.kind === "network" ||
          error.kind === "timeout" ||
          error.kind === "server" ||
          error.kind === "rate-limited" ||
          (error.kind === "conflict" && error.code === "idempotency_in_progress");
        if (!retriable || ctx.signal?.aborted) throw error;
      }
    }
    throw lastError!;
  }

  private async once<S extends z.ZodType>(
    ctx: BoatRequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.apiKey}`,
      Accept: "application/json",
      "X-Request-Id": `dt_${crypto.randomBytes(8).toString("hex")}`,
      ...request.headers,
    };
    if (ctx.org) headers["X-Boat-Org"] = ctx.org;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    // Already cancelled (while the key was read from the keychain, say): nothing is sent.
    if (ctx.signal?.aborted) throw new BoatApiError("cancelled", "Cancelled", null, null, null);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
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
      if (error instanceof BoatApiError) throw error;
      if (ctx.signal?.aborted) throw new BoatApiError("cancelled", "Cancelled", null, null, null);
      if (timeout.signal.aborted) {
        throw new BoatApiError("timeout", "Boat didn't answer in time", null, null, null);
      }
      throw new BoatApiError("network", "Couldn't reach Boat", null, null, null);
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
      const envelope = boatErrorEnvelopeSchema.safeParse(json);
      const code = envelope.success
        ? (envelope.data.error?.code ?? envelope.data.code ?? null)
        : null;
      const message = envelope.success
        ? (envelope.data.error?.message ?? envelope.data.message ?? null)
        : null;
      throw new BoatApiError(
        kindForStatus(response.status),
        redactBoatText(message ?? `Boat answered ${response.status}`, ctx.apiKey),
        response.status,
        code,
        envelope.success ? (envelope.data.requestId ?? null) : null,
        retryAfterMs(response.headers.get("retry-after"))
      );
    }
    if (schema === null) return undefined as z.infer<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BoatApiError(
        "bad-response",
        "Boat answered in a shape Daintree doesn't recognise",
        response.status,
        null,
        null
      );
    }
    return parsed.data;
  }
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new BoatApiError(
      "bad-response",
      "Boat's answer was too large",
      response.status,
      null,
      null
    );
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new BoatApiError(
      "bad-response",
      "Boat's answer was too large",
      response.status,
      null,
      null
    );
  }
  return new TextDecoder().decode(body);
}
