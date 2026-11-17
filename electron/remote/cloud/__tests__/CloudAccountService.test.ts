import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../utils/errorTypes.js";
import { CloudAccountService, normalizeProvisioning } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import type { CloudProvider } from "../provider.js";
import type {
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
        provisioning: { location: "none", image: "none", network: "none", sshKey: "after-create" },
        deletion: true,
      },
      unsupportedReason: platform === "win32" ? "not on windows" : null,
    }),
    checkKey: vi.fn(async () => ({
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
    providers: new Map<CloudProviderId, CloudProvider>([["boat", provider]]),
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
      apiKey: "  boat_live_0123456789abcd  ",
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
    expect(vault.keys.get(summary.id)).toBe("boat_live_0123456789abcd");
  });

  it("refuses a scope the key can't bill", async () => {
    const { accounts } = service();
    await expect(
      accounts.addAccount({ providerId: "boat", apiKey: "boat_live_x", scopeId: "team_other" })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses to connect the same account and wallet twice", async () => {
    const { accounts } = service();
    await accounts.addAccount({ providerId: "boat", apiKey: "boat_live_x", scopeId: "personal" });
    await expect(
      accounts.addAccount({ providerId: "boat", apiKey: "boat_live_y", scopeId: "personal" })
    ).rejects.toThrow(/already connected/);
  });

  it("refuses before any provider call on a platform the provider can't serve", async () => {
    const provider = fakeProvider();
    const { accounts } = service({ provider, platform: "win32" });
    await expect(
      accounts.addAccount({ providerId: "boat", apiKey: "boat_live_x", scopeId: "personal" })
    ).rejects.toThrow("not on windows");
    expect(provider.checkKey).not.toHaveBeenCalled();
  });

  it("never sends a key to an API origin other than the one it was connected against", async () => {
    const { accounts, store, setApiUrl } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      apiKey: "boat_live_x",
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
      apiKey: "boat_live_x",
      scopeId: "personal",
    });
    vi.mocked(provider.checkKey).mockResolvedValueOnce({
      identity: "someone-else",
      scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: true }],
    });
    await expect(accounts.replaceKey(summary.id, "boat_live_z")).rejects.toThrow(/signs in as/);
  });

  it("won't remove an account that hosts still use", async () => {
    const { accounts, store, vault } = service();
    const summary = await accounts.addAccount({
      providerId: "boat",
      apiKey: "boat_live_x",
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
      lastError: null,
      createdAt: 0,
    });
    await expect(accounts.removeAccount(summary.id)).rejects.toThrow(/Remove it first/);
    store.removeBinding("cb_abcdefgh12");
    await accounts.removeAccount(summary.id);
    expect(vault.keys.size).toBe(0);
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
      apiKey: "boat_live_x",
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
      apiKey: "boat_live_x",
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
      apiKey: "boat_live_x",
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
    const request = { providerId: "boat" as const, apiKey: "boat_live_x", scopeId: "personal" };
    const results = await Promise.allSettled([
      accounts.addAccount(request),
      accounts.addAccount(request),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(accounts.summaries()).toHaveLength(1);
    expect(vault.keys.size).toBe(1);
  });

  it("checks nothing at the provider when the key couldn't be kept", async () => {
    const provider = fakeProvider();
    const { accounts, vault } = service({ provider });
    vi.spyOn(vault, "available").mockReturnValue(false);
    await expect(accounts.checkKey("boat", "boat_live_x")).rejects.toThrow(/keychain/);
    expect(provider.checkKey).not.toHaveBeenCalled();
  });

  it("refuses a pasted private key", async () => {
    const { accounts } = service();
    await expect(accounts.checkKey("boat", "-----BEGIN OPENSSH PRIVATE KEY-----")).rejects.toThrow(
      /private key/
    );
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
