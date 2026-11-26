import { describe, expect, it, vi } from "vitest";
import {
  abortableAkashSleep,
  AkashApiError,
  AkashConsoleClient,
  type AkashConsoleClientOptions,
  redactAkashText,
  resolveAkashConsoleApiUrl,
} from "../akash/AkashConsoleClient.js";
import { AkashProvider, akashApiKey } from "../akash/AkashProvider.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import type { CloudProvider, ProviderCredentials } from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import {
  AUDITOR,
  FAKE_AKASH_KEY,
  FakeAkashConsole,
  screenedMillicores,
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
  const provider = new AkashProvider(() => client);
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
    const provider = new AkashProvider(() => {
      throw new Error("unused");
    });
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

  it("refuses what it can't do yet, and a one-request create for good, without asking the Console", async () => {
    const { provider, fake, credentials } = setup();
    const account = credentials(TEAM_KEY, TEAM_AGENTS);
    const request = {
      name: "box",
      machineType: "akash-4c-16g",
      lifetimeSeconds: null,
      provisioning: { location: "eu-west", image: null, network: null },
      labels: {},
      idempotencyKey: "k",
      publicKey: null,
    };
    const contract: CloudProvider = provider;
    const create = provider.describeError(await rejection(contract.create(account, request)));
    expect(create).toMatchObject({ code: "unsupported" });
    expect(create.message).toMatch(/offer/);
    const staged: Array<Promise<unknown>> = [
      contract.list(account),
      contract.inspect(account, "1"),
      contract.rename(account, "1", "x"),
      contract.delete(account, "1"),
      contract.sshAccess!(account, "1"),
      provider.offerCreate.placeOrder(account, request),
      provider.offerCreate.findOrders(account, request),
      provider.offerCreate.listOffers(account, "1"),
      provider.offerCreate.leaseOffer(account, "1", "2"),
      provider.offerCreate.closeOrder(account, "1"),
      provider.offerCreate.readOrder(account, "1"),
    ];
    for (const call of staged) {
      expect(provider.describeError(await rejection(call)).code).toBe("unsupported");
    }
    expect(fake.requests).toHaveLength(0);
  });
});
