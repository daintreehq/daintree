import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DIGITALOCEAN_PRODUCTION_API_URL,
  DigitalOceanApiError,
  DigitalOceanClient,
  redactDigitalOceanText,
  resolveDigitalOceanApiUrl,
} from "../digitalocean/DigitalOceanClient.js";
import {
  DigitalOceanProvider,
  dropletHostname,
  dropletResource,
  labelFilterToTag,
  labelsToTags,
  tagsToLabels,
} from "../digitalocean/DigitalOceanProvider.js";
import { digitalOceanMachineState } from "../digitalocean/digitalOceanState.js";
import {
  DROPLET_HOST_PACKAGES,
  dropletUserData,
  md5Fingerprint,
  parsePublicKey,
} from "../digitalocean/digitalOceanUserData.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import type { ProviderCredentials } from "../provider.js";

/** A real key and the fingerprint `ssh-keygen -E md5 -lf` printed for it. */
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPipFLxeJWDGZEkf8RGwEY+jWS/A0DMFY+m1WQAOvzML daintree-acct";
const KEY_BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAIPipFLxeJWDGZEkf8RGwEY+jWS/A0DMFY+m1WQAOvzML";
const KEY_MD5 = "07:2f:18:c0:de:5e:37:2b:66:70:0d:22:a8:d1:56:08";

const TOKEN = "dop_v1_unit_test_token_not_a_real_one";

