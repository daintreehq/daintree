import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { CloudAccountService, normalizeProvisioning } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import type { CloudProvider } from "../provider.js";
import type {
  CloudCredentialField,
  CloudProviderId,
  CloudProviderInfo,
  CloudProvisioning,
} from "../../../../shared/types/cloudHosts.js";

function memoryBackend(initial?: unknown) {
  const backend = {
    value: initial as unknown,
    get: () => backend.value,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backend.value = JSON.parse(JSON.stringify(value));
    },
  };
  return backend;
}

function fakeProvider(overrides: Partial<CloudProvider> = {}): CloudProvider {
  return {
    id: "boat",
    info: (platform) => ({
      id: "boat",
      name: "Boat",
      description: "",
      apiKeyUrl: "",
      dashboardUrl: "",
      docsUrl: "",
      credentialFields: [
        {
          id: "apiKey",
          label: "API key",
          secret: true,
          input: "single-line",
          required: true,
          help: null,
        },
      ],
      capabilities: {
        persistence: {
          kept: "Files",
          lost: "memory",
          retentionDays: null,
          saveRetryBilled: true,
          stoppedComputeBilled: false,
        },
        typicalStartSeconds: null,
        lifetime: { kind: "renewable" },
        sshTrust: "pinned-from-api",
        transport: "direct",
        tunnel: null,
        provisioning: { location: "none", image: "none", network: "none", sshKey: "after-create" },
        deletion: true,
      },
      unsupportedReason: platform === "win32" ? "not on windows" : null,
    }),
    checkCredentials: vi.fn(async () => ({
      identity: "octocat",
      scopes: [
        { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: false },
        { scope: { kind: "organization" as const, id: "team_1", name: "Acme" }, active: true },
      ],
    })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(),
    list: vi.fn(async () => []),
    inspect: vi.fn(),
    create: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    renewLifetime: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    authorizeSsh: vi.fn(),
    describeError: (error) => ({
      code: (error as { code?: string })?.code === "401" ? "credential-invalid" : "failed",
      message: "described",
      at: 0,
    }),
    ...overrides,
  } as CloudProvider;
}

function service(
  options: { provider?: CloudProvider; platform?: NodeJS.Platform; apiUrl?: string } = {}
) {
  const backend = memoryBackend();
  const store = new CloudHostStore(backend);
  const vault = new MemoryCloudCredentialVault();
  const provider = options.provider ?? fakeProvider();
  let apiUrl = options.apiUrl ?? "https://boat.dev/api/v1";
  const accounts = new CloudAccountService({
    store,
    vault,
    providers: new Map<CloudProviderId, CloudProvider>([[provider.id, provider]]),
    apiUrlFor: () => apiUrl,
    platform: options.platform ?? "darwin",
    now: () => 1000,
  });
  return { accounts, store, vault, backend, provider, setApiUrl: (url: string) => (apiUrl = url) };
}

describe("CloudAccountService", () => {
  it("keeps the key in the vault only, never in the settings value or a summary", async () => {
    const { accounts, backend, vault } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "  boat_live_0123456789abcd  " },
      scopeId: "team_1",
    });
    expect(summary).toMatchObject({
      displayName: "Acme",
      billingScope: { kind: "organization", id: "team_1" },
      keyHint: "abcd",
      validation: { status: "valid" },
    });
    expect(JSON.stringify(backend.value)).not.toContain("boat_live_0123456789abcd");
    expect(JSON.stringify(summary)).not.toContain("boat_live_0123456789abcd");
    expect(vault.sets.get(summary.id)).toEqual({ apiKey: "boat_live_0123456789abcd" });
  });

  it("refuses a scope the key can't bill", async () => {
    const { accounts } = service();
    await expect(
      accounts.addAccount({
        providerId: "boat",
        credentials: { apiKey: "boat_live_x" },
        scopeId: "team_other",
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses to connect the same account and wallet twice", async () => {
    const { accounts } = service();
    await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    await expect(
      accounts.addAccount({
        providerId: "boat",
        credentials: { apiKey: "boat_live_y" },
        scopeId: "personal",
      })
    ).rejects.toThrow(/already connected/);
  });

  it("refuses before any provider call on a platform the provider can't serve", async () => {
    const provider = fakeProvider();
    const { accounts } = service({ provider, platform: "win32" });
    await expect(
      accounts.addAccount({
        providerId: "boat",
        credentials: { apiKey: "boat_live_x" },
        scopeId: "personal",
      })
    ).rejects.toThrow("not on windows");
    expect(provider.checkCredentials).not.toHaveBeenCalled();
  });

  it("never sends a key to an API origin other than the one it was connected against", async () => {
    const { accounts, store, setApiUrl } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    setApiUrl("http://127.0.0.1:9999/api/v1");
    await expect(accounts.credentials(store.account(summary.id)!)).rejects.toThrow(
      /connected against/
    );
  });

  it("refuses a replacement key that signs in as someone else", async () => {
    const provider = fakeProvider();
    const { accounts } = service({ provider });
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    vi.mocked(provider.checkCredentials).mockResolvedValueOnce({
      identity: "someone-else",
      scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: true }],
    });
    await expect(
      accounts.replaceCredentials(summary.id, { apiKey: "boat_live_z" })
    ).rejects.toThrow(/sign in as someone-else/);
  });

  it("won't remove an account that hosts still use", async () => {
    const { accounts, store, vault } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    store.putBinding({
      id: "cb_abcdefgh12",
      hostId: "build-host",
      accountId: summary.id,
      providerId: "boat",
      resourceId: "bx_23456789",
      ownership: "created-by-daintree",
      createdFor: null,
      provisioning: null,
      creation: null,
      lifetimeSeconds: 7200,
      intent: null,
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: 0,
    });
    await expect(accounts.removeAccount(summary.id)).rejects.toThrow(/Remove it first/);
    store.removeBinding("cb_abcdefgh12");
    await accounts.removeAccount(summary.id);
    expect(vault.sets.size).toBe(0);
    expect(accounts.summaries()).toEqual([]);
  });

  it("marks the account invalid when the provider rejects its key", async () => {
    const provider = fakeProvider({
      validate: vi.fn(async () => {
        throw Object.assign(new Error("nope"), { code: "401" });
      }),
    });
    const { accounts } = service({ provider });
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    await expect(accounts.validate(summary.id)).rejects.toBeInstanceOf(AppError);
    expect(accounts.summaries()[0].validation).toMatchObject({ status: "invalid" });
  });

  it("doesn't bring back an account removed while its check was out", async () => {
    let finish: (value: { identity: string }) => void = () => {};
    const provider = fakeProvider({
      validate: vi.fn(() => new Promise<{ identity: string }>((resolve) => (finish = resolve))),
    });
    const { accounts } = service({ provider });
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    const checking = accounts.validate(summary.id).catch((e: unknown) => e);
    await vi.waitFor(() => expect(provider.validate).toHaveBeenCalled());
    await accounts.removeAccount(summary.id);
    finish({ identity: "octocat" });
    expect(await checking).toBeInstanceOf(AppError);
    expect(accounts.summaries()).toEqual([]);
  });

  it("keeps the account listed when its key can't be deleted", async () => {
    const { accounts, vault } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    vi.spyOn(vault, "delete").mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(accounts.removeAccount(summary.id)).rejects.toThrow("ENOSPC");
    expect(accounts.summaries().map((a) => a.id)).toEqual([summary.id]);
    await accounts.removeAccount(summary.id);
    expect(accounts.summaries()).toEqual([]);
  });

  it("keeps one account when two connects for the same wallet race", async () => {
    const { accounts, vault } = service();
    const request = {
      providerId: "boat" as const,
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    };
    const results = await Promise.allSettled([
      accounts.addAccount(request),
      accounts.addAccount(request),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(accounts.summaries()).toHaveLength(1);
    expect(vault.sets.size).toBe(1);
  });

  it("checks nothing at the provider when the key couldn't be kept", async () => {
    const provider = fakeProvider();
    const { accounts, vault } = service({ provider });
    vi.spyOn(vault, "available").mockReturnValue(false);
    await expect(accounts.checkCredentials("boat", { apiKey: "boat_live_x" })).rejects.toThrow(
      /keychain/
    );
    expect(provider.checkCredentials).not.toHaveBeenCalled();
  });

  it("refuses a pasted private key", async () => {
    const { accounts } = service();
    await expect(
      accounts.checkCredentials("boat", { apiKey: "-----BEGIN OPENSSH PRIVATE KEY-----" })
    ).rejects.toThrow(/private key/);
  });
});

function field(
  id: string,
  input: CloudCredentialField["input"],
  options: { secret?: boolean; required?: boolean } = {}
): CloudCredentialField {
  return {
    id,
    label: id,
    secret: options.secret ?? true,
    input,
    required: options.required ?? true,
    help: null,
  };
}

/** A provider declaring `fields`, under its own id, otherwise the Boat-shaped fake. */
function fieldsProvider(
  id: string,
  fields: CloudCredentialField[],
  overrides: Partial<CloudProvider> = {}
): CloudProvider {
  const base = fakeProvider(overrides);
  return {
    ...base,
    id,
    info: (platform) => ({ ...base.info(platform), id, credentialFields: fields }),
  };
}

/** Access key id, two secrets (one optional) and a region, as an EC2-like provider asks. */
const TWO_SECRETS = [
  field("accessKeyId", "single-line", { secret: false }),
  field("secretAccessKey", "single-line"),
  field("sessionToken", "single-line", { required: false }),
  field("region", "single-line", { secret: false }),
];

/** A service-account key file and a project, as a Compute Engine-like provider asks. */
const KEY_FILE = [field("keyFile", "key-file"), field("project", "single-line", { secret: false })];

function serviceAccountKey(keyId: string): string {
  return [
    "{",
    '  "type": "service_account",',
    `  "private_key_id": "${keyId}",`,
    '  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n"',
    "}",
    "",
  ].join("\n");
}

/** Every value a summary, the settings value or a snapshot must never carry. */
function expectNoSecret(carriers: unknown[], secrets: string[]): void {
  const text = JSON.stringify(carriers);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("CloudAccountService with declared credential sets", () => {
  it("checks, connects, replaces and removes a set with two secrets", async () => {
    const provider = fieldsProvider("acme.clouds.ec2", TWO_SECRETS);
    const { accounts, vault, backend } = service({ provider });
    const first = {
      accessKeyId: " AKIAEXAMPLE0001 ",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYsecret1",
      sessionToken: "FwoGZXIvYXdzEJr//////////session-one",
      region: "us-east-1",
    };

    const checked = await accounts.checkCredentials("acme.clouds.ec2", first);
    expect(checked.identity).toBe("octocat");
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(
      { ...first, accessKeyId: "AKIAEXAMPLE0001" },
      "https://boat.dev/api/v1"
    );
    expect(vault.sets.size).toBe(0);

    const added = await accounts.addAccount({
      providerId: "acme.clouds.ec2",
      credentials: first,
      scopeId: "personal",
    });
    expect(vault.sets.get(added.id)).toEqual({ ...first, accessKeyId: "AKIAEXAMPLE0001" });
    expect(added.keyHint).toBe("ret1");

    const second = {
      accessKeyId: "AKIAEXAMPLE0002",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYsecret2",
      region: "eu-west-1",
    };
    const replaced = await accounts.replaceCredentials(added.id, second);
    // The whole set: the session token the new set leaves out is gone.
    expect(vault.sets.get(added.id)).toEqual(second);
    expect(replaced.keyHint).toBe("ret2");
    expectNoSecret(
      [added, replaced, accounts.summaries(), backend.value],
      [first.secretAccessKey, first.sessionToken, second.secretAccessKey]
    );

    await accounts.removeAccount(added.id);
    expect(vault.sets.size).toBe(0);
    expect(accounts.summaries()).toEqual([]);
  });

  it("checks, connects, replaces and removes a key file exactly as it was read", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, backend } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };

    await accounts.checkCredentials("acme.clouds.gce", first);
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(first, "https://boat.dev/api/v1");

    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "team_1",
    });
    expect(vault.sets.get(added.id)).toEqual(first);
    expect(added.keyHint).toBeNull();

    const second = { keyFile: serviceAccountKey("key-two"), project: "acme-build" };
    const replaced = await accounts.replaceCredentials(added.id, second);
    expect(vault.sets.get(added.id)).toEqual(second);
    expectNoSecret(
      [added, replaced, accounts.summaries(), backend.value],
      ["PRIVATE KEY", "key-one", "key-two"]
    );

    await accounts.removeAccount(added.id);
    expect(vault.sets.size).toBe(0);
  });

  it("refuses what the provider didn't declare, or a required value left out, before any check", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts } = service({ provider });
    const key = serviceAccountKey("key-one");
    await expect(
      accounts.checkCredentials("acme.clouds.gce", { keyFile: key, project: "p", extra: "x" })
    ).rejects.toThrow(/doesn't ask for/);
    await expect(accounts.checkCredentials("acme.clouds.gce", { keyFile: key })).rejects.toThrow(
      /project is required/
    );
    await expect(
      accounts.checkCredentials("acme.clouds.gce", { keyFile: "  \n", project: "p" })
    ).rejects.toThrow(/keyFile is required/);
    await expect(
      accounts.checkCredentials("acme.clouds.gce", { keyFile: 42, project: "p" })
    ).rejects.toThrow(/must be text/);
    await expect(
      accounts.checkCredentials("acme.clouds.gce", { keyFile: `${key}\u0000`, project: "p" })
    ).rejects.toThrow(/doesn't look like text/);
    await expect(
      accounts.checkCredentials("acme.clouds.gce", { keyFile: "x".repeat(65 * 1024), project: "p" })
    ).rejects.toThrow(/larger than a key file/);
    await expect(
      accounts.checkCredentials("acme.clouds.gce", {
        keyFile: key,
        project: "-----BEGIN PRIVATE KEY----- MIIE",
      })
    ).rejects.toThrow(/can't be a private key/);
    await expect(accounts.checkCredentials("acme.clouds.gce", "key")).rejects.toThrow(
      /credentials/
    );
    expect(provider.checkCredentials).not.toHaveBeenCalled();
  });

  it("hands on only the declared shape of a check, whatever else the provider returned", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      checkCredentials: vi.fn(async () => ({
        identity: "build@acme.iam",
        token: "ya29.secret-token",
        scopes: [
          {
            scope: { kind: "personal" as const, id: "personal", name: "Personal", raw: "x" },
            active: true,
          },
        ],
      })),
    });
    const { accounts } = service({ provider });
    const checked = await accounts.checkCredentials("acme.clouds.gce", {
      keyFile: serviceAccountKey("key-one"),
      project: "acme-build",
    });
    expect(checked).toEqual({
      identity: "build@acme.iam",
      scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: true }],
    });
  });

  it("doesn't mark replaced credentials refused for an answer about the set before them", async () => {
    let refuse: (error: Error) => void = () => {};
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(
        () => new Promise<{ identity: string }>((_resolve, reject) => (refuse = reject))
      ),
    });
    const { accounts } = service({ provider });
    // A key file has no hint, so only the revision can tell the two sets apart.
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    const checking = accounts.validate(added.id).catch((e: unknown) => e);
    await vi.waitFor(() => expect(provider.validate).toHaveBeenCalled());
    await accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    refuse(Object.assign(new Error("revoked"), { code: "401" }));
    expect(await checking).toBeInstanceOf(AppError);
    expect(accounts.summaries()[0]!.validation).toMatchObject({ status: "valid" });
  });

  it("doesn't cache a catalog read with credentials since replaced", async () => {
    let answer: (value: unknown) => void = () => {};
    const catalog = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({
        machineTypes: [],
        canStart: true,
        includedHoursRemaining: null,
        startsRemaining: null,
        savedSnapshotDayDollars: null,
      });
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, { catalog });
    const { accounts } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    const reading = accounts.catalog(added.id);
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
    await accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    answer({
      machineTypes: [],
      canStart: false,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    });
    await reading;
    expect((await accounts.catalog(added.id)).canStart).toBe(true);
    expect(catalog).toHaveBeenCalledTimes(2);
  });

  it("seals nothing for an account removed while its replacement was being checked", async () => {
    let pass: () => void = () => {};
    const provider = fieldsProvider("acme.clouds.ec2", TWO_SECRETS);
    const { accounts, vault } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.ec2",
      credentials: {
        accessKeyId: "AKIAEXAMPLE0001",
        secretAccessKey: "secret-access-key-one",
        region: "us-east-1",
      },
      scopeId: "personal",
    });
    vi.mocked(provider.checkCredentials).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pass = () =>
            resolve({
              identity: "octocat",
              scopes: [
                { scope: { kind: "personal", id: "personal", name: "Personal" }, active: true },
              ],
            });
        })
    );
    const replacing = accounts
      .replaceCredentials(added.id, {
        accessKeyId: "AKIAEXAMPLE0002",
        secretAccessKey: "secret-access-key-two",
        region: "us-east-1",
      })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(provider.checkCredentials).toHaveBeenCalledTimes(2));
    await accounts.removeAccount(added.id);
    pass();
    expect(await replacing).toMatchObject({ code: "NOT_FOUND" });
    expect(vault.sets.size).toBe(0);
    expect(accounts.summaries()).toEqual([]);
  });

  it("keeps working with an account whose bare key was sealed before sets", async () => {
    const { accounts, store, vault } = service();
    store.putAccount({
      id: "ca_abcdefgh",
      providerId: "boat",
      displayName: "Personal",
      identity: "octocat",
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://boat.dev/api/v1",
      keyHint: "abcd",
      credentialRevision: null,
      addedAt: 1,
      validation: { status: "valid", checkedAt: 1 },
    });
    await vault.put("ca_abcdefgh", { apiKey: "boat_live_0123456789abcd" });
    expect(await accounts.credentials(store.account("ca_abcdefgh")!)).toMatchObject({
      values: { apiKey: "boat_live_0123456789abcd" },
      scopeId: "personal",
    });
    await accounts.validate("ca_abcdefgh");
    expect(accounts.summaries()[0]).toMatchObject({
      keyHint: "abcd",
      validation: { status: "valid" },
    });
  });
});

