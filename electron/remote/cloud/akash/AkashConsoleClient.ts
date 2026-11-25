import type { z } from "zod";
import {
  AKASH_CONSOLE_UUID,
  akashErrorSchema,
  akashOrganizationListSchema,
  akashOrganizationSchema,
  akashPlacementOptionsSchema,
  akashProjectEnvelopeSchema,
  akashProjectListSchema,
  akashProjectSchema,
  akashScreenedProviderSchema,
  akashScreeningSchema,
  akashUserSchema,
  type AkashOrganization,
  type AkashPlacementOptions,
  type AkashProject,
  type AkashScreenedProvider,
  type AkashScreeningRequest,
  type AkashUser,
} from "./akashSchemas.js";

/** The one origin a packaged build sends an Akash Console key to. */
export const AKASH_CONSOLE_PRODUCTION_API_URL = "https://console-api.akash.network/v1";

/** Development builds may point at another API (a local fake for tests); packaged builds never do. */
export const AKASH_CONSOLE_API_URL_ENV = "DAINTREE_AKASH_CONSOLE_API_URL";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;

/**
 * The Console API base URL this process may use. A packaged build always
 * answers production; a development build honours {@link AKASH_CONSOLE_API_URL_ENV}
 * when it is an http(s) URL. Accounts record the URL they were connected
 * against, so a key saved against production is never sent to an override.
 */
export function resolveAkashConsoleApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return AKASH_CONSOLE_PRODUCTION_API_URL;
  const override = env[AKASH_CONSOLE_API_URL_ENV]?.trim();
  if (!override) return AKASH_CONSOLE_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return AKASH_CONSOLE_PRODUCTION_API_URL;
    }
    // Origin and path only: a query, fragment or userinfo would swallow every request path.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return AKASH_CONSOLE_PRODUCTION_API_URL;
  }
}

/** Why a request failed, typed so callers never match on message text. */
export type AkashErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "payment-required"
  | "rate-limited"
  | "conflict"
  | "unprocessable"
  | "invalid-request"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "bad-response"
  /** The key no longer reaches the project the account was connected for. */
  | "wrong-scope"
  /** Something Daintree can't do through Akash yet, or ever (a create outside an offer). */
  | "unsupported";

export class AkashApiError extends Error {
  constructor(
    readonly kind: AkashErrorKind,
    message: string,
    readonly status: number | null,
    /** The Console's own reason, where a route names one: "project_forbidden", "organization_mismatch". */
    readonly code: string | null,
    /** How long the Console asked to be left alone before a retry; null when it didn't say. */
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "AkashApiError";
  }
}

function kindForStatus(status: number): AkashErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment-required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409) return "conflict";
  if (status === 422) return "unprocessable";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "invalid-request";
}

/** How long the Console asked to be left alone, in ms; null when it didn't say. */
function retryAfterMs(headers: Headers): number | null {
  const header = headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return null;
}