const DROPLET = {
  id: 3164444,
  name: "build-host",
  memory: 4096,
  vcpus: 2,
  disk: 80,
  locked: false,
  status: "active",
  created_at: "2026-11-14T13:00:00Z",
  size_slug: "s-2vcpu-4gb",
  region: { slug: "nyc3", name: "New York 3" },
  networks: {
    v4: [
      { ip_address: "10.10.0.5", type: "private" },
      { ip_address: "203.0.113.10", type: "public" },
    ],
    v6: [],
  },
  tags: ["daintree:1", "daintree-binding:cb_abcdefgh", "team-web"],
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Responder = Response | Error | ((url: URL, init: RequestInit) => Response);

function clientWith(responses: Responder[]) {
  const calls: Array<{ url: URL; init: RequestInit; body: unknown }> = [];
  const fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const parsed = new URL(String(url));
    calls.push({
      url: parsed,
      init: init ?? {},
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`no response queued for ${init?.method} ${parsed.pathname}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(parsed, init ?? {}) : next;
  });
  const client = new DigitalOceanClient({
    baseUrl: "https://do.test/v2",
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async () => {},
  });
  return { client, calls, fetch };
}

const ctx = { token: TOKEN };

function providerWith(responses: Responder[]) {
  const harness = clientWith(responses);
  const provider = new DigitalOceanProvider(
    () => harness.client,
    async () => {}
  );
  const credentials: ProviderCredentials = {
    apiKey: TOKEN,
    scopeId: "team-uuid",
    apiUrl: "https://do.test/v2",
  };
  return { ...harness, provider, credentials };
}

const ACCOUNT = {
  account: {
    uuid: "acct-uuid",
    email: "person@example.com",
    status: "active",
    droplet_limit: 25,
    team: { uuid: "team-uuid", name: "Web team" },
  },
};

describe("resolveDigitalOceanApiUrl", () => {
  it("always answers production in a packaged build", () => {
    expect(
      resolveDigitalOceanApiUrl(true, { DAINTREE_DIGITALOCEAN_API_URL: "http://127.0.0.1:9" })
    ).toBe(DIGITALOCEAN_PRODUCTION_API_URL);
  });

  it("honours an http(s) override in development only, as origin and path", () => {
    expect(
      resolveDigitalOceanApiUrl(false, {
        DAINTREE_DIGITALOCEAN_API_URL: "http://u:p@127.0.0.1:9/v2/?x=1#y",
      })
    ).toBe("http://127.0.0.1:9/v2");
    expect(
      resolveDigitalOceanApiUrl(false, { DAINTREE_DIGITALOCEAN_API_URL: "file:///etc/passwd" })
    ).toBe(DIGITALOCEAN_PRODUCTION_API_URL);
    expect(resolveDigitalOceanApiUrl(false, {})).toBe(DIGITALOCEAN_PRODUCTION_API_URL);
  });
});

describe("DigitalOceanClient", () => {
  it("sends only the token as a bearer, and no scope", async () => {
    const { client, calls } = clientWith([jsonResponse(200, { droplet: DROPLET })]);
    await client.getDroplet(ctx, "3164444");
    expect(calls[0]!.url.href).toBe("https://do.test/v2/droplets/3164444");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(headers).sort()).toEqual(["Accept", "Authorization"]);
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("refuses an id that isn't a Droplet id before any request", async () => {
    const { client, fetch } = clientWith([]);
    await expect(client.getDroplet(ctx, "../account")).rejects.toMatchObject({
      kind: "invalid-request",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a read after a server error and a lost response", async () => {
    const { client, fetch } = clientWith([
      jsonResponse(500, { id: "server_error", message: "oops" }),
      new TypeError("socket hang up"),
      jsonResponse(200, { droplet: DROPLET }),
    ]);
    expect((await client.getDroplet(ctx, "3164444")).id).toBe(3164444);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sends a create once, even when its answer is lost", async () => {
    const { client, fetch } = clientWith([new TypeError("socket hang up")]);
    const body = {
      name: "build",
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: [1],
      tags: [],
      user_data: "#!/bin/sh\n",
    };
    await expect(client.createDroplet(ctx, body)).rejects.toMatchObject({ kind: "network" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("types an error from DigitalOcean's envelope and redacts the token from it", async () => {
    const { client } = clientWith([
      jsonResponse(422, {
        id: "unprocessable_entity",
        message: `Size is not available in this region (token ${TOKEN}).`,
        request_id: "req-1",
      }),
    ]);
    const error = (await client
      .dropletAction(ctx, "3164444", { type: "power_on" })
      .catch((e: unknown) => e)) as DigitalOceanApiError;
    expect(error).toBeInstanceOf(DigitalOceanApiError);
    expect(error).toMatchObject({
      kind: "unprocessable",
      status: 422,
      code: "unprocessable_entity",
      requestId: "req-1",
    });
    expect(error.message).toContain("Size is not available in this region");
    expect(error.message).not.toContain(TOKEN);
  });

  it("waits out a rate limit as DigitalOcean asks, then answers", async () => {
    const sleeps: number[] = [];
    const responses: Responder[] = [
      jsonResponse(429, { id: "too_many_requests", message: "slow down" }, { "retry-after": "2" }),
      jsonResponse(200, ACCOUNT),
    ];
    const fetch = vi.fn(async () => responses.shift() as Response);
    const client = new DigitalOceanClient({
      baseUrl: "https://do.test/v2",
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect((await client.account(ctx)).uuid).toBe("acct-uuid");
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("counts pages itself, keeps the tag filter, and stops when there's no next page", async () => {
    const page = (n: number, next: boolean) =>
      jsonResponse(200, {
        droplets: [{ ...DROPLET, id: n }],
        links: next ? { pages: { next: "https://elsewhere.example/v2/droplets?page=9" } } : {},
        meta: { total: 2 },
      });
    const { client, calls } = clientWith([page(1, true), page(2, false)]);
    const droplets = await client.listDroplets(ctx, "daintree-binding:cb_abcdefgh");
    expect(droplets.map((d) => d.id)).toEqual([1, 2]);
    expect(calls.map((c) => c.url.host)).toEqual(["do.test", "do.test"]);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(
      calls.every((c) => c.url.searchParams.get("tag_name") === "daintree-binding:cb_abcdefgh")
    ).toBe(true);
  });

  it("fails a tagged lookup on an entry it can't read, but skips one in an untagged list", async () => {
    const odd = { droplets: [DROPLET, { id: "not-a-number" }], links: {} };
    const tagged = clientWith([jsonResponse(200, odd)]);
    await expect(tagged.client.listDroplets(ctx, "daintree:1")).rejects.toMatchObject({
      kind: "bad-response",
    });
    const all = clientWith([jsonResponse(200, odd)]);
    expect(await all.client.listDroplets(ctx)).toHaveLength(1);
  });

  it("stops reading an answer that runs past its size cap", async () => {
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const { client } = clientWith([new Response(huge, { status: 200 })]);
    await expect(client.account(ctx)).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("reads a missing account key as none, and refuses to send a private key", async () => {
    const { client, fetch } = clientWith([jsonResponse(404, { id: "not_found", message: "nope" })]);
    expect(await client.findSshKey(ctx, KEY_MD5)).toBeNull();
    expect(fetch.mock.calls[0]![0].toString()).toBe(`https://do.test/v2/account/keys/${KEY_MD5}`);
    await expect(
      client.createSshKey(ctx, { name: "x", public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" })
    ).rejects.toMatchObject({ kind: "invalid-request" });
  });
});

describe("redactDigitalOceanText", () => {
  it("removes token-shaped runs and bearer values", () => {
    const text = redactDigitalOceanText(
      `Authorization: Bearer abc.def and doo_v1_${"a".repeat(64)} and ?access_token=zzz`
    );
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("doo_v1_");
    expect(text).not.toContain("zzz");
  });
});

describe("digitalOceanMachineState", () => {
  it("reads a Droplet's status as a machine state", () => {
    expect(["new", "active", "off", "archive", "weird"].map(digitalOceanMachineState)).toEqual([
      "starting",
      "running",
      "stopped",
      "error",
      "unknown",
    ]);
  });
});

describe("tags, labels and hostnames", () => {
  it("keeps labels as key:value tags and reads them back", () => {
    const tags = labelsToTags({ daintree: "1", "daintree-binding": "cb_abcdefgh" });
    expect(tags).toEqual(["daintree:1", "daintree-binding:cb_abcdefgh"]);
    expect(tagsToLabels([...tags, "unrelated"])).toEqual({
      daintree: "1",
      "daintree-binding": "cb_abcdefgh",
    });
    expect(labelFilterToTag("daintree-binding=cb_abcdefgh")).toBe("daintree-binding:cb_abcdefgh");
  });

  it("refuses a label that can't be a tag rather than changing it", () => {
    expect(() => labelsToTags({ owner: "a b" })).toThrow(DigitalOceanApiError);
    expect(labelFilterToTag("no-equals")).toBeNull();
    expect(labelFilterToTag("k=v w")).toBeNull();
  });

  it("makes a single DNS label of any name, with a fallback when nothing survives", () => {
    expect(dropletHostname("Build host (main)", "x")).toBe("build-host-main");
    expect(dropletHostname("api.example.com", "x")).toBe("api-example-com");
    expect(dropletHostname("構築", "daintree-cb-abc")).toBe("daintree-cb-abc");
    const long = dropletHostname(`${"a".repeat(62)}-b`, "x");
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long.endsWith("-")).toBe(false);
  });
});

describe("dropletResource", () => {
  it("normalises a Droplet: string id, GB memory, labels from tags, nothing it doesn't report", () => {
    expect(dropletResource(DROPLET)).toMatchObject({
      resourceId: "3164444",
      name: "build-host",
      machine: "running",
      rawState: "active",
      machineType: "s-2vcpu-4gb",
      vcpu: 2,
      memoryGB: 4,
      autoStopAt: null,
      lifetimeSeconds: null,
      stop: null,
      dataExpired: false,
      restricted: false,
      labels: { daintree: "1", "daintree-binding": "cb_abcdefgh" },
    });
  });

  it("reads an active Droplet with no public address yet as still starting", () => {
    expect(dropletResource({ ...DROPLET, networks: { v4: [], v6: [] } }).machine).toBe("starting");
  });

  it("reads a shutdown under way as stopping, and a power-on under way as starting", () => {
    const action = (type: string) => ({
      id: 7,
      status: "in-progress",
      type,
      started_at: null,
      completed_at: null,
    });
    expect(dropletResource({ ...DROPLET, locked: true }, action("shutdown"))).toMatchObject({
      machine: "stopping",
      stop: { id: "7", status: "pending", error: null },
    });
    expect(
      dropletResource({ ...DROPLET, status: "off", locked: true }, action("power_on")).machine
    ).toBe("starting");
  });
});

describe("DigitalOceanProvider", () => {
  it("meets the registry's contract as a built-in", () => {
    const { provider } = providerWith([]);
    const registry = new CloudProviderRegistry();
    expect(() =>
      registry.register(provider, { owner: { kind: "built-in" }, apiUrl: "https://do.test/v2" })
    ).not.toThrow();
    const { capabilities } = provider.info("darwin");
    expect(capabilities).toMatchObject({
      lifetime: { kind: "none" },
      sshTrust: "confirm-on-first-connect",
      provisioning: {
        location: "required",
        image: "required",
        network: "none",
        sshKey: "at-create",
      },
      deletion: true,
      persistence: { retentionDays: null, stoppedComputeBilled: true },
    });
    expect(capabilities.persistence.stoppedBilling).toMatch(/in full/);
    expect(provider.info("win32").unsupportedReason).not.toBeNull();
  });

  it("checks a token: its team is the one scope, and it must be able to read Droplets", async () => {
    const { provider, calls } = providerWith([
      jsonResponse(200, ACCOUNT),
      jsonResponse(200, { droplets: [], links: {} }),
    ]);
    expect(await provider.checkKey(TOKEN, "https://do.test/v2")).toEqual({
      identity: "person@example.com",
      scopes: [
        { scope: { kind: "organization", id: "team-uuid", name: "Web team" }, active: true },
      ],
    });
    expect(calls[1]!.url.searchParams.get("per_page")).toBe("1");
  });

  it("offers a token with no team its own account", async () => {
    const { provider } = providerWith([
      jsonResponse(200, { account: { ...ACCOUNT.account, team: undefined } }),
      jsonResponse(200, { droplets: [], links: {} }),
    ]);
    const checked = await provider.checkKey(TOKEN, "https://do.test/v2");
    expect(checked.scopes[0]!.scope).toEqual({
      kind: "personal",
      id: "acct-uuid",
      name: "Personal",
    });
  });

  it("refuses a token that can sign in but not read Droplets", async () => {
    const { provider } = providerWith([
      jsonResponse(200, ACCOUNT),
      jsonResponse(403, { id: "forbidden", message: "You are not authorized" }),
    ]);
    const error = await provider.checkKey(TOKEN, "https://do.test/v2").catch((e: unknown) => e);
    expect(provider.describeError(error).code).toBe("permission");
  });

  it("calls a token that now belongs to another team invalid for this account", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(200, {
        account: { ...ACCOUNT.account, team: { uuid: "other", name: "Other team" } },
      }),
    ]);
    const error = await provider.validate(credentials).catch((e: unknown) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "credential-invalid",
      message: expect.stringContaining("Other team"),
    });
  });

  it("offers only regions, images and sizes a Host can be made with", async () => {
    const image = (slug: string, distribution: string, regions = ["nyc3", "ams3"]) => ({
      id: slug.length,
      name: slug,
      distribution,
      slug,
      regions,
      status: "available",
      public: true,
    });
    const size = (slug: string, memory: number, price: number, extra: object = {}) => ({
      slug,
      memory,
      vcpus: 2,
      disk: 50,
      price_hourly: price,
      regions: ["nyc3", "ams3"],
      available: true,
      description: "Basic",
      ...extra,
    });
    const { provider, credentials } = providerWith([
      jsonResponse(200, { ...ACCOUNT, account: { ...ACCOUNT.account, status: "locked" } }),
      jsonResponse(200, {
        regions: [
          { slug: "nyc3", name: "New York 3", sizes: [], available: true },
          { slug: "ams3", name: "Amsterdam 3", sizes: [], available: true },
          { slug: "nyc2", name: "New York 2", sizes: [], available: false },
          { slug: "syd1", name: "Sydney 1", sizes: [], available: true },
        ],
        links: {},
      }),
      jsonResponse(200, {
        sizes: [
          size("s-2vcpu-4gb", 4096, 0.03571),
          size("s-1vcpu-2gb", 2048, 0.01786),
          size("s-1vcpu-1gb", 1024, 0.00893),
          size("gpu-h100x1-80gb", 245760, 3.39),
          size("s-8vcpu-16gb", 16384, 0.14286, { available: false }),
        ],
        links: {},
      }),
      jsonResponse(200, {
        images: [
          image("ubuntu-22-04-x64", "Ubuntu"),
          image("ubuntu-24-04-x64", "Ubuntu", ["nyc3", "syd1"]),
          image("ubuntu-25-04-x64", "Ubuntu"),
          image("debian-12-x64", "Debian"),
          image("debian-11-x64", "Debian"),
          image("fedora-42-x64", "Fedora"),
          { ...image("ubuntu-20-04-x64", "Ubuntu"), status: "retired" },
        ],
        links: {},
      }),
    ]);
    const catalog = await provider.catalog(credentials);
    expect(catalog.canStart).toBe(false);
    expect(
      catalog.machineTypes.map((type) => [type.id, type.memoryGB, type.hourlyDollars])
    ).toEqual([
      ["s-1vcpu-2gb", 2, 0.01786],
      ["s-2vcpu-4gb", 4, 0.03571],
    ]);
    const regions = catalog.provisioning!.location!;
    // Sydney has an image but no offered size; New York 2 takes no new Droplets.
    expect(regions.choices.map((choice) => choice.id)).toEqual(["ams3", "nyc3"]);
    expect(regions.defaultId).toBe("nyc3");
    const images = catalog.provisioning!.image!;
    expect(images.choices.map((choice) => choice.id).sort()).toEqual([
      "debian-12-x64",
      "ubuntu-22-04-x64",
      "ubuntu-24-04-x64",
    ]);
    expect(images.defaultId).toBe("ubuntu-24-04-x64");
    expect(images.choices.find((choice) => choice.id === "ubuntu-24-04-x64")!.locations).toEqual([
      "nyc3",
    ]);
  });

  it("creates a Droplet with the account key, the binding's tags and its first-boot script", async () => {
    const { provider, credentials, calls } = providerWith([
      jsonResponse(404, { id: "not_found", message: "not found" }),
      jsonResponse(201, { ssh_key: { id: 512190, fingerprint: KEY_MD5, name: "Daintree" } }),
      jsonResponse(202, { droplet: { ...DROPLET, status: "new", networks: { v4: [], v6: [] } } }),
    ]);
    const resource = await provider.create(credentials, {
      name: "Build host",
      machineType: "s-2vcpu-4gb",
      lifetimeSeconds: null,
      provisioning: { location: "nyc3", image: "ubuntu-24-04-x64", network: null },
      labels: { daintree: "1", "daintree-binding": "cb_abcdefgh" },
      idempotencyKey: "never-sent",
      publicKey: PUBLIC_KEY,
    });
    expect(resource).toMatchObject({ resourceId: "3164444", machine: "starting" });
    expect(calls.map((c) => `${c.init.method} ${c.url.pathname}`)).toEqual([
      `GET /v2/account/keys/${KEY_MD5}`,
      "POST /v2/account/keys",
      "POST /v2/droplets",
    ]);
    // The comment names this device's account: DigitalOcean gets the key alone.
    expect(calls[1]!.body).toEqual({
      name: "Daintree a8:d1:56:08",
      public_key: `ssh-ed25519 ${KEY_BLOB}`,
    });
    const body = calls[2]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "build-host",
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      ssh_keys: [512190],
      tags: ["daintree:1", "daintree-binding:cb_abcdefgh"],
    });
    expect(body.user_data).toContain(KEY_BLOB);
    expect(JSON.stringify(calls.map((c) => c.body))).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("never-sent");
    expect(JSON.stringify(body)).not.toContain("daintree-acct");
  });

  it("reuses a key the account has, and one another create registered first", async () => {
    const known = providerWith([
      jsonResponse(200, { ssh_key: { id: 9, fingerprint: KEY_MD5 } }),
      jsonResponse(202, { droplet: DROPLET }),
    ]);
    const request = {
      name: "build",
      machineType: "s-2vcpu-4gb",
      lifetimeSeconds: null,
      provisioning: { location: "nyc3", image: "ubuntu-24-04-x64", network: null },
      labels: {},
      idempotencyKey: "k",
      publicKey: PUBLIC_KEY,
    };
    await known.provider.create(known.credentials, request);
    expect((known.calls[1]!.body as { ssh_keys: number[] }).ssh_keys).toEqual([9]);

    const raced = providerWith([
      jsonResponse(404, { id: "not_found", message: "not found" }),
      jsonResponse(422, { id: "unprocessable_entity", message: "SSH Key is already in use" }),
      jsonResponse(200, { ssh_key: { id: 10, fingerprint: KEY_MD5 } }),
      jsonResponse(202, { droplet: DROPLET }),
    ]);
    await raced.provider.create(raced.credentials, request);
    expect((raced.calls[3]!.body as { ssh_keys: number[] }).ssh_keys).toEqual([10]);
  });

  it("asks for nothing when a create is missing its region, image or key", async () => {
    const { provider, credentials, fetch } = providerWith([]);
    const base = {
      name: "build",
      machineType: "s-2vcpu-4gb",
      lifetimeSeconds: null,
      labels: {},
      idempotencyKey: "k",
    };
    await expect(
      provider.create(credentials, {
        ...base,
        provisioning: { location: null, image: "ubuntu-24-04-x64", network: null },
        publicKey: PUBLIC_KEY,
      })
    ).rejects.toThrow(DigitalOceanApiError);
    await expect(
      provider.create(credentials, {
        ...base,
        provisioning: { location: "nyc3", image: "ubuntu-24-04-x64", network: null },
        publicKey: null,
      })
    ).rejects.toThrow(DigitalOceanApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls a create DigitalOcean turned down a refusal, which nothing was made by", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(200, { ssh_key: { id: 9, fingerprint: KEY_MD5 } }),
      jsonResponse(422, {
        id: "unprocessable_entity",
        message: "Size is not available in this region.",
      }),
    ]);
    const error = await provider
      .create(credentials, {
        name: "build",
        machineType: "s-2vcpu-4gb",
        lifetimeSeconds: null,
        provisioning: { location: "sgp1", image: "ubuntu-24-04-x64", network: null },
        labels: {},
        idempotencyKey: "k",
        publicKey: PUBLIC_KEY,
      })
      .catch((e: unknown) => e);
    expect(provider.describeError(error)).toMatchObject({
      code: "refused",
      message: expect.stringContaining("Size is not available in this region"),
    });
  });

  it("looks a lost create up by its binding tag", async () => {
    const { provider, credentials, calls } = providerWith([
      jsonResponse(200, { droplets: [DROPLET], links: {} }),
    ]);
    const found = await provider.list(credentials, { label: "daintree-binding=cb_abcdefgh" });
    expect(calls[0]!.url.searchParams.get("tag_name")).toBe("daintree-binding:cb_abcdefgh");
    expect(found[0]!.labels["daintree-binding"]).toBe("cb_abcdefgh");
  });

  it("asks which action holds a locked Droplet, and only then", async () => {
    const free = providerWith([jsonResponse(200, { droplet: DROPLET })]);
    await free.provider.inspect(free.credentials, "3164444");
    expect(free.fetch).toHaveBeenCalledTimes(1);

    const locked = providerWith([
      jsonResponse(200, { droplet: { ...DROPLET, locked: true } }),
      jsonResponse(200, {
        actions: [
          { id: 2, status: "in-progress", type: "shutdown" },
          { id: 1, status: "completed", type: "power_on" },
        ],
        links: {},
      }),
    ]);
    expect((await locked.provider.inspect(locked.credentials, "3164444")).machine).toBe("stopping");
  });

  it("stops with a graceful shutdown, following it until DigitalOcean says it's done", async () => {
    const action = (status: string) => ({ action: { id: 44, status, type: "shutdown" } });
    const { provider, credentials, calls } = providerWith([
      jsonResponse(201, action("in-progress")),
      jsonResponse(200, action("in-progress")),
      jsonResponse(200, action("completed")),
      jsonResponse(200, { droplet: { ...DROPLET, status: "off" } }),
    ]);
    const resource = await provider.stop(credentials, "3164444");
    expect(calls[0]!.body).toEqual({ type: "shutdown" });
    expect(calls.map((c) => c.url.pathname)).toContain("/v2/actions/44");
    expect(resource).toMatchObject({ machine: "stopped" });
  });

  it("fails a stop whose shutdown errored instead of waiting out its deadline", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(201, { action: { id: 44, status: "in-progress", type: "shutdown" } }),
      jsonResponse(200, { action: { id: 44, status: "errored", type: "shutdown" } }),
    ]);
    const error = await provider.stop(credentials, "3164444").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "action-errored" });
    expect(provider.describeError(error).message).toMatch(/didn't shut down/);
  });

  it("starts with power_on and renames with a hostname", async () => {
    const { provider, credentials, calls } = providerWith([
      jsonResponse(201, { action: { id: 1, status: "in-progress", type: "power_on" } }),
      jsonResponse(201, { action: { id: 2, status: "in-progress", type: "rename" } }),
    ]);
    await provider.start(credentials, "3164444", {});
    await provider.rename(credentials, "3164444", "Nightly builds");
    expect(calls.map((c) => c.body)).toEqual([
      { type: "power_on" },
      { type: "rename", name: "nightly-builds" },
    ]);
  });

  it("reaches the Droplet as daintree on its public address, vouching for no host key", async () => {
    const { provider, credentials } = providerWith([jsonResponse(200, { droplet: DROPLET })]);
    expect(await provider.sshAccess(credentials, "3164444")).toEqual({
      user: "daintree",
      endpoint: { host: "203.0.113.10", port: 22 },
      hostKey: null,
    });
  });

  it("treats a Droplet with no address yet as one to try again shortly", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(200, { droplet: { ...DROPLET, networks: { v4: [], v6: [] } } }),
    ]);
    const error = await provider.sshAccess(credentials, "3164444").catch((e: unknown) => e);
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("describes errors in terms a person can act on", () => {
    const { provider } = providerWith([]);
    const err = (kind: ConstructorParameters<typeof DigitalOceanApiError>[0]) =>
      provider.describeError(new DigitalOceanApiError(kind, "said", null, null, null)).code;
    expect(err("unauthorized")).toBe("credential-invalid");
    expect(err("forbidden")).toBe("permission");
    expect(err("rate-limited")).toBe("rate-limited");
    expect(err("not-found")).toBe("not-found");
    expect(err("network")).toBe("provider-unreachable");
    expect(err("server")).toBe("provider-unreachable");
    expect(err("bad-response")).toBe("failed");
  });
});

