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

  it("waits out a rate limit as long as DigitalOcean asks, then answers", async () => {
    const sleeps: number[] = [];
    const responses: Responder[] = [
      jsonResponse(429, { id: "too_many_requests", message: "slow" }, { "retry-after": "6" }),
      jsonResponse(429, { id: "too_many_requests", message: "slow" }, { "retry-after": "8" }),
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
    expect(sleeps).toEqual([6000, 8000]);
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

  it("stops reading an answer that runs past its size cap, and cancels the rest", async () => {
    // A well-formed account, padded past 4 MiB: only the size can be why it's refused.
    const head = new TextEncoder().encode('{"account":{"uuid":"acct-uuid","email":"');
    const tail = new TextEncoder().encode('"}}');
    const chunk = new TextEncoder().encode("a".repeat(512 * 1024));
    let sent = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
      },
      pull(controller) {
        if (sent >= 12) {
          controller.enqueue(tail);
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const { client } = clientWith([new Response(body, { status: 200 })]);
    await expect(client.account(ctx)).rejects.toMatchObject({ kind: "bad-response" });
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThan(12);
  });

  it("reads a missing account key as none, and refuses to send a private key", async () => {
    const { client, fetch } = clientWith([jsonResponse(404, { id: "not_found", message: "nope" })]);
    expect(await client.findSshKey(ctx, KEY_MD5)).toBeNull();
    expect(fetch.mock.calls[0]![0].toString()).toBe(`https://do.test/v2/account/keys/${KEY_MD5}`);
    await expect(
      client.createSshKey(ctx, { name: "x", public_key: "-----BEGIN OPENSSH PRIVATE KEY-----" })
    ).rejects.toMatchObject({ kind: "invalid-request" });
  });

  it("lets any other failure to read an account key through", async () => {
    const { client } = clientWith([jsonResponse(403, { id: "forbidden", message: "no" })]);
    await expect(client.findSshKey(ctx, KEY_MD5)).rejects.toMatchObject({ kind: "forbidden" });
  });
});

describe("redactDigitalOceanText", () => {
  it("removes token-shaped runs and bearer values, and keeps what's around them", () => {
    const text = redactDigitalOceanText(
      `Size unavailable; Authorization: Bearer abc.def and doo_v1_${"a".repeat(64)} and ?access_token=zzz`
    );
    expect(text).toContain("Size unavailable;");
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("doo_v1_");
    expect(text).not.toContain("zzz");
    // The request's own token is removed whatever its shape.
    expect(redactDigitalOceanText("said opaque-secret-value here", "opaque-secret-value")).toBe(
      "said [redacted] here"
    );
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
    expect(() => labelsToTags({ "a:b": "c" })).toThrow(DigitalOceanApiError);
    expect(labelFilterToTag("no-equals")).toBeNull();
    expect(labelFilterToTag("k=v w")).toBeNull();
    expect(labelFilterToTag("a:b=c")).toBeNull();
  });

  it("makes a single DNS label of any name, with a fallback when nothing survives", () => {
    expect(dropletHostname("Build host (main)", "x")).toBe("build-host-main");
    expect(dropletHostname("api.example.com", "x")).toBe("api-example-com");
    expect(dropletHostname("構築", "daintree-cb-abc")).toBe("daintree-cb-abc");
    // Cut to 63 at a hyphen, which is then dropped rather than left at the end.
    expect(dropletHostname(`${"a".repeat(62)}-bcd`, "x")).toBe("a".repeat(62));
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
    const action = (type: string, status = "in-progress") => ({
      id: 7,
      status,
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
    // A finished one changes nothing: the Droplet's own status says where it is.
    expect(dropletResource(DROPLET, action("shutdown", "completed"))).toMatchObject({
      machine: "running",
      stop: null,
    });
    expect(
      dropletResource({ ...DROPLET, status: "off" }, action("power_on", "completed")).machine
    ).toBe("stopped");
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

  it("accepts a token that still belongs to the account's team", async () => {
    const { provider, credentials, calls } = providerWith([
      jsonResponse(200, ACCOUNT),
      jsonResponse(200, { droplets: [], links: {} }),
    ]);
    expect(await provider.validate(credentials)).toEqual({ identity: "person@example.com" });
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/account", "/v2/droplets"]);
  });

  it("offers only regions, images and sizes a Host can be made with", async () => {
    const image = (slug: string, distribution: string, extra: object = {}) => ({
      id: slug.length,
      name: slug,
      distribution,
      slug,
      regions: ["nyc3", "ams3", "nyc2"],
      status: "available",
      public: true,
      ...extra,
    });
    const size = (slug: string, memory: number, price: number, extra: object = {}) => ({
      slug,
      memory,
      vcpus: 2,
      disk: 50,
      price_hourly: price,
      regions: ["nyc3", "ams3", "nyc2"],
      available: true,
      description: "Basic",
      ...extra,
    });
    const responses = (status: string) => [
      jsonResponse(200, { account: { ...ACCOUNT.account, status } }),
      jsonResponse(200, {
        regions: [
          { slug: "nyc3", name: "New York 3", sizes: [], available: true },
          { slug: "ams3", name: "Amsterdam 3", sizes: [], available: true },
          // Has sizes and images, but takes no new Droplets.
          { slug: "nyc2", name: "New York 2", sizes: [], available: false },
          // Has a size but no image.
          { slug: "sgp1", name: "Singapore 1", sizes: [], available: true },
        ],
        links: {},
      }),
      jsonResponse(200, {
        sizes: [
          size("s-2vcpu-4gb", 4096, 0.03571),
          size("s-1vcpu-2gb", 2048, 0.01786, { regions: ["nyc3", "ams3", "sgp1"] }),
          size("s-1vcpu-1gb", 1024, 0.00893),
          size("gpu-h100x1-80gb", 245760, 3.39),
          size("s-8vcpu-16gb", 16384, 0.14286, { available: false }),
          // Only one of the offered regions has it: offered with the other, it couldn't be made.
          size("c-4", 8192, 0.125, { regions: ["nyc3"] }),
        ],
        links: {},
      }),
      jsonResponse(200, {
        images: [
          image("ubuntu-22-04-x64", "Ubuntu"),
          image("ubuntu-24-04-x64", "Ubuntu", { regions: ["nyc3"] }),
          // Sorts ahead of 24.04, yet isn't the default.
          image("ubuntu-26-04-x64", "Ubuntu"),
          image("ubuntu-25-04-x64", "Ubuntu"),
          image("debian-12-x64", "Debian"),
          image("debian-13-x64", "Debian", { public: false }),
          image("debian-14-x64", "Debian", { status: "retired" }),
          image("debian-11-x64", "Debian"),
          image("fedora-42-x64", "Fedora"),
        ],
        links: {},
      }),
    ];
    const { provider, credentials } = providerWith(responses("active"));
    const catalog = await provider.catalog(credentials);
    expect(catalog.canStart).toBe(true);
    expect(
      catalog.machineTypes.map((type) => [type.id, type.memoryGB, type.hourlyDollars])
    ).toEqual([
      ["s-1vcpu-2gb", 2, 0.01786],
      ["s-2vcpu-4gb", 4, 0.03571],
    ]);
    const regions = catalog.provisioning!.location!;
    expect(regions.choices.map((choice) => choice.id)).toEqual(["ams3", "nyc3"]);
    expect(regions.defaultId).toBe("nyc3");
    const images = catalog.provisioning!.image!;
    expect(images.choices.map((choice) => choice.id).sort()).toEqual([
      "debian-12-x64",
      "ubuntu-22-04-x64",
      "ubuntu-24-04-x64",
      "ubuntu-26-04-x64",
    ]);
    expect(images.defaultId).toBe("ubuntu-24-04-x64");
    expect(images.choices.find((choice) => choice.id === "ubuntu-24-04-x64")!.locations).toEqual([
      "nyc3",
    ]);

    const locked = providerWith(responses("locked"));
    expect((await locked.provider.catalog(locked.credentials)).canStart).toBe(false);
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

  it("narrows the regions to those of the most common size when no size is in all of them", async () => {
    const size = (slug: string, regions: string[]) => ({
      slug,
      memory: 4096,
      vcpus: 2,
      price_hourly: 0.03571,
      regions,
      available: true,
    });
    const catalogWith = async (sizes: object[]) => {
      const { provider, credentials } = providerWith([
        jsonResponse(200, ACCOUNT),
        jsonResponse(200, {
          regions: ["nyc3", "ams3", "sgp1", "lon1"].map((slug) => ({
            slug,
            name: slug,
            available: true,
          })),
          links: {},
        }),
        jsonResponse(200, { sizes, links: {} }),
        jsonResponse(200, {
          images: [
            {
              id: 1,
              name: "24.04 (LTS) x64",
              distribution: "Ubuntu",
              slug: "ubuntu-24-04-x64",
              regions: ["nyc3", "ams3", "sgp1"],
            },
          ],
          links: {},
        }),
      ]);
      const catalog = await provider.catalog(credentials);
      return {
        regions: catalog.provisioning!.location!.choices.map((choice) => choice.id).sort(),
        sizes: catalog.machineTypes.map((type) => type.id),
      };
    };
    // Each region has a size the others lack: offer the regions the widest size covers.
    expect(
      await catalogWith([size("b", ["sgp1"]), size("a", ["nyc3", "ams3"]), size("c", ["nyc3"])])
    ).toEqual({ regions: ["ams3", "nyc3"], sizes: ["a"] });
    // Sizes only where no image is: no region, and so no size either.
    expect(await catalogWith([size("d", ["lon1"])])).toEqual({ regions: [], sizes: [] });
    expect(await catalogWith([])).toEqual({ regions: [], sizes: [] });
  });

  it.each([
    ["region", { location: null, image: "ubuntu-24-04-x64", network: null }, PUBLIC_KEY],
    ["image", { location: "nyc3", image: null, network: null }, PUBLIC_KEY],
    ["key", { location: "nyc3", image: "ubuntu-24-04-x64", network: null }, null],
  ] as const)(
    "asks for nothing when a create is missing its %s",
    async (_missing, provisioning, publicKey) => {
      const { provider, credentials, fetch } = providerWith([]);
      await expect(
        provider.create(credentials, {
          name: "build",
          machineType: "s-2vcpu-4gb",
          lifetimeSeconds: null,
          labels: {},
          idempotencyKey: "k",
          provisioning,
          publicKey,
        })
      ).rejects.toMatchObject({ kind: "invalid-request" });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("doesn't look the key up again for a registration that failed some other way", async () => {
    const { provider, credentials, calls } = providerWith([
      jsonResponse(404, { id: "not_found", message: "not found" }),
      jsonResponse(403, { id: "forbidden", message: "ssh_key:create missing" }),
    ]);
    const error = await provider
      .create(credentials, {
        name: "build",
        machineType: "s-2vcpu-4gb",
        lifetimeSeconds: null,
        provisioning: { location: "nyc3", image: "ubuntu-24-04-x64", network: null },
        labels: {},
        idempotencyKey: "k",
        publicKey: PUBLIC_KEY,
      })
      .catch((e: unknown) => e);
    expect(provider.describeError(error).code).toBe("permission");
    expect(calls).toHaveLength(2);
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

  it.each([
    ["without the tag", { ...DROPLET, tags: undefined }],
    [
      "with a second binding",
      { ...DROPLET, tags: [...DROPLET.tags, "daintree-binding:cb_zzzzzzzz"] },
    ],
  ])(
    "fails a tag lookup that lists a Droplet %s, rather than reading it as none",
    async (_how, row) => {
      const { provider, credentials } = providerWith([
        jsonResponse(200, { droplets: [row], links: {} }),
      ]);
      await expect(
        provider.list(credentials, { label: "daintree-binding=cb_abcdefgh" })
      ).rejects.toMatchObject({ kind: "bad-response" });
    }
  );

  it("counts only the tag's own key as a second binding", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(200, {
        droplets: [
          {
            ...DROPLET,
            // Another key that starts the same way, and the same tag twice: still one binding.
            tags: [
              ...DROPLET.tags,
              "daintree-binding-old:cb_zzzzzzzz",
              "daintree-binding:cb_abcdefgh",
            ],
          },
        ],
        links: {},
      }),
    ]);
    const found = await provider.list(credentials, { label: "daintree-binding=cb_abcdefgh" });
    expect(found.map((resource) => resource.resourceId)).toEqual(["3164444"]);
  });

  it("asks which action holds a locked Droplet, and only then", async () => {
    const free = providerWith([jsonResponse(200, { droplet: DROPLET })]);
    await free.provider.inspect(free.credentials, "3164444");
    expect(free.fetch).toHaveBeenCalledTimes(1);

    const locked = providerWith([
      jsonResponse(200, { droplet: { ...DROPLET, locked: true } }),
      jsonResponse(200, {
        actions: [
          { id: 4, status: "in-progress", type: "rename" },
          { id: 3, status: "completed", type: "power_on" },
          { id: 2, status: "in-progress", type: "shutdown" },
        ],
        links: {},
      }),
    ]);
    expect(await locked.provider.inspect(locked.credentials, "3164444")).toMatchObject({
      machine: "stopping",
      stop: { id: "2" },
    });
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
    // Read through the Droplet, which `droplet:read` covers; `/v2/actions` needs a scope of its own.
    expect(calls.map((c) => c.url.pathname)).toContain("/v2/droplets/3164444/actions/44");
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

  it("follows a slow shutdown at a steady pace, and leaves one still going to the state reads", async () => {
    let clock = 0;
    const harness = clientWith([]);
    const reads: number[] = [];
    harness.fetch.mockImplementation(async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v2/droplets/3164444/actions") {
        return jsonResponse(201, { action: { id: 44, status: "in-progress", type: "shutdown" } });
      }
      if (path === "/v2/droplets/3164444/actions/44") {
        reads.push(clock);
        return jsonResponse(200, { action: { id: 44, status: "in-progress", type: "shutdown" } });
      }
      return jsonResponse(200, { droplet: { ...DROPLET, locked: true } });
    });
    const provider = new DigitalOceanProvider(
      () => harness.client,
      async (ms) => {
        clock += ms;
      },
      () => clock
    );
    const resource = await provider.stop(
      { apiKey: TOKEN, scopeId: "team-uuid", apiUrl: "https://do.test/v2" },
      "3164444"
    );
    expect(new Set(reads.map((at, i) => at - (reads[i - 1] ?? 0)))).toEqual(new Set([3000]));
    expect(clock).toBeLessThanOrEqual(3 * 60_000 + 3000);
    expect(clock).toBeGreaterThanOrEqual(3 * 60_000);
    expect(resource).toMatchObject({ machine: "stopping", stop: { id: "44", status: "pending" } });
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

  it("treats a Droplet with no public address yet as one to try again shortly", async () => {
    const { provider, credentials } = providerWith([
      jsonResponse(200, {
        droplet: {
          ...DROPLET,
          networks: { v4: [{ ip_address: "10.10.0.5", type: "private" }], v6: [] },
        },
      }),
    ]);
    const error = await provider.sshAccess(credentials, "3164444").catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "not-ready" });
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("maps each kind of failure to the code the lifecycle acts on", () => {
    const { provider } = providerWith([]);
    const err = (kind: ConstructorParameters<typeof DigitalOceanApiError>[0]) =>
      provider.describeError(new DigitalOceanApiError(kind, "said", null, null, null)).code;
    expect(err("unauthorized")).toBe("credential-invalid");
    expect(err("forbidden")).toBe("permission");
    expect(err("rate-limited")).toBe("rate-limited");
    expect(err("unprocessable")).toBe("refused");
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
    // A blob of another type than it claims, a private key, a blob with a stray character.
    expect(parsePublicKey(`ssh-rsa ${KEY_BLOB}`)).toBeNull();
    expect(parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeNull();
    expect(parsePublicKey(`ssh-ed25519 ${KEY_BLOB}'`)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "is a script sh can parse, small enough for user data",
    () => {
      const parsed = spawnSync("/bin/sh", ["-n"], { input: script, encoding: "utf8" });
      expect(parsed.stderr).toBe("");
      expect(parsed.status).toBe(0);
      expect(Buffer.byteLength(script)).toBeLessThan(64 * 1024);
      expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    }
  );

  it("takes the key off root first, and lets it log in as daintree only as the very last step", () => {
    const at = (needle: string) => {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const rootRemoved = at('mv -f "$T" "$R"');
    expect(rootRemoved).toBeLessThan(at("useradd"));
    expect(at("useradd")).toBeLessThan(at("satisfy -y"));
    expect(at("satisfy -y")).toBeLessThan(at('loginctl enable-linger "$U"'));
    const commands = script.trim().split("\n");
    expect(commands.at(-1)).toBe('mv -f "$K" "$H/.ssh/authorized_keys"');
    expect(script).toContain(`'${DROPLET_HOST_PACKAGES.join(", ")}'`);
    expect(script).not.toContain("daintree-acct");
    expect(script).not.toMatch(/sudo/);
  });

  it.skipIf(process.platform === "win32")(
    "drops only the line that authorizes this key from root's keys",
    () => {
      const program = /awk -v t="\$KEY_TYPE" -v b="\$BLOB" '([^']+)'/.exec(script)?.[1];
      expect(program).toBeTruthy();
      const other =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOther person@laptop";
      const lines = [
        other,
        `ssh-ed25519 ${KEY_BLOB} daintree-acct`,
        `no-pty ssh-ed25519 ${KEY_BLOB}`,
        // The blob in a comment isn't this key.
        `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC0 mentions ${KEY_BLOB}`,
        // The same blob under another type isn't either.
        `ssh-rsa ${KEY_BLOB}`,
        // Nor this key named in another key's comment.
        `ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC0 ssh-ed25519 ${KEY_BLOB}`,
      ];
      const ran = spawnSync("awk", ["-v", `t=${key.type}`, "-v", `b=${key.blob}`, program!], {
        input: `${lines.join("\n")}\n`,
        encoding: "utf8",
      });
      expect(ran.status).toBe(0);
      expect(ran.stdout.trim().split("\n")).toEqual([lines[0], lines[3], lines[4], lines[5]]);
    }
  );

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
