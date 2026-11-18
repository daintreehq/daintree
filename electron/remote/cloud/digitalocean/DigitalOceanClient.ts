import type { z } from "zod";
import {
  DIGITALOCEAN_DROPLET_ID,
  digitalOceanAccountSchema,
  digitalOceanActionEnvelopeSchema,
  digitalOceanActionPageSchema,
  digitalOceanActionSchema,
  digitalOceanDropletEnvelopeSchema,
  digitalOceanDropletPageSchema,
  digitalOceanDropletSchema,
  digitalOceanErrorSchema,
  digitalOceanImagePageSchema,
  digitalOceanImageSchema,
  digitalOceanRegionPageSchema,
  digitalOceanRegionSchema,
  digitalOceanSizePageSchema,
  digitalOceanSizeSchema,
  digitalOceanSshKeyEnvelopeSchema,
  type DigitalOceanAccount,
  type DigitalOceanAction,
  type DigitalOceanDroplet,
  type DigitalOceanImage,
  type DigitalOceanRegion,
  type DigitalOceanSize,
  type DigitalOceanSshKey,
} from "./digitalOceanSchemas.js";

/** The one origin a packaged build sends a DigitalOcean token to. */
export const DIGITALOCEAN_PRODUCTION_API_URL = "https://api.digitalocean.com/v2";

/** Development builds may point at another API (a local fake for tests); packaged builds never do. */
export const DIGITALOCEAN_API_URL_ENV = "DAINTREE_DIGITALOCEAN_API_URL";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_READ_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/**
 * The DigitalOcean API base URL this process may use. A packaged build always
 * answers production; a development build honours {@link DIGITALOCEAN_API_URL_ENV}
 * when it is an http(s) URL. Accounts record the URL they were connected
 * against, so a token saved against production is never sent to an override.
 */
export function resolveDigitalOceanApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return DIGITALOCEAN_PRODUCTION_API_URL;
  const override = env[DIGITALOCEAN_API_URL_ENV]?.trim();
  if (!override) return DIGITALOCEAN_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return DIGITALOCEAN_PRODUCTION_API_URL;
    }
    // Origin and path only: a query, fragment or userinfo would swallow every request path.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return DIGITALOCEAN_PRODUCTION_API_URL;
  }
}

/** Why a request failed, typed so callers never match on message text. */
export type DigitalOceanErrorKind =
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
  /** The token now belongs to another team than the account was connected for. */
  | "wrong-team"
  /** The Droplet exists but can't be reached yet (no public address). */
  | "not-ready"
  /** DigitalOcean accepted an action on the Droplet and then reported it errored. */
  | "action-errored";

export class DigitalOceanApiError extends Error {
  constructor(
    readonly kind: DigitalOceanErrorKind,
    message: string,
    readonly status: number | null,
    /** DigitalOcean's own error id: "unauthorized", "not_found", "unprocessable_entity". */
    readonly code: string | null,
    readonly requestId: string | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "DigitalOceanApiError";
  }
}