describe("Droplet first-boot script", () => {
  const key = parsePublicKey(PUBLIC_KEY)!;
  const script = dropletUserData(key);

  it("reads a public key's type and blob, and rejects anything else", () => {
    expect(key).toEqual({ type: "ssh-ed25519", blob: KEY_BLOB });
    expect(md5Fingerprint(key)).toBe(KEY_MD5);
    // A blob of another type than it claims, a private key, junk.
    expect(parsePublicKey(`ssh-rsa ${KEY_BLOB}`)).toBeNull();
    expect(parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeNull();
    expect(parsePublicKey("ssh-ed25519 not'base64")).toBeNull();
  });

  it("is a script sh can parse, small enough for user data", () => {
    const parsed = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
    expect(Buffer.byteLength(script)).toBeLessThan(64 * 1024);
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("lets the key log in only once everything the Host needs is in place", () => {
    const at = (needle: string) => {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const login = at('mv -f "$T" "$H/.ssh/authorized_keys"');
    expect(at("apt-get -o DPkg::Lock::Timeout=600 satisfy")).toBeLessThan(login);
    expect(at('loginctl enable-linger "$U"')).toBeLessThan(login);
    expect(at("useradd")).toBeLessThan(login);
    // Root loses the key after the daintree user has it.
    expect(at("/root/.ssh/authorized_keys")).toBeGreaterThan(login);
    expect(script).not.toContain("daintree-acct");
    expect(script).not.toMatch(/sudo/);
  });

  it("installs at least what the release's deb depends on", () => {
    const config = fs.readFileSync(
      path.resolve(__dirname, "../../../../electron-builder.config.cjs"),
      "utf8"
    );
    const block = /depends:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? "";
    const depends = [...block.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
    expect(depends.length).toBeGreaterThan(10);
    for (const dependency of depends) expect(DROPLET_HOST_PACKAGES).toContain(dependency);
  });
});
