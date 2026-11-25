import { describe, expect, it, vi } from "vitest";
import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import {
  abortableAkashSleep,
  AkashApiError,
  AkashConsoleClient,
  type AkashConsoleClientOptions,
  redactAkashText,
  resolveAkashConsoleApiUrl,
} from "../akash/AkashConsoleClient.js";
import { akashMonthlyDollars } from "../akash/akashBilling.js";
import { akashMarkedName, akashRenamed, parseAkashName } from "../akash/akashDeployments.js";
import { AkashProvider, akashApiKey } from "../akash/AkashProvider.js";
import { cloudMachineClaim, madeInSendWindow, type StoredCloudBinding } from "../CloudHostStore.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import type { CloudProvider, ProviderCreateRequest, ProviderCredentials } from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  AUDITOR,
  FAKE_AKASH_KEY,
  FakeAkashConsole,
  fakeAkashWallet,
  screenedMillicores,
  type FakeAkashDeployment,
  type FakeAkashLease,
  type FakeAkashRequest,
} from "./fakeAkashConsole.js";

const PERSONAL_ORG = "11111111-1111-4111-8111-111111111111";
const TEAM_ORG = "22222222-2222-4222-8222-222222222222";
const PERSONAL_DEFAULT = "aaaaaaaa-0000-4000-8000-000000000001";
const PERSONAL_SANDBOX = "aaaaaaaa-0000-4000-8000-000000000002";
const TEAM_DEFAULT = "aaaaaaaa-0000-4000-8000-000000000003";
const TEAM_AGENTS = "aaaaaaaa-0000-4000-8000-000000000004";

const TEAM_KEY = "ac.sk.fake-akash-unit-team-0001";
const BOUND_KEY = "ac.sk.fake-akash-unit-bound-0002";
const VIEWER_KEY = "ac.sk.fake-akash-unit-viewer-0003";
const ANONYMOUS_KEY = "ac.sk.fake-akash-unit-anon-0004";
const MIXED_KEY = "ac.sk.fake-akash-unit-mixed-0005";

const GIB = 1073741824;

