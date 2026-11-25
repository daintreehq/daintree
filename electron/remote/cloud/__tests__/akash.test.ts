import { describe, expect, it } from "vitest";
import {
  AKASH_CONSOLE_PRODUCTION_API_URL,
  AkashApiError,
  AkashConsoleClient,
  redactAkashText,
  resolveAkashConsoleApiUrl,
} from "../akash/AkashConsoleClient.js";
import { AkashProvider, akashApiKey } from "../akash/AkashProvider.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import type { CloudProvider, ProviderCredentials } from "../provider.js";
import { AppError } from "../../../utils/errorTypes.js";
import { AUDITOR, FAKE_AKASH_KEY, FakeAkashConsole } from "./fakeAkashConsole.js";

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

const GIB = 1073741824;

function setup() {
  const fake = new FakeAkashConsole();
  fake.organizations.push(
    { id: PERSONAL_ORG, name: "person", type: "personal" },
    { id: TEAM_ORG, name: "Web team", type: "team" }
  );
  fake.projects.push(
    { id: PERSONAL_DEFAULT, organizationId: PERSONAL_ORG, name: "Default", isDefault: true },
    { id: PERSONAL_SANDBOX, organizationId: PERSONAL_ORG, name: "Sandbox", isDefault: false },
    { id: TEAM_DEFAULT, organizationId: TEAM_ORG, name: "Default", isDefault: true },
    { id: TEAM_AGENTS, organizationId: TEAM_ORG, name: "Agents", isDefault: false }
  );
  const person = { email: "person@example.com", username: "person" };
  fake.keys.set(FAKE_AKASH_KEY, {
    organizationId: PERSONAL_ORG,
    projectIds: null,
    canDeploy: true,
    user: person,
  });
  fake.keys.set(TEAM_KEY, {
    organizationId: TEAM_ORG,
    projectIds: null,
    canDeploy: true,
    user: person,
  });
  fake.keys.set(BOUND_KEY, {
    organizationId: TEAM_ORG,
    projectIds: [TEAM_AGENTS],
    canDeploy: true,
    user: person,
  });
  fake.keys.set(VIEWER_KEY, {
    organizationId: TEAM_ORG,
    projectIds: null,
    canDeploy: false,
    user: person,
  });
  fake.keys.set(ANONYMOUS_KEY, {
    organizationId: PERSONAL_ORG,
    projectIds: null,
    canDeploy: true,
    user: null,
  });
  fake.regionProviderCounts = { "na-us-west": 5, "eu-west": 3, "ap-southeast": 1, "eu-north": 0 };
  fake.providers.push(
    // Room for up to 16 vCPU, 64 GiB and 400 GiB.
    {
      owner: "akash1big",
      location: "eu-west",
      audited: true,
      freeMillicores: 20_000,
      freeMemoryBytes: 80 * GIB,
      freeStorageBytes: 500 * GIB,
    },
    // Room for up to 8 vCPU, 32 GiB and 200 GiB.
    {
      owner: "akash1small",
      location: "na-us-west",
      audited: true,
      freeMillicores: 10_000,
      freeMemoryBytes: 40 * GIB,
      freeStorageBytes: 300 * GIB,
    },
    // Room for everything, but each is ruled out another way.
    ...[
      { owner: "akash1unaudited", location: "ap-southeast", audited: false },
      { owner: "akash1unplaced", location: null, audited: true },
      { owner: "akash1unlisted", location: "mars-north", audited: true },
      { owner: "akash1offline", location: "eu-north", audited: true },
    ].map((provider) => ({
      ...provider,
      freeMillicores: 64_000,
      freeMemoryBytes: 256 * GIB,
      freeStorageBytes: 2000 * GIB,
    }))
  );
  const sleeps: number[] = [];
  const client = new AkashConsoleClient({
    baseUrl: fake.baseUrl,
    fetch: fake.fetch as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const provider = new AkashProvider(() => client);
  const credentials = (apiKey: string, scopeId: string): ProviderCredentials => ({
    values: { apiKey },
    scopeId,
    apiUrl: fake.baseUrl,
  });
  return { fake, client, provider, credentials, sleeps };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("resolveAkashConsoleApiUrl", () => {
  it("answers production in a packaged build, whatever the environment says", () => {
    expect(
      resolveAkashConsoleApiUrl(true, { DAINTREE_AKASH_CONSOLE_API_URL: "http://localhost:1/v1" })
    ).toBe(AKASH_CONSOLE_PRODUCTION_API_URL);
  });

  it("honours an http(s) override in development, without its query or trailing slash", () => {
    expect(
      resolveAkashConsoleApiUrl(false, {
        DAINTREE_AKASH_CONSOLE_API_URL: "http://localhost:4010/v1/?key=x",
      })
    ).toBe("http://localhost:4010/v1");
    expect(
      resolveAkashConsoleApiUrl(false, { DAINTREE_AKASH_CONSOLE_API_URL: "file:///etc/passwd" })
    ).toBe(AKASH_CONSOLE_PRODUCTION_API_URL);
  });
});

describe("akashApiKey", () => {
  it("refuses what can't travel in a header before anything is sent", () => {
    for (const apiKey of [
      "",
      "ac.sk.has space",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "ac.sk.é",
    ]) {
      const error = (() => {
        try {
          akashApiKey({ apiKey });
        } catch (caught) {
          return caught;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION");
    }
    expect(akashApiKey({ apiKey: FAKE_AKASH_KEY })).toBe(FAKE_AKASH_KEY);
  });
});

describe("AkashProvider account connection", () => {
  it("lists every project a personal key can deploy into, the default active", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: FAKE_AKASH_KEY }, fake.baseUrl);
    expect(checked).toEqual({
      identity: "person@example.com",
      scopes: [
        {
          scope: { kind: "project", id: PERSONAL_DEFAULT, name: "Personal · Default" },
          active: true,
        },
        {
          scope: { kind: "project", id: PERSONAL_SANDBOX, name: "Personal · Sandbox" },
          active: false,
        },
      ],
    });
    expect(fake.requests.every((request) => request.apiKey === FAKE_AKASH_KEY)).toBe(true);
    expect(fake.requests.some((request) => request.organizationId !== null)).toBe(false);
  });

  it("names a team's projects after the team, and only that team's", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl);
    expect(checked.scopes.map((choice) => [choice.scope.id, choice.scope.name])).toEqual([
      [TEAM_DEFAULT, "Web team · Default"],
      [TEAM_AGENTS, "Web team · Agents"],
    ]);
  });

  it("offers a key limited to one project that project alone", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: BOUND_KEY }, fake.baseUrl);
    expect(checked.scopes).toEqual([
      { scope: { kind: "project", id: TEAM_AGENTS, name: "Web team · Agents" }, active: false },
    ]);
  });

  it("refuses a key that can deploy nowhere as a permission problem", async () => {
    const { provider, fake } = setup();
    const error = await rejection(provider.checkCredentials({ apiKey: VIEWER_KEY }, fake.baseUrl));
    expect(provider.describeError(error).code).toBe("permission");
    expect(provider.describeError(error).message).toContain("Web team");
  });

  it("reads an unknown key as invalid", async () => {
    const { provider, fake } = setup();
    const error = await rejection(
      provider.checkCredentials({ apiKey: "ac.sk.not-a-key-anyone-made" }, fake.baseUrl)
    );
    expect(provider.describeError(error).code).toBe("credential-invalid");
  });

  it("connects a key the Console won't name a person for, with no identity", async () => {
    const { provider, fake } = setup();
    const checked = await provider.checkCredentials({ apiKey: ANONYMOUS_KEY }, fake.baseUrl);
    expect(checked.identity).toBeNull();
    expect(checked.scopes).toHaveLength(2);
  });

  it("reads throttling that outlasts the retries as rate-limited", async () => {
    const { provider, fake, sleeps } = setup();
    fake.fail(
      "GET",
      /^\/organizations$/,
      () =>
        new Response(JSON.stringify({ statusCode: 429, message: "Slow down" }), { status: 429 }),
      3
    );
    const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(provider.describeError(error).code).toBe("rate-limited");
    expect(fake.requests.filter((request) => request.path === "/organizations")).toHaveLength(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it("doesn't ask again sooner than a long Retry-After allows", async () => {
    const { provider, fake } = setup();
    fake.fail(
      "GET",
      /^\/organizations$/,
      () =>
        new Response(JSON.stringify({ statusCode: 429, message: "Slow down" }), {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      3
    );
    const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(provider.describeError(error).code).toBe("rate-limited");
    expect(fake.requests.filter((request) => request.path === "/organizations")).toHaveLength(1);
  });

  it("rides out one throttled read", async () => {
    const { provider, fake } = setup();
    fake.fail(
      "GET",
      /^\/projects$/,
      () => new Response(JSON.stringify({ statusCode: 429, message: "Slow down" }), { status: 429 })
    );
    const checked = await provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl);
    expect(checked.scopes).toHaveLength(2);
  });

  it("refuses a project list it can't read rather than passing it off as no access", async () => {
    const { provider, fake } = setup();
    fake.fail(
      "GET",
      /^\/projects$/,
      () => new Response(JSON.stringify({ data: [{ id: TEAM_DEFAULT, name: "Default" }] }))
    );
    const error = await rejection(provider.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    expect(error).toMatchObject({ kind: "bad-response" });
    expect(provider.describeError(error).code).toBe("failed");
  });
});

describe("AkashProvider.validate", () => {
  it("checks the account's own project, by path and header alike", async () => {
    const { provider, fake, credentials } = setup();
    await expect(provider.validate(credentials(TEAM_KEY, TEAM_AGENTS))).resolves.toEqual({
      identity: "person@example.com",
    });
    const read = fake.requests.find((request) => request.path.startsWith("/projects/"));
    expect(read).toMatchObject({ path: `/projects/${TEAM_AGENTS}`, projectId: TEAM_AGENTS });
  });

  it("reads a key that no longer reaches the project as invalid for this account", async () => {
    const { provider, credentials } = setup();
    // A key limited to Agents, asked about the team's default project: refused by its header.
    const forbidden = await rejection(provider.validate(credentials(BOUND_KEY, TEAM_DEFAULT)));
    expect(forbidden).toMatchObject({ kind: "wrong-scope", code: "project_forbidden" });
    expect(provider.describeError(forbidden).code).toBe("credential-invalid");
    // A key from another organization never sees the project at all.
    const missing = await rejection(provider.validate(credentials(FAKE_AKASH_KEY, TEAM_AGENTS)));
    expect(provider.describeError(missing).code).toBe("credential-invalid");
  });

  it("reads a key that may only look as a permission problem", async () => {
    const { provider, credentials } = setup();
    const error = await rejection(provider.validate(credentials(VIEWER_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error)).toMatchObject({ code: "permission" });
    expect(provider.describeError(error).message).toContain("Agents");
  });

  it("keeps a generic refusal a permission problem, not a lost project", async () => {
    const { provider, fake, credentials } = setup();
    fake.fail(
      "GET",
      /^\/projects\//,
      () => new Response(JSON.stringify({ statusCode: 403, message: "Forbidden" }), { status: 403 })
    );
    const error = await rejection(provider.validate(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error).code).toBe("permission");
  });
});

describe("AkashProvider.describeError", () => {
  const provider = new AkashProvider(() => {
    throw new Error("unused");
  });
  const api = (kind: AkashApiError["kind"], code: string | null = null) =>
    new AkashApiError(kind, `said ${kind}`, null, code);

  it("maps the Console's failures onto Daintree's codes", () => {
    const cases: Array<[unknown, string]> = [
      [api("unauthorized"), "credential-invalid"],
      [api("forbidden"), "permission"],
      [api("forbidden", "project_budget_exceeded"), "billing"],
      [api("payment-required"), "billing"],
      [api("rate-limited"), "rate-limited"],
      [api("not-found"), "not-found"],
      [api("invalid-request", "organization_mismatch"), "refused"],
      [api("conflict"), "refused"],
      [api("unprocessable"), "refused"],
      [api("server"), "provider-unreachable"],
      [api("network"), "provider-unreachable"],
      [api("timeout"), "provider-unreachable"],
      [api("unsupported"), "unsupported"],
      [api("cancelled"), "failed"],
      [api("bad-response"), "failed"],
      [new Error("boom"), "failed"],
    ];
    for (const [error, code] of cases) expect(provider.describeError(error).code).toBe(code);
  });

  it("shows a validation error's own words", () => {
    const error = new AppError({
      code: "VALIDATION",
      message: "x",
      userMessage: "Paste an API key.",
    });
    expect(provider.describeError(error).message).toBe("Paste an API key.");
  });

  it("never repeats a key the Console echoed back", async () => {
    const { provider: live, fake } = setup();
    fake.fail(
      "GET",
      /^\/organizations$/,
      () =>
        new Response(
          JSON.stringify({
            statusCode: 400,
            message: `Bad header ${TEAM_KEY} and ac.sk.other-key`,
          }),
          { status: 400 }
        )
    );
    const error = await rejection(live.checkCredentials({ apiKey: TEAM_KEY }, fake.baseUrl));
    const described = live.describeError(error);
    expect(described.code).toBe("refused");
    expect(described.message).not.toContain("ac.sk.");
    expect(redactAkashText(`key=${TEAM_KEY}`, TEAM_KEY)).toBe("key=[redacted]");
  });
});

describe("AkashProvider.catalog", () => {
  it("offers the four sizes where an audited provider has room, with the regions to choose from", async () => {
    const { provider, fake, credentials } = setup();
    const catalog = await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    expect(catalog.machineTypes.map((type) => [type.id, type.available, type.locations])).toEqual([
      ["akash-4c-16g", true, ["eu-west", "na-us-west"]],
      ["akash-8c-32g", true, ["eu-west", "na-us-west"]],
      ["akash-16c-64g", true, ["eu-west"]],
      ["akash-32c-128g", false, []],
    ]);
    const largest = catalog.machineTypes[3]!;
    expect(largest.reason).toMatch(/room/);
    expect(catalog.machineTypes.every((type) => type.hourlyDollars === null)).toBe(true);
    expect(catalog.machineTypes[0]).toMatchObject({ vcpu: 4, memoryGB: 16, reason: null });
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
    // The region with the most audited providers online.
    expect(location?.defaultId).toBe("na-us-west");
    expect(catalog.canStart).toBe(false);
    expect(provider.info("linux").capabilities.provisioning.location).toBe("required");
  });

  it("screens each size in the chain's units, audited only, carrying no key", async () => {
    const { provider, fake, credentials } = setup();
    await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    const screens = fake.requests.filter((request) => request.path === "/bid-screening");
    const units = screens.map((request) => {
      const body = request.body as {
        requirements: { signedBy: { anyOf: string[] }; attributes: unknown[] };
        resources: Array<{
          resource: {
            cpu: { units: { val: string } };
            memory: { quantity: { val: string } };
            gpu: { units: { val: string } };
            storage: Array<{ quantity: { val: string } }>;
          };
        }>;
      };
      expect(body.requirements.signedBy.anyOf).toEqual([AUDITOR]);
      expect(body.requirements.attributes).toEqual([]);
      const { cpu, memory, gpu, storage } = body.resources[0]!.resource;
      return [cpu.units.val, memory.quantity.val, gpu.units.val, storage[0]!.quantity.val];
    });
    expect(units).toEqual([
      ["4000", "17179869184", "0", "107374182400"],
      ["8000", "34359738368", "0", "214748364800"],
      ["16000", "68719476736", "0", "429496729600"],
      ["32000", "137438953472", "0", "858993459200"],
    ]);
    expect(fake.requests).toHaveLength(5);
    for (const request of fake.requests) {
      expect(request.apiKey).toBeNull();
      expect(request.projectId).toBeNull();
    }
  });

  it("tells an empty screening from a failed one", async () => {
    const { provider, fake, credentials } = setup();
    fake.providers.length = 0;
    const empty = await provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS));
    expect(empty.machineTypes.every((type) => !type.available)).toBe(true);

    fake.fail(
      "POST",
      /^\/bid-screening$/,
      () =>
        new Response(
          JSON.stringify({ statusCode: 503, message: "Provider screening is unavailable" }),
          {
            status: 503,
          }
        ),
      // Every attempt of every size's screening.
      12
    );
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("fails on a screening it can't read rather than calling it no room", async () => {
    const { provider, fake, credentials } = setup();
    fake.fail(
      "POST",
      /^\/bid-screening$/,
      () => new Response(JSON.stringify({ providers: [{ location: "eu-west" }] }))
    );
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(error).toMatchObject({ kind: "bad-response" });
  });

  it("never reads a public route's refusal as the account's key going bad", async () => {
    const { provider, fake, credentials } = setup();
    fake.fail(
      "GET",
      /^\/placement-options$/,
      () =>
        new Response(JSON.stringify({ statusCode: 401, message: "Unauthorized" }), { status: 401 }),
      3
    );
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error).code).toBe("provider-unreachable");
  });

  it("cancels the other screenings once one fails, and reports the first failure", async () => {
    const { provider, fake, credentials } = setup();
    fake.hold("GET", /^\/placement-options$/);
    fake.fail(
      "POST",
      /^\/bid-screening$/,
      () =>
        new Response(JSON.stringify({ statusCode: 400, message: "Invalid request body" }), {
          status: 400,
        })
    );
    const error = await rejection(provider.catalog(credentials(TEAM_KEY, TEAM_AGENTS)));
    expect(provider.describeError(error).code).toBe("refused");
    const held = fake.requests.find((request) => request.path === "/placement-options");
    expect(held?.signal?.aborted).toBe(true);
  });

  it("sends nothing once the caller has given up", async () => {
    const { provider, fake, credentials } = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      provider.catalog({ ...credentials(TEAM_KEY, TEAM_AGENTS), signal: controller.signal })
    );
    expect(error).toMatchObject({ kind: "cancelled" });
    expect(fake.requests).toHaveLength(0);
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
    expect(info.capabilities).toMatchObject({
      deletion: true,
      transport: "direct",
      sshTrust: "confirm-on-first-connect",
      lifetime: { kind: "none" },
    });
    expect(info.capabilities.provisioning.sshKey).toBe("at-create");
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
    const calls: Array<Promise<unknown>> = [
      contract.create(account, request),
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
    ];
    for (const call of calls) {
      expect(provider.describeError(await rejection(call)).code).toBe("unsupported");
    }
    expect(fake.requests).toHaveLength(0);
  });
});