/** Strips anything key-shaped from text that came back from the Console before it is shown or logged. */
export function redactAkashText(text: string, apiKey?: string): string {
  const withoutKey = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bac\.sk\.[A-Za-z0-9._~+/=-]+/g, "[redacted]")
    .replace(/([?&](?:token|access_token|key|api_key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}

/** A request made as an account: its key, and the project it acts in when there is one. */
export interface AkashRequestContext {
  apiKey: string;
  projectId?: string;
  signal?: AbortSignal;
}

type FetchFn = typeof fetch;

export interface AkashConsoleClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function cancelled(): AkashApiError {
  return new AkashApiError("cancelled", "Cancelled", null, null);
}

export function abortableAkashSleep(ms: number, signal?: AbortSignal): Promise<void> {
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

function requireUuid(id: string, what: string): string {
  if (!AKASH_CONSOLE_UUID.test(id)) {
    throw new AkashApiError("invalid-request", `Not a Console ${what} id`, null, null);
  }
  return id;
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Safe to send again after a lost response or a 5xx/429: it reads, or screens, and changes nothing. */
  retry: boolean;
}

/** Who a request goes out as: an account, or nobody for the Console's public routes. */
type Caller =
  AkashRequestContext | { apiKey?: undefined; projectId?: undefined; signal?: AbortSignal };

/**
 * A narrow typed client for the parts of the Akash Console API that Daintree
 * uses. An account's requests carry its key in `x-api-key`, and the project
 * they act in as `x-project-id`; the public routes (placement options, bid
 * screening) carry neither. A key acts in one organization, so no request
 * names one. Reads are retried with backoff.
 */
export class AkashConsoleClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: AkashConsoleClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? abortableAkashSleep;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** The organizations the key reaches: an API key lists only the one it acts in. */
  async organizations(ctx: AkashRequestContext): Promise<AkashOrganization[]> {
    const page = await this.call(
      ctx,
      { method: "GET", path: "/organizations", retry: true },
      akashOrganizationListSchema
    );
    return parseItems(page.data, akashOrganizationSchema);
  }

  /** The projects of the key's organization it can reach. */
  async projects(ctx: AkashRequestContext): Promise<AkashProject[]> {
    const page = await this.call(
      ctx,
      { method: "GET", path: "/projects", retry: true },
      akashProjectListSchema
    );
    return parseItems(page.data, akashProjectSchema);
  }

  async project(ctx: AkashRequestContext, projectId: string): Promise<AkashProject> {
    const result = await this.call(
      ctx,
      { method: "GET", path: `/projects/${requireUuid(projectId, "project")}`, retry: true },
      akashProjectEnvelopeSchema
    );
    return result.data;
  }

  async me(ctx: AkashRequestContext): Promise<AkashUser> {
    const result = await this.call(
      ctx,
      { method: "GET", path: "/user/me", retry: true },
      akashUserSchema
    );
    return result.data;
  }

  /** The regions online, audited providers serve now. Public: no key is sent. */
  async placementOptions(signal?: AbortSignal): Promise<AkashPlacementOptions> {
    return this.call(
      { signal },
      { method: "GET", path: "/placement-options", retry: true },
      akashPlacementOptionsSchema
    );
  }

  /**
   * The providers that would bid on `request` with the capacity they have
   * free now, creating nothing. Public: no key is sent.
   */
  async screenProviders(
    request: AkashScreeningRequest,
    signal?: AbortSignal
  ): Promise<AkashScreenedProvider[]> {
    const result = await this.call(
      { signal },
      { method: "POST", path: "/bid-screening", body: request, retry: true },
      akashScreeningSchema
    );
    return parseItems(result.providers, akashScreenedProviderSchema);
  }

  private async call<S extends z.ZodType>(
    caller: Caller,
    request: RequestOptions,
    schema: S
  ): Promise<z.infer<S>> {
    let lastError: AkashApiError | null = null;
    const attempts = request.retry ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
        await this.sleep(Math.max(backoff, lastError?.retryAfterMs ?? 0), caller.signal);
      }
      try {
        return await this.once(caller, request, schema);
      } catch (error) {
        if (!(error instanceof AkashApiError)) throw error;
        lastError = error;
        const retriable =
          error.kind === "network" ||
          error.kind === "timeout" ||
          error.kind === "server" ||
          error.kind === "rate-limited";
        // A wait longer than a read should take is the Console's answer, not a reason to ask early.
        const tooLong = (error.retryAfterMs ?? 0) > MAX_RETRY_AFTER_MS;
        if (!retriable || tooLong || caller.signal?.aborted) throw error;
      }
    }
    throw lastError!;
  }

  private async once<S extends z.ZodType>(
    caller: Caller,
    request: RequestOptions,
    schema: S
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (caller.apiKey !== undefined) headers["x-api-key"] = caller.apiKey;
    if (caller.projectId !== undefined) {
      headers["x-project-id"] = requireUuid(caller.projectId, "project");
    }
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    // Already cancelled (while the key was read from the keychain, say): nothing is sent.
    if (caller.signal?.aborted) throw cancelled();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    caller.signal?.addEventListener("abort", onAbort, { once: true });
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
      if (error instanceof AkashApiError) throw error;
      if (caller.signal?.aborted) throw cancelled();
      if (timeout.signal.aborted) {
        throw new AkashApiError("timeout", "The Akash Console didn't answer in time", null, null);
      }
      throw new AkashApiError("network", "Couldn't reach the Akash Console", null, null);
    } finally {
      clearTimeout(timer);
      caller.signal?.removeEventListener("abort", onAbort);
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
      const envelope = akashErrorSchema.safeParse(json);
      const said = envelope.success ? envelope.data.message : undefined;
      let kind = kindForStatus(response.status);
      // A public route carries no key, so its refusal says nothing about the account's.
      if (caller.apiKey === undefined && (kind === "unauthorized" || kind === "forbidden")) {
        kind = "server";
      }
      throw new AkashApiError(
        kind,
        redactAkashText(said ?? `The Akash Console answered ${response.status}`, caller.apiKey),
        response.status,
        envelope.success ? (envelope.data.code ?? null) : null,
        retryAfterMs(response.headers)
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AkashApiError(
        "bad-response",
        "The Akash Console answered in a shape Daintree doesn't recognise",
        response.status,
        null
      );
    }
    return parsed.data;
  }
}

/**
 * Every entry, or a `bad-response`: scopes and availability are decided from
 * these lists, so one Daintree can't read is never passed off as absent.
 */
function parseItems<I extends z.ZodType>(raw: unknown[], schema: I): Array<z.infer<I>> {
  return raw.map((entry) => {
    const parsed = schema.safeParse(entry);
    if (!parsed.success) {
      throw new AkashApiError(
        "bad-response",
        "The Akash Console listed an entry in a shape Daintree doesn't recognise",
        null,
        null
      );
    }
    return parsed.data;
  });
}

/**
 * The body as text, counted as it arrives: a response that runs past the cap
 * is cancelled there rather than buffered whole first.
 */
async function readBounded(response: Response): Promise<string> {
  const tooLarge = () =>
    new AkashApiError(
      "bad-response",
      "The Akash Console's answer was too large",
      response.status,
      null
    );
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
