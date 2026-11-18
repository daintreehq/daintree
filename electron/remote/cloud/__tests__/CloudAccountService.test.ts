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
          stoppedStorageBilled: false,
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
  options: {
    provider?: CloudProvider;
    platform?: NodeJS.Platform;
    apiUrl?: string;
    beforeAccountRemoved?: (accountId: string) => Promise<void>;
  } = {}
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
    beforeAccountRemoved: options.beforeAccountRemoved,
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

  it("names a project or provider account for itself and a workspace one for its sign-in by default", async () => {
    const scoped = (kind: "project" | "workspace" | "account") =>
      fakeProvider({
        checkCredentials: vi.fn(async () => ({
          identity: "daintree@acme-build.iam.gserviceaccount.com",
          scopes: [{ scope: { kind, id: "acme-build", name: "Acme Build" }, active: true }],
        })),
      });
    for (const [kind, expected] of [
      ["project", "Acme Build"],
      ["workspace", "daintree@acme-build.iam.gserviceaccount.com"],
      ["account", "Acme Build"],
    ] as const) {
      const { accounts } = service({ provider: scoped(kind) });
      const summary = await accounts.addAccount({
        providerId: "boat",
        credentials: { apiKey: "boat_live_0123456789abcd" },
        scopeId: "acme-build",
      });
      expect(summary.displayName).toBe(expected);
    }
  });

  function anonymousProvider(overrides: Partial<CloudProvider> = {}): CloudProvider {
    const base = fakeProvider();
    return fakeProvider({
      info: (platform) => ({ ...base.info(platform), name: "Acme Cloud" }),
      checkCredentials: vi.fn(async () => ({
        identity: null,
        scopes: [
          {
            scope: { kind: "workspace" as const, id: "workspace", name: "Workspace" },
            active: true,
          },
        ],
      })),
      ...overrides,
    });
  }

  function bindingFor(accountId: string, resourceId: string) {
    return {
      id: `cb_${resourceId.slice(-10)}`,
      hostId: resourceId,
      accountId,
      providerId: "boat",
      resourceId,
      ownership: "imported" as const,
      createdFor: null,
      worktreeCleanup: null,
      provisioning: null,
      creation: null,
      lifetimeSeconds: null,
      intent: null,
      observation: null,
      access: null,
      trustedHostKey: null,
      offeredHostKey: null,
      lastError: null,
      createdAt: 0,
    };
  }

  it("takes a new key for a nameless workspace only when it sees that account's machines (#17347)", async () => {
    const seen = new Set(["sk_live_old", "sk_live_same"]);
    const inspect = vi.fn(async (credentials: { values: { apiKey?: string } }) => {
      if (!seen.has(credentials.values.apiKey ?? "")) throw { code: "404" };
      return {} as never;
    });
    const provider = anonymousProvider({
      inspect,
      describeError: (error) => ({
        code: (error as { code?: string })?.code === "404" ? "not-found" : "failed",
        message: "described",
        at: 0,
      }),
    });
    const { accounts, store, vault } = service({ provider });
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "sk_live_old" },
      scopeId: "workspace",
    });
    // Nothing bound yet: there is nothing a key from elsewhere could strand.
    await accounts.replaceCredentials(summary.id, { apiKey: "sk_live_elsewhere" });
    expect(inspect).not.toHaveBeenCalled();
    await accounts.replaceCredentials(summary.id, { apiKey: "sk_live_old" });

    store.putBinding(bindingFor(summary.id, "vm_gone000001"));
    store.putBinding(bindingFor(summary.id, "vm_kept000001"));
    inspect.mockImplementation(
      async (credentials: { values: { apiKey?: string } }, resourceId?: unknown) => {
        if (resourceId === "vm_gone000001" || !seen.has(credentials.values.apiKey ?? ""))
          throw { code: "404" };
        return {} as never;
      }
    );
    await expect(
      accounts.replaceCredentials(summary.id, { apiKey: "sk_live_elsewhere" })
    ).rejects.toThrow(/can't see this account's machines.*another Acme Cloud workspace/);
    expect(vault.sets.get(summary.id)).toEqual({ apiKey: "sk_live_old" });
    // One machine deleted since proves nothing; another it can see is enough.
    await accounts.replaceCredentials(summary.id, { apiKey: "sk_live_same" });
    expect(vault.sets.get(summary.id)).toEqual({ apiKey: "sk_live_same" });

    // A machine asked for and not yet found is looked for with this account's key: hold it.
    store.putBinding({
      ...bindingFor(summary.id, "vm_pend000001"),
      resourceId: null,
      ownership: "created-by-daintree",
      creation: {
        operationId: "op",
        idempotencyKey: "key",
        sentAt: 5,
        name: "pending",
        machineType: "2x4",
      },
    });
    await expect(
      accounts.replaceCredentials(summary.id, { apiKey: "sk_live_old" })
    ).rejects.toThrow(/hasn't been confirmed yet/);
    expect(vault.sets.get(summary.id)).toEqual({ apiKey: "sk_live_same" });
  });

  it("connects a second workspace whose provider can't say who a key is, named after the provider (#17347)", async () => {
    const provider = fakeProvider({
      info: anonymousProvider().info,
      checkCredentials: vi.fn(async () => ({
        identity: null,
        scopes: [
          {
            scope: { kind: "workspace" as const, id: "workspace", name: "Workspace" },
            active: true,
          },
        ],
      })),
    });
    const { accounts, store, backend, vault } = service({ provider });
    const first = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "sk_live_first" },
      scopeId: "workspace",
    });
    expect(first).toMatchObject({
      displayName: "Acme Cloud",
      identity: null,
      billingScope: { kind: "workspace", id: "workspace", name: "Workspace" },
    });
    // Nothing tells two such keys apart, so neither is refused as the other.
    const second = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "sk_live_second" },
      scopeId: "workspace",
    });
    expect(store.accounts()).toHaveLength(2);
    expect(vault.sets.get(first.id)).toEqual({ apiKey: "sk_live_first" });
    expect(vault.sets.get(second.id)).toEqual({ apiKey: "sk_live_second" });
    // The scope reads back from disk as it was written.
    const reread = new CloudHostStore(memoryBackend(backend.value));
    expect(reread.accounts().map((account) => account.scope.kind)).toEqual([
      "workspace",
      "workspace",
    ]);
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
      worktreeCleanup: null,
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

  it("keeps the account and its key while a key its machines were given can't be revoked (#17361)", async () => {
    const settle = vi.fn(async (): Promise<void> => {
      throw new AppError({ code: "OUTCOME_UNKNOWN", message: "couldn't revoke yet" });
    });
    const { accounts, vault } = service({ beforeAccountRemoved: settle });
    const summary = await accounts.addAccount({
      providerId: "boat",
      credentials: { apiKey: "boat_live_x" },
      scopeId: "personal",
    });
    await expect(accounts.removeAccount(summary.id)).rejects.toThrow("couldn't revoke yet");
    expect(settle).toHaveBeenCalledWith(summary.id);
    expect(accounts.summaries().map((a) => a.id)).toEqual([summary.id]);
    expect(await vault.get(summary.id)).toEqual({ apiKey: "boat_live_x" });

    // Revoked first, while the key is still there to do it.
    settle.mockImplementationOnce(async () => {
      expect(await vault.get(summary.id)).toEqual({ apiKey: "boat_live_x" });
    });
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

function personalChoice() {
  return { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true };
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
    expect(provider.checkCredentials).toHaveBeenCalledTimes(2);
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(
      { ...first, accessKeyId: "AKIAEXAMPLE0001" },
      "https://boat.dev/api/v1"
    );
    expect(vault.sets.get(added.id)).toEqual({ ...first, accessKeyId: "AKIAEXAMPLE0001" });
    expect(added.keyHint).toBe("ret1");

    const second = {
      accessKeyId: "AKIAEXAMPLE0002",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYsecret2",
      region: "eu-west-1",
    };
    const replaced = await accounts.replaceCredentials(added.id, second);
    expect(provider.checkCredentials).toHaveBeenCalledTimes(3);
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(second, "https://boat.dev/api/v1");
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
    expect(provider.checkCredentials).toHaveBeenCalledTimes(2);
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(first, "https://boat.dev/api/v1");
    expect(vault.sets.get(added.id)).toEqual(first);
    expect(added.keyHint).toBeNull();

    const second = { keyFile: serviceAccountKey("key-two"), project: "acme-build" };
    const replaced = await accounts.replaceCredentials(added.id, second);
    expect(provider.checkCredentials).toHaveBeenLastCalledWith(second, "https://boat.dev/api/v1");
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

    // A provider whose every field is optional still gets a set with something in it.
    const optional = fieldsProvider("acme.clouds.do", [
      field("token", "single-line", { required: false }),
    ]);
    const { accounts: others } = service({ provider: optional });
    await expect(others.checkCredentials("acme.clouds.do", { token: "  " })).rejects.toThrow(
      /Fill in the account's credentials/
    );
    expect(optional.checkCredentials).not.toHaveBeenCalled();
  });

  it("leaves the set and the account as they were when the provider refuses a replacement", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, store } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "personal",
    });
    const before = store.account(added.id);
    vi.mocked(provider.checkCredentials).mockRejectedValueOnce(
      Object.assign(new Error("invalid_grant"), { code: "401" })
    );
    await expect(
      accounts.replaceCredentials(added.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
    ).rejects.toBeInstanceOf(AppError);
    expect(vault.sets.get(added.id)).toEqual(first);
    expect(store.account(added.id)).toEqual(before);
  });

  it("puts the old set back when the account can't be written after the new one was sealed", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, store } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "personal",
    });
    const before = store.account(added.id);
    vi.spyOn(store, "putAccount").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    await expect(
      accounts.replaceCredentials(added.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
    ).rejects.toThrow("ENOSPC");
    expect(vault.sets.get(added.id)).toEqual(first);
    expect(store.account(added.id)).toEqual(before);
  });

  it("removes the new set when the account had none and can't be written", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, store } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    // Its credentials went missing on this device: what Replace exists to fix.
    await vault.delete(added.id);
    vi.spyOn(store, "putAccount").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    await expect(
      accounts.replaceCredentials(added.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
    ).rejects.toThrow("ENOSPC");
    expect(vault.sets.has(added.id)).toBe(false);
  });

  it("refuses a replacement for someone else when the old set turns out to be another's while it seals", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(async () => ({ identity: "alice@acme.iam" })),
    });
    vi.mocked(provider.checkCredentials)
      .mockResolvedValueOnce({ identity: null, scopes: [personalChoice()] })
      .mockResolvedValueOnce({ identity: "bob@acme.iam", scopes: [personalChoice()] });
    const { accounts, vault, store } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    let release: () => void = () => {};
    const sealing = new Promise<void>((resolve) => (release = resolve));
    const put = vault.put.bind(vault);
    vi.spyOn(vault, "put").mockImplementationOnce(async (id, values) => {
      await sealing;
      await put(id, values);
    });
    const replacing = accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    await vi.waitFor(() => expect(vault.put).toHaveBeenCalled());
    await accounts.validate(added.id);
    expect(store.account(added.id)?.identity).toBe("alice@acme.iam");
    release();
    await expect(replacing).rejects.toThrow(/sign in as bob@acme\.iam, not alice@acme\.iam/);
    expect(vault.sets.get(added.id)?.keyFile).toContain("key-one");
  });

  it("keeps the sign-in known at commit when the new set's check names none", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(async () => ({ identity: "carol@acme.iam" })),
    });
    vi.mocked(provider.checkCredentials)
      .mockResolvedValueOnce({ identity: "alice@acme.iam", scopes: [personalChoice()] })
      // A blank sign-in is no sign-in.
      .mockResolvedValueOnce({ identity: " ", scopes: [personalChoice()] });
    const { accounts, vault, store } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    let release: () => void = () => {};
    const sealing = new Promise<void>((resolve) => (release = resolve));
    const put = vault.put.bind(vault);
    vi.spyOn(vault, "put").mockImplementationOnce(async (id, values) => {
      await sealing;
      await put(id, values);
    });
    const replacing = accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    await vi.waitFor(() => expect(vault.put).toHaveBeenCalled());
    await accounts.validate(added.id);
    expect(store.account(added.id)?.identity).toBe("carol@acme.iam");
    release();
    await replacing;
    expect(store.account(added.id)?.identity).toBe("alice@acme.iam");
  });

  it("keeps a known sign-in when a check of the account answers with a blank one", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(async () => ({ identity: "" })),
    });
    const { accounts, store } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    await accounts.validate(added.id);
    expect(store.account(added.id)?.identity).toBe("octocat");
  });

  it("won't make an account a second copy of one already connected for that sign-in and wallet", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    vi.mocked(provider.checkCredentials)
      .mockResolvedValueOnce({ identity: null, scopes: [personalChoice()] })
      .mockResolvedValueOnce({ identity: "bob@acme.iam", scopes: [personalChoice()] })
      .mockResolvedValueOnce({ identity: "bob@acme.iam", scopes: [personalChoice()] });
    const { accounts, vault } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };
    const unknown = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "personal",
    });
    await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-bob"), project: "acme-build" },
      scopeId: "personal",
      displayName: "Bob's",
    });
    await expect(
      accounts.replaceCredentials(unknown.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
    ).rejects.toThrow(/Bob's is already connected as bob@acme\.iam/);
    expect(vault.sets.get(unknown.id)).toEqual(first);
  });

  it("refuses a replacement that signs in as someone a check of the old set has since learned", async () => {
    let pass: () => void = () => {};
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(async () => ({ identity: "alice@acme.iam" })),
    });
    vi.mocked(provider.checkCredentials)
      .mockResolvedValueOnce({ identity: null, scopes: [personalChoice()] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            pass = () => resolve({ identity: "bob@acme.iam", scopes: [personalChoice()] });
          })
      );
    const { accounts, vault } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "personal",
    });
    const replacing = accounts
      .replaceCredentials(added.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(provider.checkCredentials).toHaveBeenCalledTimes(2));
    await accounts.validate(added.id);
    pass();
    expect(await replacing).toMatchObject({
      userMessage: expect.stringMatching(/sign in as bob@acme\.iam, not alice@acme\.iam/),
    });
    expect(vault.sets.get(added.id)).toEqual(first);
  });

  it("leaves nothing sealed when a new account can't be written", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, store } = service({ provider });
    vi.spyOn(store, "putAccount").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    await expect(
      accounts.addAccount({
        providerId: "acme.clouds.gce",
        credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
        scopeId: "personal",
      })
    ).rejects.toThrow("ENOSPC");
    expect(vault.sets.size).toBe(0);
    expect(accounts.summaries()).toEqual([]);
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

  it("doesn't take a successful answer about the set before a replacement for the new one", async () => {
    let answer: (value: { identity: string }) => void = () => {};
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, {
      validate: vi.fn(() => new Promise<{ identity: string }>((resolve) => (answer = resolve))),
    });
    const { accounts, store } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    const checking = accounts.validate(added.id);
    await vi.waitFor(() => expect(provider.validate).toHaveBeenCalled());
    await accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    const replaced = store.account(added.id);
    answer({ identity: "old-key@acme.iam" });
    await checking;
    expect(store.account(added.id)).toEqual(replaced);
  });

  it("doesn't mark replaced credentials refused when a listing with the old set is refused", async () => {
    let refuse: (error: Error) => void = () => {};
    const list = vi.fn(() => new Promise<never>((_resolve, reject) => (refuse = reject)));
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE, { list });
    const { accounts } = service({ provider });
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: { keyFile: serviceAccountKey("key-one"), project: "acme-build" },
      scopeId: "personal",
    });
    const listing = accounts.listResources(added.id).catch((e: unknown) => e);
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await accounts.replaceCredentials(added.id, {
      keyFile: serviceAccountKey("key-two"),
      project: "acme-build",
    });
    refuse(Object.assign(new Error("revoked"), { code: "401" }));
    expect(await listing).toBeInstanceOf(AppError);
    expect(accounts.summaries()[0]!.validation).toMatchObject({ status: "valid" });

    // The same refusal of the set kept now does mark it.
    list.mockRejectedValueOnce(Object.assign(new Error("revoked"), { code: "401" }));
    await expect(accounts.listResources(added.id)).rejects.toBeInstanceOf(AppError);
    expect(accounts.summaries()[0]!.validation).toMatchObject({ status: "invalid" });
  });

  it("stops a replacement that can't read the set it would replace, before overwriting it", async () => {
    const provider = fieldsProvider("acme.clouds.gce", KEY_FILE);
    const { accounts, vault, store } = service({ provider });
    const first = { keyFile: serviceAccountKey("key-one"), project: "acme-build" };
    const added = await accounts.addAccount({
      providerId: "acme.clouds.gce",
      credentials: first,
      scopeId: "personal",
    });
    vi.spyOn(vault, "get").mockRejectedValueOnce(new Error("keychain timed out"));
    const put = vi.spyOn(vault, "put");
    const remove = vi.spyOn(vault, "delete");
    vi.spyOn(store, "putAccount").mockImplementationOnce(() => {
      throw new Error("ENOSPC");
    });
    await expect(
      accounts.replaceCredentials(added.id, {
        keyFile: serviceAccountKey("key-two"),
        project: "acme-build",
      })
    ).rejects.toThrow("keychain timed out");
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(vault.sets.get(added.id)).toEqual(first);
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

  it("holds a remove until a replacement already sealing has finished, so no set outlives its account", async () => {
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
    let release: () => void = () => {};
    const sealing = new Promise<void>((resolve) => (release = resolve));
    const put = vault.put.bind(vault);
    const putSpy = vi.spyOn(vault, "put").mockImplementationOnce(async (id, values) => {
      await sealing;
      await put(id, values);
    });
    const deleteSpy = vi.spyOn(vault, "delete");
    const replacing = accounts.replaceCredentials(added.id, {
      accessKeyId: "AKIAEXAMPLE0002",
      secretAccessKey: "secret-access-key-two",
      region: "us-east-1",
    });
    await vi.waitFor(() => expect(putSpy).toHaveBeenCalled());
    const removing = accounts.removeAccount(added.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleteSpy).not.toHaveBeenCalled();
    release();
    await expect(replacing).resolves.toMatchObject({ id: added.id });
    await removing;
    expect(vault.sets.size).toBe(0);
    expect(accounts.summaries()).toEqual([]);
  });

  it("lets the next commit run after one that failed, and gives each caller its own answer", async () => {
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
    let fail: (error: Error) => void = () => {};
    const put = vi
      .spyOn(vault, "put")
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = reject)));
    const second = {
      accessKeyId: "AKIAEXAMPLE0002",
      secretAccessKey: "secret-access-key-two",
      region: "us-east-1",
    };
    const third = {
      accessKeyId: "AKIAEXAMPLE0003",
      secretAccessKey: "secret-access-key-three",
      region: "us-east-1",
    };
    const get = vi.spyOn(vault, "get");
    const first = accounts.replaceCredentials(added.id, second).catch((e: unknown) => e);
    const next = accounts.replaceCredentials(added.id, third);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // The second waits its turn: it hasn't read the set to fall back to, or sealed its own.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    fail(new Error("keychain locked"));
    expect(await first).toMatchObject({ message: "keychain locked" });
    expect(await next).toMatchObject({ keyHint: "hree" });
    expect(vault.sets.get(added.id)).toEqual(third);
  });

  it("keeps working with an account whose bare key was sealed before sets", async () => {
    const { accounts, store, vault } = service();
    store.putAccount({
      id: "ca_abcdefgh",
      providerId: "boat",
      displayName: "Personal",
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://boat.dev/api/v1",
      identity: "old-login",
      keyHint: "abcd",
      credentialRevision: null,
      lastProvisioning: null,
      addedAt: 1,
      validation: { status: "unknown", checkedAt: null, detail: null },
    });
    await vault.put("ca_abcdefgh", { apiKey: "boat_live_0123456789abcd" });
    expect(await accounts.credentials(store.account("ca_abcdefgh")!)).toMatchObject({
      values: { apiKey: "boat_live_0123456789abcd" },
      scopeId: "personal",
    });
    await accounts.validate("ca_abcdefgh");
    expect(accounts.summaries()[0]).toMatchObject({
      identity: "octocat",
      keyHint: "abcd",
      validation: { status: "valid", checkedAt: 1000 },
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
