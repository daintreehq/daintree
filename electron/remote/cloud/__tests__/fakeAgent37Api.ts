/**
 * An in-memory stand-in for Agent 37's Sandbox API
 * (https://www.agent37.com/docs/agents-api), answering the routes Daintree's
 * adapter calls with the documented envelopes, statuses and error codes. It
 * is a `fetch`, so the real client runs against it unchanged. Every request
 * is recorded, and a route can be made to fail a number of times.
 */

// Agent 37's prefix, but broken up so nothing takes it for a live key.
export const FAKE_AGENT37_KEY = "sk_live_fake-agent37-unit-0042";

export interface FakeAgent37Instance {
  id: string;
  status: string;
  name: string | null;
  metadata: Record<string, unknown> | null;
  type: string;
  template: string;
  resources: { cpu: number; memory: number; disk: number };
  auto_sleep: boolean;
  idle_timeout_seconds: number;
  slept_at: number | null;
  past_due: boolean;
  status_reason: { code: string; message: string; operation: string; at: number } | null;
  created: number;
}

/** A minted signed URL: its token reaches one port of one instance until `expiresAt` (Unix seconds). */
export interface FakeAgent37SignedUrl {
  instanceId: string;
  port: number;
  token: string;
  expiresAt: number;
}

/** What answers on one port of an instance, behind Agent 37's edge: the method, path and query as forwarded. */
export type FakeAgent37PortHandler = (
  pathAndQuery: string,
  method: string
) => Response | Promise<Response>;

export interface FakeAgent37Request {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

interface Failure {
  method: string;
  path: RegExp;
  times: number;
  respond: () => Response | Error;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } });
}

export class FakeAgent37Api {
  readonly instances = new Map<string, FakeAgent37Instance>();
  readonly sshKeys: Array<{ id: string; name: string | null; key: string; created: number }> = [];
  readonly requests: FakeAgent37Request[] = [];
  billing = { balance_usd: 4.2, tier: 0, memory_limit_gb: 32, past_due: false };
  readonly signedUrls: FakeAgent37SignedUrl[] = [];
  /** Requests that reached an instance's port through the edge, by `{id}:{port}`. */
  readonly edgeHits = new Map<string, number>();
  private readonly failures: Failure[] = [];
  private readonly ports = new Map<string, FakeAgent37PortHandler>();
  /** When each instance last had activity Agent 37 counts, in its own seconds. */
  private readonly activityAt = new Map<string, number>();
  private counter = 0;
  private clock = 1_781_222_400;

  /** Agent 37's clock, in milliseconds: what it stamps on what it makes. */
  get now(): number {
    return this.clock * 1000;
  }

  constructor(readonly baseUrl = "https://api.agent37.test/v1") {}

  readonly fetch = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : null;
    const path = url.pathname.slice(new URL(this.baseUrl).pathname.length);
    this.requests.push({ method, path, authorization: headers.Authorization ?? null, body });
    const failure = this.failures.find(
      (entry) => entry.times > 0 && entry.method === method && entry.path.test(path)
    );
    if (failure) {
      failure.times -= 1;
      const answer = failure.respond();
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (headers.Authorization !== `Bearer ${FAKE_AGENT37_KEY}`) {
      return apiError(401, "invalid_api_key", "The API key is missing, malformed, or revoked.");
    }
    return this.route(method, path, body);
  };

  /** The next `times` requests matching answer with `respond` instead. */
  fail(method: string, path: RegExp, respond: () => Response | Error, times = 1): void {
    this.failures.push({ method, path, times, respond });
  }

  static error(status: number, code: string, message = code): () => Response {
    return () => apiError(status, code, message);
  }

  /** An instance that already exists in the workspace, as one made on Agent 37's dashboard. */
  seed(overrides: Partial<FakeAgent37Instance> = {}): FakeAgent37Instance {
    const instance = this.make({}, overrides);
    this.instances.set(instance.id, instance);
    return instance;
  }

  calls(method: string, path: string | RegExp): FakeAgent37Request[] {
    return this.requests.filter(
      (request) =>
        request.method === method &&
        (typeof path === "string" ? request.path === path : path.test(request.path))
    );
  }

  /**
   * Something listening on `port` inside the instance, reached through the
   * edge. Returns what takes it away again.
   */
  listen(instanceId: string, port: number, handler: FakeAgent37PortHandler): () => void {
    const key = `${instanceId}:${port}`;
    this.ports.set(key, handler);
    return () => {
      if (this.ports.get(key) === handler) this.ports.delete(key);
    };
  }

