import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Boat's public v1 API (https://docs.boat.dev/openapi/boat-v1.yaml),
 * covering the routes Daintree's adapter calls, with the same envelopes and
 * state names. Its "machines" are one private sshd on this Mac: authorizing an
 * SSH key appends it to that sshd's authorized_keys and answers with its real
 * address and host key, so the Shell reaches a real Host through it.
 *
 * Every request is recorded (method, path, the org it named, its idempotency
 * key and body) so a test can assert what Daintree did and didn't ask for.
 */

export const FAKE_BOAT_KEY = "boat_e2e_0123456789abcdefghijklmnopqrstuv";

export interface FakeBoatRequest {
  method: string;
  path: string;
  org: string | null;
  idempotencyKey: string | null;
  body: unknown;
  at: number;
}

interface Sandbox {
  id: string;
  name: string;
  state: string;
  type: string;
  ttlSeconds: number | null;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  stoppedAt: string | null;
  archiveAfter: string | null;
  stop: {
    id: string;
    status: string;
    requestedAt: string | null;
    lastAttemptAt: string | null;
    error: string | null;
    endedAt: string | null;
  } | null;
}

export interface FakeBoat {
  url: string;
  requests: FakeBoatRequest[];
  sandboxes: Map<string, Sandbox>;
  /** How long provisioning and archiving take. */
  transitionMs: number;
  stop(): Promise<void>;
}

const SIZES: Record<string, { vcpu: number; memoryGB: number; multiplier: number }> = {
  small: { vcpu: 2, memoryGB: 4, multiplier: 0.5 },
  default: { vcpu: 4, memoryGB: 8, multiplier: 1 },
  large: { vcpu: 8, memoryGB: 16, multiplier: 2 },
  xlarge: { vcpu: 16, memoryGB: 32, multiplier: 50 / 9 },
};

function sandboxId(n: number): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let out = "";
  let value = n + 1234567;
  for (let i = 0; i < 8; i++) {
    out += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length);
  }
  return `bx_${out}`;
}

