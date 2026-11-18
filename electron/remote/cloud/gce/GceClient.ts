import crypto from "node:crypto";
import type { z } from "zod";
import { GceApiError, redactGceText, type GceErrorKind } from "./gceErrors.js";
import {
  gceErrorEnvelopeSchema,
  gceGuestAttributesSchema,
  gceInstanceAggregatedListSchema,
  gceInstanceSchema,
  gceMachineTypeAggregatedListSchema,
  gceMachineTypeSchema,
  gceOperationSchema,
  gceProjectSchema,
  gceSubnetworkAggregatedListSchema,
  gceSubnetworkSchema,
  gceZoneListSchema,
  gceZoneSchema,
  type GceGuestAttributes,
  type GceInstance,
  type GceOperation,
  type GceScheduling,
  type GceSubnetwork,
} from "./gceSchemas.js";

/** Failures that happened before anything was sent to Compute Engine. */
const UNSENT = new WeakSet<GceApiError>();

/** The one Compute Engine origin a packaged build sends a token to. */
export const GCE_PRODUCTION_API_URL = "https://compute.googleapis.com/compute/v1";

/** Development builds may point at another Compute Engine (a local fake for tests); packaged builds never do. */
export const GCE_API_URL_ENV = "DAINTREE_GCE_API_URL";

const REQUEST_TIMEOUT_MS = 30_000;
/** `operations.wait` holds a request open for up to about two minutes. */
const WAIT_REQUEST_TIMEOUT_MS = 150_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_PAGES = 50;

/** A zone, region, subnetwork or machine type name, as Compute Engine spells them. */
export const GCE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
/** An instance's numeric id, which every instance call accepts in place of its name. */
export const GCE_INSTANCE_ID = /^\d{1,20}$/;
const OPERATION_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The Compute Engine API base this process may use. A packaged build always
 * answers production; a development build honours {@link GCE_API_URL_ENV}
 * when it is an http(s) URL. Accounts record the URL they were connected
 * against, so a key saved against production is never sent to an override.
 */
export function resolveGceApiUrl(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (isPackaged) return GCE_PRODUCTION_API_URL;
  const override = env[GCE_API_URL_ENV]?.trim();
  if (!override) return GCE_PRODUCTION_API_URL;
  try {
    const url = new URL(override);
    if (url.protocol !== "https:" && url.protocol !== "http:") return GCE_PRODUCTION_API_URL;
    // Origin and path only: a query, fragment or userinfo would swallow every request path.
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return GCE_PRODUCTION_API_URL;
  }
}

/** Reasons Google gives for a zone that has no machine of the kind asked for right now. */
const CAPACITY_REASON =
  /RESOURCE_POOL_EXHAUSTED|RESOURCE_NOT_AVAILABLE|STOCKOUT|POOL_CAPACITY_INSUFFICIENT/;

function kindForStatus(status: number | null, reason: string | null): GceErrorKind {
  if (reason) {
    if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED") return "api-disabled";
    if (/^(?:userR|r)ateLimitExceeded$|^RATE_LIMIT_EXCEEDED$/.test(reason)) return "rate-limited";
    if (reason === "quotaExceeded" || reason === "QUOTA_EXCEEDED") return "quota";
    if (reason === "billingNotEnabled" || reason === "BILLING_DISABLED") return "billing";
    if (CAPACITY_REASON.test(reason)) return "no-capacity";
    if (reason === "RESOURCE_ALREADY_EXISTS" || reason === "alreadyExists") return "conflict";
    if (reason === "RESOURCE_NOT_FOUND" || reason === "notFound") return "not-found";
  }
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate-limited";
  if (status !== null && status >= 500) return "server";
  return "invalid-request";
}

/** A finished operation's own failure, as an error; null while it runs or when it succeeded. */
export function operationError(operation: GceOperation): GceApiError | null {
  if (operation.status !== "DONE") return null;
  const errors = operation.error?.errors ?? [];
  const status = operation.httpErrorStatusCode ?? null;
  if (errors.length === 0 && (status === null || status < 400)) return null;
  const first = errors[0];
  const reason = first?.code ?? null;
  const message = first?.message ?? operation.httpErrorMessage ?? "Compute Engine refused it";
  return new GceApiError(kindForStatus(status, reason), redactGceText(message), status, reason);
}