const HOST_IMAGE = `ghcr.io/daintreehq/daintree-host@sha256:${"0123456789abcdef".repeat(4)}`;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function setup(clientOptions: Partial<AkashConsoleClientOptions> = {}) {
  const fake = new FakeAkashConsole();
  fake.organizations.push(
    { id: PERSONAL_ORG, name: "person", type: "personal" },
    { id: TEAM_ORG, name: "Web team", type: "team" }
  );
  fake.projects.push(
    // The default isn't named "Default", so only its flag can mark it.
    { id: PERSONAL_DEFAULT, organizationId: PERSONAL_ORG, name: "Main", isDefault: true },
    { id: PERSONAL_SANDBOX, organizationId: PERSONAL_ORG, name: "Sandbox", isDefault: false },
    { id: TEAM_DEFAULT, organizationId: TEAM_ORG, name: "Default", isDefault: true },
    { id: TEAM_AGENTS, organizationId: TEAM_ORG, name: "Agents", isDefault: false }
  );
  const person = { email: "person@example.com", username: "person" };
  const key = (organizationId: string, extra: object = {}) => ({
    organizationId,
    projectIds: null,
    canDeploy: true,
    user: person,
    ...extra,
  });
  fake.keys.set(FAKE_AKASH_KEY, key(PERSONAL_ORG));
  fake.keys.set(TEAM_KEY, key(TEAM_ORG));
  fake.keys.set(BOUND_KEY, key(TEAM_ORG, { projectIds: [TEAM_AGENTS] }));
  fake.keys.set(VIEWER_KEY, key(TEAM_ORG, { canDeploy: false }));
  fake.keys.set(ANONYMOUS_KEY, key(PERSONAL_ORG, { user: null }));
  fake.keys.set(MIXED_KEY, key(TEAM_ORG, { readOnlyProjectIds: [TEAM_DEFAULT] }));
  // mars-north has a count but isn't a listed region, so a count alone never offers a region.
  fake.regionProviderCounts = {
    "na-us-west": 5,
    "eu-west": 3,
    "ap-southeast": 1,
    "eu-north": 0,
    "mars-north": 2,
  };
  fake.placementRegions = ["na-us-west", "eu-west", "ap-southeast", "eu-north"];
  const room = (millicores: number, memoryGiB: number, storageGiB: number) => ({
    freeMillicores: millicores,
    freeMemoryBytes: memoryGiB * GIB,
    freeStorageBytes: storageGiB * GIB,
  });
  fake.providers.push(
    { owner: "akash1big", location: "eu-west", audited: true, ...room(20_000, 80, 500) },
    { owner: "akash1small", location: "na-us-west", audited: true, ...room(10_000, 40, 300) },
    { owner: "akash1tiny", location: "ap-southeast", audited: true, ...room(5_000, 20, 150) },
    // Room for everything, but each is ruled out another way.
    {
      owner: "akash1unaudited",
      location: "ap-southeast",
      audited: false,
      ...room(64_000, 256, 2000),
    },
    { owner: "akash1unplaced", location: null, audited: true, ...room(64_000, 256, 2000) },
    { owner: "akash1unlisted", location: "mars-north", audited: true, ...room(64_000, 256, 2000) },
    // Screening still matches it while placement counts none there: the two snapshots disagree.
    { owner: "akash1disagreeing", location: "eu-north", audited: true, ...room(64_000, 256, 2000) }
  );
  const sleeps: number[] = [];
  const client = new AkashConsoleClient({
    baseUrl: fake.baseUrl,
    fetch: fake.fetch as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...clientOptions,
  });
  const provider = new AkashProvider(() => client, { hostImage: HOST_IMAGE });
  const credentials = (apiKey: string, scopeId: string): ProviderCredentials => ({
    values: { apiKey },
    scopeId,
    apiUrl: fake.baseUrl,
  });
  const paths = (path: string) => fake.requests.filter((request) => request.path === path);
  return { fake, client, provider, credentials, sleeps, paths };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const cpu = (millicores: number) => (body: unknown) => screenedMillicores(body) === millicores;

describe("resolveAkashConsoleApiUrl", () => {
  it("answers production in a packaged build, whatever the environment says", () => {
    expect(
      resolveAkashConsoleApiUrl(true, { DAINTREE_AKASH_CONSOLE_API_URL: "http://localhost:1/v1" })
    ).toBe("https://console-api.akash.network/v1");
  });

  it("honours an http(s) override in development, origin and path only", () => {
    const resolve = (value: string) =>
      resolveAkashConsoleApiUrl(false, { DAINTREE_AKASH_CONSOLE_API_URL: value });
    expect(resolve("http://localhost:4010/v1/?key=x")).toBe("http://localhost:4010/v1");
    expect(resolve("https://user:pass@fake.test/v1#frag")).toBe("https://fake.test/v1");
    expect(resolve("file:///etc/passwd")).toBe("https://console-api.akash.network/v1");
    expect(resolve("not a url")).toBe("https://console-api.akash.network/v1");
  });
});

describe("akashApiKey", () => {
  const refusal = (apiKey: string) => {
    try {
      akashApiKey({ apiKey });
    } catch (error) {
      return error as AppError;
    }
    throw new Error("expected a refusal");
  };

  it("refuses what can't travel in a header", () => {
    for (const apiKey of ["", "ac.sk.has space", "ac.sk.é", `ac.sk.${"x".repeat(4091)}`]) {
      expect(refusal(apiKey)).toMatchObject({ code: "VALIDATION" });
    }
    expect(refusal("-----BEGIN OPENSSH PRIVATE KEY-----").userMessage).toMatch(/private key/);
    expect(akashApiKey({ apiKey: `ac.sk.${"x".repeat(4090)}` })).toHaveLength(4096);
  });

  it("sends nothing for a key it refuses", async () => {
    const { provider, fake } = setup();
    await rejection(provider.checkCredentials({ apiKey: "ac.sk.has space" }, fake.baseUrl));
    expect(fake.requests).toHaveLength(0);
  });
});

describe("AkashProvider account connection", () => {
  it("lists every project a personal key can deploy into, the default active", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: FAKE_AKASH_KEY }, fake.baseUrl);
    expect(checked).toEqual({
      identity: "person@example.com",
      scopes: [
        { scope: { kind: "project", id: PERSONAL_DEFAULT, name: "Personal · Main" }, active: true },
        {
          scope: { kind: "project", id: PERSONAL_SANDBOX, name: "Personal · Sandbox" },
          active: false,
        },
      ],
    });
    expect(fake.requests.map((request) => request.path).sort()).toEqual([
      "/organizations",
      "/projects",
      "/user/me",
    ]);
    for (const request of fake.requests) {
      expect(request).toMatchObject({
        apiKey: FAKE_AKASH_KEY,
        organizationId: null,
        projectId: null,
        authorization: null,
        redirect: "error",
      });
    }
  });

  it("names a team's projects after the team, and only that team's", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl);
    expect(
      checked.scopes.map((choice) => [choice.scope.id, choice.scope.name, choice.active])
    ).toEqual([
      [TEAM_DEFAULT, "Web team · Default", true],
      [TEAM_AGENTS, "Web team · Agents", false],
    ]);
  });

  it("offers a key limited to one project that project alone", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: BOUND_KEY }, fake.baseUrl);
    expect(checked.scopes).toEqual([
      { scope: { kind: "project", id: TEAM_AGENTS, name: "Web team · Agents" }, active: false },
    ]);
  });

  it("leaves out a project the key may only read, the default included", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: MIXED_KEY }, fake.baseUrl);
    expect(checked.scopes).toEqual([
      { scope: { kind: "project", id: TEAM_AGENTS, name: "Web team · Agents" }, active: false },
    ]);
  });

  it("lists a project once, by its lowercase id, however the Console spells it", async () => {
    const { provider, fake } = setup();
    const row = (id: string) => ({
      id,
      name: "Agents",
      isDefault: false,
      access: { canDeploy: true, canManage: false },
    });
    fake.fail("GET", /^\/projects$/, () =>
      reply(200, { data: [row(TEAM_AGENTS.toUpperCase()), row(TEAM_AGENTS)] })
    );
    const checked = await provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl);
    expect(checked.scopes.map((choice) => choice.scope.id)).toEqual([TEAM_AGENTS]);
  });

  it("refuses a key that can deploy nowhere as a permission problem", async () => {
    const { provider, fake } = setup();
    const viewer = await rejection(provider.checkCredentials({ apiKey: VIEWER_KEY }, fake.baseUrl));
    expect(provider.describeError(viewer).code).toBe("permission");
    expect(provider.describeError(viewer).message).toContain("Web team");

    fake.fail("GET", /^\/projects$/, () => reply(200, { data: [] }));
    const none = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(provider.describeError(none).code).toBe("permission");
  });

  it("reads an unknown key as invalid, asking each route once", async () => {
    const { provider, fake, sleeps } = setup();
    const error = await rejection(
      provider.checkCredentials({ apiKey: "ac.sk.not-a-key-anyone-made" }, fake.baseUrl)
    );
    expect(provider.describeError(error).code).toBe("credential-invalid");
    expect(fake.requests.map((request) => request.path).sort()).toEqual([
      "/organizations",
      "/projects",
      "/user/me",
    ]);
    expect(sleeps).toEqual([]);
  });

  it("refuses an answer that doesn't name exactly one organization the key acts in", async () => {
    const organization = (id: string, isActive: boolean) => ({
      id,
      name: "x",
      slug: "x",
      type: "team",
      role: "member",
      isActive,
      hasPaymentMethod: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    for (const data of [
      [organization(TEAM_ORG, false)],
      [organization(TEAM_ORG, true), organization(PERSONAL_ORG, true)],
    ]) {
      const { provider, fake } = setup();
      fake.fail("GET", /^\/organizations$/, () => reply(200, { data }));
      const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
      expect(error).toMatchObject({ kind: "bad-response" });
    }
    // An inactive one listed first doesn't stand in for the active one.
    const { provider, fake } = setup();
    fake.fail("GET", /^\/organizations$/, () =>
      reply(200, {
        data: [
          { ...organization(PERSONAL_ORG, false), name: "Other" },
          { ...organization(TEAM_ORG, true), name: "Web team" },
        ],
      })
    );
    const checked = await provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl);
    expect(checked.scopes[0]!.scope.name).toBe("Web team · Default");
  });

  it("connects with no identity only when the Console won't name a person", async () => {
    const anonymous = setup();
    const checked = await anonymous.provider.checkCredentials(
      { apiKey: ANONYMOUS_KEY },
      anonymous.fake.baseUrl
    );
    expect(checked).toMatchObject({ identity: null, scopes: [{}, {}] });

    const missing = setup();
    missing.fake.fail("GET", /^\/user\/me$/, () => reply(404, { statusCode: 404, message: "No" }));
    await expect(
      missing.provider.checkCredentials({ apiKey: TEAM_KEY }, missing.fake.baseUrl)
    ).resolves.toMatchObject({ identity: null });

    const broken = setup();
    broken.fake.fail("GET", /^\/user\/me$/, () => reply(500, { statusCode: 500, message: "x" }), 3);
    const error = await rejection(
      broken.provider.checkCredentials({ apiKey: TEAM_KEY }, broken.fake.baseUrl)
    );
    expect(broken.provider.describeError(error).code).toBe("provider-unreachable");

    const unnamed = setup();
    unnamed.fake.fail("GET", /^\/user\/me$/, () =>
      reply(200, { data: { email: "  ", username: "  person  " } })
    );
    await expect(
      unnamed.provider.checkCredentials({ apiKey: TEAM_KEY }, unnamed.fake.baseUrl)
    ).resolves.toMatchObject({ identity: "person" });
  });

  it("backs off between throttled reads, and reads throttling that outlasts them as rate-limited", async () => {
    const { provider, fake, sleeps, paths } = setup();
    fake.fail(
      "GET",
      /^\/organizations$/,
      () => reply(429, { statusCode: 429, message: "Slow" }),
      3
    );
    const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(provider.describeError(error).code).toBe("rate-limited");
    expect(paths("/organizations")).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThanOrEqual(750);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeLessThanOrEqual(1250);
  });

  it("waits as long as Retry-After asks, and gives up rather than ask sooner than a long one allows", async () => {
    const throttled = (retryAfter: string) => () =>
      reply(429, { statusCode: 429, message: "Slow" }, { "retry-after": retryAfter });

    const recovering = setup();
    recovering.fake.fail("GET", /^\/projects$/, throttled("2"));
    await recovering.provider.checkCredentials({ apiKey: TEAM_KEY }, recovering.fake.baseUrl);
    expect(recovering.sleeps).toEqual([2000]);
    expect(recovering.paths("/projects")).toHaveLength(2);

    const atCutoff = setup();
    atCutoff.fake.fail("GET", /^\/projects$/, throttled("10"));
    await atCutoff.provider.checkCredentials({ apiKey: TEAM_KEY }, atCutoff.fake.baseUrl);
    expect(atCutoff.sleeps).toEqual([10_000]);

    const dated = setup();
    dated.fake.fail("GET", /^\/projects$/, throttled(new Date(Date.now() + 6000).toUTCString()));
    await dated.provider.checkCredentials({ apiKey: TEAM_KEY }, dated.fake.baseUrl);
    expect(dated.sleeps[0]).toBeGreaterThanOrEqual(4000);
    expect(dated.sleeps[0]).toBeLessThanOrEqual(6000);

    for (const retryAfter of ["11", "120"]) {
      const { provider, fake, sleeps, paths } = setup();
      fake.fail("GET", /^\/organizations$/, throttled(retryAfter), 3);
      const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
      expect(error).toMatchObject({
        kind: "rate-limited",
        retryAfterMs: Number(retryAfter) * 1000,
      });
      expect(paths("/organizations")).toHaveLength(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("refuses a project list it can't read rather than passing it off as no access", async () => {
    const valid = {
      id: TEAM_DEFAULT,
      name: "Default",
      isDefault: true,
      access: { canDeploy: true },
    };
    const { access: _access, ...noAccess } = { ...valid, id: TEAM_AGENTS };
    const { isDefault: _isDefault, ...noDefault } = { ...valid, id: TEAM_AGENTS };
    for (const broken of [noAccess, noDefault]) {
      const { provider, fake } = setup();
      fake.fail("GET", /^\/projects$/, () => reply(200, { data: [valid, broken] }));
      const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
      expect(error).toMatchObject({ kind: "bad-response" });
      expect(provider.describeError(error).code).toBe("failed");
    }
  });

  it("sends nothing once the caller has given up", async () => {
    const { provider, fake } = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl, controller.signal)
    );
    expect(error).toMatchObject({ kind: "cancelled" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("AkashProvider.validate", () => {
  it("checks the account's own project, named in the header, from the list that says what the key may do", async () => {
    const { provider, fake, credentials } = setup();
    await expect(
      provider.validate(credentials(TEAM_KEY, TEAM_AGENTS.toUpperCase()))
    ).resolves.toEqual({ identity: "person@example.com" });
    expect(fake.requests.map((request) => [request.path, request.projectId])).toEqual([
      ["/projects", TEAM_AGENTS],
      ["/user/me", null],
    ]);
    // Another project it may only read is no concern of this account's.
    await expect(provider.validate(credentials(MIXED_KEY, TEAM_AGENTS))).resolves.toEqual({
      identity: "person@example.com",
    });
  });

  it("reads a key that no longer reaches the project as invalid for this account", async () => {
    // A key limited to Agents, asked about the team's default project: refused by its header.
    const bound = setup();
    const forbidden = await rejection(
      bound.provider.validate(bound.credentials(BOUND_KEY, TEAM_DEFAULT))
    );
    expect(forbidden).toMatchObject({ kind: "wrong-scope", code: "project_forbidden" });
    expect(bound.provider.describeError(forbidden).code).toBe("credential-invalid");

    const gone = setup();
    gone.fake.fail("GET", /^\/projects$/, () => reply(404, { statusCode: 404, message: "No" }));
    const missing = await rejection(
      gone.provider.validate(gone.credentials(TEAM_KEY, TEAM_AGENTS))
    );
    expect(missing).toMatchObject({ kind: "wrong-scope", status: 404 });
    expect(gone.provider.describeError(missing).code).toBe("credential-invalid");

    const unlisted = setup();
    // Another project, deployable, but not the one this account deploys into.
    unlisted.fake.fail("GET", /^\/projects$/, () =>
      reply(200, {
        data: [{ id: TEAM_DEFAULT, name: "Default", isDefault: true, access: { canDeploy: true } }],
      })
    );
    const absent = await rejection(
      unlisted.provider.validate(unlisted.credentials(TEAM_KEY, TEAM_AGENTS))
    );
    expect(absent).toMatchObject({ kind: "wrong-scope" });
  });

  it("reads a key that may only look as a permission problem, before asking who holds it", async () => {
    const { provider, fake, credentials } = setup();
    const error = await rejection(provider.validate(credentials(VIEWER_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error)).toMatchObject({ code: "permission" });
    expect(provider.describeError(error).message).toContain("Agents");
    expect(fake.requests.map((request) => request.path)).toEqual(["/projects"]);
  });

  it("keeps any other refusal a permission problem, not a lost project", async () => {
    const { provider, fake, credentials } = setup();
    fake.fail("GET", /^\/projects$/, () =>
      reply(403, {
        error: "Forbidden",
        message: "Not a member",
        code: "organization_forbidden",
        type: "client_error",
      })
    );
    const error = await rejection(provider.validate(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(error).toMatchObject({ kind: "forbidden", code: "organization_forbidden" });
    expect(provider.describeError(error).code).toBe("permission");
  });

  it("asks nothing with no saved key, or a saved scope that isn't a project id", async () => {
    const { provider, fake, credentials } = setup();
    const keyless = await rejection(provider.validate(credentials("", TEAM_AGENTS)));
    expect(provider.describeError(keyless).code).toBe("credential-invalid");
    const scopeless = await rejection(provider.validate(credentials(TEAM_KEY, "personal")));
    expect(provider.describeError(scopeless).code).toBe("refused");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("AkashProvider.describeError", () => {
  it("maps each status the Console answers with onto Daintree's codes", async () => {
    const cases: Array<[Response, Partial<AkashApiError>, string]> = [
      [reply(402, { statusCode: 402, message: "Top up" }), { kind: "payment-required" }, "billing"],
      [
        reply(403, {
          error: "Forbidden",
          message: "Over budget",
          code: "project_budget_exceeded",
          type: "x",
        }),
        { kind: "forbidden", code: "project_budget_exceeded" },
        "billing",
      ],
      [reply(404, { statusCode: 404, message: "No" }), { kind: "not-found" }, "not-found"],
      [
        reply(400, { error: "Bad", message: "Mismatch", code: "organization_mismatch", type: "x" }),
        { kind: "invalid-request", code: "organization_mismatch" },
        "refused",
      ],
      [reply(409, { statusCode: 409, message: "Taken" }), { kind: "conflict" }, "refused"],
      [reply(422, { statusCode: 422, message: "Too many" }), { kind: "unprocessable" }, "refused"],
    ];
    for (const [response, raw, code] of cases) {
      const { provider, fake } = setup();
      fake.fail("GET", /^\/organizations$/, () => response.clone());
      const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
      expect(error).toMatchObject({ ...raw, status: response.status });
      expect(provider.describeError(error).code).toBe(code);
    }
  });

  it("falls back to the status for an error body that isn't JSON", async () => {
    const { provider, fake } = setup();
    fake.fail(
      "GET",
      /^\/organizations$/,
      () => new Response("<html>oops</html>", { status: 503 }),
      3
    );
    const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(error).toMatchObject({ kind: "server", message: "The Akash Console answered 503" });
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("maps failures that never reached a status", () => {
    const provider = new AkashProvider(
      () => {
        throw new Error("unused");
      },
      { hostImage: HOST_IMAGE }
    );
    const api = (kind: AkashApiError["kind"]) =>
      new AkashApiError(kind, `said ${kind}`, null, null);
    expect(provider.describeError(api("network")).code).toBe("provider-unreachable");
    expect(provider.describeError(api("timeout")).code).toBe("provider-unreachable");
    expect(provider.describeError(api("unsupported"))).toMatchObject({
      code: "unsupported",
      message: "said unsupported",
    });
    expect(provider.describeError(api("cancelled"))).toMatchObject({
      code: "failed",
      message: "Cancelled.",
    });
    expect(provider.describeError(api("bad-response")).code).toBe("failed");
    expect(provider.describeError(new Error("boom")).code).toBe("failed");
    const invalid = new AppError({
      code: "VALIDATION",
      message: "x",
      userMessage: "Paste an API key.",
    });
    expect(provider.describeError(invalid)).toMatchObject({
      code: "failed",
      message: "Paste an API key.",
    });
  });

  it("never repeats a key the Console echoed back, prefixed or not", async () => {
    const plainKey = "plain-unit-key-without-prefix-0042";
    const { provider, fake } = setup();
    fake.keys.set(plainKey, fake.keys.get(TEAM_KEY)!);
    fake.fail("GET", /^\/organizations$/, () =>
      reply(400, { statusCode: 400, message: `Bad header ${plainKey} and ac.sk.other-key` })
    );
    const error = await rejection(provider.checkCredentials({ apiKey: plainKey }, fake.baseUrl));
    expect(error).toMatchObject({ message: "Bad header [redacted] and [redacted]" });
    expect(provider.describeError(error).message).not.toContain(plainKey);
    expect(redactAkashText("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer [redacted]"
    );
    expect(redactAkashText("GET /x?api_key=secret&y=1")).toBe("GET /x?api_key=[redacted]&y=1");
  });

  it("never shows a key hidden in a name the Console supplied", async () => {
    const { provider, fake } = setup();
    fake.organizations[1]!.name = "ac.sk.leaked-into-a-name";
    const error = await rejection(provider.checkCredentials({ apiKey: VIEWER_KEY }, fake.baseUrl));
    expect(provider.describeError(error).message).not.toContain("ac.sk.");
  });
});

describe("AkashProvider.catalog", () => {
  it("offers the four sizes where an audited provider has room, with the regions to choose from", async () => {
    const { provider, credentials } = setup();
    const catalog = await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    expect(catalog.machineTypes.map((type) => [type.id, type.available, type.locations])).toEqual([
      ["akash-4c-16g", true, ["ap-southeast", "eu-west", "na-us-west"]],
      ["akash-8c-32g", true, ["eu-west", "na-us-west"]],
      ["akash-16c-64g", true, ["eu-west"]],
      ["akash-32c-128g", false, []],
    ]);
    for (const type of catalog.machineTypes) {
      expect(type.hourlyDollars).toBeNull();
      if (type.available) expect(type.reason).toBeNull();
      else expect(type.reason).toMatch(/room/);
    }
    expect(catalog.machineTypes[0]).toMatchObject({ vcpu: 4, memoryGB: 16 });
    expect(catalog.machineTypes[0]!.label).toContain("100 GB disk");

    const location = catalog.provisioning?.location;
    expect(location?.choices.map((choice) => [choice.id, choice.available])).toEqual([
      ["ap-southeast", true],
      ["eu-north", false],
      ["eu-west", true],
      ["na-us-west", true],
    ]);
    expect(location?.choices.find((choice) => choice.id === "eu-west")?.description).toBe(
      "3 audited providers online"
    );
    expect(location?.defaultId).toBe("na-us-west");
    expect(catalog.canStart).toBe(false);
  });

  it("suggests the busiest region some size fits, not merely the busiest", async () => {
    const { provider, fake, credentials } = setup();
    // ap-southeast is busiest but fits nothing; eu-west is the busiest that fits, and not last by name.
    fake.regionProviderCounts["ap-southeast"] = 9;
    fake.regionProviderCounts["na-us-west"] = 2;
    fake.providers.splice(
      fake.providers.findIndex((entry) => entry.owner === "akash1tiny"),
      1
    );
    const catalog = await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    expect(catalog.provisioning?.location?.defaultId).toBe("eu-west");
  });

  it("screens each size in the chain's units, audited only, carrying no credential", async () => {
    const { provider, fake, credentials, paths } = setup();
    await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    const units = paths("/bid-screening")
      .map((request) => {
        const body = request.body as {
          requirements: unknown;
          timezone: string;
          resources: Array<{
            resource: {
              cpu: { units: { val: string } };
              memory: { quantity: { val: string } };
              gpu: { units: { val: string } };
              storage: Array<{ quantity: { val: string } }>;
            };
          }>;
        };
        expect(body.requirements).toEqual({
          signedBy: { allOf: [], anyOf: [AUDITOR] },
          attributes: [],
        });
        expect(body.timezone).toBe("UTC");
        expect(request.contentType).toBe("application/json");
        const { cpu, memory, gpu, storage } = body.resources[0]!.resource;
        return [cpu.units.val, memory.quantity.val, gpu.units.val, storage[0]!.quantity.val];
      })
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(units).toEqual([
      ["4000", "17179869184", "0", "107374182400"],
      ["8000", "34359738368", "0", "214748364800"],
      ["16000", "68719476736", "0", "429496729600"],
      ["32000", "137438953472", "0", "858993459200"],
    ]);
    expect(fake.requests).toHaveLength(5);
    for (const request of fake.requests) {
      expect(request).toMatchObject({
        apiKey: null,
        projectId: null,
        organizationId: null,
        authorization: null,
        search: "",
      });
    }
  });

  it("tells an empty screening from a failed one", async () => {
    const empty = setup();
    empty.fake.providers.length = 0;
    const catalog = await empty.provider.catalog(empty.credentials(TEAM_KEY, TEAM_AGENTS));
    expect(catalog.machineTypes).toHaveLength(4);
    for (const type of catalog.machineTypes) {
      expect(type).toMatchObject({ available: false, locations: [] });
      expect(type.reason).toMatch(/room/);
    }

    const unavailable = () =>
      reply(503, { statusCode: 503, message: "Provider screening is unavailable" });
    const recovering = setup();
    recovering.fake.fail("POST", /^\/bid-screening$/, unavailable, 1, cpu(8000));
    await recovering.provider.catalog(recovering.credentials(TEAM_KEY, TEAM_AGENTS));
    const eights = recovering.paths("/bid-screening").filter((request) => cpu(8000)(request.body));
    expect(eights).toHaveLength(2);

    const failing = setup();
    failing.fake.fail("POST", /^\/bid-screening$/, unavailable, 3, cpu(8000));
    const error = await rejection(
      failing.provider.catalog(failing.credentials(TEAM_KEY, TEAM_AGENTS))
    );
    expect(failing.provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("fails on an answer it can't read rather than calling it no room", async () => {
    const valid = { owner: "akash1p", isAudited: true, location: "eu-west" };
    const { location: _location, ...noLocation } = valid;
    const { isAudited: _isAudited, ...noAudit } = valid;
    for (const broken of [noLocation, noAudit]) {
      const { provider, fake, credentials } = setup();
      fake.fail("POST", /^\/bid-screening$/, () => reply(200, { providers: [valid, broken] }));
      const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
      expect(error).toMatchObject({ kind: "bad-response" });
    }
    const { provider, fake, credentials } = setup();
    fake.fail("GET", /^\/placement-options$/, () => reply(200, { regions: ["eu-west"] }));
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(error).toMatchObject({ kind: "bad-response" });
  });

  it("never reads a public route's refusal as the account's key going bad", async () => {
    for (const status of [401, 403]) {
      for (const [method, path, body] of [
        ["GET", /^\/placement-options$/, undefined],
        ["POST", /^\/bid-screening$/, cpu(4000)],
      ] as const) {
        const { provider, fake, credentials } = setup();
        fake.fail(
          method,
          path,
          () => reply(status, { statusCode: status, message: "No" }),
          3,
          body
        );
        const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
        expect(error).toMatchObject({ kind: "server", status });
        expect(provider.describeError(error).code).toBe("provider-unreachable");
      }
    }
  });

  it("cancels every other request once one fails, and reports that failure", async () => {
    const { provider, fake, credentials, paths } = setup();
    fake.hold({ method: "GET", path: /^\/placement-options$/ });
    fake.hold({ method: "POST", path: /^\/bid-screening$/, body: cpu(16000) });
    fake.fail(
      "POST",
      /^\/bid-screening$/,
      () => reply(400, { statusCode: 400, message: "Invalid request body" }),
      1,
      cpu(8000)
    );
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(error).toMatchObject({
      kind: "invalid-request",
      status: 400,
      message: "Invalid request body",
    });
    const held: Array<FakeAkashRequest | undefined> = [
      paths("/placement-options")[0],
      paths("/bid-screening").find((request) => cpu(16000)(request.body)),
    ];
    for (const request of held) expect(request?.signal?.aborted).toBe(true);
  });

  it("sends nothing once the caller has given up, and stops when they give up mid-way", async () => {
    const before = setup();
    const gaveUp = new AbortController();
    gaveUp.abort();
    const early = await rejection(
      before.provider.catalog({
        ...before.credentials(TEAM_KEY, TEAM_AGENTS),
        signal: gaveUp.signal,
      })
    );
    expect(early).toMatchObject({ kind: "cancelled" });
    expect(before.fake.requests).toHaveLength(0);

    const during = setup();
    during.fake.hold({ method: "GET", path: /^\/placement-options$/ });
    const giveUp = new AbortController();
    const pending = rejection(
      during.provider.catalog({
        ...during.credentials(TEAM_KEY, TEAM_AGENTS),
        signal: giveUp.signal,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    giveUp.abort();
    expect(await pending).toMatchObject({ kind: "cancelled" });
  });
});

describe("AkashConsoleClient transport", () => {
  const ctx = { apiKey: TEAM_KEY };

  it("retries a network failure and reads it as unreachable", async () => {
    const { client, fake, paths, provider } = setup();
    fake.fail("GET", /^\/organizations$/, () => new TypeError("fetch failed"), 3);
    const error = await rejection(client.organizations(ctx));
    expect(error).toMatchObject({ kind: "network" });
    expect(paths("/organizations")).toHaveLength(3);
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("gives up on an answer that never comes", async () => {
    const { client, fake, paths } = setup({ timeoutMs: 10 });
    fake.hold({ method: "GET", path: /^\/organizations$/ });
    const error = await rejection(client.organizations(ctx));
    expect(error).toMatchObject({ kind: "timeout" });
    expect(paths("/organizations")).toHaveLength(3);
  });

  it("waits out a backoff on its caller's signal", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const { fake } = setup();
    const client = new AkashConsoleClient({
      baseUrl: fake.baseUrl,
      fetch: fake.fetch as unknown as typeof fetch,
      sleep: async (_ms, signal) => {
        seen.push(signal);
      },
    });
    const controller = new AbortController();
    fake.fail("GET", /^\/organizations$/, () => reply(429, { statusCode: 429, message: "Slow" }));
    await client.organizations({ ...ctx, signal: controller.signal });
    expect(seen).toEqual([controller.signal]);
  });

  it("ends a backoff the moment its caller gives up, leaving no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = rejection(abortableAkashSleep(10_000, controller.signal));
      controller.abort();
      expect(await waiting).toMatchObject({ kind: "cancelled" });
      expect(vi.getTimerCount()).toBe(0);
      expect(await rejection(abortableAkashSleep(10_000, controller.signal))).toMatchObject({
        kind: "cancelled",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an answer too large to read, whether or not it says so up front", async () => {
    const declared = setup();
    declared.fake.fail(
      "GET",
      /^\/organizations$/,
      () => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } })
    );
    expect(await rejection(declared.client.organizations(ctx))).toMatchObject({
      kind: "bad-response",
      message: "The Akash Console's answer was too large",
    });

    const streamed = setup();
    streamed.fake.fail("GET", /^\/organizations$/, () => {
      const chunk = new TextEncoder().encode(" ".repeat(1024 * 1024));
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 5) controller.enqueue(chunk);
            else controller.close();
          },
        })
      );
    });
    expect(await rejection(streamed.client.organizations(ctx))).toMatchObject({
      kind: "bad-response",
      message: "The Akash Console's answer was too large",
    });
  });

  it("refuses a success it can't parse", async () => {
    const { client, fake } = setup();
    fake.fail("GET", /^\/organizations$/, () => new Response("not json", { status: 200 }));
    expect(await rejection(client.organizations(ctx))).toMatchObject({ kind: "bad-response" });
  });

  it("keeps a refusal's status and Retry-After when its body stalls", async () => {
    const { client, fake, paths } = setup({ timeoutMs: 20 });
    fake.fail("GET", /^\/organizations$/, (request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError"))
          );
        },
      });
      return new Response(body, { status: 429, headers: { "retry-after": "120" } });
    });
    const error = await rejection(client.organizations(ctx));
    expect(error).toMatchObject({ kind: "rate-limited", status: 429, retryAfterMs: 120_000 });
    expect(paths("/organizations")).toHaveLength(1);
  });

  it("asks again when another refusal's body stalls, since its code is in the body", async () => {
    const { provider, fake, credentials, paths } = setup({ timeoutMs: 20 });
    fake.fail("GET", /^\/projects$/, (request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError"))
          );
        },
      });
      return new Response(body, { status: 403 });
    });
    const error = await rejection(provider.validate(credentials(BOUND_KEY, TEAM_DEFAULT)));
    expect(error).toMatchObject({ kind: "wrong-scope", code: "project_forbidden" });
    expect(paths("/projects")).toHaveLength(2);
  });
});

describe("AkashProvider declarations", () => {
  it("passes every check a built-in registration makes", () => {
    const { provider, fake } = setup();
    const registry = new CloudProviderRegistry();
    expect(() =>
      registry.register(provider, { owner: { kind: "built-in" }, apiUrl: fake.baseUrl })
    ).not.toThrow();
    const info = provider.info("linux");
    expect(info).toMatchObject({ stopMode: "delete-only", createMode: "offers" });
    expect(info.credentialFields).toEqual([
      expect.objectContaining({ id: "apiKey", secret: true, required: true, input: "single-line" }),
    ]);
    expect(info.capabilities).toMatchObject({
      deletion: true,
      transport: "direct",
      sshTrust: "confirm-on-first-connect",
      lifetime: { kind: "none" },
    });
    expect(info.capabilities.provisioning).toMatchObject({
      location: "required",
      sshKey: "at-create",
    });
    expect(info.unsupportedReason).toBeNull();
    expect(provider.info("win32").unsupportedReason).toMatch(/WSL/);
  });

  it("refuses a one-request create for good, without asking the Console", async () => {
    const { provider, fake, credentials } = setup();
    const contract: CloudProvider = provider;
    const create = provider.describeError(
      await rejection(contract.create(credentials(TEAM_KEY, TEAM_AGENTS), orderRequest()))
    );
    expect(create).toMatchObject({ code: "unsupported" });
    expect(create.message).toMatch(/offer/);
    expect(fake.requests).toHaveLength(0);
    // Placing an order twice for one lost answer would place two.
    expect(contract.createReplay).toBe("lookup-only");
  });

  it("is built only with Daintree's host image, named by digest", () => {
    const client = () => {
      throw new Error("unused");
    };
    for (const hostImage of [
      "ghcr.io/daintreehq/daintree-host:1.0.0",
      `evil.test/${HOST_IMAGE}`,
      "ghcr.io/someone/daintree-host@sha256:" + "a".repeat(64),
      `${HOST_IMAGE}0`,
    ]) {
      expect(() => new AkashProvider(client, { hostImage })).toThrow(/digest/);
    }
  });
});

const BINDING = "cb_0123456789ab";
const CREATE_KEY = "550e8400-e29b-41d4-a716-446655440000";
// A real ed25519 public key, made for these tests; its private half was never kept.
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILcFNx+78F0OkTxtjczpD3lFD4F7jGgYhUdsFBuikMxd daintree-cb_0123456789ab";
const LABELS = { daintree: "1", "daintree-binding": BINDING };
const MARK = `[daintree=1 daintree-binding=${BINDING} daintree-create=${CREATE_KEY}]`;

function orderRequest(extra: Partial<ProviderCreateRequest> = {}): ProviderCreateRequest {
  return {
    name: "Build host",
    machineType: "akash-8c-32g",
    lifetimeSeconds: null,
    provisioning: { location: "eu-west", image: null, network: null },
    labels: { ...LABELS },
    idempotencyKey: CREATE_KEY,
    publicKey: PUBLIC_KEY,
    ...extra,
  };
}

function coded(status: number, code: string, message = code): Response {
  return reply(status, { error: "Error", message, code, type: "client_error" });
}

/** The team key's account in its Agents project, with one order placed and its dseq. */
async function placed(extra: Partial<ProviderCreateRequest> = {}) {
  const context = setup();
  const account = context.credentials(TEAM_KEY, TEAM_AGENTS);
  const order = await context.provider.offerCreate.placeOrder(account, orderRequest(extra));
  const dseq = order.id.split("/")[1]!;
  const deployment = context.fake.deployments.find((entry) => entry.dseq === dseq)!;
  // Another Daintree, or the same one after a restart: nothing carried over but the account.
  const fresh = () => new AkashProvider(() => context.client, { hostImage: HOST_IMAGE });
  return { ...context, account, order, dseq, deployment, fresh };
}

/** A placed order with one bid, leased. */
async function leasedOrder(price = "1000") {
  const context = await placed();
  context.fake.bid(context.dseq, "akash1chosen", price);
  const [offer] = await context.provider.offerCreate.listOffers(context.account, context.order.id);
  const machine = await context.provider.offerCreate.leaseOffer(
    context.account,
    context.order.id,
    offer!.id
  );
  return { ...context, offer: offer!, machine };
}

/** A deployment someone else made in the account's project, as the fake files it. */
function seed(
  fake: FakeAkashConsole,
  name: string | null,
  extra: Partial<FakeAkashDeployment> = {}
): FakeAkashDeployment {
  fake.height++;
  const deployment: FakeAkashDeployment = {
    owner: fakeAkashWallet(TEAM_ORG),
    dseq: String(fake.height),
    organizationId: TEAM_ORG,
    projectId: TEAM_AGENTS,
    name,
    state: "active",
    createdHeight: fake.height,
    groupState: "open",
    definition: null,
    secretEnv: undefined,
    bids: [],
    leases: [],
    ...extra,
  };
  fake.deployments.push(deployment);
  return deployment;
}

function liveLease(fake: FakeAkashConsole, provider = "akash1p"): FakeAkashLease {
  return {
    provider,
    gseq: 1,
    oseq: 1,
    bseq: 1,
    state: "active",
    price: "1",
    createdHeight: fake.height,
    forwarded: { host: `${provider}.ingress.test`, externalPort: 30_001 },
  };
}

const teamWalletOf = () => fakeAkashWallet(TEAM_ORG);

const sent = (fake: FakeAkashConsole, method: string, path: string) =>
  fake.requests.filter((request) => request.method === method && request.path === path);

const writes = (fake: FakeAkashConsole) =>
  fake.requests.filter((request) => request.method !== "GET").length;

function code(provider: AkashProvider, error: unknown): string {
  return provider.describeError(error).code;
}

function claimant(id: string, resourceId: string | null): StoredCloudBinding {
  return {
    id,
    hostId: id,
    accountId: "ca_0123456789",
    providerId: "akash" as CloudProviderId,
    resourceId,
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    creation: null,
    lifetimeSeconds: null,
    intent: "run",
    observation: null,
    access: null,
    trustedHostKey: null,
    offeredHostKey: null,
    lastError: null,
    createdAt: 1,
  } as StoredCloudBinding;
}

describe("Akash deployment names", () => {
  it("writes the labels and key it reads back, encoded so no value can end the mark", () => {
    const labels = { daintree: "1", "daintree-binding": "a b]=[c%" };
    const name = akashMarkedName("My [box]", labels, "k y");
    expect(name).toBe(
      "My [box] [daintree=1 daintree-binding=a%20b%5D%3D%5Bc%25 daintree-create=k%20y]"
    );
    expect(parseAkashName(name)).toEqual({
      display: "My [box]",
      labels,
      createKey: "k y",
      suffix: "[daintree=1 daintree-binding=a%20b%5D%3D%5Bc%25 daintree-create=k%20y]",
    });
  });

  it("takes anything but a create's own mark at the very end as name", () => {
    for (const name of [
      "Plain name",
      "Ends [with brackets of its own]",
      "Labels but no create [daintree=1 daintree-binding=cb_0123456789ab]",
      "Half [daintree=1",
      `Then text ${MARK} after`,
      `Twice [daintree-create=a daintree-create=b]`,
      "Twice [daintree=1 daintree=2 daintree-create=a]",
      "Bad escape [daintree-create=%E0%A4%A]",
      null,
    ]) {
      expect(parseAkashName(name)).toMatchObject({
        display: name ?? "",
        labels: {},
        createKey: null,
        suffix: null,
      });
    }
  });

  it("refuses a label it couldn't read back, and a name past the Console's 256 characters", () => {
    expect(() => akashMarkedName("x", { "Has Space": "1" }, CREATE_KEY)).toThrow(AkashApiError);
    expect(() => akashMarkedName("x", { "daintree-create": "1" }, CREATE_KEY)).toThrow(
      AkashApiError
    );
    expect(() => akashMarkedName("x", LABELS, "\uD800")).toThrow(AkashApiError);
    const room = 256 - MARK.length - 1;
    expect(akashMarkedName("x".repeat(room), LABELS, CREATE_KEY)).toHaveLength(256);
    expect(() => akashMarkedName("x".repeat(room + 1), LABELS, CREATE_KEY)).toThrow(/too long/);
  });

  it("keeps a deployment's mark through a rename, and adds none to one without", () => {
    expect(akashRenamed(`Old ${MARK}`, "New")).toBe(`New ${MARK}`);
    expect(akashRenamed("Someone's [notes]", "New")).toBe("New");
    expect(() => akashRenamed(`Old ${MARK}`, "x".repeat(256))).toThrow(/too long/);
  });
});

describe("AkashProvider orders and machines", () => {
  it("places an order, offers its bids, leases the chosen one, then reaches, renames and closes it", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    const wallet = fakeAkashWallet(TEAM_ORG);
    expect(order).toEqual({ id: `${wallet}/${dseq}` });
    const [create] = sent(fake, "POST", "/deployments");
    expect(create).toMatchObject({ apiKey: TEAM_KEY, projectId: TEAM_AGENTS });
    const data = (create!.body as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      projectId: TEAM_AGENTS,
      secretEnv: [],
      name: `Build host ${MARK}`,
    });
    expect(data.definition).toEqual({
      version: "2.0",
      services: {
        daintree: {
          image: HOST_IMAGE,
          env: [`DAINTREE_AUTHORIZED_KEYS=${PUBLIC_KEY}`],
          expose: [{ port: 22, proto: "tcp", to: [{ global: true }] }],
        },
      },
      profiles: {
        compute: {
          daintree: {
            resources: {
              cpu: { units: 8, attributes: { arch: "amd64" } },
              memory: { size: "32Gi" },
              storage: [{ size: "200Gi" }],
            },
          },
        },
        placement: {
          region: {
            attributes: { "location-region": "eu-west" },
            signedBy: { anyOf: [AUDITOR] },
            pricing: { daintree: { denom: "uact", amount: 100_000 } },
          },
        },
      },
      deployment: { daintree: { region: { profile: "daintree", count: 1 } } },
    });

    // Offers arrive while the person waits; none yet is no answer.
    expect(await provider.offerCreate.listOffers(account, order.id)).toEqual([]);
    fake.bid(dseq, "akash1cheap", "800.5");
    fake.bid(dseq, "akash1dear", "2000");
    const offers = await provider.offerCreate.listOffers(account, order.id);
    expect(offers).toEqual([
      expect.objectContaining({
        choosable: true,
        reason: null,
        bidder: { id: "akash1cheap", name: "akash1cheap", region: null },
      }),
      expect.objectContaining({ choosable: true, reason: null }),
    ]);
    expect(offers[0]!.hourlyDollars).toBeCloseTo(0.4803, 9);
    expect(offers[1]!.hourlyDollars).toBeCloseTo(1.2, 9);

    const machine = await provider.offerCreate.leaseOffer(account, order.id, offers[1]!.id);
    expect(sent(fake, "POST", "/leases").map((request) => request.body)).toEqual([
      { leases: [{ dseq, gseq: 1, oseq: 1, provider: "akash1dear" }] },
    ]);
    expect(machine).toMatchObject({
      resourceId: order.id,
      name: "Build host",
      machine: "running",
      machineType: "akash-8c-32g",
      vcpu: 8,
      memoryGB: 32,
      labels: LABELS,
      error: null,
    });
    // When the order was placed, from its block: the person may take a while to choose.
    expect(machine.createdAt).toBe(fake.blockTime(deployment.createdHeight));
    const after = await provider.offerCreate.listOffers(account, order.id);
    expect(after.map((offer) => [offer.bidder.id, offer.choosable, offer.reason])).toEqual([
      ["akash1cheap", false, "Another offer was leased"],
      ["akash1dear", false, "Already leased"],
    ]);

    expect(await provider.inspect(account, order.id)).toMatchObject({
      machine: "running",
      machineType: "akash-8c-32g",
      labels: LABELS,
    });
    expect(await provider.list(account)).toEqual([
      expect.objectContaining({ resourceId: order.id, machine: "running", vcpu: 8 }),
    ]);
    expect(await provider.sshAccess!(account, order.id)).toEqual({
      user: "daintree",
      endpoint: {
        host: "akash1dear.ingress.test",
        port: deployment.leases[0]!.forwarded!.externalPort,
      },
      hostKey: null,
    });

    await provider.rename(account, order.id, "Renamed host");
    expect(deployment.name).toBe(`Renamed host ${MARK}`);
    expect(await provider.inspect(account, order.id)).toMatchObject({ name: "Renamed host" });

    await provider.delete(account, order.id);
    expect(deployment.leases[0]!.state).toBe("closed");
    expect(await provider.inspect(account, order.id)).toMatchObject({ machine: "deleted" });
    // Already closed: done, with no second close sent.
    await provider.delete(account, order.id);
    expect(sent(fake, "DELETE", `/deployments/${dseq}`)).toHaveLength(1);
    expect(await provider.list(account)).toEqual([]);
  });

  it("asks for each size in the chain's terms and reads it back as that size", async () => {
    const { fake, provider, account, order, dseq } = await placed({
      machineType: "akash-4c-16g",
      provisioning: { location: "NA-US-West", image: null, network: null },
    });
    const definition = (
      sent(fake, "POST", "/deployments")[0]!.body as {
        data: { definition: { profiles: Record<string, Record<string, unknown>> } };
      }
    ).data.definition;
    expect(definition.profiles.compute).toEqual({
      daintree: {
        resources: {
          cpu: { units: 4, attributes: { arch: "amd64" } },
          memory: { size: "16Gi" },
          storage: [{ size: "100Gi" }],
        },
      },
    });
    expect(definition.profiles.placement).toMatchObject({
      region: { attributes: { "location-region": "na-us-west" } },
    });
    fake.bid(dseq, "akash1p", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    await provider.offerCreate.leaseOffer(account, order.id, offer!.id);
    expect(await provider.list(account)).toEqual([
      expect.objectContaining({ machineType: "akash-4c-16g", vcpu: 4, memoryGB: 16 }),
    ]);
    expect(await provider.inspect(account, order.id)).toMatchObject({
      machineType: "akash-4c-16g",
      vcpu: 4,
      memoryGB: 16,
    });
  });

  it("checks what it would send before placing anything", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    for (const extra of [
      { machineType: "akash-3c-7g" },
      { provisioning: { location: null, image: null, network: null } },
      { provisioning: { location: "  ", image: null, network: null } },
      { publicKey: null },
      { publicKey: "ssh-ed25519 AAAA" },
      { publicKey: PUBLIC_KEY.replace("ssh-ed25519", "ssh-rsa") },
      { publicKey: `${PUBLIC_KEY}\nssh-ed25519 AAAAsecond` },
      { name: "x".repeat(200) },
    ]) {
      expect(
        code(
          provider,
          await rejection(provider.offerCreate.placeOrder(account, orderRequest(extra)))
        )
      ).toBe("refused");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("tells an order Console refused from one that may have been placed", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    const place = () => provider.offerCreate.placeOrder(account, orderRequest());
    fake.fail("POST", /^\/deployments$/, () =>
      reply(404, { statusCode: 404, message: "Unknown project" })
    );
    expect(code(provider, await rejection(place()))).toBe("credential-invalid");
    fake.fail("POST", /^\/deployments$/, () => coded(503, "deposit_price_unavailable"));
    expect(code(provider, await rejection(place()))).toBe("refused");
    fake.fail("POST", /^\/deployments$/, () => coded(403, "project_budget_exceeded"));
    expect(code(provider, await rejection(place()))).toBe("billing");
    // An outage could have placed it: never a refusal, and never sent twice.
    fake.fail("POST", /^\/deployments$/, () => reply(503, { statusCode: 503, message: "down" }));
    expect(code(provider, await rejection(place()))).toBe("outcome-unknown");
    expect(sent(fake, "POST", "/deployments")).toHaveLength(4);
    expect(fake.deployments).toHaveLength(0);
  });

  it("finds an order whose answer was lost from its labels and key alone, and only that create's", async () => {
    const { fake, provider, credentials, client } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    fake.lose("POST", /^\/deployments$/);
    expect(
      code(provider, await rejection(provider.offerCreate.placeOrder(account, orderRequest())))
    ).toBe("outcome-unknown");
    const [made] = fake.deployments;
    // What must not match: another create's key, a longer key holding this one, the key only
    // as text, the same key for another binding, an order already leased, one whose group
    // isn't open, one closed, and another project's.
    await provider.offerCreate.placeOrder(account, orderRequest({ idempotencyKey: "another-key" }));
    seed(fake, `Long [daintree=1 daintree-binding=${BINDING} daintree-create=${CREATE_KEY}-2]`);
    seed(fake, `Notes on daintree-create=${CREATE_KEY}`);
    seed(fake, `Other [daintree=1 daintree-binding=cb_ffffffffffff daintree-create=${CREATE_KEY}]`);
    seed(fake, `Leased ${MARK}`, { leases: [{ ...liveLease(fake), state: "closed" }] });
    seed(fake, `Paused ${MARK}`, { groupState: "paused" });
    seed(fake, `Closed ${MARK}`, { state: "closed", groupState: "closed" });
    seed(fake, `Elsewhere ${MARK}`, { projectId: TEAM_DEFAULT });

    const match = { labels: LABELS, idempotencyKey: CREATE_KEY };
    const wallet = fakeAkashWallet(TEAM_ORG);
    const fresh = new AkashProvider(() => client, { hostImage: HOST_IMAGE });
    expect(await fresh.offerCreate.findOrders(account, match)).toEqual([
      { id: `${wallet}/${made!.dseq}` },
    ]);
    // A second order placed for the same create is found beside it.
    const second = seed(fake, `Build host ${MARK}`);
    expect(await fresh.offerCreate.findOrders(account, match)).toEqual([
      { id: `${wallet}/${made!.dseq}` },
      { id: `${wallet}/${second.dseq}` },
    ]);
    expect(
      await fresh.offerCreate.findOrders(account, { ...match, labels: { daintree: "1" } })
    ).toEqual([]);
    // Looking never places anything.
    expect(sent(fake, "POST", "/deployments")).toHaveLength(2);
  });

  it("reads every page, as the Console pages them, when it won't search that many deployments", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    for (let index = 0; index < 150; index++) seed(fake, `Someone's ${index}`);
    const order = await provider.offerCreate.placeOrder(account, orderRequest());
    fake.searchCap = 10;
    // Pages shorter than asked for, and no total: only `hasMore` says when to stop.
    fake.pageCap = 60;
    fake.totalUnknown = true;
    expect(
      await provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([order]);
    const listed = sent(fake, "GET", "/deployments").map((request) =>
      Object.fromEntries(new URLSearchParams(request.search))
    );
    expect(listed).toEqual([
      expect.objectContaining({ search: `daintree-create=${CREATE_KEY}`, skip: "0" }),
      expect.objectContaining({ skip: "0", limit: "100", projectId: TEAM_AGENTS }),
      expect.objectContaining({ skip: "59", limit: "100", projectId: TEAM_AGENTS }),
      expect.objectContaining({ skip: "118", limit: "100", projectId: TEAM_AGENTS }),
    ]);
    expect(listed.slice(1).every((query) => !("search" in query))).toBe(true);
    expect(
      sent(fake, "GET", "/deployments").every((request) => request.projectId === TEAM_AGENTS)
    ).toBe(true);
  });

  it("starts over when the list moves while it is read, rather than miss a row", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    const first = seed(fake, "Someone's first");
    for (let index = 0; index < 120; index++) seed(fake, `Someone's ${index}`);
    const order = await provider.offerCreate.placeOrder(account, orderRequest());
    fake.searchCap = 0;
    let moved = false;
    fake.onAnswered = (request) => {
      // Right after the first plain page: one row leaves, and every later row moves up.
      if (!moved && request.path === "/deployments" && !request.search.includes("search")) {
        moved = true;
        first.state = "closed";
      }
    };
    expect(
      await provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([order]);
    const skips = sent(fake, "GET", "/deployments")
      .slice(1)
      .map((request) => new URLSearchParams(request.search).get("skip"));
    expect(skips).toEqual(["0", "99", "0", "99"]);
  });

  it("refuses rather than half-answers when the Console won't list, searched or not", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    fake.fail("GET", /^\/deployments$/, () => coded(403, "project_forbidden"));
    const error = await rejection(
      provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    );
    expect(code(provider, error)).toBe("permission");
    expect(sent(fake, "GET", "/deployments")).toHaveLength(1);
  });

  it("finds a lease whose answer was lost, and never closes it as an unchosen order", async () => {
    const sentAt = Date.now();
    const { fake, provider, account, order, dseq, deployment, fresh } = await placed();
    fake.bid(dseq, "akash1chosen", "1500");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    // The lease is made, its answer lost, and the order can't be read back either.
    fake.lose("POST", /^\/leases$/);
    fake.onAnswered = (request) => {
      if (request.method === "POST" && request.path === "/leases") {
        fake.onAnswered = null;
        fake.fail(
          "GET",
          new RegExp(`^/deployments/${dseq}$`),
          () => new TypeError("fetch failed"),
          3
        );
      }
    };
    expect(
      code(provider, await rejection(provider.offerCreate.leaseOffer(account, order.id, offer!.id)))
    ).toBe("outcome-unknown");
    // A decoy that only names the binding in its display, and carries another's mark.
    seed(
      fake,
      `daintree-binding=${BINDING} [daintree=1 daintree-binding=cb_ffffffffffff daintree-create=x]`,
      {
        leases: [liveLease(fake)],
      }
    );

    const recovering = fresh();
    expect(
      await recovering.offerCreate.findOrders(account, {
        labels: LABELS,
        idempotencyKey: CREATE_KEY,
      })
    ).toEqual([]);
    const label = `daintree-binding=${BINDING}`;
    const found = await recovering.list(account, { label, location: "eu-west" });
    expect(found).toEqual([
      expect.objectContaining({ resourceId: order.id, machine: "running", labels: LABELS }),
    ]);
    // Dated by the order's block, as the lifecycle's own lookup checks a create's machine.
    expect(found[0]!.createdAt).toBe(fake.blockTime(deployment.createdHeight));
    expect(madeInSendWindow(sentAt, found[0]!.createdAt)).toBe(true);
    expect(await recovering.list(account, { label, location: "na-us-west" })).toEqual([]);

    expect(await recovering.offerCreate.closeOrder(account, order.id)).toEqual({
      kind: "leased",
      resource: expect.objectContaining({ resourceId: order.id, machine: "running" }),
    });
    // Choosing it again answers with the machine it leased, sending nothing.
    expect(await recovering.offerCreate.leaseOffer(account, order.id, offer!.id)).toMatchObject({
      resourceId: order.id,
      machine: "running",
      error: null,
    });
    expect(sent(fake, "POST", "/leases")).toHaveLength(1);
    expect(sent(fake, "DELETE", `/deployments/${dseq}`)).toHaveLength(0);
  });

  it("reads a lease's answer back from the order when the answer itself was lost", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    fake.bid(dseq, "akash1chosen", "1500");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.lose("POST", /^\/leases$/);
    expect(await provider.offerCreate.leaseOffer(account, order.id, offer!.id)).toMatchObject({
      resourceId: order.id,
      machine: "running",
      error: null,
    });
    // An answer it can't read is read back the same way.
    const other = await placed();
    other.fake.bid(other.dseq, "akash1chosen", "1500");
    const [chosen] = await other.provider.offerCreate.listOffers(other.account, other.order.id);
    other.fake.commitThen("POST", /^\/leases$/, () => reply(200, { data: { leases: [{}] } }));
    expect(
      await other.provider.offerCreate.leaseOffer(other.account, other.order.id, chosen!.id)
    ).toMatchObject({ resourceId: other.order.id, machine: "running" });
  });

  it("won't let a block it couldn't read pass for a create's machine made at an unknown time", async () => {
    const { fake, account, fresh } = await leasedOrder();
    const recovering = fresh();
    fake.fail("GET", /^\/blocks\//, () => reply(503, { statusCode: 503, message: "down" }), 3);
    const lookup = await rejection(
      recovering.list(account, { label: `daintree-binding=${BINDING}` })
    );
    expect(code(recovering, lookup)).toBe("provider-unreachable");
    // The import list shows the machine, its time unknown.
    fake.fail("GET", /^\/blocks\//, () => reply(503, { statusCode: 503, message: "down" }), 3);
    expect(await recovering.list(account)).toEqual([expect.objectContaining({ createdAt: null })]);
    // Public, so no key goes with it.
    const blocks = fake.requests.filter((request) => request.path.startsWith("/blocks/"));
    expect(blocks.every((request) => request.apiKey === null && request.projectId === null)).toBe(
      true
    );
  });

  it("finds a machine the create made and deleted since, dated apart from a later copy", async () => {
    const sentAt = Date.now();
    const { fake, provider, account, order } = await leasedOrder();
    await provider.delete(account, order.id);
    // Someone made a copy with the same name an hour and a half on.
    fake.height += 900;
    const copy = seed(fake, `Build host ${MARK}`, { leases: [liveLease(fake)] });
    seed(fake, `Other [daintree=1 daintree-binding=${BINDING}0 daintree-create=x]`, {
      state: "closed",
      leases: [{ ...liveLease(fake), state: "closed" }],
    });
    const found = await provider.list(account, { label: `daintree-binding=${BINDING}` });
    expect(found).toHaveLength(2);
    const original = found.find((resource) => resource.resourceId === order.id);
    const later = found.find((resource) => resource.resourceId.endsWith(`/${copy.dseq}`));
    expect(original).toMatchObject({ machine: "deleted" });
    expect(later).toMatchObject({ machine: "running" });
    expect(madeInSendWindow(sentAt, original!.createdAt)).toBe(true);
    expect(madeInSendWindow(sentAt, later!.createdAt)).toBe(false);
    // The import list shows only what runs now.
    expect((await provider.list(account)).map((resource) => resource.resourceId)).toEqual([
      later!.resourceId,
    ]);
  });

  it("refuses an offer that has gone, sending nothing and leaving the order open", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    const withdrawn = fake.bid(dseq, "akash1gone", "1000");
    fake.bid(dseq, "akash1down", "1100");
    fake.bid(dseq, "akash1fine", "1200");
    const offers = await provider.offerCreate.listOffers(account, order.id);
    withdrawn.state = "closed";
    const gone = await rejection(provider.offerCreate.leaseOffer(account, order.id, offers[0]!.id));
    expect(gone).toMatchObject({ kind: "offer-gone" });
    expect(code(provider, gone)).toBe("refused");
    expect(sent(fake, "POST", "/leases")).toHaveLength(0);

    // Console couldn't reach the provider: it says nothing was leased.
    fake.unreachableProviders.add("akash1down");
    const unreachable = await rejection(
      provider.offerCreate.leaseOffer(account, order.id, offers[1]!.id)
    );
    expect(unreachable).toMatchObject({ kind: "offer-gone", code: "provider_unreachable" });
    expect(deployment.leases).toHaveLength(0);
    expect(
      await provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([order]);

    // Another offer is still there to choose.
    expect(await provider.offerCreate.leaseOffer(account, order.id, offers[2]!.id)).toMatchObject({
      machine: "running",
    });
    // Once one is leased, another never is, and a machine stands: not a refusal.
    withdrawn.state = "open";
    const taken = await rejection(
      provider.offerCreate.leaseOffer(account, order.id, offers[0]!.id)
    );
    expect(code(provider, taken)).toBe("outcome-unknown");
    expect(sent(fake, "POST", "/leases")).toHaveLength(2);
  });

  it("won't choose between two open offers from one provider, which a lease can't tell apart", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    fake.bid(dseq, "akash1twice", "1000", "uact", null, 1);
    fake.bid(dseq, "akash1twice", "900", "uact", null, 2);
    const offers = await provider.offerCreate.listOffers(account, order.id);
    expect(offers.map((offer) => [offer.choosable, offer.reason])).toEqual([
      [false, "The provider made more than one offer on this order"],
      [false, "The provider made more than one offer on this order"],
    ]);
    expect(offers[0]!.id).not.toBe(offers[1]!.id);
    expect(
      code(
        provider,
        await rejection(provider.offerCreate.leaseOffer(account, order.id, offers[1]!.id))
      )
    ).toBe("refused");
    expect(sent(fake, "POST", "/leases")).toHaveLength(0);
  });

  it("says so when the provider swapped its offer as it was leased", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    const bid = fake.bid(dseq, "akash1swap", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.onAnswered = (request) => {
      // Between the read and the lease, the provider withdraws and bids again, dearer.
      if (request.path === "/bids" && bid.state === "open") {
        fake.onAnswered = null;
        bid.state = "closed";
        fake.bid(dseq, "akash1swap", "3000", "uact", null, 2);
      }
    };
    const machine = await provider.offerCreate.leaseOffer(account, order.id, offer!.id);
    expect(deployment.leases[0]).toMatchObject({ bseq: 2, price: "3000" });
    expect(machine).toMatchObject({
      machine: "error",
      error: expect.stringMatching(/replaced its offer.*\$1\.8000 an hour/),
    });
  });

  it("sends a lease again while its manifest doesn't arrive, and reports what then stands", async () => {
    const delivered = await placed();
    delivered.fake.bid(delivered.dseq, "akash1slow", "1000");
    const [slow] = await delivered.provider.offerCreate.listOffers(
      delivered.account,
      delivered.order.id
    );
    delivered.fake.manifestFailures = 1;
    expect(
      await delivered.provider.offerCreate.leaseOffer(
        delivered.account,
        delivered.order.id,
        slow!.id
      )
    ).toMatchObject({ machine: "running", error: null });
    const bodies = sent(delivered.fake, "POST", "/leases").map((request) => request.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(delivered.deployment.leases).toHaveLength(1);
    expect(delivered.fake.manifestSends).toBe(2);
    await delivered.provider.sshAccess!(delivered.account, delivered.order.id);

    const stuck = await placed();
    stuck.fake.bid(stuck.dseq, "akash1slow", "1000");
    const [late] = await stuck.provider.offerCreate.listOffers(stuck.account, stuck.order.id);
    stuck.fake.manifestFailures = 2;
    const pending = await stuck.provider.offerCreate.leaseOffer(
      stuck.account,
      stuck.order.id,
      late!.id
    );
    expect(pending).toMatchObject({
      resourceId: stuck.order.id,
      error: expect.stringMatching(/hasn't taken/),
    });
    expect(stuck.fake.manifestSends).toBe(2);
    expect(stuck.deployment.leases).toHaveLength(1);
    expect(
      code(
        stuck.provider,
        await rejection(stuck.provider.sshAccess!(stuck.account, stuck.order.id))
      )
    ).toBe("provider-unreachable");
    // Choosing it again sends the manifest again, since the provider still reports nothing.
    expect(
      await stuck.provider.offerCreate.leaseOffer(stuck.account, stuck.order.id, late!.id)
    ).toMatchObject({
      machine: "running",
      error: null,
    });
    expect(stuck.fake.manifestSends).toBe(3);
    expect(stuck.deployment.leases).toHaveLength(1);
    await stuck.provider.sshAccess!(stuck.account, stuck.order.id);
  });

  it("answers a lease the provider refused as invalid with the machine, failed, to delete", async () => {
    for (const failuresFirst of [0, 1]) {
      const { fake, provider, account, order, dseq, deployment } = await placed();
      fake.bid(dseq, "akash1strict", "1000");
      const [strict] = await provider.offerCreate.listOffers(account, order.id);
      fake.manifestFailures = failuresFirst;
      fake.manifestInvalid = true;
      const refused = await provider.offerCreate.leaseOffer(account, order.id, strict!.id);
      expect(refused).toMatchObject({
        resourceId: order.id,
        machine: "error",
        error: expect.stringMatching(/invalid/),
      });
      expect(fake.manifestSends).toBe(failuresFirst + 1);
      expect(deployment.leases).toHaveLength(1);
      expect(deployment.leases[0]!.forwarded).toBeNull();
    }
  });

  it("closes an order nobody chose, once, and answers one already closed as closed", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    expect(await provider.offerCreate.closeOrder(account, order.id)).toEqual({ kind: "closed" });
    expect(deployment.state).toBe("closed");
    expect(code(provider, await rejection(provider.inspect(account, order.id)))).toBe("not-found");
    expect(
      await provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([]);
    expect(await provider.offerCreate.closeOrder(account, order.id)).toEqual({ kind: "closed" });
    expect(
      await provider.offerCreate.closeOrder(account, `${fakeAkashWallet(TEAM_ORG)}/999`)
    ).toEqual({
      kind: "closed",
    });
    expect(fake.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
    expect(sent(fake, "DELETE", `/deployments/${dseq}`)).toHaveLength(1);
  });

  it("never sends an order's close twice, and says when a lease landed under it", async () => {
    const lost = await placed();
    lost.fake.lose("DELETE", /^\/deployments\/\d+$/);
    expect(
      code(
        lost.provider,
        await rejection(lost.provider.offerCreate.closeOrder(lost.account, lost.order.id))
      )
    ).toBe("provider-unreachable");
    expect(sent(lost.fake, "DELETE", `/deployments/${lost.dseq}`)).toHaveLength(1);
    expect(await lost.provider.offerCreate.closeOrder(lost.account, lost.order.id)).toEqual({
      kind: "closed",
    });

    const raced = await placed();
    raced.fake.bid(raced.dseq, "akash1quick", "1000");
    raced.fake.onAnswered = (request) => {
      // Someone leases the order on the Akash Console between the read and the close.
      if (request.method === "GET" && request.path === `/deployments/${raced.dseq}`) {
        raced.fake.onAnswered = null;
        raced.deployment.bids[0]!.state = "active";
        raced.deployment.leases.push(liveLease(raced.fake, "akash1quick"));
      }
    };
    expect(await raced.provider.offerCreate.closeOrder(raced.account, raced.order.id)).toEqual({
      kind: "leased",
      resource: expect.objectContaining({ resourceId: raced.order.id, machine: "deleted" }),
    });

    const unclear = await placed();
    unclear.fake.fail("DELETE", /^\/deployments\/\d+$/, () =>
      reply(200, { data: { success: false } })
    );
    expect(
      await rejection(unclear.provider.offerCreate.closeOrder(unclear.account, unclear.order.id))
    ).toMatchObject({ kind: "bad-response" });
  });

  it("sends a machine's close again after a lost answer, since closing it twice closes nothing more", async () => {
    const { fake, provider, account, order, dseq, deployment } = await leasedOrder();
    fake.lose("DELETE", /^\/deployments\/\d+$/);
    await provider.delete(account, order.id);
    expect(sent(fake, "DELETE", `/deployments/${dseq}`)).toHaveLength(2);
    expect(deployment.state).toBe("closed");
  });

  it("reaches a running machine at the port its provider forwards now", async () => {
    const { fake, provider, account, order, dseq, deployment } = await leasedOrder();
    const lease = deployment.leases[0]!;
    const first = await provider.sshAccess!(account, order.id);
    lease.forwarded = { host: lease.forwarded!.host, externalPort: 32_999 };
    const second = await provider.sshAccess!(account, order.id);
    expect(first.endpoint).toEqual({ host: "akash1chosen.ingress.test", port: 31_022 });
    expect(second.endpoint).toEqual({ host: "akash1chosen.ingress.test", port: 32_999 });
    // Each answer is read afresh from the Console.
    expect(sent(fake, "GET", `/deployments/${dseq}`).length).toBeGreaterThanOrEqual(2);

    // Of several, the daintree service's port 22 that answers.
    lease.ports = {
      other: [{ port: 22, externalPort: 1, host: "other.test", available: 1 }],
      daintree: [
        { port: 80, externalPort: 2, host: "web.test", available: 1 },
        { port: 22, externalPort: 3, host: "down.test", available: 0 },
        { port: 22, externalPort: 32_123, host: "up.test", available: 1 },
      ],
    };
    expect((await provider.sshAccess!(account, order.id)).endpoint).toEqual({
      host: "up.test",
      port: 32_123,
    });

    const reason = async () =>
      code(provider, await rejection(provider.sshAccess!(account, order.id)));
    // Not said yet: worth asking again.
    lease.ports = { daintree: [{ port: 22, externalPort: 3, host: "down.test", available: 0 }] };
    expect(await reason()).toBe("provider-unreachable");
    lease.ports = undefined;
    lease.forwarded = null;
    expect(await reason()).toBe("provider-unreachable");
    lease.forwarded = { host: null, externalPort: 32_999 };
    expect(await reason()).toBe("provider-unreachable");
    // Said, and unusable.
    lease.forwarded = { host: "not a host!", externalPort: 32_999 };
    expect(await reason()).toBe("failed");
    lease.forwarded = { host: "akash1chosen.ingress.test", externalPort: 70_000 };
    expect(await reason()).toBe("failed");
    // Reclaimed, it still runs until it ends.
    lease.forwarded = { host: "akash1chosen.ingress.test", externalPort: 32_999 };
    lease.state = "reclaiming";
    expect((await provider.sshAccess!(account, order.id)).endpoint.port).toBe(32_999);
    expect(await provider.inspect(account, order.id)).toMatchObject({
      machine: "running",
      error: expect.stringMatching(/reclaiming/),
    });
    // Out of funds, there is no container to reach.
    lease.state = "insufficient_funds";
    expect(await reason()).toBe("refused");
    expect(await provider.inspect(account, order.id)).toMatchObject({
      machine: "error",
      error: expect.stringMatching(/funds/),
    });
  });

  it("prices an offer as Console prices the lease it becomes", async () => {
    // Console's API counts 6-second blocks and 30.437-day months, and values uact at a
    // millionth of a dollar: akash-network/console 201f4e89d3d5b97ccf98403008c49e778f4c2161,
    // apps/api/src/utils/constants.ts L4-L8,
    // apps/api/src/deployment/services/deployment-reader/deployment-reader.service.ts L661-L682,
    // apps/deploy-web/src/utils/denomLabel.ts L6-L11 (6 decimals) and
    // apps/deploy-web/src/hooks/usePricing/usePricing.ts L37 (uact at $1 an ACT).
    const price = "1234.567890000000000000";
    const { fake, offer, dseq } = await leasedOrder(price);
    expect(offer.hourlyDollars).toBeCloseTo(0.740740734, 9);
    const wallet = fakeAkashWallet(TEAM_ORG);
    const shown = (await (
      await fake.fetch(`${fake.baseUrl}/deployment/${wallet}/${dseq}`)
    ).json()) as {
      totalMonthlyCostUDenom: number;
    };
    expect(shown.totalMonthlyCostUDenom).toBe(541_102_217);
    expect(akashMonthlyDollars(price)).toBe(shown.totalMonthlyCostUDenom / 1_000_000);
    // An hour's rate over Console's month comes to the same, short of its rounding.
    expect(offer.hourlyDollars * 24 * 30.437).toBeCloseTo(akashMonthlyDollars(price)!, 5);
    // Console rounds each lease's month to a whole uact, up as well as down.
    expect(akashMonthlyDollars("0.000002")).toBe(0.000001);
  });

  it("refuses an offer it can't price rather than quoting it at nothing", async () => {
    for (const [amount, denom] of [
      ["1000", "uakt"],
      ["1e5", "uact"],
      [`1${"0".repeat(400)}`, "uact"],
    ] as const) {
      const { fake, provider, account, order, dseq } = await placed();
      fake.bid(dseq, "akash1odd", amount, denom);
      expect(await rejection(provider.offerCreate.listOffers(account, order.id))).toMatchObject({
        kind: "bad-response",
      });
    }
  });

  it("keeps two wallets' deployments of the same number apart", async () => {
    const { fake, provider, credentials } = setup();
    const team = credentials(TEAM_KEY, TEAM_AGENTS);
    const personal = credentials(FAKE_AKASH_KEY, PERSONAL_DEFAULT);
    const teamWallet = fakeAkashWallet(TEAM_ORG);
    const myWallet = fakeAkashWallet(PERSONAL_ORG);
    fake.nextDseq = "4242";
    const teams = await provider.offerCreate.placeOrder(team, orderRequest());
    fake.nextDseq = "4242";
    const mine = await provider.offerCreate.placeOrder(personal, orderRequest());
    expect(teams.id).toBe(`${teamWallet}/4242`);
    expect(mine.id).toBe(`${myWallet}/4242`);
    fake.bid("4242", "akash1either", "1000", "uact", teamWallet);
    fake.bid("4242", "akash1either", "1000", "uact", myWallet);
    const [teamOffer] = await provider.offerCreate.listOffers(team, teams.id);
    const [myOffer] = await provider.offerCreate.listOffers(personal, mine.id);
    const teamMachine = await provider.offerCreate.leaseOffer(team, teams.id, teamOffer!.id);
    const myMachine = await provider.offerCreate.leaseOffer(personal, mine.id, myOffer!.id);
    expect(teamMachine.resourceId).not.toBe(myMachine.resourceId);

    // A binding's claim on one is never a claim on the other.
    const held = claimant("cb_team0000000", teamMachine.resourceId);
    expect(cloudMachineClaim([held], "akash" as CloudProviderId, myMachine)).toBeNull();
    const both = [held, claimant("cb_mine0000000", myMachine.resourceId)];
    expect(cloudMachineClaim(both, "akash" as CloudProviderId, teamMachine)?.binding.id).toBe(
      "cb_team0000000"
    );
    expect(cloudMachineClaim(both, "akash" as CloudProviderId, myMachine)?.binding.id).toBe(
      "cb_mine0000000"
    );

    // The personal account, handed the team's id, finds its own 4242 and refuses it.
    const before = writes(fake);
    for (const call of [
      provider.inspect(personal, teams.id),
      provider.sshAccess!(personal, teams.id),
      provider.rename(personal, teams.id, "Mine now"),
      provider.delete(personal, teams.id),
      provider.offerCreate.leaseOffer(personal, teams.id, teamOffer!.id),
      provider.offerCreate.listOffers(personal, teams.id),
      provider.offerCreate.closeOrder(personal, teams.id),
    ]) {
      expect(code(provider, await rejection(call))).toBe("credential-invalid");
    }
    expect(writes(fake)).toBe(before);
    expect(await provider.inspect(team, teams.id)).toMatchObject({ machine: "running" });
  });

  it("keeps one wallet's projects apart, and never takes a machine elsewhere for one gone", async () => {
    const { fake, provider, account, order, dseq, deployment, credentials } = await leasedOrder();
    expect(await provider.inspect(account, order.id)).toMatchObject({ machine: "running" });
    const sibling = { ...account, scopeId: TEAM_DEFAULT };
    const before = writes(fake);
    expect(await provider.list(sibling)).toEqual([]);
    expect(
      await provider.offerCreate.findOrders(sibling, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([]);
    // Asked for by id, it is still the wallet's, in another project: the account's problem.
    for (const call of [
      provider.inspect(sibling, order.id),
      provider.delete(sibling, order.id),
      provider.rename(sibling, order.id, "x"),
      provider.offerCreate.closeOrder(sibling, order.id),
    ]) {
      expect(code(provider, await rejection(call))).toBe("credential-invalid");
    }
    expect(writes(fake)).toBe(before);
    // Each was asked in the account's project first, and only then the wallet's others.
    const reads = sent(fake, "GET", `/deployments/${dseq}`).slice(-8);
    expect(reads.filter((request) => request.projectId === TEAM_DEFAULT)).toHaveLength(4);
    expect(reads.filter((request) => request.projectId === null)).toHaveLength(4);
    expect(deployment.state).toBe("active");

    // One moved to another project on the Akash Console is neither deleted nor closed.
    deployment.projectId = TEAM_DEFAULT;
    expect(code(provider, await rejection(provider.delete(account, order.id)))).toBe(
      "credential-invalid"
    );
    expect(writes(fake)).toBe(before);
    // A key that can't see beyond its project can't tell, and says not found.
    const bound = credentials(BOUND_KEY, TEAM_AGENTS);
    expect(code(provider, await rejection(provider.inspect(bound, order.id)))).toBe("not-found");
  });

  it("finds a deployment whose archive can't be searched by reading the archive whole", async () => {
    const { fake, provider, account, order } = await leasedOrder();
    await provider.delete(account, order.id);
    fake.archiveSearchDown = true;
    expect(await provider.list(account, { label: `daintree-binding=${BINDING}` })).toEqual([
      expect.objectContaining({ resourceId: order.id, machine: "deleted" }),
    ]);
    const closed = sent(fake, "GET", "/deployments")
      .map((request) => new URLSearchParams(request.search))
      .filter((query) => query.get("state") === "closed");
    expect(closed.map((query) => query.has("search"))).toEqual([true, false]);
  });

  it("reads pages of a single row", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    for (let index = 0; index < 4; index++) seed(fake, `Someone's ${index}`);
    const order = await provider.offerCreate.placeOrder(account, orderRequest());
    fake.searchCap = 0;
    fake.pageCap = 1;
    expect(
      await provider.offerCreate.findOrders(account, { labels: LABELS, idempotencyKey: CREATE_KEY })
    ).toEqual([order]);
  });

  it("verifies an order with no bids yet is the account's own", async () => {
    const { fake, provider, credentials } = setup();
    const team = credentials(TEAM_KEY, TEAM_AGENTS);
    const personal = credentials(FAKE_AKASH_KEY, PERSONAL_DEFAULT);
    fake.nextDseq = "4242";
    const teams = await provider.offerCreate.placeOrder(team, orderRequest());
    fake.nextDseq = "4242";
    await provider.offerCreate.placeOrder(personal, orderRequest());
    expect(
      code(provider, await rejection(provider.offerCreate.listOffers(personal, teams.id)))
    ).toBe("credential-invalid");
    expect(await provider.offerCreate.listOffers(team, teams.id)).toEqual([]);
    expect(
      code(provider, await rejection(provider.offerCreate.listOffers(team, `${teamWalletOf()}/77`)))
    ).toBe("not-found");
  });

  it("refuses a create's lookup that can't date a block, rather than taking its time as unknown", async () => {
    const { fake, account, fresh } = await leasedOrder();
    const recovering = fresh();
    fake.fail("GET", /^\/blocks\//, () =>
      reply(404, { statusCode: 404, message: "Block not found" })
    );
    expect(
      await rejection(recovering.list(account, { label: `daintree-binding=${BINDING}` }))
    ).toMatchObject({ kind: "bad-response" });
    fake.fail("GET", /^\/blocks\//, () =>
      reply(404, { statusCode: 404, message: "Block not found" })
    );
    expect(await recovering.list(account)).toEqual([expect.objectContaining({ createdAt: null })]);
  });

  it("never reads a lease that may stand as refused", async () => {
    // An answer the Console didn't explain, with nothing leased yet: it may still be.
    const unexplained = await placed();
    unexplained.fake.bid(unexplained.dseq, "akash1p", "1000");
    const [first] = await unexplained.provider.offerCreate.listOffers(
      unexplained.account,
      unexplained.order.id
    );
    unexplained.fake.fail("POST", /^\/leases$/, () => reply(422, { statusCode: 422 }));
    expect(
      code(
        unexplained.provider,
        await rejection(
          unexplained.provider.offerCreate.leaseOffer(
            unexplained.account,
            unexplained.order.id,
            first!.id
          )
        )
      )
    ).toBe("outcome-unknown");
    // A plain refusal, with nothing leased, stands.
    unexplained.fake.fail("POST", /^\/leases$/, () =>
      reply(400, { statusCode: 400, message: "bad" })
    );
    expect(
      code(
        unexplained.provider,
        await rejection(
          unexplained.provider.offerCreate.leaseOffer(
            unexplained.account,
            unexplained.order.id,
            first!.id
          )
        )
      )
    ).toBe("refused");

    // A manifest refused as invalid means the lease exists, even when the order can't be read.
    const invalid = await placed();
    invalid.fake.bid(invalid.dseq, "akash1strict", "1000");
    const [strict] = await invalid.provider.offerCreate.listOffers(
      invalid.account,
      invalid.order.id
    );
    invalid.fake.manifestInvalid = true;
    invalid.fake.onAnswered = (request) => {
      if (request.method === "POST" && request.path === "/leases") {
        invalid.fake.onAnswered = null;
        invalid.fake.fail(
          "GET",
          new RegExp(`^/deployments/${invalid.dseq}$`),
          () => new TypeError("fetch failed"),
          3
        );
      }
    };
    expect(
      code(
        invalid.provider,
        await rejection(
          invalid.provider.offerCreate.leaseOffer(invalid.account, invalid.order.id, strict!.id)
        )
      )
    ).toBe("outcome-unknown");
  });

  it("sends the manifest again when the answer saying it failed was lost", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    fake.bid(dseq, "akash1slow", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.manifestFailures = 1;
    fake.lose("POST", /^\/leases$/);
    expect(await provider.offerCreate.leaseOffer(account, order.id, offer!.id)).toMatchObject({
      machine: "running",
      error: null,
    });
    expect(sent(fake, "POST", "/leases")).toHaveLength(2);
    expect(fake.manifestSends).toBe(2);
    await provider.sshAccess!(account, order.id);
  });

  it("never sends the manifest of a bid swapped in for the one chosen", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    const bid = fake.bid(dseq, "akash1swap", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.onAnswered = (request) => {
      if (request.path === "/bids" && bid.state === "open") {
        fake.onAnswered = null;
        bid.state = "closed";
        fake.bid(dseq, "akash1swap", "3000", "uact", null, 2);
      }
    };
    fake.manifestFailures = 1;
    const swapped = await provider.offerCreate.leaseOffer(account, order.id, offer!.id);
    // Both said: the manifest that didn't arrive, and the bid that changed; nothing sent again.
    expect(swapped.machine).toBe("error");
    expect(swapped.error).toMatch(/hasn't taken/);
    expect(swapped.error).toMatch(/replaced its offer/);
    expect(deployment.leases[0]).toMatchObject({ bseq: 2, forwarded: null });
    const posts = sent(fake, "POST", "/leases").length;
    expect(posts).toBe(1);
    // Choosing the original again sends nothing for the swapped one.
    const again = await provider.offerCreate.leaseOffer(account, order.id, offer!.id);
    expect(again.error).toMatch(/replaced its offer/);
    expect(sent(fake, "POST", "/leases")).toHaveLength(posts);
  });

  it("takes a refusal the Console named before leasing at its word, and only then", async () => {
    const refused = await placed();
    refused.fake.bid(refused.dseq, "akash1p", "1000");
    const [offer] = await refused.provider.offerCreate.listOffers(
      refused.account,
      refused.order.id
    );
    refused.fake.fail("POST", /^\/leases$/, () => reply(401, { statusCode: 401, message: "no" }));
    const reads = sent(refused.fake, "GET", `/deployments/${refused.dseq}`).length;
    expect(
      code(
        refused.provider,
        await rejection(
          refused.provider.offerCreate.leaseOffer(refused.account, refused.order.id, offer!.id)
        )
      )
    ).toBe("credential-invalid");
    // Read once before the lease, never after: the refusal is the answer.
    expect(sent(refused.fake, "GET", `/deployments/${refused.dseq}`)).toHaveLength(reads + 1);

    // Once Console said the lease exists, a later refusal never undoes that.
    const standing = await placed();
    standing.fake.bid(standing.dseq, "akash1p", "1000");
    const [chosen] = await standing.provider.offerCreate.listOffers(
      standing.account,
      standing.order.id
    );
    standing.fake.manifestFailures = 1;
    standing.fake.onAnswered = (request) => {
      if (request.method === "POST" && request.path === "/leases") {
        standing.fake.onAnswered = null;
        standing.fake.fail("POST", /^\/leases$/, () =>
          reply(400, { statusCode: 400, message: "no" })
        );
      }
    };
    expect(
      await standing.provider.offerCreate.leaseOffer(
        standing.account,
        standing.order.id,
        chosen!.id
      )
    ).toMatchObject({
      resourceId: standing.order.id,
      error: expect.stringMatching(/hasn't taken/),
    });
  });

  it("reads the order back when a lease is refused as not open, in case another was leased", async () => {
    const { fake, provider, account, order, dseq, deployment } = await placed();
    const mine = fake.bid(dseq, "akash1mine", "1000");
    const theirs = fake.bid(dseq, "akash1theirs", "900");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.onAnswered = (request) => {
      // Someone leases the other offer on the Akash Console just before this one is sent.
      if (request.path === "/bids") {
        fake.onAnswered = null;
        mine.state = "lost";
        theirs.state = "active";
        deployment.leases.push(liveLease(fake, "akash1theirs"));
      }
    };
    const error = await rejection(provider.offerCreate.leaseOffer(account, order.id, offer!.id));
    expect(code(provider, error)).toBe("outcome-unknown");
  });

  it("never sends a manifest for a lease priced unlike the bid chosen", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    const bid = fake.bid(dseq, "akash1repriced", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.onAnswered = (request) => {
      if (request.path === "/bids") {
        fake.onAnswered = null;
        bid.price = "3000";
      }
    };
    fake.manifestFailures = 1;
    fake.commitThen("POST", /^\/leases$/, () => reply(200, { data: { leases: [{}] } }));
    const machine = await provider.offerCreate.leaseOffer(account, order.id, offer!.id);
    expect(machine).toMatchObject({ machine: "error", error: expect.stringMatching(/replaced/) });
    expect(sent(fake, "POST", "/leases")).toHaveLength(1);
  });

  it("drops a manifest's warning once the provider reports the lease after all", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    fake.bid(dseq, "akash1slow", "1000");
    const [offer] = await provider.offerCreate.listOffers(account, order.id);
    fake.manifestFailures = 1;
    fake.onAnswered = (request) => {
      // The first send leases and the manifest fails; the resend delivers, its answer lost.
      if (request.method === "POST" && request.path === "/leases") {
        fake.onAnswered = null;
        fake.lose("POST", /^\/leases$/);
      }
    };
    expect(await provider.offerCreate.leaseOffer(account, order.id, offer!.id)).toMatchObject({
      machine: "running",
      error: null,
    });
    expect(fake.manifestSends).toBe(2);
  });

  it("never takes a machine the project lost track of for one gone", async () => {
    // Moved away, and the wallet's other projects can't be asked: never gone.
    const unasked = await leasedOrder();
    unasked.deployment.projectId = TEAM_DEFAULT;
    unasked.fake.onAnswered = (request) => {
      if (request.method === "GET" && request.path === `/deployments/${unasked.dseq}`) {
        unasked.fake.onAnswered = null;
        unasked.fake.fail(
          "GET",
          new RegExp(`^/deployments/${unasked.dseq}$`),
          () => reply(503, { statusCode: 503, message: "down" }),
          3
        );
      }
    };
    expect(
      code(
        unasked.provider,
        await rejection(unasked.provider.delete(unasked.account, unasked.order.id))
      )
    ).toBe("provider-unreachable");

    // Moved between the read and the close: the close's own 404 is looked into too.
    const moving = await leasedOrder();
    moving.fake.onAnswered = (request) => {
      if (request.method === "GET" && request.path === `/deployments/${moving.dseq}`) {
        moving.fake.onAnswered = null;
        moving.deployment.projectId = TEAM_DEFAULT;
      }
    };
    expect(
      code(
        moving.provider,
        await rejection(moving.provider.delete(moving.account, moving.order.id))
      )
    ).toBe("credential-invalid");
    expect(moving.deployment.state).toBe("active");
  });

  it("refuses a create's lookup for a deployment that doesn't say its block", async () => {
    const { fake, provider, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    seed(fake, `Build host ${MARK}`, { createdHeight: 0, leases: [liveLease(fake)] });
    expect(
      await rejection(provider.list(account, { label: `daintree-binding=${BINDING}` }))
    ).toMatchObject({ kind: "bad-response" });
    expect(await provider.list(account)).toEqual([expect.objectContaining({ createdAt: null })]);
  });

  it("never answers a close as closed while the Console still shows the order open", async () => {
    const open = await placed();
    open.fake.fail("DELETE", /^\/deployments\/\d+$/, () => reply(200, { data: { success: true } }));
    expect(
      code(
        open.provider,
        await rejection(open.provider.offerCreate.closeOrder(open.account, open.order.id))
      )
    ).toBe("outcome-unknown");

    const vanished = await placed();
    vanished.fake.onAnswered = (request) => {
      if (request.method === "DELETE") {
        vanished.fake.onAnswered = null;
        vanished.fake.deployments.splice(vanished.fake.deployments.indexOf(vanished.deployment), 1);
      }
    };
    expect(
      code(
        vanished.provider,
        await rejection(
          vanished.provider.offerCreate.closeOrder(vanished.account, vanished.order.id)
        )
      )
    ).toBe("outcome-unknown");
  });

  it("never answers a close it couldn't confirm as closed", async () => {
    const { fake, provider, account, order, dseq } = await placed();
    fake.onAnswered = (request) => {
      if (request.method === "DELETE") {
        fake.onAnswered = null;
        fake.fail(
          "GET",
          new RegExp(`^/deployments/${dseq}$`),
          () => new TypeError("fetch failed"),
          3
        );
      }
    };
    expect(
      code(provider, await rejection(provider.offerCreate.closeOrder(account, order.id)))
    ).toBe("outcome-unknown");
    // Asked again, it reads what the close left.
    expect(await provider.offerCreate.closeOrder(account, order.id)).toEqual({ kind: "closed" });
  });
});