export async function startFakeBoat(params: {
  sshdPort: number;
  sshdRoot: string;
}): Promise<FakeBoat> {
  const hostKey = (await fs.readFile(path.join(params.sshdRoot, "hostkey.pub"), "utf8")).trim();
  const authorizedKeys = path.join(params.sshdRoot, "authorized_keys");
  const user = os.userInfo().username;
  const requests: FakeBoatRequest[] = [];
  const sandboxes = new Map<string, Sandbox>();
  const idempotency = new Map<string, string>();
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;

  const fake: FakeBoat = {
    url: "",
    requests,
    sandboxes,
    transitionMs: 1_500,
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

  const view = (sandbox: Sandbox) => {
    const size = SIZES[sandbox.type] ?? SIZES.default!;
    return {
      ...sandbox,
      vcpu: size.vcpu,
      memoryGB: size.memoryGB,
      billingMultiplier: size.multiplier,
      ip: sandbox.state === "ready" ? "127.0.0.1" : null,
      sshEndpoint: null,
      desktopAvailable: false,
      snapshotAvailable: sandbox.stoppedAt !== null,
      snapshots: true,
      access: "owner",
      dataExpiredAt: null,
    };
  };

  const touch = (sandbox: Sandbox, state: string) => {
    sandbox.state = state;
    sandbox.updatedAt = new Date().toISOString();
  };

  const bootLater = (sandbox: Sandbox) => {
    later(() => {
      touch(sandbox, "ready");
      sandbox.stoppedAt = null;
      sandbox.archiveAfter =
        sandbox.ttlSeconds === null
          ? null
          : new Date(Date.now() + sandbox.ttlSeconds * 1000).toISOString();
    });
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const route = url.pathname.replace(/^\/api\/v1/, "");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      requests.push({
        method: req.method ?? "GET",
        path: `${route}${url.search}`,
        org: (req.headers["x-boat-org"] as string | undefined) ?? null,
        idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
        body,
        at: Date.now(),
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const fail = (status: number, code: string, message: string) =>
        send(status, {
          ok: false,
          type: "sandbox.error",
          status,
          code,
          message,
          requestId: "req_fake",
          error: { code, message, status },
        });
      if (req.headers.authorization !== `Bearer ${FAKE_BOAT_KEY}`) {
        fail(401, "unauthorized", "Invalid API key");
        return;
      }
      const method = req.method ?? "GET";
      const match = /^\/sandboxes\/(bx_[a-z0-9]+)(\/[a-z]+)?$/.exec(route);
      const sandbox = match ? sandboxes.get(match[1]!) : undefined;
      const action = match?.[2] ?? "";

      if (method === "GET" && route === "/me") {
        send(200, { ok: true, type: "user.info", user: { id: "acct_e2e", login: "e2e-user" } });
      } else if (method === "GET" && route === "/orgs") {
        send(200, {
          ok: true,
          type: "org.list",
          activeWalletChosen: false,
          orgs: [
            {
              id: "acct_e2e",
              name: "Personal",
              type: "personal",
              role: "owner",
              memberCount: 1,
              active: true,
            },
          ],
        });
      } else if (method === "GET" && route === "/limits") {
        send(200, {
          ok: true,
          type: "limits.info",
          canStart: true,
          overagePrices: { vmHourDollars: 0.036, savedSnapshotDayDollars: 0.056 },
          planIncluded: {
            vmHours: 555.56,
            vmHoursRemaining: 312.7,
            periodEnd: "2026-12-01T00:00:00.000Z",
          },
          starts: {
            unlimited: false,
            minute: { limit: 10, used: 0, remaining: 10 },
            hour: { limit: 50, used: 0, remaining: 50 },
          },
          machineTypes: [
            { type: "small", available: true, reason: null },
            { type: "default", available: true, reason: null },
            { type: "large", available: true, reason: null },
            { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
          ],
        });
      } else if (method === "GET" && route === "/sandboxes") {
        const label = url.searchParams.get("label");
        let list = [...sandboxes.values()];
        if (label) {
          const [key, value] = label.split("=");
          list = list.filter((entry) => entry.labels[key!] === value);
        }
        send(200, {
          ok: true,
          type: "sandbox.list",
          sandboxes: list.map(view),
          pageInfo: { nextCursor: null, hasMore: false, limit: 100 },
        });
      } else if (method === "POST" && route === "/sandboxes") {
        const key = (req.headers["idempotency-key"] as string | undefined) ?? null;
        const existing = key ? idempotency.get(key) : undefined;
        if (existing) {
          send(202, {
            ok: true,
            type: "sandbox.created",
            status: "provisioning",
            sandbox: view(sandboxes.get(existing)!),
          });
          return;
        }
        const request = (body ?? {}) as {
          name?: string;
          type?: string;
          ttlSeconds?: number | null;
          labels?: Record<string, string>;
        };
        const now = new Date().toISOString();
        const created: Sandbox = {
          id: sandboxId(counter++),
          name: request.name ?? "Sandbox",
          state: "provisioning",
          type: request.type ?? "default",
          ttlSeconds: request.ttlSeconds === undefined ? 3600 : request.ttlSeconds,
          labels: request.labels ?? {},
          createdAt: now,
          updatedAt: now,
          stoppedAt: null,
          archiveAfter: null,
          stop: null,
        };
        sandboxes.set(created.id, created);
        if (key) idempotency.set(key, created.id);
        bootLater(created);
        send(202, {
          ok: true,
          type: "sandbox.created",
          status: "provisioning",
          sandbox: view(created),
        });
      } else if (!sandbox) {
        fail(404, "sandbox_not_found", "No such sandbox");
      } else if (method === "GET" && action === "") {
        send(200, { ok: true, type: "sandbox.info", sandbox: view(sandbox) });
      } else if (method === "PATCH" && action === "") {
        const update = (body ?? {}) as { name?: string; ttlSeconds?: number | null };
        if (update.name) sandbox.name = update.name;
        if (update.ttlSeconds !== undefined) {
          sandbox.ttlSeconds = update.ttlSeconds;
          sandbox.archiveAfter =
            update.ttlSeconds === null
              ? null
              : new Date(Date.now() + update.ttlSeconds * 1000).toISOString();
        }
        send(200, { ok: true, type: "sandbox.info", sandbox: view(sandbox) });
      } else if (method === "POST" && action === "/stop") {
        if (sandbox.state === "archived") {
          send(200, {
            ok: true,
            type: "sandbox.stopped",
            id: sandbox.id,
            status: "archived",
            sandbox: view(sandbox),
            operation: sandbox.stop,
          });
          return;
        }
        if (sandbox.state !== "archiving") {
          const now = new Date().toISOString();
          sandbox.stop = {
            id: `stop_${counter++}`,
            status: "pending",
            requestedAt: now,
            lastAttemptAt: null,
            error: null,
            endedAt: null,
          };
          touch(sandbox, "archiving");
          later(() => {
            touch(sandbox, "archived");
            sandbox.stoppedAt = new Date().toISOString();
            sandbox.archiveAfter = null;
            sandbox.stop = { ...sandbox.stop!, status: "completed", endedAt: sandbox.stoppedAt };
          });
        }
        send(202, {
          ok: true,
          type: "sandbox.stopping",
          id: sandbox.id,
          status: "archiving",
          sandbox: view(sandbox),
          operation: sandbox.stop,
        });
      } else if (method === "POST" && action === "/resume") {
        if (sandbox.state === "archiving") {
          fail(409, "sandbox_stopping", "The sandbox is still stopping");
          return;
        }
        const resume = (body ?? {}) as { ttlSeconds?: number | null };
        if (resume.ttlSeconds !== undefined) sandbox.ttlSeconds = resume.ttlSeconds;
        touch(sandbox, "provisioning");
        bootLater(sandbox);
        send(202, {
          ok: true,
          type: "sandbox.resuming",
          id: sandbox.id,
          status: "resuming",
          sandbox: view(sandbox),
        });
      } else if (method === "POST" && action === "/sshkey") {
        if (sandbox.state !== "ready") {
          fail(409, "sandbox_not_running", "The sandbox isn't running");
          return;
        }
        const key = String((body as { key?: unknown } | null)?.key ?? "");
        void fs
          .readFile(authorizedKeys, "utf8")
          .catch(() => "")
          .then(async (current) => {
            if (!current.includes(key)) await fs.appendFile(authorizedKeys, `${key}\n`);
            send(200, {
              ok: true,
              type: "ssh_key.configured",
              success: true,
              machineIp: null,
              sshUser: user,
              sshEndpoint: `127.0.0.1:${params.sshdPort}`,
              hostKey,
            });
          });
      } else if (method === "DELETE" && action === "") {
        if (req.headers["x-ascii-confirm-delete"] !== sandbox.id) {
          fail(409, "confirm_delete_mismatch", "Confirmation header must name the sandbox");
          return;
        }
        sandboxes.delete(sandbox.id);
        send(202, {
          ok: true,
          type: "deletion.accepted",
          id: `bdop_${"0".repeat(32)}`,
          status: "accepted",
        });
      } else {
        fail(404, "not_found", `No route ${method} ${route}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return fake;
}