function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, MAX_RETRY_AFTER_MS));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), MAX_RETRY_AFTER_MS)) : null;
}

export interface GceRequestContext {
  /** An access token for the account; `fresh` asks Google for a new one instead of a kept one. */
  authorize: (fresh: boolean) => Promise<string>;
  project: string;
  signal?: AbortSignal;
}

/** What `instances.insert` is sent: the fields Daintree sets, nothing more. */
export interface GceInsertInstanceBody {
  name: string;
  description: string;
  machineType: string;
  labels: Record<string, string>;
  metadata: { items: { key: string; value: string }[] };
  disks: {
    boot: true;
    autoDelete: true;
    type: "PERSISTENT";
    initializeParams: { sourceImage: string; diskSizeGb: string; diskType: string };
  }[];
  networkInterfaces: {
    subnetwork: string;
    accessConfigs: { type: "ONE_TO_ONE_NAT"; name: string }[];
  }[];
  scheduling: GceScheduling;
}

type FetchFn = typeof fetch;

export interface GceClientOptions {
  baseUrl: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function gceSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GceApiError("cancelled", "Cancelled", null, null));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GceApiError("cancelled", "Cancelled", null, null));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function segment(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw new GceApiError("invalid-request", `Not a Compute Engine ${what}`, null, null);
  }
  return encodeURIComponent(value);
}

interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** A write: once one attempt may have reached Google, a later refusal no longer proves nothing happened. */
  mutation?: boolean;
}

/**
 * A narrow typed client for the Compute Engine v1 calls Daintree makes. Every
 * request names its project and carries a bearer token for the account's
 * service account. Reads are retried with backoff, and so are writes: each
 * carries a `requestId`, which makes a resend the same request to Compute
 * Engine rather than a second one.
 */
export class GceClient {
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly options: GceClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? gceSleep;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  private projectPath(ctx: GceRequestContext): string {
    return `/projects/${encodeURIComponent(ctx.project)}`;
  }

  private zonePath(ctx: GceRequestContext, zone: string): string {
    return `${this.projectPath(ctx)}/zones/${segment(zone, GCE_NAME, "zone")}`;
  }

  private instancePath(ctx: GceRequestContext, zone: string, instance: string): string {
    return `${this.zonePath(ctx, zone)}/instances/${segment(instance, GCE_INSTANCE_ID, "instance id")}`;
  }

  async getProject(ctx: GceRequestContext): Promise<z.infer<typeof gceProjectSchema>> {
    return this.call(ctx, { method: "GET", path: this.projectPath(ctx) }, gceProjectSchema);
  }

  async listZones(ctx: GceRequestContext): Promise<z.infer<typeof gceZoneSchema>[]> {
    return this.pages(ctx, `${this.projectPath(ctx)}/zones`, {}, async (query) => {
      const result = await this.call(
        ctx,
        { method: "GET", path: `${this.projectPath(ctx)}/zones`, query },
        gceZoneListSchema
      );
      return {
        items: (result.items ?? []).flatMap((raw) => {
          const parsed = gceZoneSchema.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        }),
        next: result.nextPageToken,
      };
    });
  }

  /** The named machine types in every zone that offers them, keyed by zone name. */
  async machineTypesByZone(
    ctx: GceRequestContext,
    names: readonly string[]
  ): Promise<Map<string, z.infer<typeof gceMachineTypeSchema>[]>> {
    const pattern = names.map((name) => segment(name, GCE_NAME, "machine type")).join("|");
    const path = `${this.projectPath(ctx)}/aggregated/machineTypes`;
    const entries = await this.pages(
      ctx,
      path,
      // A regular expression must use `eq` and match the whole name.
      { filter: `name eq "(${pattern})"`, returnPartialSuccess: "true" },
      async (query) => {
        const result = await this.call(
          ctx,
          { method: "GET", path, query },
          gceMachineTypeAggregatedListSchema
        );
        const items: { zone: string; type: z.infer<typeof gceMachineTypeSchema> }[] = [];
        for (const [scope, entry] of Object.entries(result.items ?? {})) {
          const zone = /^zones\/([a-z0-9-]+)$/.exec(scope)?.[1];
          if (!zone) continue;
          for (const raw of entry.machineTypes ?? []) {
            const parsed = gceMachineTypeSchema.safeParse(raw);
            if (parsed.success) items.push({ zone, type: parsed.data });
          }
        }
        return { items, next: result.nextPageToken };
      }
    );
    const byZone = new Map<string, z.infer<typeof gceMachineTypeSchema>[]>();
    for (const { zone, type } of entries) byZone.set(zone, [...(byZone.get(zone) ?? []), type]);
    return byZone;
  }

