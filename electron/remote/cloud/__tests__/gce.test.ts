import crypto from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { normalizeCloudCredentials } from "../cloudCredentials.js";
import type { ProviderCredentials } from "../provider.js";
import {
  GCE_COMPUTE_SCOPE,
  GCE_PRODUCTION_TOKEN_URL,
  GceTokenSource,
  gceTokenUrlFor,
  parseGceServiceAccountKey,
} from "../gce/gceAuth.js";
import {
  GCE_PRODUCTION_API_URL,
  GceClient,
  mayHaveReachedCompute,
  resolveGceApiUrl,
} from "../gce/GceClient.js";
import { GceApiError, redactGceText } from "../gce/gceErrors.js";
import { GCE_SSH_USER, GceProvider, gceInstanceName } from "../gce/GceProvider.js";
import { gceMachineState } from "../gce/gceState.js";
import type { MetadataFetch } from "../../host/guestPowerOffSystem.js";
import { cloudMachineHost, IDLE_MINUTES, MINUTE } from "./guestPowerOffHarness.js";

const API = "http://gce.test/compute/v1";
const TOKEN_URL = "http://gce.test/token";
const PROJECT = "daintree-build";
const OTHER_PROJECT = "other-project";
const KEY_PROJECT = "key-home-project";
/** Larger than Number.MAX_SAFE_INTEGER: an id must stay a string end to end. */
const BIG_ID = "9007199254740993123";
const HOST_KEY_BLOB = Buffer.alloc(51, 7).toString("base64");
const PUBLIC_KEY = `ssh-ed25519 ${Buffer.alloc(51, 3).toString("base64")} daintree-account`;

let privatePem = "";
let publicKey: crypto.KeyObject;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKey = pair.publicKey;
});

function keyFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    project_id: KEY_PROJECT,
    private_key_id: "abc123",
    private_key: privatePem,
    client_email: "daintree@key-home-project.iam.gserviceaccount.com",
    token_uri: "https://evil.example/token",
    ...overrides,
  });
}

interface FakeInstance {
  id: string;
  name: string;
  zone: string;
  status: string;
  labels: Record<string, string>;
  scheduling: Record<string, unknown>;
  machineType: string;
  natIP: string | null;
  hostKeysPublished: boolean;
  body: InsertBody;
}

/** The parts of an insert body the fake and the tests read. */
interface InsertBody {
  name: string;
  machineType: string;
  labels?: Record<string, string>;
  scheduling?: Record<string, unknown>;
  metadata: { items: { key: string; value: string }[] };
  disks: { type?: string; boot?: boolean; initializeParams?: { sourceImage: string } }[];
  networkInterfaces: { subnetwork: string; accessConfigs?: unknown[] }[];
}

interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  /** Whether anything at all was sent as the body. */
  sentBody: boolean;
}