describe("CloudHostStore", () => {
  it("skips records it can't read without failing the rest", () => {
    const account = {
      id: "ca_ijklmnop",
      providerId: "agent37",
      displayName: "Agent 37",
      identity: null,
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://api.agent37.test",
      keyHint: null,
      addedAt: 1,
      validation: { status: "valid", checkedAt: 1 },
    };
    const binding = {
      id: "cb_ijklmnop34",
      accountId: "ca_ijklmnop",
      providerId: "acme.clouds.ec2",
    };
    const store = new CloudHostStore(
      memoryBackend({
        version: 1,
        accounts: [{ id: "nope" }, null, account],
        // "agent37" reads (a provider this build may not have is still kept); "Agent 37" has neither shape.
        bindings: [
          { id: "cb_abcdefgh12", accountId: "ca_abcdefgh", providerId: "Agent 37" },
          binding,
        ],
      })
    );
    expect(store.accounts().map((entry) => [entry.id, entry.providerId])).toEqual([
      ["ca_ijklmnop", "agent37"],
    ]);
    expect(store.bindings().map((entry) => [entry.id, entry.providerId])).toEqual([
      ["cb_ijklmnop34", "acme.clouds.ec2"],
    ]);
  });
});

describe("normalizeProvisioning", () => {
  function infoTaking(provisioning: Partial<CloudProvisioning>): CloudProviderInfo {
    const base = fakeProvider().info("darwin");
    return {
      ...base,
      capabilities: {
        ...base.capabilities,
        provisioning: { ...base.capabilities.provisioning, ...provisioning },
      },
    };
  }
  const region = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    label: id.toUpperCase(),
    description: null,
    available: true,
    reason: null,
    locations: null,
    ...extra,
  });

  it("offers only the dimensions the provider says a create takes", () => {
    const offered = {
      location: { label: "Region", choices: [region("nyc1")], defaultId: "nyc1" },
      image: { label: "Image", choices: [region("ubuntu")], defaultId: null },
    };
    expect(normalizeProvisioning(infoTaking({}), offered)).toEqual({
      location: null,
      image: null,
      network: null,
    });
    const taken = normalizeProvisioning(infoTaking({ location: "required" }), offered);
    expect(taken.location?.choices.map((choice) => choice.id)).toEqual(["nyc1"]);
    expect(taken.image).toBeNull();
  });

  it("reads a declared dimension the catalog left out as offering nothing, under a plain name", () => {
    expect(normalizeProvisioning(infoTaking({ image: "required" }), undefined).image).toEqual({
      label: "Image",
      choices: [],
      defaultId: null,
    });
  });

  it("keeps each id once and a default only when it names a choice", () => {
    const result = normalizeProvisioning(infoTaking({ location: "optional" }), {
      location: {
        label: " Zone ",
        choices: [region("a"), region("a", { label: "again" }), { label: "no id" }, region("b")],
        defaultId: "c",
      } as never,
    });
    expect(result.location).toMatchObject({ label: "Zone", defaultId: null });
    expect(result.location?.choices.map((choice) => [choice.id, choice.label])).toEqual([
      ["a", "A"],
      ["b", "B"],
    ]);
  });

  it("ties images and networks to locations only when the provider takes a location", () => {
    const image = {
      label: "Image",
      choices: [region("ubuntu", { locations: ["nyc1", 3] })],
      defaultId: null,
    };
    const network = {
      label: "VPC",
      choices: [region("vpc-1", { locations: ["nyc1"] })],
      defaultId: null,
    };
    const withLocation = normalizeProvisioning(
      infoTaking({ location: "required", image: "required", network: "optional" }),
      {
        location: { label: "Region", choices: [region("nyc1")], defaultId: null },
        image,
        network,
      } as never
    );
    expect(withLocation.image?.choices[0]?.locations).toEqual(["nyc1"]);
    expect(withLocation.network?.choices[0]?.locations).toEqual(["nyc1"]);
    const without = normalizeProvisioning(infoTaking({ image: "required", network: "optional" }), {
      image,
      network,
    } as never);
    expect(without.image?.choices[0]?.locations).toBeNull();
    expect(without.network?.choices[0]?.locations).toBeNull();
  });

  it("narrows a choice whose constraints don't read, never widens it", () => {
    const result = normalizeProvisioning(
      infoTaking({ location: "required", image: "required", network: "optional" }),
      {
        location: { label: "Region", choices: [region("nyc1")], defaultId: null },
        image: {
          label: "Image",
          choices: [
            region("as-text", { locations: "nyc1" }),
            region("said-false", { available: "false" }),
            region("unsaid", { available: undefined }),
          ],
          defaultId: null,
        },
        network: {
          label: "VPC",
          choices: [region("vpc-1", { locations: { nyc1: true } })],
          defaultId: null,
        },
      } as never
    );
    const image = (id: string) => result.image?.choices.find((choice) => choice.id === id);
    expect(image("as-text")?.locations).toEqual([]);
    expect(image("said-false")?.available).toBe(false);
    expect(image("unsaid")?.available).toBe(false);
    expect(result.network?.choices[0]?.locations).toEqual([]);
  });
});