  /** Every subnetwork in the project, keyed by nothing: each names its own region. */
  async listSubnetworks(ctx: GceRequestContext): Promise<GceSubnetwork[]> {
    const path = `${this.projectPath(ctx)}/aggregated/subnetworks`;
    return this.pages(ctx, path, { returnPartialSuccess: "true" }, async (query) => {
      const result = await this.call(
        ctx,
        { method: "GET", path, query },
        gceSubnetworkAggregatedListSchema
      );
      const items: GceSubnetwork[] = [];
      for (const entry of Object.values(result.items ?? {})) {
        for (const raw of entry.subnetworks ?? []) {
          const parsed = gceSubnetworkSchema.safeParse(raw);
          if (parsed.success) items.push(parsed.data);
        }
      }
      return { items, next: result.nextPageToken };
    });
  }

  /**
   * Every instance in the project, across zones, optionally only those
   * carrying one label. An answer that left a zone out fails rather than pass
   * a partial list off as complete: a create looked for there would read as
   * never made.
   */
  async listInstances(
    ctx: GceRequestContext,
    label?: { key: string; value: string }
  ): Promise<GceInstance[]> {
    const path = `${this.projectPath(ctx)}/aggregated/instances`;
    const filter = label ? `labels.${label.key} = "${label.value}"` : undefined;
    return this.pages(ctx, path, { filter }, async (query) => {
      const result = await this.call(
        ctx,
        { method: "GET", path, query },
        gceInstanceAggregatedListSchema
      );
      if ((result.unreachables ?? []).length > 0) {
        throw new GceApiError(
          "server",
          "Compute Engine couldn't list every zone right now",
          null,
          null
        );
      }
      const items: GceInstance[] = [];
      for (const entry of Object.values(result.items ?? {})) {
        for (const raw of entry.instances ?? []) {
          const parsed = gceInstanceSchema.safeParse(raw);
          if (parsed.success) items.push(parsed.data);
          // A lookup by label that skipped a row could read a machine that exists as never made.
          else if (label) {
            throw new GceApiError(
              "bad-response",
              "Compute Engine listed a machine in a shape Daintree doesn't recognise",
              null,
              null
            );
          }
        }
      }
      return { items, next: result.nextPageToken };
    });
  }

  async getInstance(ctx: GceRequestContext, zone: string, instance: string): Promise<GceInstance> {
    return this.call(
      ctx,
      { method: "GET", path: this.instancePath(ctx, zone, instance) },
      gceInstanceSchema
    );
  }

  /** Creates an instance. The caller's `requestId` makes every resend of this create the same request. */
  async insertInstance(
    ctx: GceRequestContext,
    zone: string,
    body: GceInsertInstanceBody,
    requestId: string
  ): Promise<GceOperation> {
    return this.call(
      ctx,
      {
        method: "POST",
        path: `${this.zonePath(ctx, zone)}/instances`,
        query: { requestId },
        body,
        mutation: true,
      },
      gceOperationSchema
    );
  }