/** A stand-in for Google's token endpoint and the Compute Engine calls the provider makes. */
function fakeGoogle(
  options: { clientSleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}
) {
  const requests: FakeRequest[] = [];
  const tokens = new Set<string>();
  const instances = new Map<string, FakeInstance>();
  const operations = new Map<string, Record<string, unknown>>();
  const byRequestId = new Map<string, Record<string, unknown>>();
  const projects = new Set([PROJECT, KEY_PROJECT]);
  const state = {
    tokenError: null as null | { status: number; error: string },
    /** What the next insert's operation ends in, once waited for. */
    insertFailure: null as null | { code: string; message: string; status: number },
    /** Insert operations stay running until waited for this many times. */
    waitsBeforeDone: 1,
    publishHostKeysAfter: 0,
    guestReads: 0,
    failWaitWith: null as Error | null,
    nextId: 0n,
    /** Inserts answer with an operation that's already done. */
    insertDone: false,
    /** What the next delete's operation ends in, once waited for. */
    deleteFailure: null as null | { code: string; message: string; status: number },
    /** What the next stop's operation ends in, once waited for. */
    stopFailure: null as null | { code: string; message: string; status: number },
    /** Answers taken in order by the next requests whose path matches, before the fake's own. */
    script: [] as { path: RegExp; status: number; reason?: string; error?: Error }[],
  };
  const onDone = new Map<string, () => void>();
  let opCounter = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const apiError = (status: number, message: string, reason?: string) =>
    json(status, {
      error: { code: status, message, errors: reason ? [{ reason, message }] : [] },
    });
  const view = (instance: FakeInstance) => ({
    id: instance.id,
    name: instance.name,
    zone: `${API}/projects/${PROJECT}/zones/${instance.zone}`,
    status: instance.status,
    machineType: `${API}/projects/${PROJECT}/zones/${instance.zone}/machineTypes/${instance.machineType}`,
    labels: instance.labels,
    scheduling: instance.scheduling,
    creationTimestamp: "2026-11-18T01:00:00.000-07:00",
    lastStartTimestamp: "2026-11-18T01:00:10.000-07:00",
    ...(instance.status === "TERMINATED"
      ? { lastStopTimestamp: "2026-11-18T02:00:00.000-07:00" }
      : {}),
    resourceStatus:
      instance.status === "RUNNING" && instance.scheduling.maxRunDuration
        ? { scheduling: { terminationTimestamp: "2026-11-18T03:00:10.000-07:00" } }
        : {},
    networkInterfaces: [
      {
        networkIP: "10.128.0.2",
        accessConfigs: instance.natIP ? [{ natIP: instance.natIP, type: "ONE_TO_ONE_NAT" }] : [],
      },
    ],
    disks: instance.body.disks.map((disk) => ({ type: disk.type, boot: disk.boot })),
  });
  const operation = (
    zone: string,
    target: string,
    extra: Record<string, unknown> = {},
    done?: () => void
  ) => {
    const op = {
      name: `operation-${++opCounter}`,
      status: "RUNNING",
      zone: `${API}/projects/${PROJECT}/zones/${zone}`,
      targetId: target,
      waits: 0,
      ...extra,
    };
    operations.set(op.name, op);
    if (done) onDone.set(op.name, done);
    return op;
  };
  const opView = (op: Record<string, unknown>) => {
    const { waits: _waits, failure, ...rest } = op;
    return failure ? { ...rest, ...(failure as object) } : rest;
  };

  const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? init.body : undefined;
    let parsedBody: unknown;
    try {
      parsedBody = body && !body.startsWith("grant_type") ? JSON.parse(body) : body;
    } catch {
      parsedBody = body;
    }
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: parsedBody,
      sentBody: init?.body !== undefined && init?.body !== null,
    });
    const scripted = state.script.findIndex((entry) => entry.path.test(url.pathname));
    if (scripted >= 0) {
      const [entry] = state.script.splice(scripted, 1);
      if (entry!.error) throw entry!.error;
      return apiError(entry!.status, `scripted ${entry!.status}`, entry!.reason);
    }
    if (url.href === TOKEN_URL) {
      if (state.tokenError) {
        return json(state.tokenError.status, {
          error: state.tokenError.error,
          error_description: `Invalid JWT Signature. assertion=${new URLSearchParams(body).get("assertion")}`,
        });
      }
      const form = new URLSearchParams(body);
      const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
      const ok = crypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url")
      );
      const decoded = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
      if (!ok || decoded.aud !== TOKEN_URL || decoded.scope !== GCE_COMPUTE_SCOPE) {
        return json(400, { error: "invalid_grant", error_description: "bad assertion" });
      }
      const token = `ya29.fake-${tokens.size + 1}`;
      tokens.add(token);
      return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
    }
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    if (!tokens.has(auth.replace(/^Bearer /, ""))) return apiError(401, "Invalid Credentials");
    const path = url.pathname.replace(/^\/compute\/v1/, "");
    const project = /^\/projects\/([^/]+)/.exec(path)?.[1];
    if (!project || !projects.has(project)) {
      return apiError(403, `Permission denied on project ${project}`, "forbidden");
    }
    const rest = path.slice(`/projects/${project}`.length);
    if (rest === "") return json(200, { name: project, id: "1234" });
    if (rest === "/zones") {
      return json(200, {
        items: [
          { name: "us-central1-a", status: "UP", region: `${API}/projects/p/regions/us-central1` },
          { name: "us-central1-b", status: "UP", region: `${API}/projects/p/regions/us-central1` },
          {
            name: "europe-west1-b",
            status: "UP",
            region: `${API}/projects/p/regions/europe-west1`,
          },
          { name: "asia-east1-a", status: "DOWN", region: `${API}/projects/p/regions/asia-east1` },
          { name: "us-east1-b", status: "UP", region: `${API}/projects/p/regions/us-east1` },
        ],
      });
    }
    if (rest === "/aggregated/machineTypes") {
      const all = ["e2-standard-2", "e2-standard-4", "e2-standard-8"].map((name) => ({ name }));
      return json(200, {
        items: {
          "zones/us-central1-a": { machineTypes: all },
          "zones/us-central1-b": { machineTypes: all },
          "zones/europe-west1-b": { machineTypes: all },
          // Missing a size: never offered as a zone.
          "zones/us-east1-b": { machineTypes: all.slice(0, 2) },
          "zones/asia-east1-a": { machineTypes: all },
        },
      });
    }
    if (rest === "/aggregated/subnetworks") {
      return json(200, {
        items: {
          "regions/us-central1": {
            subnetworks: [
              {
                name: "build",
                network: `${API}/projects/p/global/networks/corp`,
                region: `${API}/projects/p/regions/us-central1`,
                ipCidrRange: "10.8.0.0/20",
              },
              {
                name: "default",
                network: `${API}/projects/p/global/networks/default`,
                region: `${API}/projects/p/regions/us-central1`,
                ipCidrRange: "10.128.0.0/20",
              },
              {
                name: "proxy-only",
                network: `${API}/projects/p/global/networks/default`,
                region: `${API}/projects/p/regions/us-central1`,
                purpose: "REGIONAL_MANAGED_PROXY",
              },
            ],
          },
          "regions/europe-west1": {
            subnetworks: [
              {
                name: "default",
                network: `${API}/projects/p/global/networks/default`,
                region: `${API}/projects/p/regions/europe-west1`,
                ipCidrRange: "10.132.0.0/20",
              },
              {
                name: "legacy",
                network: `${API}/projects/p/global/networks/corp`,
                region: `${API}/projects/p/regions/europe-west1`,
                ipCidrRange: "10.9.0.0/20",
                purpose: "PRIVATE_RFC_1918",
              },
            ],
          },
          "regions/asia-east1": { warning: { code: "NO_RESULTS_ON_PAGE" } },
        },
      });
    }
    if (rest === "/aggregated/instances") {
      const filter = url.searchParams.get("filter");
      const wanted = filter ? /^labels\.([a-z0-9_-]+) = "([a-z0-9_-]*)"$/.exec(filter) : null;
      const matching = [...instances.values()].filter(
        (instance) => !wanted || instance.labels[wanted[1]!] === wanted[2]
      );
      return json(200, {
        items: {
          "zones/us-central1-a": { instances: matching.map(view) },
          "zones/us-east1-b": { warning: { code: "NO_RESULTS_ON_PAGE" } },
        },
      });
    }
    const zoneMatch = /^\/zones\/([a-z0-9-]+)(\/.*)$/.exec(rest);
    if (!zoneMatch) return apiError(404, "not found", "notFound");
    const [, zone, zoneRest] = zoneMatch;
    const opMatch = /^\/operations\/([^/]+)\/wait$/.exec(zoneRest!);
    if (opMatch) {
      if (state.failWaitWith) throw state.failWaitWith;
      const op = operations.get(opMatch[1]!);
      if (!op) return apiError(404, "operation not found", "notFound");
      op.waits = Number(op.waits) + 1;
      if (op.status !== "DONE" && Number(op.waits) >= state.waitsBeforeDone) {
        op.status = "DONE";
        onDone.get(String(op.name))?.();
      }
      return json(200, opView(op));
    }
    if (zoneRest === "/instances" && init?.method === "POST") {
      const requestId = url.searchParams.get("requestId") ?? "";
      const replay = byRequestId.get(requestId);
      if (replay) return json(200, opView(replay));
      const sent = parsedBody as InsertBody;
      const failure = state.insertFailure;
      const id = (BigInt(BIG_ID) + state.nextId++).toString();
      if (!failure) {
        instances.set(id, {
          id,
          name: sent.name,
          zone: zone!,
          status: "RUNNING",
          labels: sent.labels ?? {},
          scheduling: sent.scheduling ?? {},
          machineType: sent.machineType.split("/").pop()!,
          // An external address only when the create asked for one.
          natIP: sent.networkInterfaces?.[0]?.accessConfigs?.length ? "203.0.113.20" : null,
          hostKeysPublished: false,
          body: sent,
        });
      }
      const op = operation(
        zone!,
        id,
        failure
          ? {
              failure: {
                error: { errors: [{ code: failure.code, message: failure.message }] },
                httpErrorStatusCode: failure.status,
              },
            }
          : {}
      );
      byRequestId.set(requestId, op);
      if (state.insertDone) op.status = "DONE";
      return json(200, opView(op));
    }
    const instanceMatch = /^\/instances\/(\d+)(\/[A-Za-z]+)?$/.exec(zoneRest!);
    if (!instanceMatch) return apiError(404, "not found", "notFound");
    const instance = instances.get(instanceMatch[1]!);
    if (!instance) return apiError(404, "The resource was not found", "notFound");
    const action = instanceMatch[2];
    if (!action && init?.method === "DELETE") {
      instance.status = "STOPPING";
      return json(
        200,
        opView(
          operation(
            zone!,
            instance.id,
            state.deleteFailure
              ? {
                  failure: {
                    error: {
                      errors: [
                        { code: state.deleteFailure.code, message: state.deleteFailure.message },
                      ],
                    },
                    httpErrorStatusCode: state.deleteFailure.status,
                  },
                }
              : {},
            () => {
              if (!state.deleteFailure) instances.delete(instance.id);
            }
          )
        )
      );
    }
    if (!action) return json(200, view(instance));
    if (action === "/getGuestAttributes") {
      state.guestReads += 1;
      if (!instance.hostKeysPublished && state.guestReads > state.publishHostKeysAfter) {
        instance.hostKeysPublished = true;
      }
      if (!instance.hostKeysPublished) return apiError(404, "The resource was not found");
      // Only the namespace asked for; an unrelated one listed first must never be what's pinned.
      if (url.searchParams.get("queryPath") !== "hostkeys/") {
        return apiError(404, "The resource was not found");
      }
      return json(200, {
        queryPath: "hostkeys/",
        queryValue: {
          items: [
            {
              namespace: "other",
              key: "ssh-ed25519",
              value: Buffer.alloc(51, 1).toString("base64"),
            },
            {
              namespace: "hostkeys",
              key: "ssh-rsa",
              value: Buffer.alloc(260, 9).toString("base64"),
            },
            { namespace: "hostkeys", key: "ssh-ed25519", value: HOST_KEY_BLOB },
          ],
        },
      });
    }
    if (action === "/stop") {
      instance.status = "STOPPING";
      return json(
        200,
        opView(
          operation(
            zone!,
            instance.id,
            state.stopFailure
              ? {
                  failure: {
                    error: {
                      errors: [
                        { code: state.stopFailure.code, message: state.stopFailure.message },
                      ],
                    },
                    httpErrorStatusCode: state.stopFailure.status,
                  },
                }
              : {},
            () => {
              if (!state.stopFailure) instance.status = "TERMINATED";
            }
          )
        )
      );
    }
    if (action === "/start" || action === "/resume") {
      instance.status = "RUNNING";
      return json(200, opView(operation(zone!, instance.id)));
    }
    if (action === "/setScheduling") {
      if (instance.status !== "TERMINATED") {
        return apiError(400, "Instance must be stopped", "invalid");
      }
      const next = parsedBody as Record<string, unknown>;
      instance.scheduling = Object.fromEntries(
        Object.entries({ ...instance.scheduling, ...next }).filter(([, value]) => value !== null)
      );
      return json(200, opView(operation(zone!, instance.id)));
    }
    return apiError(400, "unsupported", "invalid");
  });

  const tokensSource = new GceTokenSource(TOKEN_URL, {
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  const client = new GceClient({
    baseUrl: API,
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: options.clientSleep ?? (async () => {}),
  });
  let clock = Date.parse("2026-11-18T08:00:00Z");
  const provider = new GceProvider(() => ({ client, tokens: tokensSource }), {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  const credentials = (overrides: Partial<ProviderCredentials> = {}): ProviderCredentials => ({
    values: { serviceAccountKey: keyFile() },
    scopeId: PROJECT,
    apiUrl: API,
    ...overrides,
  });
  /** The VM's own OS powering off: Compute Engine stops it, with no API call involved. */
  const guestPowerOff = (id: string) => {
    instances.get(id)!.status = "TERMINATED";
  };
  /** The VM's metadata server, answering only from the VM itself. */
  const metadataFor =
    (id: string): MetadataFetch =>
    async (request) => {
      const instance = instances.get(id)!;
      if (request.headers["Metadata-Flavor"] !== "Google") {
        return { status: 403, headers: {}, body: "" };
      }
      const flavor = { "metadata-flavor": "Google" };
      switch (request.path) {
        case "/computeMetadata/v1/project/project-id":
          return { status: 200, headers: flavor, body: PROJECT };
        case "/computeMetadata/v1/instance/zone":
          return { status: 200, headers: flavor, body: `projects/123456789/zones/${instance.zone}` };
        case "/computeMetadata/v1/instance/id":
          return { status: 200, headers: flavor, body: instance.id };
        default:
          return { status: 404, headers: flavor, body: "" };
      }
    };
  return {
    fetch,
    requests,
    instances,
    state,
    provider,
    credentials,
    tokens,
    guestPowerOff,
    metadataFor,
  };
}

/** Reads of the VM itself made after the first DELETE was sent. */
function lookupsAfterDelete(requests: FakeRequest[]): number {
  const sent = requests.findIndex((request) => request.method === "DELETE");
  return requests
    .slice(sent + 1)
    .filter((request) => request.method === "GET" && /\/instances\/\d+$/.test(request.path)).length;
}

const CREATE = {
  name: "Build host",
  machineType: "e2-standard-4",
  lifetimeSeconds: 7200,
  provisioning: {
    location: "us-central1-a",
    image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
    network: "regions/us-central1/subnetworks/default",
  },
  labels: { daintree: "1", "daintree-binding": "cb_0123456789ab" },
  idempotencyKey: "3f2b8c1a-1111-4222-8333-444455556666",
  publicKey: PUBLIC_KEY,
};

describe("Compute Engine endpoints", () => {
  it("uses production in a packaged build whatever the environment says", () => {
    expect(resolveGceApiUrl(true, { DAINTREE_GCE_API_URL: "http://127.0.0.1:9" })).toBe(
      GCE_PRODUCTION_API_URL
    );
    expect(
      resolveGceApiUrl(false, { DAINTREE_GCE_API_URL: "http://127.0.0.1:9/compute/v1/" })
    ).toBe("http://127.0.0.1:9/compute/v1");
    expect(resolveGceApiUrl(false, { DAINTREE_GCE_API_URL: "file:///etc/passwd" })).toBe(
      GCE_PRODUCTION_API_URL
    );
  });

  it("signs assertions for Google's token endpoint, or for the override's own origin", () => {
    expect(gceTokenUrlFor(GCE_PRODUCTION_API_URL)).toBe(GCE_PRODUCTION_TOKEN_URL);
    expect(gceTokenUrlFor("http://127.0.0.1:9/compute/v1")).toBe("http://127.0.0.1:9/token");
  });
});

describe("service-account keys", () => {
  it("reads a key file and the project it names", () => {
    const key = parseGceServiceAccountKey(keyFile());
    expect(key.clientEmail).toBe("daintree@key-home-project.iam.gserviceaccount.com");
    expect(key.projectId).toBe(KEY_PROJECT);
    expect(parseGceServiceAccountKey(keyFile({ project_id: undefined })).projectId).toBeNull();
  });

  it.each([
    ["not JSON", "AIzaSyNotAKeyFile", /should be JSON/],
    [
      "another kind of credential",
      keyFile({ type: "authorized_user" }),
      /isn't a service-account key/,
    ],
    [
      "an unreadable private key",
      keyFile({ private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" }),
      /can't be read/,
    ],
    ["no service account", keyFile({ client_email: "" }), /missing its service account/],
  ])("refuses %s", (_what, text, message) => {
    expect(() => parseGceServiceAccountKey(text)).toThrow(message);
  });

  it("exchanges a signed assertion at the configured endpoint only, and keeps the token", async () => {
    const google = fakeGoogle();
    const key = parseGceServiceAccountKey(keyFile());
    const source = new GceTokenSource(TOKEN_URL, {
      fetch: google.fetch as unknown as typeof globalThis.fetch,
    });
    const first = await source.token(key);
    expect(await source.token(key)).toBe(first);
    expect(google.fetch).toHaveBeenCalledTimes(1);
    expect(String(google.fetch.mock.calls[0]![0])).toBe(TOKEN_URL);
    expect(await source.token(key, undefined, true)).not.toBe(first);
    // The key file's own token_uri is never where an assertion goes.
    expect(google.fetch.mock.calls.every(([url]) => !String(url).includes("evil"))).toBe(true);
  });

  it("shares one exchange between concurrent callers", async () => {
    const google = fakeGoogle();
    const key = parseGceServiceAccountKey(keyFile());
    const source = new GceTokenSource(TOKEN_URL, {
      fetch: google.fetch as unknown as typeof globalThis.fetch,
    });
    const [a, b] = await Promise.all([source.token(key), source.token(key)]);
    expect(a).toBe(b);
    expect(google.fetch).toHaveBeenCalledTimes(1);
  });

  it("cancels an exchange under way when it's disposed", async () => {
    let seen: AbortSignal | undefined;
    const source = new GceTokenSource(TOKEN_URL, {
      fetch: ((_url: URL | string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof globalThis.fetch,
    });
    const pending = source.token(parseGceServiceAccountKey(keyFile())).catch((e: unknown) => e);
    await vi.waitFor(() => expect(seen).toBeDefined());
    source.dispose();
    expect(seen!.aborted).toBe(true);
    expect(await pending).toMatchObject({ kind: "cancelled" });
  });

  it("keeps a refused exchange's assertion out of the error", async () => {
    const google = fakeGoogle();
    google.state.tokenError = { status: 400, error: "invalid_grant" };
    const key = parseGceServiceAccountKey(keyFile());
    const source = new GceTokenSource(TOKEN_URL, {
      fetch: google.fetch as unknown as typeof globalThis.fetch,
    });
    const error = await source.token(key).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GceApiError);
    expect((error as GceApiError).kind).toBe("unauthorized");
    expect((error as GceApiError).message).not.toMatch(/eyJ/);
  });

  it("redacts tokens, assertions and private keys from Google's text", () => {
    const text = redactGceText(
      `Bearer ya29.abcdef token ya29.ghijk eyJhbGciOi.eyJpc3MiOi.c2lnbmF0dXJl ${privatePem}`
    );
    expect(text).not.toMatch(/ya29|eyJ|PRIVATE KEY|MII/);
  });
});

describe("GceProvider", () => {
  it("passes the registry's checks of what it declares", () => {
    const google = fakeGoogle();
    const registry = new CloudProviderRegistry();
    expect(() =>
      registry.register(google.provider, { owner: { kind: "built-in" }, apiUrl: API })
    ).not.toThrow();
    expect(google.provider.info("darwin").unsupportedReason).toBeNull();
    expect(google.provider.info("win32").unsupportedReason).not.toBeNull();
  });

  it("connects with the key's own project, or the one entered", async () => {
    const google = fakeGoogle();
    const fields = google.provider.info("darwin").credentialFields;
    const own = await google.provider.checkCredentials(
      normalizeCloudCredentials(fields, { serviceAccountKey: keyFile() }),
      API
    );
    expect(own).toEqual({
      identity: "daintree@key-home-project.iam.gserviceaccount.com",
      scopes: [{ scope: { kind: "project", id: KEY_PROJECT, name: KEY_PROJECT }, active: true }],
    });
    const entered = await google.provider.checkCredentials(
      normalizeCloudCredentials(fields, {
        serviceAccountKey: keyFile(),
        projectId: ` ${PROJECT} `,
      }),
      API
    );
    expect(entered.scopes[0]!.scope.id).toBe(PROJECT);
    expect(
      google.requests.some((request) => request.path === `/compute/v1/projects/${PROJECT}`)
    ).toBe(true);
  });

  it("refuses a project the key can't use, before anything is kept", async () => {
    const google = fakeGoogle();
    const error = await google.provider
      .checkCredentials({ serviceAccountKey: keyFile(), projectId: OTHER_PROJECT }, API)
      .catch((err: unknown) => err);
    expect(google.provider.describeError(error).code).toBe("permission");
    await expect(
      google.provider.checkCredentials(
        { serviceAccountKey: keyFile({ project_id: undefined }) },
        API
      )
    ).rejects.toThrow(/doesn't name a project/);
  });

  it("calls a deleted or disabled key invalid", async () => {
    const google = fakeGoogle();
    google.state.tokenError = { status: 400, error: "invalid_grant" };
    const error = await google.provider.validate(google.credentials()).catch((err: unknown) => err);
    expect(google.provider.describeError(error).code).toBe("credential-invalid");
  });

  it("validates with a fresh token, never one kept from before", async () => {
    const google = fakeGoogle();
    await google.provider.validate(google.credentials());
    await google.provider.validate(google.credentials());
    const exchanges = google.requests.filter((request) => request.path === "/token");
    expect(exchanges).toHaveLength(2);
  });

  it("offers zones with every size, their region's subnets, and images", async () => {
    const google = fakeGoogle();
    const catalog = await google.provider.catalog(google.credentials());
    const zones = catalog.provisioning!.location!;
    expect(zones.choices.map((zone) => zone.id)).toEqual([
      "europe-west1-b",
      "us-central1-a",
      "us-central1-b",
    ]);
    expect(zones.defaultId).toBe("us-central1-a");
    const subnets = catalog.provisioning!.network!.choices;
    // Default network first, then by name; a proxy-only subnet is never offered, a legacy-purpose one is.
    expect(subnets.map((subnet) => [subnet.id, subnet.locations])).toEqual([
      ["regions/europe-west1/subnetworks/default", ["europe-west1-b"]],
      ["regions/us-central1/subnetworks/default", ["us-central1-a", "us-central1-b"]],
      ["regions/us-central1/subnetworks/build", ["us-central1-a", "us-central1-b"]],
      ["regions/europe-west1/subnetworks/legacy", ["europe-west1-b"]],
    ]);
    const images = catalog.provisioning!.image!;
    expect(images.choices.find((image) => image.id === images.defaultId)?.available).toBe(true);
    expect(images.choices.every((image) => image.locations === null)).toBe(true);
    // Every size offered is one the zones listed: the filter asks for exactly those.
    const typesRequest = google.requests.find((request) =>
      request.path.endsWith("/aggregated/machineTypes")
    );
    const pattern = /^name eq "\((.+)\)"$/.exec(typesRequest!.query.get("filter") ?? "");
    expect(pattern?.[1]?.split("|")).toEqual(catalog.machineTypes.map((type) => type.id));
  });

  it("creates a VM with Daintree's key, guest attributes and a runtime limit", async () => {
    const google = fakeGoogle();
    const resource = await google.provider.create(google.credentials(), CREATE);
    const insert = google.requests.find(
      (request) => request.method === "POST" && request.path.endsWith("/instances")
    )!;
    expect(insert.path).toBe(`/compute/v1/projects/${PROJECT}/zones/us-central1-a/instances`);
    expect(insert.query.get("requestId")).toBe(CREATE.idempotencyKey);
    const body = insert.body as InsertBody;
    expect(body.name).toBe(gceInstanceName("Build host", CREATE.idempotencyKey));
    expect(body.name).toMatch(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/);
    expect(body.machineType).toBe("zones/us-central1-a/machineTypes/e2-standard-4");
    expect(body.metadata.items).toEqual([
      { key: "ssh-keys", value: `${GCE_SSH_USER}:${PUBLIC_KEY}` },
      { key: "enable-guest-attributes", value: "TRUE" },
      { key: "enable-oslogin", value: "FALSE" },
    ]);
    expect(body.scheduling).toEqual({
      maxRunDuration: { seconds: "7200" },
      instanceTerminationAction: "STOP",
    });
    expect(body.networkInterfaces[0]!.subnetwork).toBe("regions/us-central1/subnetworks/default");
    // Direct SSH needs an external address, asked for with the create.
    expect(body.networkInterfaces[0]!.accessConfigs).toEqual([
      expect.objectContaining({ type: "ONE_TO_ONE_NAT" }),
    ]);
    expect(body.disks[0]!.initializeParams?.sourceImage).toBe(CREATE.provisioning.image);
    expect(body.labels).toEqual(CREATE.labels);
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(resource.resourceId).toBe(`projects/${PROJECT}/zones/us-central1-a/instances/${BIG_ID}`);
    expect(resource.machine).toBe("running");
    expect(resource.machineType).toBe("e2-standard-4");
    expect(resource.vcpu).toBe(4);
    expect(resource.lifetimeSeconds).toBe(7200);
    expect(resource.autoStopAt).toBe("2026-11-18T03:00:10.000-07:00");
  });

  it("creates a VM that never stops by itself with no runtime limit", async () => {
    const google = fakeGoogle();
    const resource = await google.provider.create(google.credentials(), {
      ...CREATE,
      lifetimeSeconds: null,
    });
    const insert = google.requests.find((request) => request.path.endsWith("/instances"))!;
    expect((insert.body as Record<string, unknown>).scheduling).toEqual({});
    expect(resource.lifetimeSeconds).toBeNull();
    expect(resource.autoStopAt).toBeNull();
  });

  it("refuses a subnet outside the zone's region before anything is sent", async () => {
    const google = fakeGoogle();
    await expect(
      google.provider.create(google.credentials(), {
        ...CREATE,
        provisioning: {
          ...CREATE.provisioning,
          network: "regions/europe-west1/subnetworks/default",
        },
      })
    ).rejects.toThrow(/subnet in the machine's region/);
    expect(google.fetch).not.toHaveBeenCalled();
  });

  it.each(["ZONE_RESOURCE_POOL_EXHAUSTED", "POOL_CAPACITY_INSUFFICIENT"])(
    "reports %s as a refusal for capacity, which made nothing",
    async (code) => {
      const google = fakeGoogle();
      google.state.insertFailure = { code, message: "Not enough resources", status: 503 };
      const error = await google.provider
        .create(google.credentials(), CREATE)
        .catch((e: unknown) => e);
      expect(google.provider.describeError(error).code).toBe("capacity");
    }
  );

  it("reports quota as a refusal", async () => {
    const google = fakeGoogle();
    google.state.insertFailure = {
      code: "QUOTA_EXCEEDED",
      message: "Quota 'CPUS' exceeded",
      status: 403,
    };
    const error = await google.provider
      .create(google.credentials(), CREATE)
      .catch((e: unknown) => e);
    expect(google.provider.describeError(error).code).toBe("capacity");
  });

  it("calls an unfamiliar failure of a create Google took an unknown outcome, whatever its status", async () => {
    const google = fakeGoogle();
    google.state.insertFailure = {
      code: "SOMETHING_GOOGLE_ADDED_LATER",
      message: "Something new went wrong",
      status: 403,
    };
    const error = await google.provider
      .create(google.credentials(), CREATE)
      .catch((e: unknown) => e);
    expect(google.provider.describeError(error).code).toBe("outcome-unknown");
  });

  it("calls a refused resend after a lost insert an unknown outcome, never a refusal", async () => {
    const google = fakeGoogle();
    google.state.script.push(
      { path: /\/instances$/, status: 0, error: new TypeError("fetch failed") },
      { path: /\/instances$/, status: 403, reason: "forbidden" }
    );
    const error = await google.provider
      .create(google.credentials(), CREATE)
      .catch((e: unknown) => e);
    expect(google.provider.describeError(error).code).toBe("outcome-unknown");
    const sent = google.requests.filter((request) => request.path.endsWith("/instances"));
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((request) => request.query.get("requestId"))).size).toBe(1);
  });

  it("takes an insert answered as already done without waiting on it", async () => {
    const google = fakeGoogle();
    google.state.insertDone = true;
    const resource = await google.provider.create(google.credentials(), CREATE);
    expect(resource.machine).toBe("running");
    expect(google.requests.some((request) => request.path.endsWith("/wait"))).toBe(false);
  });

  it("never counts a token that couldn't be had as a sent create", async () => {
    const google = fakeGoogle();
    google.state.script.push({ path: /^\/token$/, status: 503 });
    google.state.tokenError = null;
    const tokenOnce = google.fetch.getMockImplementation()!;
    let exchanges = 0;
    google.fetch.mockImplementation(async (input, init) => {
      if (String(input) === TOKEN_URL && exchanges++ > 0) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      return tokenOnce(input, init);
    });
    const error = await google.provider
      .create(google.credentials(), CREATE)
      .catch((e: unknown) => e);
    expect(google.provider.describeError(error).code).toBe("credential-invalid");
    expect(google.requests.some((request) => request.path.endsWith("/instances"))).toBe(false);
  });

  it("calls a create Google took but couldn't be followed up an unknown outcome", async () => {
    const google = fakeGoogle();
    google.state.failWaitWith = new TypeError("fetch failed");
    const error = await google.provider
      .create(google.credentials(), CREATE)
      .catch((e: unknown) => e);
    expect(google.provider.describeError(error).code).toBe("outcome-unknown");
    expect(google.instances.size).toBe(1);
  });

  it("finds a created machine again by its binding label", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const found = await google.provider.list(google.credentials(), {
      label: "daintree-binding=cb_0123456789ab",
    });
    expect(found.map((resource) => resource.resourceId)).toEqual([created.resourceId]);
    const listing = google.requests.find((request) =>
      request.path.endsWith("/aggregated/instances")
    )!;
    expect(listing.query.get("filter")).toBe('labels.daintree-binding = "cb_0123456789ab"');
    expect(
      await google.provider.list(google.credentials(), {
        label: "daintree-binding=cb_ffffffffffff",
      })
    ).toEqual([]);
  });

  it("refuses a machine id from another project without asking", async () => {
    const google = fakeGoogle();
    await expect(
      google.provider.inspect(
        google.credentials(),
        `projects/${OTHER_PROJECT}/zones/us-central1-a/instances/${BIG_ID}`
      )
    ).rejects.toThrow(/another Google Cloud project/);
    expect(google.fetch).not.toHaveBeenCalled();
  });

  it("changes the runtime limit while stopped, before it starts", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.instances.get(BIG_ID)!.status = "TERMINATED";
    const started = await google.provider.start(google.credentials(), created.resourceId, {
      lifetimeSeconds: 4 * 3600,
    });
    const actions = google.requests
      .filter(
        (request) => request.method === "POST" && /\/(setScheduling|start)$/.test(request.path)
      )
      .map((request) => request.path.split("/").pop());
    expect(actions).toEqual(["setScheduling", "start"]);
    const set = google.requests.find((request) => request.path.endsWith("/setScheduling"))!;
    expect(set.body).toMatchObject({
      maxRunDuration: { seconds: "14400" },
      instanceTerminationAction: "STOP",
    });
    expect(started?.lifetimeSeconds).toBe(4 * 3600);
    expect(started?.machine).toBe("running");
  });

  it("clears the limit for a machine that should run until stopped", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.instances.get(BIG_ID)!.status = "TERMINATED";
    const started = await google.provider.start(google.credentials(), created.resourceId, {
      lifetimeSeconds: null,
    });
    const set = google.requests.find((request) => request.path.endsWith("/setScheduling"))!;
    expect(set.body).toMatchObject({ maxRunDuration: null, instanceTerminationAction: null });
    expect(started?.lifetimeSeconds).toBeNull();
  });

  it("disarms a deadline set elsewhere before starting a machine meant to run until stopped", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), {
      ...CREATE,
      lifetimeSeconds: null,
    });
    const vm = google.instances.get(BIG_ID)!;
    vm.status = "TERMINATED";
    vm.scheduling = {
      terminationTime: "2026-11-19T00:00:00Z",
      instanceTerminationAction: "DELETE",
    };
    await google.provider.start(google.credentials(), created.resourceId, {
      lifetimeSeconds: null,
    });
    const set = google.requests.find((request) => request.path.endsWith("/setScheduling"))!;
    expect(set.body).toMatchObject({ terminationTime: null, instanceTerminationAction: null });
    expect(vm.scheduling).toEqual({});
    expect(vm.status).toBe("RUNNING");
  });

  it("replaces a limit set elsewhere with a fraction of a second on it", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const vm = google.instances.get(BIG_ID)!;
    vm.status = "TERMINATED";
    vm.scheduling = {
      maxRunDuration: { seconds: "7200", nanos: 5 },
      instanceTerminationAction: "STOP",
    };
    await google.provider.start(google.credentials(), created.resourceId, {
      lifetimeSeconds: 7200,
    });
    expect(google.requests.some((request) => request.path.endsWith("/setScheduling"))).toBe(true);
  });

  it("starts without touching the limit when it is unchanged or not given", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.instances.get(BIG_ID)!.status = "TERMINATED";
    await google.provider.start(google.credentials(), created.resourceId, {
      lifetimeSeconds: 7200,
    });
    google.instances.get(BIG_ID)!.status = "TERMINATED";
    await google.provider.start(google.credentials(), created.resourceId, {});
    expect(google.requests.some((request) => request.path.endsWith("/setScheduling"))).toBe(false);
    // Start sends no body at all, as Compute Engine asks.
    const starts = google.requests.filter((request) => request.path.endsWith("/start"));
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((request) => !request.sentBody)).toBe(true);
  });

  it("follows a stop to its end", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const stopped = await google.provider.stop(google.credentials(), created.resourceId);
    expect(stopped?.machine).toBe("stopped");
    expect(google.requests.find((request) => request.path.endsWith("/stop"))!.sentBody).toBe(false);
  });

  it("leaves a stop's progress to the VM when its operation can't be read", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.script.push({
      path: /\/operations\/operation-2\/wait$/,
      status: 403,
      reason: "forbidden",
    });
    const stopped = await google.provider.stop(google.credentials(), created.resourceId);
    expect(stopped?.machine).toBe("stopping");
  });

  it("reads a delete answered 404 as done once the VM is confirmed gone", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.instances.delete(BIG_ID);
    await expect(
      google.provider.delete(google.credentials(), created.resourceId)
    ).resolves.toBeUndefined();
    expect(lookupsAfterDelete(google.requests)).toBe(1);
  });

  it("passes on a failed look at the VM after an unsettled delete, rather than guess", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const instancePath = /\/instances\/\d+$/;
    google.state.script.push(
      { path: instancePath, status: 0, error: new TypeError("fetch failed") },
      { path: instancePath, status: 404, reason: "notFound" },
      { path: instancePath, status: 503, reason: "backendError" },
      { path: instancePath, status: 503, reason: "backendError" },
      { path: instancePath, status: 503, reason: "backendError" }
    );
    const error = await google.provider
      .delete(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: "server", message: "scripted 503" });
    expect(lookupsAfterDelete(google.requests)).toBe(3);
  });

  it("keeps a host whose resent delete was refused while the VM still exists", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const instancePath = /\/instances\/\d+$/;
    google.state.script.push(
      { path: instancePath, status: 0, error: new TypeError("fetch failed") },
      { path: instancePath, status: 404, reason: "notFound" }
    );
    const error = await google.provider
      .delete(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: "server", message: /hasn't finished deleting/ });
    expect(lookupsAfterDelete(google.requests)).toBe(1);
    expect(google.instances.size).toBe(1);
  });

  it("confirms a delete whose every answer was lost by looking at the VM", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const deleting = /\/instances\/\d+$/;
    google.state.script.push(
      ...[0, 1, 2].map(() => ({
        path: deleting,
        status: 0,
        error: new TypeError("fetch failed"),
      }))
    );
    google.instances.delete(BIG_ID);
    await expect(
      google.provider.delete(google.credentials(), created.resourceId)
    ).resolves.toBeUndefined();
    expect(lookupsAfterDelete(google.requests)).toBe(1);
  });

  it("confirms a delete Google answered 503 to by looking at the VM", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.script.push(
      ...[0, 1, 2].map(() => ({
        path: /\/instances\/\d+$/,
        status: 503,
        reason: "backendError",
      }))
    );
    google.instances.delete(BIG_ID);
    await expect(
      google.provider.delete(google.credentials(), created.resourceId)
    ).resolves.toBeUndefined();
    expect(lookupsAfterDelete(google.requests)).toBe(1);
  });

  it("looks at the VM when a delete Google took can't be followed", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.script.push(
      ...[0, 1, 2].map(() => ({
        path: /\/operations\/operation-2\/wait$/,
        status: 503,
        reason: "backendError",
      }))
    );
    const error = await google.provider
      .delete(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(error).toMatchObject({ kind: "server", message: /hasn't finished deleting/ });
    expect(lookupsAfterDelete(google.requests)).toBe(1);
  });

  it("says a delete Google finished with an error of its own", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.deleteFailure = {
      code: "SOMETHING_FAILED",
      message: "Delete failed",
      status: 500,
    };
    await expect(
      google.provider.delete(google.credentials(), created.resourceId)
    ).rejects.toMatchObject({ message: "Delete failed" });
    expect(lookupsAfterDelete(google.requests)).toBe(0);
  });

  it("never reads a finished delete's own 404 as the VM gone while it's still there", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.deleteFailure = { code: "RESOURCE_NOT_FOUND", message: "Not found", status: 404 };
    await expect(
      google.provider.delete(google.credentials(), created.resourceId)
    ).rejects.toMatchObject({ kind: "server", message: /hasn't finished deleting/ });
    expect(google.instances.size).toBe(1);
  });

  it("says a stop Google gave up on", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.stopFailure = { code: "SOMETHING_FAILED", message: "Stop failed", status: 400 };
    await expect(
      google.provider.stop(google.credentials(), created.resourceId)
    ).rejects.toMatchObject({ message: "Stop failed" });
  });

  it("settles a write cancelled during its backoff as unknown once it may have been sent", async () => {
    const controller = new AbortController();
    const cancelled = async () => {
      controller.abort();
      throw new GceApiError("cancelled", "Cancelled", null, null);
    };
    const google = fakeGoogle({ clientSleep: cancelled });
    google.state.script.push({ path: /\/instances$/, status: 503, reason: "backendError" });
    const error = await google.provider
      .create(google.credentials({ signal: controller.signal }), CREATE)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "outcome-unknown" });
    expect(google.requests.filter((request) => request.path.endsWith("/instances"))).toHaveLength(
      1
    );
  });

  it("settles a write cancelled while its token was retried as cancelled: nothing was sent", async () => {
    const controller = new AbortController();
    const cancelled = async () => {
      controller.abort();
      throw new GceApiError("cancelled", "Cancelled", null, null);
    };
    const google = fakeGoogle({ clientSleep: cancelled });
    google.state.script.push({ path: /^\/token$/, status: 503 });
    const error = await google.provider
      .create(google.credentials({ signal: controller.signal }), CREATE)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "cancelled" });
    expect(google.requests.some((request) => request.path.endsWith("/instances"))).toBe(false);
  });

  it("deletes only once Compute Engine has finished", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.waitsBeforeDone = 3;
    await google.provider.delete(google.credentials(), created.resourceId);
    expect(google.instances.size).toBe(0);
    const deleteWaits = google.requests.filter(
      (request) =>
        /\/operations\/operation-\d+\/wait$/.test(request.path) &&
        request.path.includes("operation-2/")
    );
    expect(deleteWaits).toHaveLength(3);
  });

  it("never reads a lost delete operation as the machine gone", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.script.push({
      path: /\/operations\/operation-2\/wait$/,
      status: 404,
      reason: "notFound",
    });
    const error = await google.provider
      .delete(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GceApiError);
    expect(google.provider.describeError(error).code).not.toBe("not-found");
    expect(google.instances.size).toBe(1);
  });

  it("pins the strongest host key the guest publishes, once it has", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.publishHostKeysAfter = 2;
    const access = await google.provider.sshAccess(google.credentials(), created.resourceId);
    expect(access).toEqual({
      user: GCE_SSH_USER,
      endpoint: { host: "203.0.113.20", port: 22 },
      hostKey: `ssh-ed25519 ${HOST_KEY_BLOB}`,
    });
    expect(google.state.guestReads).toBe(3);
  });

  it("gives up waiting for host keys as a transient failure, never trusting a key unseen", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.state.publishHostKeysAfter = Number.POSITIVE_INFINITY;
    const error = await google.provider
      .sshAccess(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(google.provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("waits through throttled host-key reads instead of giving up on the machine", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    for (let i = 0; i < 3; i++) {
      google.state.script.push({
        path: /\/getGuestAttributes$/,
        status: 429,
        reason: "rateLimitExceeded",
      });
    }
    const error = await google.provider
      .sshAccess(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect(google.provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("gives a kept token refused late in the retries its one fresh try", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    const exchanges = () => google.requests.filter((request) => request.path === "/token").length;
    const before = exchanges();
    const instancePath = /\/instances\/\d+$/;
    google.state.script.push(
      { path: instancePath, status: 503 },
      { path: instancePath, status: 503 },
      { path: instancePath, status: 401 }
    );
    await expect(
      google.provider.inspect(google.credentials(), created.resourceId)
    ).resolves.toMatchObject({
      machine: "running",
    });
    expect(exchanges()).toBe(before + 1);
  });

  it("refuses a machine with no external address", async () => {
    const google = fakeGoogle();
    const created = await google.provider.create(google.credentials(), CREATE);
    google.instances.get(BIG_ID)!.natIP = null;
    const error = await google.provider
      .sshAccess(google.credentials(), created.resourceId)
      .catch((err: unknown) => err);
    expect((error as GceApiError).message).toMatch(/no external IP address/);
  });
});

describe("GceClient writes", () => {
  const ID = "1234567890";
  function client(responses: Response[]) {
    const fetch = vi.fn(async () => responses.shift() ?? new Response("{}", { status: 500 }));
    return {
      fetch,
      client: new GceClient({
        baseUrl: API,
        fetch: fetch as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      }),
    };
  }

  it("calls a token failure of any shape an unsent refusal", async () => {
    const { client: gce, fetch } = client([]);
    const error = await gce
      .deleteInstance(
        {
          project: PROJECT,
          authorize: async () => {
            throw new Error("sign failed");
          },
        },
        "us-central1-a",
        ID
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "unauthorized" });
    expect(mayHaveReachedCompute(error as GceApiError)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a sent write's uncertainty through a later token failure", async () => {
    const { client: gce, fetch } = client([
      new Response(JSON.stringify({ error: { code: 503, message: "busy" } }), { status: 503 }),
    ]);
    let calls = 0;
    const error = await gce
      .deleteInstance(
        {
          project: PROJECT,
          authorize: async () => {
            if (calls++ > 0) throw new Error("sign failed");
            return "ya29.token";
          },
        },
        "us-central1-a",
        ID
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "outcome-unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never marks a write that only ever failed to get a token as possibly sent", async () => {
    const { client: gce, fetch } = client([]);
    const error = await gce
      .deleteInstance(
        {
          project: PROJECT,
          authorize: async () => {
            throw new GceApiError("server", "sign-in down", 503, null);
          },
        },
        "us-central1-a",
        ID
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "server" });
    expect(mayHaveReachedCompute(error as GceApiError)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("gceMachineState", () => {
  it("reads a TERMINATED VM as stopped and a suspended one as stopped too", () => {
    expect(gceMachineState("TERMINATED")).toBe("stopped");
    expect(gceMachineState("SUSPENDED")).toBe("stopped");
    expect(gceMachineState("STAGING")).toBe("starting");
    expect(gceMachineState("SOMETHING_NEW")).toBe("unknown");
  });
});

describe("gceInstanceName", () => {
  it("makes a valid name from any display name, apart for each create", () => {
    const key = "3f2b8c1a-1111-4222-8333-444455556666";
    const other = "9a8b7c6d-1111-4222-8333-444455556666";
    const valid = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
    expect(gceInstanceName("Build host", key)).toBe("build-host-3f2b8c1a");
    expect(gceInstanceName("42 Ünïcode!", key)).toBe("dt-42-unicode-3f2b8c1a");
    expect(gceInstanceName("x".repeat(100), key)).toMatch(valid);
    expect(gceInstanceName("x".repeat(100), key)).toHaveLength(63);
    expect(gceInstanceName("Build host", other)).toMatch(valid);
    expect(gceInstanceName("Build host", other)).not.toBe(gceInstanceName("Build host", key));
  });
});

describe("a Compute Engine VM stopping itself once idle (#17362)", () => {
  const NO_LIMIT = { ...CREATE, lifetimeSeconds: null };

  it("stops itself after its idle time with no Shell, keeping its disk, with no Google call from the VM", async () => {
    const google = fakeGoogle();
    const resource = await google.provider.create(google.credentials(), NO_LIMIT);
    const check = await google.provider.checkGuestPowerOff(
      google.credentials(),
      resource.resourceId
    );
    expect(check).toEqual({
      eligible: true,
      target: { provider: "gce", project: PROJECT, zone: "us-central1-a", instanceId: BIG_ID },
    });
    if (!check.eligible) return;
    const host = cloudMachineHost({
      metadata: google.metadataFor(BIG_ID),
      powerOff: () => google.guestPowerOff(BIG_ID),
    });
    // All the Shell hands over: which VM it is. No service-account key, no token.
    await expect(host.keeper.set({ target: check.target, enabled: true })).resolves.toEqual({
      armed: true,
      problem: null,
    });
    const requestsBefore = google.requests.length;
    await host.pass(0);
    await host.pass((IDLE_MINUTES - 1) * MINUTE);
    expect(host.powerOffs).toEqual([]);
    await host.pass(2 * MINUTE);
    expect(host.powerOffs).toEqual([["/usr/bin/sudo", "-n", "/usr/bin/systemctl", "poweroff"]]);
    await host.pass(MINUTE);
    expect(host.powerOffs).toHaveLength(1);
    expect(google.requests.slice(requestsBefore)).toEqual([]);

    await expect(
      google.provider.inspect(google.credentials(), resource.resourceId)
    ).resolves.toMatchObject({ resourceId: resource.resourceId, machine: "stopped", error: null });
    expect([...google.instances.keys()]).toEqual([BIG_ID]);
    expect(google.instances.get(BIG_ID)!.body.disks).toEqual([
      expect.objectContaining({ type: "PERSISTENT", boot: true }),
    ]);
    expect(
      google.requests.filter((request) => /\/(stop|setScheduling)$/.test(request.path))
    ).toEqual([]);
    expect(google.requests.some((request) => request.method === "DELETE")).toBe(false);
    host.dispose();
  });

  it("holds while the host sees work, past the old two-hour limit, and counts a full idle time after", async () => {
    const google = fakeGoogle();
    const resource = await google.provider.create(google.credentials(), NO_LIMIT);
    const check = await google.provider.checkGuestPowerOff(
      google.credentials(),
      resource.resourceId
    );
    if (!check.eligible) throw new Error("not eligible");
    const host = cloudMachineHost({
      metadata: google.metadataFor(BIG_ID),
      powerOff: () => google.guestPowerOff(BIG_ID),
    });
    await host.keeper.set({ target: check.target, enabled: true });
    host.setBusy(true);
    for (let elapsed = 0; elapsed < 3 * 60; elapsed += 10) {
      await host.pass(10 * MINUTE);
    }
    expect(host.powerOffs).toEqual([]);
    expect(google.instances.get(BIG_ID)!.status).toBe("RUNNING");
    expect(google.instances.get(BIG_ID)!.scheduling).toEqual({});
    host.setBusy(false);
    await host.pass(MINUTE);
    await host.pass((IDLE_MINUTES - 2) * MINUTE);
    expect(host.powerOffs).toEqual([]);
    await host.pass(2 * MINUTE);
    expect(host.powerOffs).toHaveLength(1);
    expect(google.instances.get(BIG_ID)!.status).toBe("TERMINATED");
    host.dispose();
  });

  it("never lets a VM with a disk a stop doesn't keep power itself off", async () => {
    const google = fakeGoogle();
    const resource = await google.provider.create(google.credentials(), NO_LIMIT);
    google.instances.get(BIG_ID)!.body.disks.push({ type: "SCRATCH" });
    await expect(
      google.provider.checkGuestPowerOff(google.credentials(), resource.resourceId)
    ).resolves.toMatchObject({
      eligible: false,
      target: { provider: "gce", instanceId: BIG_ID },
      problem: expect.stringContaining("local SSD"),
    });
  });

  it("refuses to power off a VM whose metadata names another one", async () => {
    const google = fakeGoogle();
    await google.provider.create(google.credentials(), NO_LIMIT);
    const host = cloudMachineHost({
      metadata: google.metadataFor(BIG_ID),
      powerOff: () => google.guestPowerOff(BIG_ID),
    });
    await expect(
      host.keeper.set({
        target: { provider: "gce", project: PROJECT, zone: "us-central1-b", instanceId: BIG_ID },
        enabled: true,
      })
    ).resolves.toEqual({ armed: false, problem: expect.stringContaining("another machine") });
    await host.pass(0);
    await host.pass(2 * IDLE_MINUTES * MINUTE);
    expect(host.powerOffs).toEqual([]);
    host.dispose();
  });
});