function kindForStatus(status: number): DigitalOceanErrorKind {
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

function retryAfterMs(headers: Headers): number | null {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS));
  }
  // DigitalOcean's own header: when the hourly window resets, in epoch seconds.
  const reset = Number(headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, Math.min(reset * 1000 - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return null;
}

/** Strips anything token-shaped from text that came back from DigitalOcean before it is shown or logged. */
export function redactDigitalOceanText(text: string, token?: string): string {
  const withoutToken = token && token.length >= 8 ? text.split(token).join("[redacted]") : text;
  return (
    withoutToken
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
      // Personal access, OAuth and refresh tokens: dop_v1_, doo_v1_, dor_v1_.
      .replace(/\bdo[a-z]_v\d+_[A-Za-z0-9]{16,}/g, "[redacted]")
      .replace(/([?&](?:token|access_token|key)=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 500)
  );
}

export interface DigitalOceanRequestContext {
  token: string;
  signal?: AbortSignal;
}

export interface DigitalOceanCreateDropletBody {
  name: string;
  region: string;
  size: string;
  image: string | number;
  ssh_keys: Array<string | number>;
  tags: string[];
  user_data: string;
  monitoring?: boolean;
  ipv6?: boolean;
}

export type DigitalOceanDropletActionBody =
  { type: "shutdown" } | { type: "power_on" } | { type: "rename"; name: string };

type FetchFn = typeof fetch;

export interface DigitalOceanClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function cancelled(): DigitalOceanApiError {
  return new DigitalOceanApiError("cancelled", "Cancelled", null, null, null);
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

function requireDropletId(id: string): string {
  if (!DIGITALOCEAN_DROPLET_ID.test(id)) {
    throw new DigitalOceanApiError("invalid-request", "Not a Droplet id", null, null, null);
  }
  return id;
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Safe to send again after a lost response or a 5xx/429. */
  retry: boolean;
}

/**
 * A narrow typed client for the parts of DigitalOcean's v2 API that Daintree
 * uses. Every request carries the account's token as a bearer token; a token
 * belongs to one team, so no request names a scope. Reads are retried with
 * backoff; mutations never are, since DigitalOcean takes no idempotency key.
 */
export class DigitalOceanClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: DigitalOceanClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async account(ctx: DigitalOceanRequestContext): Promise<DigitalOceanAccount> {
    const result = await this.call(
      ctx,
      { method: "GET", path: "/account", retry: true },
      digitalOceanAccountSchema
    );
    return result.account;
  }

  async listRegions(ctx: DigitalOceanRequestContext): Promise<DigitalOceanRegion[]> {
    return this.listAll(
      ctx,
      "/regions",
      {},
      digitalOceanRegionPageSchema,
      (page) => page.regions,
      digitalOceanRegionSchema
    );
  }

  async listSizes(ctx: DigitalOceanRequestContext): Promise<DigitalOceanSize[]> {
    return this.listAll(
      ctx,
      "/sizes",
      {},
      digitalOceanSizePageSchema,
      (page) => page.sizes,
      digitalOceanSizeSchema
    );
  }

  async listDistributionImages(ctx: DigitalOceanRequestContext): Promise<DigitalOceanImage[]> {
    return this.listAll(
      ctx,
      "/images",
      { type: "distribution" },
      digitalOceanImagePageSchema,
      (page) => page.images,
      digitalOceanImageSchema
    );
  }

  /**
   * Every Droplet the token can see; with `tag`, only those carrying it. A
   * tagged lookup is how a lost create is found again, so there an entry it
   * can't read fails the whole answer instead of passing for "none".
   */
  async listDroplets(
    ctx: DigitalOceanRequestContext,
    tag?: string
  ): Promise<DigitalOceanDroplet[]> {
    return this.listAll(
      ctx,
      "/droplets",
      { tag_name: tag },
      digitalOceanDropletPageSchema,
      (page) => page.droplets,
      digitalOceanDropletSchema,
      tag !== undefined
    );
  }

  /** One Droplet of one page: whether the token may read Droplets at all. */
  async probeDroplets(ctx: DigitalOceanRequestContext): Promise<void> {
    await this.call(
      ctx,
      { method: "GET", path: "/droplets", query: { per_page: "1" }, retry: true },
      digitalOceanDropletPageSchema
    );
  }

  async getDroplet(
    ctx: DigitalOceanRequestContext,
    dropletId: string
  ): Promise<DigitalOceanDroplet> {
    const result = await this.call(
      ctx,
      { method: "GET", path: `/droplets/${requireDropletId(dropletId)}`, retry: true },
      digitalOceanDropletEnvelopeSchema
    );
    return result.droplet;
  }

  /** Sent once: a lost answer may still have made the Droplet, which only its tags find again. */
  async createDroplet(
    ctx: DigitalOceanRequestContext,
    body: DigitalOceanCreateDropletBody
  ): Promise<DigitalOceanDroplet> {
    const result = await this.call(
      ctx,
      { method: "POST", path: "/droplets", body, retry: false },
      digitalOceanDropletEnvelopeSchema
    );
    return result.droplet;
  }

  async dropletAction(
    ctx: DigitalOceanRequestContext,
    dropletId: string,
    body: DigitalOceanDropletActionBody
  ): Promise<DigitalOceanAction> {
    const result = await this.call(
      ctx,
      {
        method: "POST",
        path: `/droplets/${requireDropletId(dropletId)}/actions`,
        body,
        retry: false,
      },
      digitalOceanActionEnvelopeSchema
    );
    return result.action;
  }

  /** One action on a Droplet, read through the Droplet: a token needs only `droplet:read` for it. */
  async getDropletAction(
    ctx: DigitalOceanRequestContext,
    dropletId: string,
    actionId: number
  ): Promise<DigitalOceanAction> {
    if (!Number.isSafeInteger(actionId) || actionId <= 0) {
      throw new DigitalOceanApiError("invalid-request", "Not an action id", null, null, null);
    }
    const result = await this.call(
      ctx,
      {
        method: "GET",
        path: `/droplets/${requireDropletId(dropletId)}/actions/${actionId}`,
        retry: true,
      },
      digitalOceanActionEnvelopeSchema
    );
    return result.action;
  }

  /** The Droplet's most recent actions, newest first: one page, which is all a state read needs. */
  async recentDropletActions(
    ctx: DigitalOceanRequestContext,
    dropletId: string
  ): Promise<DigitalOceanAction[]> {
    const page = await this.call(
      ctx,
      {
        method: "GET",
        path: `/droplets/${requireDropletId(dropletId)}/actions`,
        query: { per_page: "20" },
        retry: true,
      },
      digitalOceanActionPageSchema
    );
    return parseItems(page.actions, digitalOceanActionSchema);
  }

  /** Permanent deletion. */
  async deleteDroplet(ctx: DigitalOceanRequestContext, dropletId: string): Promise<void> {
    await this.call(
      ctx,
      { method: "DELETE", path: `/droplets/${requireDropletId(dropletId)}`, retry: false },
      null
    );
  }

  /** The account's key with this MD5 fingerprint; null when it isn't registered. */
  async findSshKey(
    ctx: DigitalOceanRequestContext,
    fingerprint: string
  ): Promise<DigitalOceanSshKey | null> {
    if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){15}$/.test(fingerprint)) {
      throw new DigitalOceanApiError(
        "invalid-request",
        "Not an MD5 key fingerprint",
        null,
        null,
        null
      );
    }
    try {
      const result = await this.call(
        ctx,
        { method: "GET", path: `/account/keys/${fingerprint}`, retry: true },
        digitalOceanSshKeyEnvelopeSchema
      );
      return result.ssh_key;
    } catch (error) {
      if (error instanceof DigitalOceanApiError && error.kind === "not-found") return null;
      throw error;
    }
  }

  async createSshKey(
    ctx: DigitalOceanRequestContext,
    body: { name: string; public_key: string }
  ): Promise<DigitalOceanSshKey> {
    if (/PRIVATE KEY/.test(body.public_key)) {
      throw new DigitalOceanApiError(
        "invalid-request",
        "Refusing to send a private key",
        null,
        null,
        null
      );
    }
    const result = await this.call(
      ctx,
      { method: "POST", path: "/account/keys", body, retry: false },
      digitalOceanSshKeyEnvelopeSchema
    );
    return result.ssh_key;
  }

  /**
   * Every item of a paged list, page by page to the end. Page numbers are
   * counted here rather than following `links.pages.next`, so the token only
   * ever goes to this client's own origin. Past {@link MAX_PAGES} it fails
   * rather than pass a partial list off as complete.
   */
  private async listAll<P extends z.ZodType, I extends z.ZodType>(
    ctx: DigitalOceanRequestContext,
    path: string,
    query: Record<string, string | undefined>,
    pageSchema: P,
    itemsOf: (page: z.infer<P>) => unknown[],
    itemSchema: I,
    strict = false
  ): Promise<Array<z.infer<I>>> {
    const out: Array<z.infer<I>> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await this.call(
        ctx,
        {
          method: "GET",
          path,
          query: { ...query, page: String(page), per_page: String(PAGE_SIZE) },
          retry: true,
        },
        pageSchema
      );
      const raw = itemsOf(result);
      out.push(...parseItems(raw, itemSchema, strict));
      const links = (result as { links?: { pages?: { next?: string | null } | null } | null })
        .links;
      if (!links?.pages?.next || raw.length === 0) return out;
    }
    throw new DigitalOceanApiError(
      "bad-response",
      `DigitalOcean listed more than ${MAX_PAGES * PAGE_SIZE} entries; Daintree can't read them all`,
      null,
      null,
      null
    );
  }

  private async call<S extends z.ZodType>(
    ctx: DigitalOceanRequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    let lastError: DigitalOceanApiError | null = null;
    const attempts = request.retry ? MAX_READ_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
        await this.sleep(Math.max(backoff, lastError?.retryAfterMs ?? 0), ctx.signal);
      }
      try {
        return await this.once(ctx, request, schema);
      } catch (error) {
        if (!(error instanceof DigitalOceanApiError)) throw error;
        lastError = error;
        const retriable =
          error.kind === "network" ||
          error.kind === "timeout" ||
          error.kind === "server" ||
          error.kind === "rate-limited";
        if (!retriable || ctx.signal?.aborted) throw error;
      }
    }
    throw lastError!;
  }

  private async once<S extends z.ZodType>(
    ctx: DigitalOceanRequestContext,
    request: RequestOptions,
    schema: S | null
  ): Promise<z.infer<S>> {
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.token}`,
      Accept: "application/json",
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    // Already cancelled (while the token was read from the keychain, say): nothing is sent.
    if (ctx.signal?.aborted) throw cancelled();
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
      if (error instanceof DigitalOceanApiError) throw error;
      if (ctx.signal?.aborted) throw cancelled();
      if (timeout.signal.aborted) {
        throw new DigitalOceanApiError(
          "timeout",
          "DigitalOcean didn't answer in time",
          null,
          null,
          null
        );
      }
      throw new DigitalOceanApiError("network", "Couldn't reach DigitalOcean", null, null, null);
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
      const envelope = digitalOceanErrorSchema.safeParse(json);
      const said = envelope.success ? envelope.data.message : undefined;
      throw new DigitalOceanApiError(
        kindForStatus(response.status),
        redactDigitalOceanText(said ?? `DigitalOcean answered ${response.status}`, ctx.token),
        response.status,
        envelope.success ? (envelope.data.id ?? null) : null,
        envelope.success ? (envelope.data.request_id ?? null) : null,
        retryAfterMs(response.headers)
      );
    }
    if (schema === null) return undefined as z.infer<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new DigitalOceanApiError(
        "bad-response",
        "DigitalOcean answered in a shape Daintree doesn't recognise",
        response.status,
        null,
        null
      );
    }
    return parsed.data;
  }
}

function parseItems<I extends z.ZodType>(
  raw: unknown[],
  schema: I,
  strict = false
): Array<z.infer<I>> {
  const out: Array<z.infer<I>> = [];
  for (const entry of raw) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
    else if (strict) {
      throw new DigitalOceanApiError(
        "bad-response",
        "DigitalOcean listed a Droplet in a shape Daintree doesn't recognise",
        null,
        null,
        null
      );
    }
  }
  return out;
}

/**
 * The body as text, counted as it arrives: a response that runs past the cap
 * is cancelled there rather than buffered whole first.
 */
async function readBounded(response: Response): Promise<string> {
  const tooLarge = () =>
    new DigitalOceanApiError(
      "bad-response",
      "DigitalOcean's answer was too large",
      response.status,
      null,
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