  async startInstance(
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<GceOperation> {
    return this.mutate(ctx, "POST", `${this.instancePath(ctx, zone, instance)}/start`, undefined);
  }

  /** Brings a suspended instance back with its memory. */
  async resumeInstance(
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<GceOperation> {
    return this.mutate(ctx, "POST", `${this.instancePath(ctx, zone, instance)}/resume`, undefined);
  }

  /** A normal stop: the guest gets its shutdown, and the disks are kept. */
  async stopInstance(
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<GceOperation> {
    return this.mutate(ctx, "POST", `${this.instancePath(ctx, zone, instance)}/stop`, undefined);
  }

  /** Replaces the scheduling policy; Compute Engine takes a runtime limit only while the instance is stopped. */
  async setScheduling(
    ctx: GceRequestContext,
    zone: string,
    instance: string,
    scheduling: Record<string, unknown>
  ): Promise<GceOperation> {
    return this.mutate(
      ctx,
      "POST",
      `${this.instancePath(ctx, zone, instance)}/setScheduling`,
      scheduling
    );
  }

  /** Renames a stopped instance. */
  async setName(
    ctx: GceRequestContext,
    zone: string,
    instance: string,
    body: { currentName: string; name: string }
  ): Promise<GceOperation> {
    return this.mutate(ctx, "POST", `${this.instancePath(ctx, zone, instance)}/setName`, body);
  }

  /** Permanent deletion, with the boot disk that was created to go with it. */
  async deleteInstance(
    ctx: GceRequestContext,
    zone: string,
    instance: string
  ): Promise<GceOperation> {
    return this.mutate(ctx, "DELETE", this.instancePath(ctx, zone, instance), undefined);
  }

  /**
   * Waits for a zone operation to finish, asking Compute Engine to hold each
   * request until it does, and gives up at `deadline`, returning it as it
   * then stood.
   */
  async waitOperation(
    ctx: GceRequestContext,
    zone: string,
    operation: string,
    deadline: number
  ): Promise<GceOperation> {
    const path = `${this.zonePath(ctx, zone)}/operations/${segment(operation, OPERATION_NAME, "operation")}/wait`;
    let current: GceOperation | null = null;
    while (current?.status !== "DONE") {
      const left = deadline - Date.now();
      if (current && left <= 0) return current;
      current = await this.call(
        ctx,
        {
          method: "POST",
          path,
          timeoutMs: Math.max(1_000, Math.min(WAIT_REQUEST_TIMEOUT_MS, left)),
        },
        gceOperationSchema
      );
    }
    return current;
  }

  async guestAttributes(
    ctx: GceRequestContext,
    zone: string,
    instance: string,
    queryPath: string
  ): Promise<GceGuestAttributes> {
    return this.call(
      ctx,
      {
        method: "GET",
        path: `${this.instancePath(ctx, zone, instance)}/getGuestAttributes`,
        query: { queryPath },
      },
      gceGuestAttributesSchema
    );
  }

  private mutate(
    ctx: GceRequestContext,
    method: "POST" | "DELETE",
    path: string,
    body: unknown
  ): Promise<GceOperation> {
    return this.call(
      ctx,
      { method, path, query: { requestId: crypto.randomUUID() }, body, mutation: true },
      gceOperationSchema
    );
  }

  /** Follows a list to its end, failing past the page limit or on a page token seen before. */
  private async pages<T>(
    ctx: GceRequestContext,
    what: string,
    query: Record<string, string | undefined>,
    read: (query: Record<string, string | undefined>) => Promise<{ items: T[]; next?: string }>
  ): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.signal?.aborted) throw new GceApiError("cancelled", "Cancelled", null, null);
      const result = await read({ ...query, maxResults: "500", pageToken });
      out.push(...result.items);
      if (!result.next) return out;
      if (seen.has(result.next)) break;
      seen.add(result.next);
      pageToken = result.next;
    }
    throw new GceApiError(
      "bad-response",
      `Compute Engine's list at ${what} didn't end`,
      null,
      null
    );
  }

