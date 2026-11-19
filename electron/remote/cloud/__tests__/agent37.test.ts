import { describe, expect, it, vi } from "vitest";
import {
  AGENT37_PRODUCTION_API_URL,
  Agent37ApiError,
  Agent37Client,
  redactAgent37Text,
  resolveAgent37ApiUrl,
} from "../agent37/Agent37Client.js";
import {
  AGENT37_IDLE_SECONDS,
  AGENT37_KEY_DELIVERY_MS,
  Agent37Provider,
} from "../agent37/Agent37Provider.js";
import { agent37MachineState } from "../agent37/agent37State.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { FAKE_AGENT37_KEY, FakeAgent37Api } from "./fakeAgent37Api.js";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForDaintree daintree";
const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyMadeAgain daintree";
const LABELS = { daintree: "1", "daintree-binding": "cb_0123456789ab" };

function env(options: { now?: () => number } = {}) {
  const api = new FakeAgent37Api();
  const sleeps: number[] = [];
  const client = new Agent37Client({
    baseUrl: api.baseUrl,
    fetch: api.fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const provider = new Agent37Provider(() => client, options);
  const credentials = {
    values: { apiKey: FAKE_AGENT37_KEY },
    scopeId: "workspace",
    apiUrl: api.baseUrl,
  };
  const ctx = { apiKey: FAKE_AGENT37_KEY };
  return { api, client, provider, credentials, ctx, sleeps };
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    name: "build",
    machineType: "2x4",
    lifetimeSeconds: null,
    provisioning: { location: null, image: null, network: null },
    labels: LABELS,
    idempotencyKey: "unused",
    publicKey: PUBLIC_KEY,
    ...overrides,
  };
}

describe("resolveAgent37ApiUrl", () => {
  it("always answers production in a packaged build", () => {
    expect(resolveAgent37ApiUrl(true, { DAINTREE_AGENT37_API_URL: "http://127.0.0.1:9" })).toBe(
      AGENT37_PRODUCTION_API_URL
    );
  });

  it("honours an http(s) override in development only, as origin and path", () => {
    expect(
      resolveAgent37ApiUrl(false, { DAINTREE_AGENT37_API_URL: "http://u:p@127.0.0.1:9/v1/?x=1#y" })
    ).toBe("http://127.0.0.1:9/v1");
    expect(resolveAgent37ApiUrl(false, { DAINTREE_AGENT37_API_URL: "file:///etc/passwd" })).toBe(
      AGENT37_PRODUCTION_API_URL
    );
    expect(resolveAgent37ApiUrl(false, {})).toBe(AGENT37_PRODUCTION_API_URL);
  });
});

describe("Agent37Client", () => {
  it("sends the key as a bearer token and refuses redirects", async () => {
    const calls: RequestInit[] = [];
    const api = new FakeAgent37Api();
    const client = new Agent37Client({
      baseUrl: api.baseUrl,
      fetch: (async (url: URL, init: RequestInit) => {
        calls.push(init);
        return api.fetch(url, init);
      }) as unknown as typeof globalThis.fetch,
    });
    await client.billing({ apiKey: FAKE_AGENT37_KEY });
    expect((calls[0]!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${FAKE_AGENT37_KEY}`
    );
    expect(calls[0]!.redirect).toBe("error");
  });

  it("refuses an id that isn't an instance id before any request", async () => {
    const { api, client, ctx } = env();
    await expect(client.getInstance(ctx, "../billing")).rejects.toMatchObject({
      kind: "invalid-request",
    });
    expect(api.requests).toHaveLength(0);
  });

  it("sends nothing for a request already cancelled", async () => {
    const { api, client } = env();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.listInstances({ apiKey: FAKE_AGENT37_KEY, signal: controller.signal })
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(api.requests).toHaveLength(0);
  });

  it("types an error by its code and redacts the request's own key from the message", async () => {
    const { api, client } = env();
    // Not shaped like any key the pattern knows: only the exact key can find it.
    const opaque = "opaque0key0of0no0known0shape";
    api.fail(
      "GET",
      /^\/billing$/,
      FakeAgent37Api.error(403, "ip_not_allowed", `Key ${opaque} from 203.0.113.9`)
    );
    const error = (await client
      .billing({ apiKey: opaque })
      .catch((e: unknown) => e)) as Agent37ApiError;
    expect(error).toBeInstanceOf(Agent37ApiError);
    expect(error).toMatchObject({ kind: "forbidden", code: "ip_not_allowed", status: 403 });
    expect(error.message).not.toContain(opaque);
    expect(error.message).toContain("203.0.113.9");
  });

  it("reads a transport rejection's bare code", async () => {
    const { api, client, ctx } = env();
    api.fail(
      "GET",
      /^\/billing$/,
      () =>
        new Response(JSON.stringify({ error: "instance_suspended", message: "Top up" }), {
          status: 402,
        })
    );
    await expect(client.billing(ctx)).rejects.toMatchObject({
      kind: "payment-required",
      code: "instance_suspended",
      message: "Top up",
    });
  });

  it("calls only a no_capacity 503 a lack of room", async () => {
    const { api, client, ctx } = env();
    api.fail("POST", /^\/instances$/, FakeAgent37Api.error(503, "no_capacity"));
    await expect(
      client.createInstance(ctx, {
        template: "agent37-base",
        type: "default",
        resources: { cpu: 2, memory: 4, disk: 12 },
        name: "a",
        metadata: {},
        auto_sleep: true,
        idle_timeout_seconds: 900,
      })
    ).rejects.toMatchObject({ kind: "no-capacity" });
    api.fail("GET", /^\/billing$/, FakeAgent37Api.error(503, "host_mesh_not_ready"), 3);
    await expect(client.billing(ctx)).rejects.toMatchObject({ kind: "server" });
    api.fail("GET", /^\/billing$/, FakeAgent37Api.error(500, "no_capacity"), 3);
    await expect(client.billing(ctx)).rejects.toMatchObject({ kind: "server" });
  });

  it("retries a read after a server error and a lost response", async () => {
    const { api, client, ctx } = env();
    api.fail("GET", /^\/billing$/, FakeAgent37Api.error(500, "internal_error"));
    api.fail("GET", /^\/billing$/, () => new TypeError("socket hang up"));
    await expect(client.billing(ctx)).resolves.toMatchObject({ balance_usd: 4.2 });
    expect(api.calls("GET", "/billing")).toHaveLength(3);
  });

  it("never sends a create twice, whatever happened to the first", async () => {
    const { api, client, ctx } = env();
    api.fail("POST", /^\/instances$/, () => new TypeError("socket hang up"));
    await expect(
      client.createInstance(ctx, {
        template: "agent37-base",
        type: "default",
        resources: { cpu: 2, memory: 4, disk: 12 },
        name: "a",
        metadata: {},
        auto_sleep: true,
        idle_timeout_seconds: 900,
      })
    ).rejects.toMatchObject({ kind: "network" });
    expect(api.calls("POST", "/instances")).toHaveLength(1);
  });

  it("never sends a delete twice: a repeat would answer not found", async () => {
    const { api, client, ctx } = env();
    const instance = api.seed();
    api.fail("DELETE", /^\/instances\//, FakeAgent37Api.error(500, "internal_error"));
    await expect(client.deleteInstance(ctx, instance.id)).rejects.toMatchObject({
      kind: "server",
    });
    expect(api.calls("DELETE", /^\/instances\//)).toHaveLength(1);
  });

  it("keeps asking a stop while the instance is mid-checkpoint, backing off longer each time", async () => {
    const { api, client, ctx, sleeps } = env();
    const instance = api.seed({ status: "sleeping" });
    api.fail("POST", /\/stop$/, FakeAgent37Api.error(409, "try_again"), 4);
    await expect(client.stopInstance(ctx, instance.id)).resolves.toMatchObject({
      status: "stopped",
    });
    expect(api.calls("POST", /\/stop$/)).toHaveLength(5);
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 10_000]);
  });

  it("sends a start again after a lost answer: a start of a running instance is the same ack", async () => {
    const { api, client, ctx } = env();
    const instance = api.seed({ status: "stopped" });
    api.fail("POST", /\/start$/, () => new TypeError("socket hang up"));
    await expect(client.startInstance(ctx, instance.id)).resolves.toMatchObject({
      status: "running",
    });
    expect(api.calls("POST", /\/start$/)).toHaveLength(2);
  });

  it("treats a key already registered as registered, and refuses to send a private key", async () => {
    const { api, client, ctx } = env();
    // A new key carries Agent 37's own time for it; one already there has none to give.
    const first = await client.registerSshKey(ctx, PUBLIC_KEY, "Daintree");
    expect(first).toEqual({ created: true, at: api.sshKeys[0]!.created });
    await expect(client.registerSshKey(ctx, PUBLIC_KEY, "Daintree")).resolves.toEqual({
      created: false,
      at: null,
    });
    expect(api.sshKeys).toHaveLength(1);
    await expect(
      client.registerSshKey(ctx, "-----BEGIN OPENSSH PRIVATE KEY-----", "Daintree")
    ).rejects.toMatchObject({ kind: "invalid-request" });
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(2);
  });

  it("counts a key as new when the answer to its registering was lost and it then exists", async () => {
    const { api, client, ctx } = env();
    // Agent 37 registered it, but the answer never arrived: the retry finds it there.
    api.fail("POST", /^\/ssh-keys$/, () => {
      api.sshKeys.push({
        id: "k1",
        name: "Daintree",
        key: PUBLIC_KEY.split(" ").slice(0, 2).join(" "),
        created: 1,
      });
      return new TypeError("socket hang up");
    });
    await expect(client.registerSshKey(ctx, PUBLIC_KEY, "Daintree")).resolves.toEqual({
      created: true,
      at: null,
    });
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(2);
    // Found there on the first try, it was registered before, not now.
    await expect(client.registerSshKey(ctx, PUBLIC_KEY, "Daintree")).resolves.toEqual({
      created: false,
      at: null,
    });
  });

  it("refuses an answer too large to be one, however well formed", async () => {
    const { api, client, ctx } = env();
    api.fail("GET", /^\/instances$/, () =>
      Response.json({ data: [], padding: "x".repeat(5 * 1024 * 1024) })
    );
    await expect(client.listInstances(ctx)).rejects.toMatchObject({
      kind: "bad-response",
      message: expect.stringContaining("too large"),
    });
  });

  it("counts a delete done only when Agent 37 names this instance as deleted", async () => {
    const { api, client, ctx } = env();
    const instance = api.seed();
    api.fail("DELETE", /^\/instances\//, () => Response.json({ id: "zzzzzzzzzz", deleted: true }));
    await expect(client.deleteInstance(ctx, instance.id)).rejects.toMatchObject({
      kind: "bad-response",
    });
    api.fail("DELETE", /^\/instances\//, () => new Response("", { status: 200 }));
    await expect(client.deleteInstance(ctx, instance.id)).rejects.toMatchObject({
      kind: "bad-response",
    });
    await expect(client.deleteInstance(ctx, instance.id)).resolves.toBeUndefined();
    expect(api.instances.has(instance.id)).toBe(false);
  });

  it("leaves out an instance it can't read rather than failing the list", async () => {
    const { api, client, ctx } = env();
    const kept = api.seed();
    api.fail("GET", /^\/instances$/, () =>
      Response.json({ data: [{ id: "NOT-AN-ID", status: "running" }, { ...kept }] })
    );
    expect((await client.listInstances(ctx)).map((entry) => entry.id)).toEqual([kept.id]);
  });
});

describe("redactAgent37Text", () => {
  it("removes key-shaped runs and bearer tokens but keeps Agent 37's error codes", () => {
    expect(
      redactAgent37Text("ssh_key_exists: sk_live_ABCDEFGH12345678 and Bearer sk_live_x.y")
    ).toBe("ssh_key_exists: [redacted] and Bearer [redacted]");
  });
});

describe("agent37MachineState", () => {
  it.each([
    ["provisioning", "starting"],
    ["starting", "starting"],
    ["restarting", "starting"],
    ["updating", "starting"],
    ["waking", "starting"],
    ["running", "running"],
    ["stopping", "stopping"],
    ["stopped", "stopped"],
    ["sleeping", "stopped"],
    ["failed", "error"],
    ["deleting", "deleted"],
    ["deleted", "deleted"],
    ["hibernating", "unknown"],
  ])("reads %s as %s", (status, machine) => {
    expect(agent37MachineState(status)).toBe(machine);
  });
});

describe("Agent37Provider", () => {
  it("declares a tunnel the registry accepts, trust in that tunnel, and an idle sleep", () => {
    const { provider } = env();
    const registry = new CloudProviderRegistry();
    registry.register(provider, {
      owner: { kind: "built-in" },
      apiUrl: "https://api.agent37.test/v1",
    });
    const { capabilities } = provider.info("darwin");
    expect(capabilities).toMatchObject({
      sshTrust: "provider-tunnel",
      transport: "provider-command",
      tunnel: { command: "agent37", args: ["tunnel", "%h"] },
      lifetime: { kind: "idle-sleep", idleSeconds: AGENT37_IDLE_SECONDS },
      provisioning: { sshKey: "at-create" },
      deletion: true,
    });
    expect(capabilities.persistence).toMatchObject({
      stoppedComputeBilled: false,
      stoppedStorageBilled: true,
    });
    expect(provider.info("win32").unsupportedReason).toContain("Windows");
  });

  it("checks a key against its workspace before it is saved, and names no one", async () => {
    const { api, provider } = env();
    await expect(
      provider.checkCredentials({ apiKey: FAKE_AGENT37_KEY }, api.baseUrl)
    ).resolves.toEqual({
      identity: null,
      scopes: [{ scope: { kind: "workspace", id: "workspace", name: "Workspace" }, active: true }],
    });
    const refused = await provider
      .checkCredentials({ apiKey: "sk_live_wrong000000000000" }, api.baseUrl)
      .catch((e) => e);
    expect(provider.describeError(refused).code).toBe("credential-invalid");
  });

  it("prices each shape as what its create asks for, at the published rates", async () => {
    const { api, provider, credentials } = env();
    const catalog = await provider.catalog(credentials);
    expect(catalog.machineTypes.length).toBeGreaterThan(1);
    let previous = 0;
    for (const type of catalog.machineTypes) {
      await provider.create(credentials, createRequest({ machineType: type.id }));
      const { resources } = api.calls("POST", "/instances").at(-1)!.body as {
        resources: { cpu: number; memory: number; disk: number };
      };
      expect(resources).toMatchObject({ cpu: type.vcpu, memory: type.memoryGB });
      // $0.80 a vCPU, $0.70 a GB of memory and $0.09 a GB of disk a month, over 730 hours.
      const monthly = resources.cpu * 0.8 + resources.memory * 0.7 + resources.disk * 0.09;
      expect(type.hourlyDollars).toBeCloseTo(monthly / 730, 4);
      expect(type.hourlyDollars!).toBeGreaterThan(previous);
      previous = type.hourlyDollars!;
    }
  });

  it("says when the wallet is suspended", async () => {
    const { api, provider, credentials } = env();
    const catalog = await provider.catalog(credentials);
    expect(api.calls("GET", "/billing")).toHaveLength(1);
    expect(catalog.canStart).toBe(true);
    api.billing.past_due = true;
    expect((await provider.catalog(credentials)).canStart).toBe(false);
  });

  it("registers the key before the create, then asks once for a sleeping-when-idle instance", async () => {
    const { api, provider, credentials } = env();
    const created = await provider.create(credentials, createRequest({ name: "x".repeat(70) }));
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /ssh-keys",
      "POST /instances",
    ]);
    expect(api.calls("POST", "/ssh-keys")[0]!.body).toEqual({
      public_key: PUBLIC_KEY,
      name: "Daintree",
    });
    expect(api.calls("POST", "/instances")[0]!.body).toEqual({
      template: "agent37-base",
      type: "default",
      resources: { cpu: 2, memory: 4, disk: 12 },
      name: "x".repeat(60),
      metadata: LABELS,
      auto_sleep: true,
      idle_timeout_seconds: AGENT37_IDLE_SECONDS,
    });
    expect(created).toMatchObject({
      machine: "running",
      machineType: "2x4",
      labels: LABELS,
      asleep: false,
      idleSleep: { enabled: true, idleSeconds: AGENT37_IDLE_SECONDS },
    });
  });

  it("creates nothing when the key can't be registered, as a refusal the create can be sent again after", async () => {
    const { api, provider, credentials } = env();
    api.fail(
      "POST",
      /^\/ssh-keys$/,
      FakeAgent37Api.error(400, "invalid_request", "A workspace holds at most 20 SSH keys.")
    );
    const error = await provider.create(credentials, createRequest()).catch((e: unknown) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "ssh-authorization",
      message: expect.stringContaining("at most 20 SSH keys"),
    });
    expect(api.calls("POST", "/instances")).toHaveLength(0);

    const keyPosts = api.calls("POST", "/ssh-keys").length;
    const noKey = await provider
      .create(credentials, createRequest({ publicKey: null }))
      .catch((e: unknown) => e);
    expect(provider.describeError(noKey).code).toBe("ssh-authorization");
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(keyPosts);
    expect(api.calls("POST", "/instances")).toHaveLength(0);

    api.fail("POST", /^\/ssh-keys$/, FakeAgent37Api.error(401, "invalid_api_key"));
    const refused = await provider.create(credentials, createRequest()).catch((e: unknown) => e);
    expect(provider.describeError(refused).code).toBe("credential-invalid");
    expect(api.calls("POST", "/instances")).toHaveLength(0);
  });

  it("says why Agent 37 refused a create as invalid, as a refusal that made nothing", async () => {
    const { api, provider, credentials } = env();
    api.fail(
      "POST",
      /^\/instances$/,
      FakeAgent37Api.error(400, "invalid_request", "Unsupported shape: 4 vCPU / 4 GB")
    );
    const error = await provider.create(credentials, createRequest()).catch((e: unknown) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "unsupported",
      message: expect.stringContaining("Unsupported shape"),
    });
    // A timeout a proxy answered for, or a lost answer, stays a lost answer.
    api.fail("POST", /^\/instances$/, FakeAgent37Api.error(408, "request_timeout"));
    const timedOut = await provider.create(credentials, createRequest()).catch((e: unknown) => e);
    expect(provider.describeError(timedOut).code).not.toBe("unsupported");
    api.fail("POST", /^\/instances$/, () => new TypeError("socket hang up"));
    const lost = await provider.create(credentials, createRequest()).catch((e: unknown) => e);
    expect(provider.describeError(lost).code).toBe("provider-unreachable");
  });

  it("finds a lost create by its labels, since Agent 37 filters nothing itself", async () => {
    const { api, provider, credentials } = env();
    api.seed({ metadata: { daintree: "1", "daintree-binding": "cb_other" } });
    const mine = api.seed({ metadata: { ...LABELS, unrelated: 3 } });
    const found = await provider.list(credentials, { label: "daintree-binding=cb_0123456789ab" });
    expect(found.map((entry) => entry.resourceId)).toEqual([mine.id]);
    expect(found[0]!.labels).toEqual(LABELS);
    expect(await provider.list(credentials)).toHaveLength(2);
  });

  it("reads an asleep machine as stopped and asleep, with its own idle sleep", async () => {
    const { api, provider, credentials } = env();
    const asleep = api.seed({
      status: "sleeping",
      slept_at: 1_781_230_000,
      idle_timeout_seconds: 600,
      auto_sleep: true,
    });
    const awake = api.seed({ auto_sleep: false, resources: { cpu: 2, memory: 4, disk: 6 } });
    const asleepResource = await provider.inspect(credentials, asleep.id);
    expect(asleepResource).toMatchObject({
      machine: "stopped",
      rawState: "sleeping",
      asleep: true,
      stoppedAt: new Date(1_781_230_000 * 1000).toISOString(),
      idleSleep: { enabled: true, idleSeconds: 600 },
    });
    const awakeResource = await provider.inspect(credentials, awake.id);
    // A disk Daintree doesn't offer: the size is reported, the price isn't guessed from a near shape.
    expect(awakeResource).toMatchObject({
      machine: "running",
      machineType: null,
      vcpu: 2,
      memoryGB: 4,
      asleep: false,
      idleSleep: { enabled: false },
    });
    // Stopped on purpose isn't asleep, and carries no sleep time.
    const stopped = api.seed({ status: "stopped", slept_at: 1_781_230_000 });
    expect(await provider.inspect(credentials, stopped.id)).toMatchObject({
      machine: "stopped",
      asleep: false,
      stoppedAt: null,
    });
  });

  it("says why a suspended or failed machine is down, in words safe to show", async () => {
    const { api, provider, credentials } = env();
    const failed = api.seed({
      status: "failed",
      status_reason: {
        code: "provisioning_failed",
        message: "bad sk_live_ABCDEFGH12345678",
        operation: "create",
        at: 1,
      },
    });
    const suspended = api.seed({ status: "sleeping", past_due: true });
    expect((await provider.inspect(credentials, failed.id)).error).toBe("bad [redacted]");
    expect((await provider.inspect(credentials, suspended.id)).error).toContain("Top up");
    expect((await provider.inspect(credentials, api.seed().id)).error).toBeNull();
  });

  it("starts, stops, renames and deletes through Agent 37's own calls", async () => {
    const { api, provider, credentials } = env();
    const instance = api.seed({ status: "stopped" });
    await expect(provider.start(credentials, instance.id, {})).resolves.toBeNull();
    expect(api.instances.get(instance.id)!.status).toBe("running");
    await expect(provider.stop(credentials, instance.id)).resolves.toBeNull();
    expect(api.instances.get(instance.id)!.status).toBe("stopped");
    await provider.rename(credentials, instance.id, "y".repeat(64));
    expect(api.instances.get(instance.id)!.name).toBe("y".repeat(60));
    await provider.delete(credentials, instance.id);
    expect(api.instances.has(instance.id)).toBe(false);
  });

  it("reaches a machine it created as node through the tunnel's name for it, with no key to pin", async () => {
    const { api, provider, credentials } = env();
    const created = await provider.create(credentials, createRequest());
    const access = {
      user: "node",
      endpoint: { host: `${created.resourceId}.agent37.app`, port: 22 },
      hostKey: null,
    };
    // It booted with the workspace's key: only how to reach it is asked, and nothing registered.
    await expect(provider.sshAccess(credentials, created.resourceId)).resolves.toEqual(access);
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(1);
    // An imported machine has the key made sure of first: the workspace keeps one copy.
    await expect(
      provider.authorizeSsh(credentials, created.resourceId, PUBLIC_KEY)
    ).resolves.toEqual(access);
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(2);
    expect(api.sshKeys).toHaveLength(1);
    await expect(provider.sshAccess(credentials, "zzzzzzzzzz")).rejects.toMatchObject({
      kind: "not-found",
    });
    api.instances.get(created.resourceId)!.status = "sleeping";
    const asleep = await provider.sshAccess(credentials, created.resourceId).catch((e) => e);
    expect(provider.describeError(asleep).code).toBe("failed");
  });

  it("waits out the key's delivery to a machine that was already running when it was first registered", async () => {
    let now = 1_000_000;
    const { api, provider, credentials } = env({ now: () => now });
    const existing = api.seed();
    const error = await provider.authorizeSsh(credentials, existing.id, PUBLIC_KEY).catch((e) => e);
    // A wait the link retries by itself, not a refusal it parks on.
    expect(provider.describeError(error)).toMatchObject({
      code: "provider-unreachable",
      message: expect.stringContaining("120 seconds"),
    });
    now += AGENT37_KEY_DELIVERY_MS - 30_000;
    const again = await provider.authorizeSsh(credentials, existing.id, PUBLIC_KEY).catch((e) => e);
    expect(provider.describeError(again).message).toContain("30 seconds");
    now += 30_000;
    await expect(
      provider.authorizeSsh(credentials, existing.id, PUBLIC_KEY)
    ).resolves.toMatchObject({
      user: "node",
    });
  });

  it("waits out a new key's delivery to a machine it created with a key that was lost since (#17929)", async () => {
    let now = 1_000_000;
    const { api, provider, credentials } = env({ now: () => now });
    const created = await provider.create(credentials, createRequest());
    // The key it booted with gets it straight through.
    await expect(
      provider.authorizeSsh(credentials, created.resourceId, PUBLIC_KEY)
    ).resolves.toMatchObject({ user: "node" });
    const error = await provider
      .authorizeSsh(credentials, created.resourceId, OTHER_KEY)
      .catch((e) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "provider-unreachable",
      message: expect.stringContaining("still delivering"),
    });
    now += AGENT37_KEY_DELIVERY_MS - 1_000;
    const still = await provider
      .authorizeSsh(credentials, created.resourceId, OTHER_KEY)
      .catch((e) => e);
    expect(provider.describeError(still).message).toContain("still delivering");
    now += 1_000;
    await expect(
      provider.authorizeSsh(credentials, created.resourceId, OTHER_KEY)
    ).resolves.toMatchObject({ user: "node" });
    expect(api.sshKeys.map((entry) => entry.key)).toEqual(
      [PUBLIC_KEY, OTHER_KEY].map((key) => key.split(" ").slice(0, 2).join(" "))
    );
  });

  it("holds every machine waiting on one new key until its registration is answered (#17929)", async () => {
    const { api, client, provider, credentials } = env();
    const first = api.seed();
    const second = api.seed();
    const register = client.registerSshKey.bind(client);
    let release: () => void = () => {};
    vi.spyOn(client, "registerSshKey").mockImplementationOnce(async (...args) => {
      const answer = await register(...args);
      // Registered at Agent 37, but the answer saying when arrives late.
      await new Promise<void>((resolve) => (release = resolve));
      return answer;
    });
    let settled = 0;
    const one = provider
      .authorizeSsh(credentials, first.id, OTHER_KEY)
      .catch((e) => e)
      .finally(() => settled++);
    const other = provider
      .authorizeSsh(credentials, second.id, OTHER_KEY)
      .catch((e) => e)
      .finally(() => settled++);
    try {
      await vi.waitFor(() => expect(api.sshKeys).toHaveLength(1));
      await vi.waitFor(() => expect(api.calls("GET", `/instances/${second.id}`)).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Neither is answered while the registration's own answer is outstanding.
      expect(settled).toBe(0);
    } finally {
      release();
    }
    for (const outcome of [await one, await other]) {
      expect(provider.describeError(outcome)).toMatchObject({
        code: "provider-unreachable",
        message: expect.stringContaining("still delivering"),
      });
    }
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(1);
  });

  it("stops waiting on a shared registration when its own caller gives up, leaving it to the rest", async () => {
    const { api, client, provider, credentials } = env();
    const existing = api.seed();
    const register = client.registerSshKey.bind(client);
    let release: () => void = () => {};
    const sent = vi.spyOn(client, "registerSshKey").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return register(...args);
    });
    const abort = new AbortController();
    const quitter = provider
      .authorizeSsh({ ...credentials, signal: abort.signal }, existing.id, OTHER_KEY)
      .catch((e) => e);
    try {
      await vi.waitFor(() => expect(sent).toHaveBeenCalled());
      // Sent for everyone, so with no one caller's signal.
      expect(sent.mock.calls[0]![0].signal).toBeUndefined();
      const stayer = provider.authorizeSsh(credentials, existing.id, OTHER_KEY).catch((e) => e);
      await vi.waitFor(() => expect(api.calls("GET", `/instances/${existing.id}`)).toHaveLength(2));
      abort.abort();
      expect(await quitter).toMatchObject({ kind: "cancelled" });
      release();
      expect(provider.describeError(await stayer)).toMatchObject({
        code: "provider-unreachable",
        message: expect.stringContaining("still delivering"),
      });
    } finally {
      release();
    }
    expect(sent).toHaveBeenCalledTimes(1);
    expect(api.sshKeys).toHaveLength(1);
  });

  it("sends nothing for a create cancelled before its key was registered", async () => {
    const { api, provider, credentials } = env();
    const abort = new AbortController();
    abort.abort();
    await expect(
      provider.create({ ...credentials, signal: abort.signal }, createRequest())
    ).rejects.toBeTruthy();
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(0);
    expect(api.calls("POST", "/instances")).toHaveLength(0);
  });

  it("hands no tunnel to an instance that isn't awake: a sleeper would wake, a stopped one refuse", async () => {
    const { api, provider, credentials } = env();
    const asleep = api.seed({ status: "sleeping" });
    const waking = api.seed({ status: "waking" });
    const refused = await provider.authorizeSsh(credentials, asleep.id, PUBLIC_KEY).catch((e) => e);
    // Parked for a person's Start, never retried into a wake.
    expect(provider.describeError(refused)).toMatchObject({
      code: "failed",
      message: expect.stringContaining("sleeping"),
    });
    const later = await provider.authorizeSsh(credentials, waking.id, PUBLIC_KEY).catch((e) => e);
    expect(provider.describeError(later).code).toBe("provider-unreachable");
    expect(api.calls("POST", "/ssh-keys")).toHaveLength(0);
  });

  it("doesn't wait for an instance Agent 37 made after the key, by Agent 37's own clock", async () => {
    let now = 1_000_000;
    const { api, provider, credentials } = env({ now: () => now });
    const before = api.seed();
    await provider.authorizeSsh(credentials, before.id, PUBLIC_KEY).catch(() => {});
    // This device's clock says the key is new; the instance came after it all the same.
    const after = api.seed();
    now += 1_000;
    await expect(provider.authorizeSsh(credentials, after.id, PUBLIC_KEY)).resolves.toMatchObject({
      user: "node",
    });
    const still = await provider.authorizeSsh(credentials, before.id, PUBLIC_KEY).catch((e) => e);
    expect(provider.describeError(still).code).toBe("provider-unreachable");
  });

  it("doesn't wait for a key that was registered before this run, or a machine created with it", async () => {
    const { api, provider, credentials } = env();
    const older = api.seed();
    const created = await provider.create(credentials, createRequest());
    await expect(
      provider.authorizeSsh(credentials, created.resourceId, PUBLIC_KEY)
    ).resolves.toBeTruthy();
    // One that was already there when the create registered the key still waits for it.
    const waiting = await provider.authorizeSsh(credentials, older.id, PUBLIC_KEY).catch((e) => e);
    expect(provider.describeError(waiting).code).toBe("provider-unreachable");

    const fresh = env();
    fresh.api.sshKeys.push({
      id: "k1",
      name: "Daintree",
      key: PUBLIC_KEY.split(" ").slice(0, 2).join(" "),
      created: 1,
    });
    const existing = fresh.api.seed();
    await expect(
      fresh.provider.authorizeSsh(fresh.credentials, existing.id, PUBLIC_KEY)
    ).resolves.toMatchObject({ endpoint: { host: `${existing.id}.agent37.app` } });
    expect(fresh.api.sshKeys).toHaveLength(1);
  });

  it("describes failures in terms a person can act on", () => {
    const { provider } = env();
    const said = (kind: Agent37ApiError["kind"], status: number | null, code: string | null) =>
      provider.describeError(new Agent37ApiError(kind, `said ${code}`, status, code));
    expect(said("payment-required", 402, "insufficient_balance")).toMatchObject({
      code: "billing",
    });
    expect(said("conflict", 409, "instance_limit_reached")).toMatchObject({ code: "billing" });
    expect(said("conflict", 409, "capacity_unavailable")).toMatchObject({ code: "capacity" });
    expect(said("no-capacity", 503, "no_capacity")).toMatchObject({ code: "capacity" });
    expect(said("conflict", 409, "try_again").message).toContain("putting the machine to sleep");
    expect(said("forbidden", 403, "ip_not_allowed").message).toContain("allowlist");
    expect(said("not-found", 404, "not_found")).toMatchObject({ code: "not-found" });
    expect(said("network", null, null)).toMatchObject({ code: "provider-unreachable" });
    expect(said("server", 502, "provisioning_failed")).toMatchObject({ code: "failed" });
    expect(said("server", 500, "internal_error")).toMatchObject({ code: "provider-unreachable" });
    expect(provider.describeError(new Error("boom"))).toMatchObject({ code: "failed" });
  });

  it("never asks Agent 37 anything while it is only registered", () => {
    const fetch = vi.fn();
    const client = new Agent37Client({ baseUrl: "https://api.agent37.test/v1", fetch });
    new CloudProviderRegistry().register(new Agent37Provider(() => client), {
      owner: { kind: "built-in" },
      apiUrl: "https://api.agent37.test/v1",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
