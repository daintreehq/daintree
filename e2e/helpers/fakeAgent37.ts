import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Agent 37's Sandbox API (https://www.agent37.com/docs/agents-api),
 * covering the routes Daintree's adapter calls, with the same envelopes,
 * statuses and error codes. Its "instances" are one private sshd on this Mac:
 * registering an SSH key appends it to that sshd's authorized_keys, and the
 * fake `agent37` command ({@link writeFakeAgent37Cli}) pipes every tunnel to
 * that sshd, so the Shell reaches a real Host through the provider's own
 * transport, as it would on Agent 37.
 *
 * Every request is recorded (method, path, body) so a test can assert what
 * Daintree did and didn't ask for; every tunnel the fake command opened is
 * recorded too.
 */

// Agent 37's prefix, but broken up so nothing takes it for a live key.
export const FAKE_AGENT37_KEY = "sk_live_fake-agent37-e2e-0042";

export interface FakeAgent37Request {
  method: string;
  path: string;
  body: unknown;
  at: number;
}

export interface FakeAgent37Instance {
  id: string;
  status: string;
  name: string | null;
  metadata: Record<string, unknown> | null;
  resources: { cpu: number; memory: number; disk: number };
  auto_sleep: boolean;
  idle_timeout_seconds: number;
  slept_at: number | null;
  created: number;
}

export interface FakeAgent37 {
  url: string;
  requests: FakeAgent37Request[];
  /** The hostnames each tunnel was opened to, in order. */
  tunnels: string[];
  instances: Map<string, FakeAgent37Instance>;
  /** How long a create and a start take. */
  transitionMs: number;
  /** An instance made outside Daintree, as on Agent 37's dashboard. */
  seed(overrides?: Partial<FakeAgent37Instance>): FakeAgent37Instance;
  /** Puts an instance to sleep, as Agent 37 does after its idle timeout. */
  sleep(id: string): void;
  stop(): Promise<void>;
}

function epoch(): number {
  return Math.floor(Date.now() / 1000);
}