  private async call<S extends z.ZodType>(
    ctx: GceRequestContext,
    request: RequestOptions,
    schema: S
  ): Promise<z.infer<S>> {
    let lastError: GceApiError | null = null;
    let freshToken = false;
    let authRetried = false;
    let possiblyDelivered = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS;) {
      try {
        if (attempt > 0 && !freshToken) {
          const backoff = Math.min(500 * 2 ** (attempt - 1), 4_000) + Math.random() * 250;
          await this.sleep(Math.max(backoff, lastError?.retryAfterMs ?? 0), ctx.signal);
        }
        return await this.once(ctx, request, schema, freshToken);
      } catch (error) {
        if (!(error instanceof GceApiError)) throw error;
        // Cancelled between attempts or before a send: whatever an earlier send did still stands.
        if (error.kind === "cancelled") throw this.settled(error, request, possiblyDelivered);
        // A kept token Google has stopped honouring gets one fresh try of its own; a fresh one refused is final.
        if (error.kind === "unauthorized" && error.status === 401 && !authRetried) {
          authRetried = true;
          freshToken = true;
          lastError = error;
          if (ctx.signal?.aborted) throw this.settled(error, request, possiblyDelivered);
          continue;
        }
        freshToken = false;
        lastError = error;
        attempt += 1;
        const unanswered =
          error.kind === "network" || error.kind === "timeout" || error.kind === "server";
        // Only a request that left for Compute Engine can have done anything; a token that couldn't be had sent nothing.
        if (unanswered && !UNSENT.has(error)) possiblyDelivered = true;
        const retriable = unanswered || error.kind === "rate-limited";
        if (!retriable || ctx.signal?.aborted) {
          throw this.settled(error, request, possiblyDelivered);
        }
      }
    }
    throw this.settled(lastError!, request, possiblyDelivered);
  }

  /**
   * The error a request ends with. A write whose earlier attempt may have
   * reached Google ends unknown, whatever a later resend was told: the first
   * may have done what was asked.
   */
  private settled(
    error: GceApiError,
    request: RequestOptions,
    possiblyDelivered: boolean
  ): GceApiError {
    if (!request.mutation || !possiblyDelivered) return error;
    if (error.kind === "network" || error.kind === "timeout" || error.kind === "server") {
      return error;
    }
    return new GceApiError(
      "outcome-unknown",
      `An earlier attempt may have reached Compute Engine before it answered: ${error.message}`,
      error.status,
      error.reason
    );
  }

  private async once<S extends z.ZodType>(
    ctx: GceRequestContext,
    request: RequestOptions,
    schema: S,
    freshToken: boolean
  ): Promise<z.infer<S>> {
    // Already cancelled (while the key was read from the keychain, say): nothing is sent.
    if (ctx.signal?.aborted) throw new GceApiError("cancelled", "Cancelled", null, null);
    let token: string;
    try {
      token = await ctx.authorize(freshToken);
    } catch (error) {
      if (error instanceof GceApiError) UNSENT.add(error);
      throw error;
    }
    // Cancelled while the token was fetched: nothing is sent.
    if (ctx.signal?.aborted) throw new GceApiError("cancelled", "Cancelled", null, null);
    const url = new URL(`${this.options.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

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
      if (error instanceof GceApiError) throw error;
      if (ctx.signal?.aborted) throw new GceApiError("cancelled", "Cancelled", null, null);
      if (timeout.signal.aborted) {
        throw new GceApiError("timeout", "Compute Engine didn't answer in time", null, null);
      }
      throw new GceApiError("network", "Couldn't reach Compute Engine", null, null);
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
      const envelope = gceErrorEnvelopeSchema.safeParse(json);
      const error = envelope.success ? envelope.data.error : undefined;
      // The structured reason first; the legacy per-error reason is often coarser.
      const reason =
        error?.details?.find((detail) => detail.reason)?.reason ??
        error?.errors?.find((entry) => entry.reason)?.reason ??
        null;
      throw new GceApiError(
        kindForStatus(response.status, reason),
        redactGceText(error?.message ?? `Compute Engine answered ${response.status}`),
        response.status,
        reason,
        retryAfterMs(response.headers.get("retry-after"))
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new GceApiError(
        "bad-response",
        "Compute Engine answered in a shape Daintree doesn't recognise",
        response.status,
        null
      );
    }
    return parsed.data;
  }
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new GceApiError(
      "bad-response",
      "Compute Engine's answer was too large",
      response.status,
      null
    );
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new GceApiError(
      "bad-response",
      "Compute Engine's answer was too large",
      response.status,
      null
    );
  }
  return new TextDecoder().decode(body);
}
