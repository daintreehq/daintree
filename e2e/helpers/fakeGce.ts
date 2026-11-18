import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for Google's token endpoint and the Compute Engine v1 calls
 * Daintree's adapter makes, with Google's envelopes, operation objects and
 * status names. Its one "zone" of machines is a private sshd on this Mac: an
 * insert appends the key from the VM's `ssh-keys` metadata to that sshd's
 * authorized_keys, the VM's external address is 127.0.0.1, and its guest
 * attributes publish that sshd's real host key once it has "booted".
 *
 * Assertions are checked against the service account's public key and the
 * fake's own token URL, so a token is only ever issued to a properly signed
 * request. Every request is recorded so a test can assert what was asked.
 */

export const FAKE_GCE_PROJECT = "daintree-e2e-target";
export const FAKE_GCE_KEY_PROJECT = "daintree-e2e-home";
export const FAKE_GCE_CLIENT_EMAIL = "daintree-e2e@daintree-e2e-home.iam.gserviceaccount.com";

export interface FakeGceRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  at: number;
}

interface Instance {
  id: string;
  name: string;
  zone: string;
  status: string;
  labels: Record<string, string>;
  scheduling: Record<string, unknown>;
  machineType: string;
  /** The create asked for an external address. */
  external: boolean;
  hostKeysPublished: boolean;
  createdAt: string;
  lastStartAt: string | null;
  lastStopAt: string | null;
}

interface Operation {
  name: string;
  zone: string;
  targetId: string;
  status: "RUNNING" | "DONE";
}

export interface FakeGce {
  /** The Compute Engine base: `http://127.0.0.1:{port}/compute/v1`. */
  url: string;
  requests: FakeGceRequest[];
  instances: Map<string, Instance>;
  /** How long provisioning, starting, stopping and deleting take. */
  transitionMs: number;
  /** How long after a VM runs before its guest publishes its host keys. */
  hostKeyDelayMs: number;
  stop(): Promise<void>;
}