  /**
   * Moves Agent 37's clock on, and sleeps every running instance with
   * auto-sleep on whose last activity is `idle_timeout_seconds` old, as its
   * own idle timer would.
   */
  advance(seconds: number): void {
    this.clock += seconds;
    for (const instance of this.instances.values()) {
      if (instance.status !== "running" || !instance.auto_sleep) continue;
      const last = this.activityAt.get(instance.id) ?? instance.created;
      if (this.clock - last >= instance.idle_timeout_seconds) {
        instance.status = "sleeping";
        instance.slept_at = this.clock;
      }
    }
  }

  /**
   * Agent 37's edge for the instances' preview URLs (`https://{id}-{port}.agent37.app`):
   * a request with a live `a37_token` for that instance and port wakes a
   * sleeping instance and reaches whatever listens on the port with the token
   * stripped, counting as activity, or answers 502 when nothing does.
   */
  readonly edge = async (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const host = /^([a-z0-9]{10})-(\d{1,5})\.agent37\.app$/.exec(url.hostname);
    const instance = host ? this.instances.get(host[1]!) : undefined;
    if (!host || !instance || url.protocol !== "https:") {
      return apiError(404, "not_found", "No such instance URL.");
    }
    const port = Number(host[2]);
    const token = url.searchParams.get("a37_token");
    const grant = this.signedUrls.find(
      (entry) => entry.token === token && entry.instanceId === instance.id && entry.port === port
    );
    if (!grant || grant.expiresAt <= this.clock) {
      return apiError(401, "unauthorized", "Missing or expired access token.");
    }
    if (instance.status === "sleeping" || instance.status === "waking") {
      instance.status = "running";
      instance.slept_at = null;
    }
    if (instance.status !== "running") {
      return apiError(503, "wake_failed", `The instance is ${instance.status}.`);
    }
    const key = `${instance.id}:${port}`;
    const handler = this.ports.get(key);
    // Whether a transport error counts is undocumented, so the fake never credits one.
    if (!handler) return new Response("Bad Gateway", { status: 502 });
    this.activityAt.set(instance.id, this.clock);
    this.edgeHits.set(key, (this.edgeHits.get(key) ?? 0) + 1);
    url.searchParams.delete("a37_token");
    return handler(`${url.pathname}${url.search}`, init?.method ?? "GET");
  };

  private nextId(): string {
    return (1_000_000_000 + this.counter++ * 7_919).toString(36).padStart(10, "a");
  }

  private make(
    body: Record<string, unknown>,
    overrides: Partial<FakeAgent37Instance> = {}
  ): FakeAgent37Instance {
    this.clock += 60;
    const resources = (body.resources as FakeAgent37Instance["resources"] | undefined) ?? {
      cpu: 2,
      memory: 4,
      disk: 4,
    };
    return {
      id: this.nextId(),
      status: "running",
      name: typeof body.name === "string" ? body.name : null,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? null,
      type: typeof body.type === "string" ? body.type : "default",
      template: typeof body.template === "string" ? body.template : "agent37-base",
      resources,
      auto_sleep: body.auto_sleep === true,
      idle_timeout_seconds:
        typeof body.idle_timeout_seconds === "number" ? body.idle_timeout_seconds : 900,
      slept_at: null,
      past_due: false,
      status_reason: null,
      created: this.clock,
      ...overrides,
    };
  }

  private view(instance: FakeAgent37Instance) {
    return {
      ...instance,
      status_reason: instance.status_reason,
      template_revision: null,
      image_ref: "ghcr.io/agent37-platform/base:2026.11.01",
      image_digest: `sha256:${"0".repeat(64)}`,
      region: "us",
      mount_path: "/home/node",
      url: `https://${instance.id}.agent37.app`,
      domain_urls: [],
      public_ports: [],
      network: "allow-all",
      ...(instance.status === "sleeping" || instance.status === "waking"
        ? { slept_at: instance.slept_at }
        : { slept_at: undefined }),
    };
  }