export async function startFakeAgent37(params: { sshdRoot: string }): Promise<FakeAgent37> {
  const authorizedKeys = path.join(params.sshdRoot, "authorized_keys");
  const requests: FakeAgent37Request[] = [];
  const tunnels: string[] = [];
  const instances = new Map<string, FakeAgent37Instance>();
  const keys = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;

  const nextId = () => (1_000_000_000 + counter++ * 7_919).toString(36).padStart(10, "a");

  const make = (overrides: Partial<FakeAgent37Instance> = {}): FakeAgent37Instance => ({
    id: nextId(),
    status: "running",
    name: null,
    metadata: null,
    resources: { cpu: 2, memory: 4, disk: 4 },
    auto_sleep: false,
    idle_timeout_seconds: 900,
    slept_at: null,
    created: epoch(),
    ...overrides,
  });

  const fake: FakeAgent37 = {
    url: "",
    requests,
    tunnels,
    instances,
    transitionMs: 1_500,
    seed(overrides) {
      const instance = make(overrides);
      instances.set(instance.id, instance);
      return instance;
    },
    sleep(id) {
      const instance = instances.get(id);
      if (!instance) throw new Error(`No fake instance ${id}`);
      instance.status = "sleeping";
      instance.slept_at = epoch();
    },
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const later = (fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, fake.transitionMs);
    timers.add(timer);
  };

  const view = (instance: FakeAgent37Instance) => ({
    ...instance,
    status_reason: null,
    template: "agent37-base",
    template_revision: null,
    image_ref: "ghcr.io/agent37-platform/base:2026.11.01",
    image_digest: `sha256:${"0".repeat(64)}`,
    type: "default",
    region: "us",
    mount_path: "/home/node",
    url: `https://${instance.id}.agent37.app`,
    domain_urls: [],
    public_ports: [],
    network: "allow-all",
    past_due: false,
    slept_at:
      instance.status === "sleeping" || instance.status === "waking"
        ? instance.slept_at
        : undefined,
  });

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const route = url.pathname.replace(/^\/v1/, "");
      const method = req.method ?? "GET";
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const fail = (status: number, code: string, message: string) =>
        send(status, { error: { code, message } });

      // The fake CLI's side door: what the edge decides before it hands a tunnel to sshd.
      const tunnel = /^\/__tunnel\/([a-z0-9]{10})\.agent37\.app$/.exec(route);
      if (tunnel) {
        const instance = instances.get(tunnel[1]!);
        tunnels.push(`${tunnel[1]}.agent37.app`);
        if (!instance) return fail(404, "not_found", "No such instance");
        // A request to a sleeper wakes it; a stopped one refuses connections.
        if (instance.status === "sleeping") instance.status = "running";
        if (instance.status !== "running") {
          return fail(502, "container_unavailable", `The instance is ${instance.status}`);
        }
        return send(200, { ok: true });
      }

      requests.push({ method, path: `${route}${url.search}`, body, at: Date.now() });
      if (req.headers.authorization !== `Bearer ${FAKE_AGENT37_KEY}`) {
        return fail(401, "invalid_api_key", "The API key is missing, malformed, or revoked.");
      }
      const match = /^\/instances\/([a-z0-9]{10})(\/[a-z]+)?$/.exec(route);
      const instance = match ? instances.get(match[1]!) : undefined;
      const action = match?.[2] ?? "";

      if (method === "GET" && route === "/billing") {
        send(200, {
          balance_usd: 5,
          tier: 0,
          memory_limit_gb: 32,
          instance_limit: 8,
          auto_top_up: null,
          past_due: false,
        });
      } else if (method === "GET" && route === "/instances") {
        send(200, { data: [...instances.values()].reverse().map(view) });
      } else if (method === "POST" && route === "/instances") {
        const request = (body ?? {}) as Partial<FakeAgent37Instance>;
        const created = make({
          status: "provisioning",
          name: request.name ?? null,
          metadata: request.metadata ?? null,
          resources: request.resources ?? { cpu: 2, memory: 4, disk: 4 },
          auto_sleep: request.auto_sleep === true,
          idle_timeout_seconds: request.idle_timeout_seconds ?? 900,
        });
        instances.set(created.id, created);
        // The real create answers only once the instance is running.
        later(() => {
          created.status = "running";
          send(201, view(created));
        });
      } else if (method === "POST" && route === "/ssh-keys") {
        const key = String((body as { public_key?: unknown } | null)?.public_key ?? "").trim();
        if (!/^ssh-ed25519 [A-Za-z0-9+/=]+/.test(key)) {
          return fail(400, "invalid_request", "public_key must be one OpenSSH public key line");
        }
        const blob = key.split(/\s+/).slice(0, 2).join(" ");
        if (keys.has(blob)) return fail(409, "ssh_key_exists", "This key is already registered.");
        keys.add(blob);
        void fs.appendFile(authorizedKeys, `${key}\n`).then(() =>
          send(201, {
            id: `${counter++}`.padStart(24, "0"),
            name: (body as { name?: string }).name ?? null,
            fingerprint: "SHA256:fake",
            type: "ssh-ed25519",
            created: epoch(),
          })
        );
      } else if (!instance) {
        fail(404, "not_found", "No instance with that id in your workspace.");
      } else if (method === "GET" && action === "") {
        send(200, view(instance));
      } else if (method === "PATCH" && action === "") {
        const update = (body ?? {}) as { name?: string | null };
        if ("name" in update) instance.name = update.name || null;
        send(200, view(instance));
      } else if (method === "DELETE" && action === "") {
        instances.delete(instance.id);
        send(200, { id: instance.id, deleted: true });
      } else if (method === "POST" && action === "/start") {
        if (instance.status === "running") return send(200, { id: instance.id, status: "running" });
        instance.status = instance.status === "sleeping" ? "waking" : "starting";
        instance.slept_at = instance.status === "waking" ? instance.slept_at : null;
        later(() => {
          instance.status = "running";
          instance.slept_at = null;
        });
        send(202, { id: instance.id, status: instance.status });
      } else if (method === "POST" && action === "/stop") {
        if (!["running", "sleeping", "stopped"].includes(instance.status)) {
          return fail(400, "invalid_request", `Can't stop an instance that is ${instance.status}`);
        }
        instance.status = "stopped";
        instance.slept_at = null;
        send(200, { id: instance.id, status: "stopped" });
      } else {
        fail(404, "not_found", `No route ${method} ${route}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return fake;
}

/**
 * Two commands for the Shell. `bin/agent37`, first on its PATH, is Agent 37's
 * CLI as far as `ProxyCommand agent37 tunnel %h` can tell: it asks the fake
 * whether the instance takes a tunnel (as the real edge does) and then pipes
 * the stream to the private sshd. `ssh-as-me/ssh`, named by `DAINTREE_SSH`, is
 * the system ssh logging in as this Mac's user: the private sshd can't log in
 * as Agent 37's `node`, and the generated config still says `User node`.
 */
export async function writeFakeAgent37Cli(
  root: string,
  params: { apiUrl: string; sshdPort: number }
): Promise<{ binDir: string; sshPath: string }> {
  const binDir = path.join(root, "bin");
  const shimDir = path.join(root, "ssh-as-me");
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(shimDir, { recursive: true });
  const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  await fs.writeFile(
    path.join(binDir, "agent37"),
    [
      "#!/bin/sh",
      'if [ "$1" != tunnel ] || [ -z "$2" ]; then echo "agent37 (fake): only tunnel <host>" >&2; exit 2; fi',
      `/usr/bin/curl -fsS -o /dev/null ${q(`${params.apiUrl}/__tunnel/`)}"$2" || { echo "agent37 (fake): $2 refused the tunnel" >&2; exit 1; }`,
      `exec /usr/bin/nc 127.0.0.1 ${params.sshdPort}`,
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  const sshPath = path.join(shimDir, "ssh");
  await fs.writeFile(
    sshPath,
    ["#!/bin/sh", 'exec /usr/bin/ssh -l "$(/usr/bin/id -un)" "$@"', ""].join("\n"),
    { mode: 0o755 }
  );
  return { binDir, sshPath };
}