/** A service-account key file for the fake, and the public half it checks assertions with. */
export function makeFakeServiceAccountKey(): { keyFile: string; publicKeyPem: string } {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    keyFile: JSON.stringify(
      {
        type: "service_account",
        project_id: FAKE_GCE_KEY_PROJECT,
        private_key_id: "e2e0123456789abcdef",
        private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        client_email: FAKE_GCE_CLIENT_EMAIL,
        client_id: "100000000000000000001",
        token_uri: "https://oauth2.googleapis.com/token",
      },
      null,
      2
    ),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

const ZONES = [
  { name: "us-central1-a", region: "us-central1" },
  { name: "us-central1-b", region: "us-central1" },
  { name: "europe-west1-b", region: "europe-west1" },
];
const MACHINE_TYPES = ["e2-standard-2", "e2-standard-4", "e2-standard-8"];

export async function startFakeGce(params: {
  sshdRoot: string;
  publicKeyPem: string;
}): Promise<FakeGce> {
  const hostKey = (await fs.readFile(path.join(params.sshdRoot, "hostkey.pub"), "utf8")).trim();
  const [hostKeyType, hostKeyBlob] = hostKey.split(" ");
  const authorizedKeys = path.join(params.sshdRoot, "authorized_keys");
  const verifier = crypto.createPublicKey(params.publicKeyPem);
  const requests: FakeGceRequest[] = [];
  const instances = new Map<string, Instance>();
  const operations = new Map<string, Operation>();
  const byRequestId = new Map<string, Operation>();
  const tokens = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  let counter = 0;

  const fake: FakeGce = {
    url: "",
    requests,
    instances,
    transitionMs: 1_500,
    hostKeyDelayMs: 2_000,
    async stop() {
      for (const timer of timers) clearTimeout(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const after = (ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };
  const origin = () => fake.url.replace(/\/compute\/v1$/, "");
  const selfLink = (rest: string) => `${fake.url}/projects/${FAKE_GCE_PROJECT}${rest}`;
  const now = () => new Date().toISOString();

  const view = (instance: Instance) => {
    const limit = instance.scheduling.maxRunDuration as { seconds?: string } | undefined;
    const running = instance.status === "RUNNING";
    return {
      kind: "compute#instance",
      id: instance.id,
      name: instance.name,
      zone: selfLink(`/zones/${instance.zone}`),
      status: instance.status,
      machineType: selfLink(`/zones/${instance.zone}/machineTypes/${instance.machineType}`),
      labels: instance.labels,
      scheduling: instance.scheduling,
      creationTimestamp: instance.createdAt,
      ...(instance.lastStartAt ? { lastStartTimestamp: instance.lastStartAt } : {}),
      ...(instance.lastStopAt ? { lastStopTimestamp: instance.lastStopAt } : {}),
      resourceStatus:
        running && limit?.seconds && instance.lastStartAt
          ? {
              scheduling: {
                terminationTimestamp: new Date(
                  Date.parse(instance.lastStartAt) + Number(limit.seconds) * 1000
                ).toISOString(),
              },
            }
          : {},
      networkInterfaces: [
        {
          networkIP: "10.128.0.2",
          accessConfigs: !instance.external
            ? []
            : [
                running
                  ? { type: "ONE_TO_ONE_NAT", name: "External NAT", natIP: "127.0.0.1" }
                  : { type: "ONE_TO_ONE_NAT", name: "External NAT" },
              ],
        },
      ],
    };
  };
  const opView = (op: Operation) => ({
    kind: "compute#operation",
    name: op.name,
    status: op.status,
    zone: selfLink(`/zones/${op.zone}`),
    targetId: op.targetId,
    targetLink: selfLink(`/zones/${op.zone}/instances/${op.targetId}`),
  });
  const operation = (zone: string, targetId: string, finish: () => void): Operation => {
    const op: Operation = { name: `operation-${++counter}`, zone, targetId, status: "RUNNING" };
    operations.set(op.name, op);
    after(fake.transitionMs, () => {
      finish();
      op.status = "DONE";
    });
    return op;
  };
  const started = (instance: Instance) => {
    instance.status = "RUNNING";
    instance.lastStartAt = now();
    if (!instance.hostKeysPublished) {
      after(fake.hostKeyDelayMs, () => {
        instance.hostKeysPublished = true;
      });
    }
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      void handle(req, raw).then(
        ({ status, body }) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (error: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { code: 500, message: String(error) } }));
        }
      );
    });
  });

  const reply = (status: number, body: unknown) => ({ status, body });
  const refuse = (status: number, message: string, reason: string) =>
    reply(status, { error: { code: status, message, errors: [{ reason, message }] } });

  async function handle(
    req: http.IncomingMessage,
    raw: string
  ): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? "/", origin());
    const method = req.method ?? "GET";
    let body: unknown = raw;
    if (raw && req.headers["content-type"]?.includes("json")) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      // The assertion is a credential: only its presence is recorded.
      body: url.pathname === "/token" ? { assertion: "[signed]" } : body,
      at: Date.now(),
    });

    if (url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
      const signed =
        form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
        crypto.verify(
          "sha256",
          Buffer.from(`${header}.${claims}`),
          verifier,
          Buffer.from(signature ?? "", "base64url")
        );
      const decoded = signed
        ? (JSON.parse(Buffer.from(claims!, "base64url").toString()) as Record<string, unknown>)
        : null;
      if (
        !decoded ||
        decoded.aud !== `${origin()}/token` ||
        decoded.iss !== FAKE_GCE_CLIENT_EMAIL ||
        decoded.scope !== "https://www.googleapis.com/auth/compute"
      ) {
        return reply(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." });
      }
      const token = `ya29.e2e-${crypto.randomBytes(12).toString("hex")}`;
      tokens.add(token);
      return reply(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }

    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!tokens.has(bearer))
      return refuse(401, "Request had invalid authentication credentials.", "authError");
    const match = /^\/compute\/v1\/projects\/([^/]+)(.*)$/.exec(url.pathname);
    if (!match) return refuse(404, "Not found", "notFound");
    const [, project, rest] = match;
    if (project !== FAKE_GCE_PROJECT && project !== FAKE_GCE_KEY_PROJECT) {
      return refuse(403, `Permission denied on resource project ${project}.`, "forbidden");
    }
    if (rest === "") return reply(200, { kind: "compute#project", name: project, id: "424242" });
    if (rest === "/zones") {
      return reply(200, {
        items: ZONES.map((zone) => ({
          name: zone.name,
          status: "UP",
          region: selfLink(`/regions/${zone.region}`),
        })),
      });
    }
    if (rest === "/aggregated/machineTypes") {
      return reply(200, {
        items: Object.fromEntries(
          ZONES.map((zone) => [
            `zones/${zone.name}`,
            { machineTypes: MACHINE_TYPES.map((name) => ({ name, zone: zone.name })) },
          ])
        ),
      });
    }
    if (rest === "/aggregated/subnetworks") {
      return reply(200, {
        items: Object.fromEntries(
          [...new Set(ZONES.map((zone) => zone.region))].map((region) => [
            `regions/${region}`,
            {
              subnetworks: [
                {
                  name: "default",
                  network: selfLink("/global/networks/default"),
                  region: selfLink(`/regions/${region}`),
                  ipCidrRange: "10.128.0.0/20",
                },
              ],
            },
          ])
        ),
      });
    }
    if (rest === "/aggregated/instances") {
      const filter = url.searchParams.get("filter");
      const wanted = filter ? /^labels\.([a-z0-9_-]+) = "([a-z0-9_-]*)"$/.exec(filter) : null;
      const found = [...instances.values()].filter(
        (instance) => !wanted || instance.labels[wanted[1]!] === wanted[2]
      );
      return reply(200, {
        items: Object.fromEntries(
          ZONES.map((zone) => {
            const here = found.filter((instance) => instance.zone === zone.name);
            return [
              `zones/${zone.name}`,
              here.length > 0
                ? { instances: here.map(view) }
                : { warning: { code: "NO_RESULTS_ON_PAGE", message: "No results" } },
            ];
          })
        ),
      });
    }

    const zoned = /^\/zones\/([a-z0-9-]+)(.*)$/.exec(rest!);
    if (!zoned) return refuse(404, "Not found", "notFound");
    // The key's home project may be read, but the VMs live in the account's chosen project only.
    if (project !== FAKE_GCE_PROJECT) {
      return refuse(404, `The resource 'projects/${project}${rest}' was not found`, "notFound");
    }
    const [, zone, zoneRest] = zoned;
    const waited = /^\/operations\/([^/]+)\/wait$/.exec(zoneRest!);
    if (waited) {
      const op = operations.get(waited[1]!);
      if (!op) return refuse(404, "The resource was not found", "notFound");
      const deadline = Date.now() + 30_000;
      while (op.status !== "DONE" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return reply(200, opView(op));
    }
    if (zoneRest === "/instances" && method === "POST") {
      const requestId = url.searchParams.get("requestId") ?? "";
      const replay = byRequestId.get(requestId);
      if (replay) return reply(200, opView(replay));
      const sent = body as {
        name: string;
        labels?: Record<string, string>;
        scheduling?: Record<string, unknown>;
        machineType: string;
        metadata?: { items?: { key: string; value: string }[] };
        networkInterfaces?: { accessConfigs?: unknown[] }[];
      };
      const sshKeys = sent.metadata?.items?.find((item) => item.key === "ssh-keys")?.value ?? "";
      const key = sshKeys.slice(sshKeys.indexOf(":") + 1);
      if (key) await fs.appendFile(authorizedKeys, `${key}\n`);
      const id = (BigInt("9007199254740993000") + BigInt(++counter)).toString();
      const instance: Instance = {
        id,
        name: sent.name,
        zone: zone!,
        status: "PROVISIONING",
        labels: sent.labels ?? {},
        scheduling: sent.scheduling ?? {},
        machineType: sent.machineType.split("/").pop() ?? "e2-standard-2",
        external: (sent.networkInterfaces?.[0]?.accessConfigs?.length ?? 0) > 0,
        hostKeysPublished: false,
        createdAt: now(),
        lastStartAt: null,
        lastStopAt: null,
      };
      instances.set(id, instance);
      const op = operation(zone!, id, () => started(instance));
      byRequestId.set(requestId, op);
      return reply(200, opView(op));
    }
    const target = /^\/instances\/(\d+)(?:\/([A-Za-z]+))?$/.exec(zoneRest!);
    if (!target) return refuse(404, "Not found", "notFound");
    const instance = instances.get(target[1]!);
    if (!instance || instance.zone !== zone) {
      return refuse(404, `The resource 'instances/${target[1]}' was not found`, "notFound");
    }
    const action = target[2];
    if (!action && method === "GET") return reply(200, view(instance));
    if (!action && method === "DELETE") {
      instance.status = "STOPPING";
      return reply(200, opView(operation(zone!, instance.id, () => instances.delete(instance.id))));
    }
    if (action === "getGuestAttributes") {
      if (
        !instance.hostKeysPublished ||
        instance.status !== "RUNNING" ||
        url.searchParams.get("queryPath") !== "hostkeys/"
      ) {
        return refuse(404, "The resource was not found", "notFound");
      }
      return reply(200, {
        kind: "compute#guestAttributes",
        queryPath: "hostkeys/",
        queryValue: {
          items: [{ namespace: "hostkeys", key: hostKeyType, value: hostKeyBlob }],
        },
      });
    }
    if (action === "stop") {
      instance.status = "STOPPING";
      return reply(
        200,
        opView(
          operation(zone!, instance.id, () => {
            instance.status = "TERMINATED";
            instance.lastStopAt = now();
          })
        )
      );
    }
    if (action === "start") {
      if (instance.status !== "TERMINATED") {
        return refuse(400, "The instance isn't stopped", "resourceNotReady");
      }
      instance.status = "STAGING";
      return reply(200, opView(operation(zone!, instance.id, () => started(instance))));
    }
    if (action === "setScheduling") {
      if (instance.status !== "TERMINATED") {
        return refuse(400, "Instance must be stopped to change its run duration", "invalid");
      }
      const next = body as Record<string, unknown>;
      instance.scheduling = Object.fromEntries(
        Object.entries({ ...instance.scheduling, ...next }).filter(([, value]) => value !== null)
      );
      const op: Operation = {
        name: `operation-${++counter}`,
        zone: zone!,
        targetId: instance.id,
        status: "DONE",
      };
      operations.set(op.name, op);
      return reply(200, opView(op));
    }
    return refuse(400, `Unsupported: ${method} ${url.pathname}`, "invalid");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  fake.url = `http://127.0.0.1:${port}/compute/v1`;
  return fake;
}