  private route(method: string, path: string, body: unknown): Response {
    const match = /^\/instances\/([^/]+)(\/[a-z-]+)?$/.exec(path);
    const instance = match ? this.instances.get(match[1]!) : undefined;
    const action = match?.[2] ?? "";
    if (method === "GET" && path === "/billing") {
      return json(200, { ...this.billing, instance_limit: 8, auto_top_up: null });
    }
    if (method === "GET" && path === "/instances") {
      return json(200, {
        data: [...this.instances.values()].reverse().map((entry) => this.view(entry)),
      });
    }
    if (method === "POST" && path === "/instances") {
      const created = this.make((body ?? {}) as Record<string, unknown>);
      this.instances.set(created.id, created);
      return json(201, this.view(created));
    }
    if (method === "POST" && path === "/ssh-keys") {
      const key = String((body as { public_key?: unknown } | null)?.public_key ?? "");
      if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+/.test(key)) {
        return apiError(400, "invalid_request", "public_key must be one OpenSSH public key line");
      }
      const blob = key.split(/\s+/).slice(0, 2).join(" ");
      if (this.sshKeys.some((entry) => entry.key === blob)) {
        return apiError(409, "ssh_key_exists", "This key is already registered.");
      }
      if (this.sshKeys.length >= 20) {
        return apiError(400, "invalid_request", "A workspace holds at most 20 SSH keys.");
      }
      const entry = {
        id: `${this.counter++}`.padStart(24, "0"),
        name: ((body as { name?: string } | null)?.name ?? null) as string | null,
        key: blob,
        created: this.clock,
      };
      this.sshKeys.push(entry);
      return json(201, {
        id: entry.id,
        name: entry.name,
        fingerprint: "SHA256:fake",
        type: blob.split(" ")[0],
        created: entry.created,
      });
    }
    if (!instance) return apiError(404, "not_found", "No instance with that id in your workspace.");
    if (method === "GET" && action === "") return json(200, this.view(instance));
    if (method === "PATCH" && action === "") {
      const update = (body ?? {}) as {
        name?: string | null;
        auto_sleep?: unknown;
        idle_timeout_seconds?: unknown;
      };
      const idle = update.idle_timeout_seconds;
      if (
        idle !== undefined &&
        (typeof idle !== "number" || !Number.isInteger(idle) || idle < 300 || idle > 86_400)
      ) {
        return apiError(400, "invalid_request", "idle_timeout_seconds must be 300 to 86400.");
      }
      if (update.auto_sleep !== undefined && typeof update.auto_sleep !== "boolean") {
        return apiError(400, "invalid_request", "auto_sleep must be a boolean.");
      }
      if ("name" in update) instance.name = update.name || null;
      if (typeof update.auto_sleep === "boolean") instance.auto_sleep = update.auto_sleep;
      if (typeof idle === "number") instance.idle_timeout_seconds = idle;
      return json(200, this.view(instance));
    }
    if (method === "DELETE" && action === "") {
      this.instances.delete(instance.id);
      return json(200, { id: instance.id, deleted: true });
    }
    if (method === "POST" && action === "/signed-url") {
      const request = (body ?? {}) as { port?: unknown; ttl_seconds?: unknown };
      const port = request.port;
      if (
        typeof port !== "number" ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65_535 ||
        port === 22_022
      ) {
        return apiError(400, "invalid_request", "port must be 1 to 65535, and not 22022.");
      }
      const ttl = request.ttl_seconds ?? 3600;
      if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0) {
        return apiError(400, "invalid_request", "ttl_seconds must be a positive integer.");
      }
      if (!["running", "sleeping", "waking"].includes(instance.status)) {
        return apiError(400, "invalid_request", `The instance is ${instance.status}.`);
      }
      const grant: FakeAgent37SignedUrl = {
        instanceId: instance.id,
        port,
        token: `tok${this.counter++}`.padEnd(32, "f"),
        expiresAt: this.clock + Math.min(Math.max(ttl, 60), 604_800),
      };
      this.signedUrls.push(grant);
      return json(200, {
        url: `https://${instance.id}-${port}.agent37.app/?a37_token=${grant.token}`,
        domain_urls: [],
        port,
        expires_at: grant.expiresAt,
      });
    }
    if (method === "POST" && action === "/start") {
      if (instance.past_due) return apiError(402, "insufficient_balance", "Top up first.");
      instance.status = "running";
      instance.slept_at = null;
      this.activityAt.set(instance.id, this.clock);
      return json(200, { id: instance.id, status: instance.status });
    }
    if (method === "POST" && action === "/stop") {
      if (
        instance.status !== "running" &&
        instance.status !== "sleeping" &&
        instance.status !== "stopped"
      ) {
        return apiError(
          400,
          "invalid_request",
          `Can't stop an instance that is ${instance.status}.`
        );
      }
      instance.status = "stopped";
      instance.slept_at = null;
      return json(200, { id: instance.id, status: instance.status });
    }
    if (method === "POST" && action === "/sleep") {
      // An instance already asleep answers the same ack again; any other state is refused.
      if (instance.status !== "running" && instance.status !== "sleeping") {
        return apiError(
          400,
          "invalid_request",
          `Can't sleep an instance that is ${instance.status}.`
        );
      }
      if (instance.status === "running") {
        instance.status = "sleeping";
        instance.slept_at = this.clock;
      }
      return json(200, { id: instance.id, status: instance.status });
    }
    return apiError(404, "not_found", `No route ${method} ${path}`);
  }
}
