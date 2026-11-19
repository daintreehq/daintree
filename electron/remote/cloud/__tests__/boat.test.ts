import { describe, expect, it, vi } from "vitest";
import {
  BOAT_PRODUCTION_API_URL,
  BoatApiError,
  BoatClient,
  redactBoatText,
  resolveBoatApiUrl,
} from "../boat/BoatClient.js";
import { BoatProvider, boatResource } from "../boat/BoatProvider.js";
import { boatMachineState } from "../boat/boatState.js";
import { boatMachineDriver, boatMachineKeyFailure } from "../boat/boatMachineDriver.js";
import { UnusableMachineKeyError } from "../provider.js";

const SANDBOX = {
  id: "bx_23456789",
  name: "Build host",
  state: "idle",
  type: "default",
  ip: "203.0.113.10",
  archiveAfter: "2026-11-14T13:00:00Z",
  ttlSeconds: 7200,
  desktopAvailable: false,
  snapshotAvailable: true,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientWith(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new BoatClient({
    baseUrl: "https://boat.test/api/v1",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { client, calls, fetch };
}

const ctx = { apiKey: "boat_live_secretsecretsecret", org: "personal" };

describe("resolveBoatApiUrl", () => {
  it("always answers production in a packaged build", () => {
    expect(resolveBoatApiUrl(true, { DAINTREE_BOAT_API_URL: "http://127.0.0.1:9" })).toBe(
      BOAT_PRODUCTION_API_URL
    );
  });

  it("honours an http(s) override in development only", () => {
    expect(resolveBoatApiUrl(false, { DAINTREE_BOAT_API_URL: "http://127.0.0.1:9/api/v1/" })).toBe(
      "http://127.0.0.1:9/api/v1"
    );
    expect(resolveBoatApiUrl(false, { DAINTREE_BOAT_API_URL: "file:///etc/passwd" })).toBe(
      BOAT_PRODUCTION_API_URL
    );
    expect(resolveBoatApiUrl(false, {})).toBe(BOAT_PRODUCTION_API_URL);
    expect(
      resolveBoatApiUrl(false, { DAINTREE_BOAT_API_URL: "http://u:p@127.0.0.1:9/api/v1?mock=1#x" })
    ).toBe("http://127.0.0.1:9/api/v1");
  });
});

describe("BoatClient", () => {
  it("sends the key as a bearer token and names the billing scope on every request", async () => {
    const { client, calls } = clientWith([jsonResponse(200, { ok: true, sandbox: SANDBOX })]);
    await client.getSandbox(ctx, "bx_23456789");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://boat.test/api/v1/sandboxes/bx_23456789");
    expect(headers.Authorization).toBe(`Bearer ${ctx.apiKey}`);
    expect(headers["X-Boat-Org"]).toBe("personal");
    expect(calls[0].init.redirect).toBe("error");
  });

  it("refuses an id that isn't a sandbox id before any request", async () => {
    const { client, fetch } = clientWith([]);
    await expect(client.getSandbox(ctx, "../me")).rejects.toMatchObject({
      kind: "invalid-request",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a read after a server error and a lost response", async () => {
    const { client, fetch } = clientWith([
      jsonResponse(502, { ok: false, code: "bad_gateway", message: "upstream" }),
      new TypeError("socket hang up"),
      jsonResponse(200, { ok: true, sandbox: SANDBOX }),
    ]);
    const sandbox = await client.getSandbox(ctx, "bx_23456789");
    expect(sandbox.id).toBe("bx_23456789");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never retries a resume, whose outcome a retry could double", async () => {
    const { client, fetch } = clientWith([jsonResponse(500, { message: "oops" })]);
    await expect(client.resumeSandbox(ctx, "bx_23456789")).rejects.toMatchObject({
      kind: "server",
      outcomeUnknown: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a create with the same idempotency key and body", async () => {
    const { client, calls } = clientWith([
      new TypeError("network"),
      jsonResponse(202, { ok: true, sandbox: { ...SANDBOX, state: "provisioning" } }),
    ]);
    await client.createSandbox(
      ctx,
      { name: "Build host", ttlSeconds: 7200, snapshots: true },
      "idem-1"
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("idem-1");
    }
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({
      snapshots: true,
      org: "personal",
    });
  });

  it("types an error from Boat's envelope and redacts the request's own key from it", async () => {
    const { client } = clientWith([
      jsonResponse(403, {
        ok: false,
        code: "missing_scope",
        message: `key ${ctx.apiKey} lacks sandbox.create`,
        error: { code: "missing_scope", message: `key ${ctx.apiKey} lacks sandbox.create` },
        requestId: "req_1",
      }),
    ]);
    const error = await client.limits(ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    expect(error).toMatchObject({ kind: "forbidden", code: "missing_scope", requestId: "req_1" });
    expect((error as Error).message).toBe("key [redacted] lacks sandbox.create");
  });

  it("sends nothing for a request already cancelled", async () => {
    const { client, fetch } = clientWith([]);
    const abort = new AbortController();
    abort.abort();
    await expect(
      client.resumeSandbox({ ...ctx, signal: abort.signal }, "bx_23456789")
    ).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves the unscoped account calls without a billing scope", async () => {
    const { client, calls } = clientWith([
      jsonResponse(200, { ok: true, user: { login: "octocat" } }),
      jsonResponse(200, { ok: true, orgs: [] }),
    ]);
    await client.me({ apiKey: ctx.apiKey, org: "" });
    await client.orgs({ apiKey: ctx.apiKey });
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)["X-Boat-Org"]).toBeUndefined();
    }
  });

  it("fails rather than return a list it had to cut short", async () => {
    const page = (cursor: string) =>
      jsonResponse(200, { sandboxes: [SANDBOX], pageInfo: { nextCursor: cursor, hasMore: true } });
    const { client } = clientWith([page("a"), page("b")]);
    await expect(client.listSandboxes(ctx, 2)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("follows the list cursor to the end", async () => {
    const { client, calls } = clientWith([
      jsonResponse(200, { sandboxes: [SANDBOX], pageInfo: { nextCursor: "c2", hasMore: true } }),
      jsonResponse(200, {
        sandboxes: [{ ...SANDBOX, id: "bx_3456789a" }, { id: "not-a-sandbox" }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    ]);
    const list = await client.listSandboxes(ctx);
    expect(list.map((s) => s.id)).toEqual(["bx_23456789", "bx_3456789a"]);
    expect(calls[1].url).toContain("cursor=c2");
  });

  it("refuses to send a private key as an SSH key", async () => {
    const { client, fetch } = clientWith([]);
    await expect(
      client.authorizeSshKey(ctx, "bx_23456789", "-----BEGIN OPENSSH PRIVATE KEY-----")
    ).rejects.toMatchObject({ kind: "invalid-request" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the sandbox in the delete confirmation header", async () => {
    const { client, calls } = clientWith([jsonResponse(202, { ok: true })]);
    await client.deleteSandbox(ctx, "bx_23456789");
    expect((calls[0].init.headers as Record<string, string>)["X-Ascii-Confirm-Delete"]).toBe(
      "bx_23456789"
    );
  });
});

describe("redactBoatText", () => {
  it("removes the exact key and key-shaped runs but keeps Boat's error codes", () => {
    expect(redactBoatText("got abc123secretkey-xyz back", "abc123secretkey-xyz")).toBe(
      "got [redacted] back"
    );
    expect(redactBoatText("legacy box_AbCdEfGhIjKlMnOpQrStUv1234 leaked")).toBe(
      "legacy [redacted] leaked"
    );
    expect(redactBoatText("box_running_stop_first")).toBe("box_running_stop_first");
  });

  it("removes bearer tokens and token query parameters", () => {
    expect(redactBoatText("Bearer abc.def and https://x/?token=sekrit&a=1")).toBe(
      "Bearer [redacted] and https://x/?token=[redacted]&a=1"
    );
  });
});

describe("boatMachineState", () => {
  it.each([
    ["provisioning", "starting"],
    ["provisioned", "starting"],
    ["cloning", "starting"],
    ["ready", "running"],
    ["idle", "running"],
    ["running", "running"],
    ["archiving", "stopping"],
    ["archived", "stopped"],
    ["error", "error"],
    ["cancelled", "deleted"],
    ["something-new", "unknown"],
  ])("%s → %s", (state, machine) => {
    expect(boatMachineState(state)).toBe(machine);
  });
});

describe("BoatProvider", () => {
  const credentials = {
    values: { apiKey: ctx.apiKey },
    scopeId: "personal",
    apiUrl: "https://boat.test/api/v1",
  };

  function provider(responses: Array<Response | Error>) {
    const { client, calls } = clientWith(responses);
    return { provider: new BoatProvider(() => client), calls };
  }

  it("keeps the raw state beside the machine state and reads the stop operation", () => {
    const resource = boatResource({
      ...SANDBOX,
      state: "archiving",
      stop: {
        id: "stop_1",
        status: "failing",
        requestedAt: null,
        lastAttemptAt: null,
        error: "disk save failed",
        endedAt: null,
      },
    } as never);
    expect(resource).toMatchObject({
      machine: "stopping",
      rawState: "archiving",
      stop: { status: "failing", error: "disk save failed" },
      vcpu: 4,
      memoryGB: 8,
    });
  });

  it("prefers the forwarded endpoint and pins the host key", async () => {
    const { provider: p } = provider([
      jsonResponse(200, {
        ok: true,
        machineIp: "2001:db8::1",
        sshUser: "user",
        sshEndpoint: "203.0.113.10:22001",
        hostKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl boat",
      }),
    ]);
    const access = await p.authorizeSsh(credentials, "bx_23456789", "ssh-ed25519 AAAA test");
    expect(access.endpoint).toEqual({ host: "203.0.113.10", port: 22001 });
    expect(access.hostKey).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
    );
  });

  it("fails closed when Boat returns no host key", async () => {
    const { provider: p } = provider([
      jsonResponse(200, { ok: true, machineIp: "203.0.113.10", sshUser: "user" }),
    ]);
    await expect(
      p.authorizeSsh(credentials, "bx_23456789", "ssh-ed25519 AAAA test")
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("prices sizes from the account's own rate and keeps unavailable ones with their reason", async () => {
    const { provider: p } = provider([
      jsonResponse(200, {
        ok: true,
        canStart: true,
        overagePrices: { vmHourDollars: 0.036 },
        starts: { unlimited: false, minute: { remaining: 7 }, hour: { remaining: 3 } },
        machineTypes: [
          { type: "large", available: true, reason: null },
          { type: "small", available: true, reason: null },
          { type: "xlarge", available: false, reason: "needs the $100/month plan" },
        ],
      }),
    ]);
    const catalog = await p.catalog(credentials);
    expect(catalog.machineTypes.map((t) => [t.id, t.hourlyDollars, t.available])).toEqual([
      ["small", 0.018, true],
      ["large", 0.072, true],
      ["xlarge", 0.2, false],
    ]);
    expect(catalog.machineTypes[2].reason).toBe("needs the $100/month plan");
    expect(catalog.startsRemaining).toBe(3);
  });

  it("offers personal billing when the key can't list organizations but can use it", async () => {
    const { provider: p } = provider([
      jsonResponse(200, { ok: true, user: { login: "octocat" } }),
      jsonResponse(403, { ok: false, code: "missing_scope", message: "account.read" }),
      jsonResponse(200, { ok: true, sandboxes: [] }),
    ]);
    const checked = await p.checkCredentials(credentials.values, credentials.apiUrl);
    expect(checked).toEqual({
      identity: "octocat",
      scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: false }],
    });
  });

  it("offers only the wallets an organization key can use", async () => {
    const { provider: p, calls } = provider([
      jsonResponse(200, { ok: true, user: { login: "octocat" } }),
      jsonResponse(200, {
        ok: true,
        orgs: [
          { id: "acct_1", name: "Personal", type: "personal", active: false },
          { id: "team_1", name: "Acme", type: "org", active: false },
        ],
      }),
      jsonResponse(403, { ok: false, code: "api_key_org_mismatch", message: "org key" }),
      jsonResponse(200, { ok: true, sandboxes: [] }),
    ]);
    const checked = await p.checkCredentials(credentials.values, credentials.apiUrl);
    expect(checked.scopes.map((choice) => choice.scope.id)).toEqual(["team_1"]);
    expect((calls[2].init.headers as Record<string, string>)["X-Boat-Org"]).toBe("personal");
    expect((calls[3].init.headers as Record<string, string>)["X-Boat-Org"]).toBe("team_1");
  });

  it("refuses what isn't a Boat key before asking Boat anything", async () => {
    const { provider: p, calls } = provider([]);
    for (const [values, refusal] of [
      [{}, /Paste an API key/],
      [{ apiKey: "-----BEGIN OPENSSH PRIVATE KEY-----" }, /private key/],
      [{ apiKey: "boat live key" }, /one line of letters/],
    ] as const) {
      await expect(p.checkCredentials(values, credentials.apiUrl)).rejects.toMatchObject({
        code: "VALIDATION",
        userMessage: expect.stringMatching(refusal),
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("signs every request with the API key from the account's own set", async () => {
    const { provider: p, calls } = provider([
      jsonResponse(200, { ok: true, user: { login: "octocat" } }),
      jsonResponse(200, { ok: true, orgs: [] }),
      jsonResponse(200, { ok: true, sandboxes: [] }),
      jsonResponse(200, { ok: true, sandboxes: [] }),
    ]);
    await p.checkCredentials({ apiKey: "boat_live_checkedcheckedchecked" }, credentials.apiUrl);
    await p.list({ ...credentials, values: { apiKey: "boat_live_storedstoredstored" } });
    const signed = calls.map((call) => (call.init.headers as Record<string, string>).Authorization);
    expect(signed).toEqual([
      "Bearer boat_live_checkedcheckedchecked",
      "Bearer boat_live_checkedcheckedchecked",
      "Bearer boat_live_checkedcheckedchecked",
      "Bearer boat_live_storedstoredstored",
    ]);
  });

  it("sends no request for an account whose set holds no API key", async () => {
    const { provider: p, calls } = provider([]);
    await expect(p.list({ ...credentials, values: {} })).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(calls).toHaveLength(0);
  });

  it("refuses a key that can use no wallet at all", async () => {
    const { provider: p } = provider([
      jsonResponse(200, { ok: true, user: { login: "octocat" } }),
      jsonResponse(403, { ok: false, code: "missing_scope", message: "account.read" }),
      jsonResponse(403, { ok: false, code: "api_key_org_mismatch", message: "org key" }),
    ]);
    await expect(p.checkCredentials(credentials.values, credentials.apiUrl)).rejects.toMatchObject({
      kind: "forbidden",
      code: "api_key_org_mismatch",
    });
  });

  it("creates durable machines only: snapshots on, private in an organization", async () => {
    const { provider: p, calls } = provider([
      jsonResponse(202, { ok: true, sandbox: { ...SANDBOX, state: "provisioning" } }),
    ]);
    await p.create(
      { ...credentials, scopeId: "team_1" },
      {
        name: "Build host",
        machineType: "large",
        lifetimeSeconds: 7200,
        provisioning: { location: null, image: null, network: null },
        labels: { daintree: "1" },
        idempotencyKey: "k",
        publicKey: null,
      }
    );
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      snapshots: true,
      visibility: "private",
      type: "large",
      ttlSeconds: 7200,
      org: "team_1",
    });
    // Boat takes no region, image or network: nothing about them reaches its API.
    for (const key of ["provisioning", "location", "region", "image", "network"]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  // The renderer's Boat fixture (cloudProviderFixtures.ts) mirrors this: a
  // stop ends compute billing and Daintree can delete, so Boat's Stop and
  // Remove copy carries no billing caveat and keeps its Delete (#17346).
  it("declares that a stopped machine stops billing and that Daintree can delete it", () => {
    const { capabilities } = new BoatProvider(() => {
      throw new Error("unused");
    }).info("darwin");
    expect(capabilities.persistence.stoppedComputeBilled).toBe(false);
    expect(capabilities.deletion).toBe(true);
  });

  it("describes errors in terms a person can act on", () => {
    const p = new BoatProvider(() => {
      throw new Error("unused");
    });
    expect(p.describeError(new BoatApiError("unauthorized", "no", 401, null, null)).code).toBe(
      "credential-invalid"
    );
    expect(
      p.describeError(new BoatApiError("conflict", "x", 409, "snapshot_data_expired", null)).code
    ).toBe("data-expired");
    expect(
      p.describeError(new BoatApiError("forbidden", "x", 403, "api_key_expired", null)).code
    ).toBe("credential-invalid");
    expect(p.describeError(new BoatApiError("forbidden", "x", 403, "missing", null)).code).toBe(
      "permission"
    );
    expect(p.describeError(new BoatApiError("network", "x", null, null, null)).code).toBe(
      "provider-unreachable"
    );
  });
});

describe("machine keys (#17361)", () => {
  const credentials = {
    values: { apiKey: ctx.apiKey },
    scopeId: "personal",
    apiUrl: "https://boat.test/api/v1",
  };
  const expiresAt = "2026-12-18T09:00:00Z";
  const created = (scope: Record<string, unknown> | undefined) =>
    jsonResponse(201, {
      ok: true,
      apiKey: { id: "sak_42", name: "daintree-mk_1", expiresAt, ...(scope ? { scope } : {}) },
      secret: "boat_live_machinesecretvalue",
      apiKeys: [],
    });

  it("asks for a key that can only read, renew and stop the one machine, sent once", async () => {
    const { client, calls } = clientWith([
      created({
        actions: ["sandbox.read", "sandbox.update", "sandbox.stop"],
        sandboxes: ["bx_23456789"],
      }),
    ]);
    const issued = await new BoatProvider(() => client).machineKeys.issue(
      credentials,
      "bx_23456789",
      { name: "daintree-mk_1", ttlDays: 30 }
    );
    expect(calls[0].url).toBe("https://boat.test/api/v1/api-keys/scoped");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: "daintree-mk_1",
      ttl: "30d",
      actions: ["sandbox.read", "sandbox.update", "sandbox.stop"],
      sandboxIds: ["bx_23456789"],
    });
    expect(issued).toEqual({
      keyId: "sak_42",
      secret: "boat_live_machinesecretvalue",
      expiresAt: Date.parse(expiresAt),
    });

    const lost = clientWith([new TypeError("socket hang up")]);
    await expect(
      lost.client.createScopedKey(ctx, {
        name: "x",
        ttl: "30d",
        actions: ["sandbox.read"],
        sandboxIds: ["bx_23456789"],
      })
    ).rejects.toMatchObject({ kind: "network" });
    expect(lost.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a key whose answer doesn't show exactly this machine and these actions", async () => {
    const asked = ["sandbox.read", "sandbox.update", "sandbox.stop"];
    for (const scope of [
      { actions: ["*"], sandboxes: ["bx_23456789"] },
      { actions: asked, sandboxes: "*" },
      { actions: asked, sandboxes: ["bx_23456789", "bx_otherother"] },
      { actions: asked, sandboxes: ["bx_otherother"] },
      { actions: asked, sandboxes: ["bx_23456789"], environments: ["env_1"] },
      // One that can't renew or stop would leave the machine looking kept.
      { actions: ["sandbox.read"], sandboxes: ["bx_23456789"] },
      // No evidence at all of what it reaches.
      { actions: asked },
      undefined,
    ]) {
      const { client, calls } = clientWith([created(scope as Record<string, unknown>)]);
      const refused = await new BoatProvider(() => client).machineKeys
        .issue(credentials, "bx_23456789", { name: "daintree-mk_1", ttlDays: 30 })
        .catch((error: unknown) => error);
      // Revoked by the caller, through its record, by this id.
      expect(refused).toBeInstanceOf(UnusableMachineKeyError);
      expect((refused as UnusableMachineKeyError).keyId).toBe("sak_42");
      expect(calls).toHaveLength(1);
    }
  });

  it("keeps the id of a key whose scope doesn't read, so it can still be revoked and found", async () => {
    const { client } = clientWith([
      jsonResponse(201, {
        ok: true,
        apiKey: { id: "sak_42", name: "daintree-mk_1", expiresAt, scope: null },
        secret: "boat_live_machinesecretvalue",
      }),
      jsonResponse(200, {
        ok: true,
        apiKeys: [{ id: "sak_42", name: "daintree-mk_1", scope: "everything", expiresAt: 5 }],
      }),
    ]);
    const keys = new BoatProvider(() => client).machineKeys;
    const refused = await keys
      .issue(credentials, "bx_23456789", { name: "daintree-mk_1", ttlDays: 30 })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ keyId: "sak_42", expiresAt: Date.parse(expiresAt) });
    expect(await keys.findByName(credentials, "daintree-mk_1")).toEqual(["sak_42"]);
  });

  it("tells key creation switched off apart from a machine shortage", () => {
    const provider = new BoatProvider(() => {
      throw new Error("unused");
    });
    expect(
      provider.describeError(
        new BoatApiError("no-capacity", "off", 503, "scoped_api_key_creation_disabled", null)
      )
    ).toMatchObject({ code: "unsupported", message: expect.stringMatching(/isn't issuing/) });
    expect(
      provider.describeError(new BoatApiError("no-capacity", "busy", 503, null, null)).code
    ).toBe("capacity");
  });

  it("reads a bare error code, such as key creation being switched off", async () => {
    const { client } = clientWith([
      jsonResponse(503, {
        error: "scoped_api_key_creation_disabled",
        message: "Scoped keys aren't on yet",
        scopedCreationEnabled: false,
      }),
    ]);
    await expect(
      client.createScopedKey(ctx, {
        name: "x",
        ttl: "30d",
        actions: ["sandbox.read"],
        sandboxIds: ["bx_23456789"],
      })
    ).rejects.toMatchObject({
      code: "scoped_api_key_creation_disabled",
      message: "Scoped keys aren't on yet",
    });
  });

  it("takes a key already gone as revoked, and finds keys by their exact name", async () => {
    const { client, calls } = clientWith([
      jsonResponse(404, { error: { code: "not_found", message: "no such key" } }),
      jsonResponse(200, {
        ok: true,
        apiKeys: [
          { id: "sak_1", name: "daintree-mk_1" },
          { id: "sak_2", name: "daintree-mk_10" },
          { name: "no id" },
        ],
      }),
    ]);
    const keys = new BoatProvider(() => client).machineKeys;
    await expect(keys.revoke(credentials, "sak_1")).resolves.toBeUndefined();
    expect(await keys.findByName(credentials, "daintree-mk_1")).toEqual(["sak_1"]);
    expect(calls[1].url).toBe("https://boat.test/api/v1/api-keys");
  });

  it("sends the machine's own stop once, where a person's stop retries", async () => {
    const once = clientWith([jsonResponse(500, { message: "oops" })]);
    const driver = boatMachineDriver(
      {
        grantId: "mk_1",
        provider: "boat",
        apiUrl: "https://boat.test/api/v1",
        scope: "personal",
        resourceId: "bx_23456789",
        secret: "boat_live_machinesecretvalue",
        expiresAt: Date.parse(expiresAt),
      },
      once.client
    );
    await expect(driver.stop(new AbortController().signal)).rejects.toMatchObject({
      kind: "server",
    });
    expect(once.fetch).toHaveBeenCalledTimes(1);
    expect((once.calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer boat_live_machinesecretvalue"
    );

    const person = clientWith([
      jsonResponse(500, { message: "oops" }),
      jsonResponse(202, { ok: true, sandbox: { ...SANDBOX, state: "archiving" } }),
    ]);
    await person.client.stopSandbox(ctx, "bx_23456789");
    expect(person.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends an idle stop from the desktop once, where a person's stop retries (#17924)", async () => {
    const idle = clientWith([jsonResponse(429, { message: "slow down" })]);
    const provider = new BoatProvider(() => idle.client);
    await expect(
      provider.stop(credentials, "bx_23456789", { once: true })
    ).rejects.toMatchObject({ kind: "rate-limited" });
    expect(idle.fetch).toHaveBeenCalledTimes(1);

    const person = clientWith([
      jsonResponse(500, { message: "oops" }),
      jsonResponse(202, { ok: true, sandbox: { ...SANDBOX, state: "archiving" } }),
    ]);
    await new BoatProvider(() => person.client).stop(credentials, "bx_23456789");
    expect(person.fetch).toHaveBeenCalledTimes(2);
  });

  it("drops the machine's key on a refusal, and retries anything that may pass", () => {
    expect(
      boatMachineKeyFailure(new BoatApiError("unauthorized", "no", 401, null, null)).kind
    ).toBe("lost");
    expect(
      boatMachineKeyFailure(new BoatApiError("forbidden", "no", 403, "api_key_expired", null))
    ).toMatchObject({ kind: "lost", problem: expect.stringMatching(/expired/) });
    expect(
      boatMachineKeyFailure(
        new BoatApiError("forbidden", "no", 403, "api_key_sandbox_forbidden", null)
      )
    ).toMatchObject({ kind: "lost", problem: expect.not.stringMatching(/expired/) });
    expect(boatMachineKeyFailure(new BoatApiError("not-found", "gone", 404, null, null)).kind).toBe(
      "lost"
    );
    for (const kind of ["network", "timeout", "server", "rate-limited", "conflict"] as const) {
      expect(boatMachineKeyFailure(new BoatApiError(kind, "x", null, null, null)).kind).toBe(
        "retry"
      );
    }
  });
});
