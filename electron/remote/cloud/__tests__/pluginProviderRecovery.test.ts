import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type {
  CloudProviderContribution,
  CloudProviderImpl,
  CloudProviderResource,
} from "../../../../shared/types/pluginCloudProvider.js";
import type { SecretCipher } from "../../../services/plugin/secretCipher.js";

vi.mock("electron", () => ({ app: undefined, safeStorage: {} }));

const {
  bindPluginCloudProvider,
  clearPluginCloudProviders,
  publishPluginCloudProviders,
  setPluginCloudProviderRuntime,
  withdrawPluginCloudProviders,
} = await import("../../../services/plugin/pluginCloudProviders.js");
const { CloudAccountService } = await import("../CloudAccountService.js");
const { KeychainCloudCredentialVault } = await import("../CloudCredentialVault.js");
const { CloudHostLifecycle } = await import("../CloudHostLifecycle.js");
const { CloudHosts } = await import("../CloudHosts.js");
const { CloudHostStore } = await import("../CloudHostStore.js");
const { CloudProviderRegistry } = await import("../CloudProviderRegistry.js");
const { CloudSshFiles } = await import("../CloudSshFiles.js");
const { watchPluginCloudProviders } = await import("../pluginCloudProviderRegistrations.js");

const PLUGIN = "acme.clouds";
const PROVIDER = "acme.clouds.ec2";
const ACCOUNT = "ca_acmeplugin1";
const NOW = Date.parse("2026-11-18T12:00:00Z");
const CREDENTIALS = { accessKeyId: "AKIAEXAMPLE0001" };

function contribution(): CloudProviderContribution {
  return {
    id: "ec2",
    name: "EC2",
    description: "Machines on your AWS account.",
    apiUrl: "https://ec2.example.com",
    apiKeyUrl: "https://console.example.com/keys",
    dashboardUrl: "https://console.example.com/ec2",
    docsUrl: "https://docs.example.com",
    credentialFields: [
      {
        id: "accessKeyId",
        label: "Access key ID",
        secret: true,
        input: "single-line",
        required: true,
        help: null,
      },
    ],
    capabilities: {
      persistence: {
        kept: "Its disk",
        lost: "Memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: true,
      },
      typicalStartSeconds: 90,
      lifetime: { kind: "none" },
      sshTrust: "confirm-on-first-connect",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "none", image: "none", network: "none", sshKey: "at-create" },
      deletion: true,
    },
  };
}

function machine(overrides: Partial<CloudProviderResource> = {}): CloudProviderResource {
  return {
    resourceId: "i-0123456789",
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "t3.large",
    vcpu: 2,
    memoryGB: 8,
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: null,
    createdAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: false,
    labels: {},
    restricted: false,
    error: null,
    ...overrides,
  };
}

function fakeCipher(): SecretCipher {
  return {
    tier: () => "keychain",
    encrypt: async (plaintext) => Buffer.from(`enc:${plaintext}`, "utf-8").toString("base64"),
    decrypt: async (c) => ({
      plaintext: Buffer.from(c, "base64").toString("utf-8").slice("enc:".length),
      reencrypt: false,
    }),
  };
}

type PluginState = "enabled" | "disabled" | "blocked" | "uninstalled";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-plugin-recovery-"));
});

afterEach(async () => {
  clearPluginCloudProviders();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * The cloud runtime wired as `initCloudHosts` wires it, over the real plugin
 * hub and registrations, with a plugin whose state the test drives the way
 * the plugin service would: published and bound while it is on, withdrawn
 * otherwise, and its reasons worded by state.
 */
function runtime(options: { backend?: { value: unknown }; hosts?: HostDescriptor[] } = {}) {
  const backend = options.backend ?? { value: undefined };
  const plugin = { state: "uninstalled" as PluginState };
  setPluginCloudProviderRuntime({
    activate: async () => {},
    isActivated: () => plugin.state === "enabled",
    unavailableReason: (pluginId) =>
      plugin.state === "blocked"
        ? `Its cloud provider comes from the ${pluginId} plugin, which Daintree blocked: it leaks keys`
        : plugin.state === "disabled"
          ? `Its cloud provider comes from the ${pluginId} plugin, which is turned off. Turn it on in Settings → Plugins.`
          : `Its cloud provider comes from the ${pluginId} plugin, which isn't installed.`,
    startFailure: () => null,
  });
  let current = machine();
  const impl = {
    checkCredentials: vi.fn(async () => ({ identity: "octocat", scopes: [] })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(),
    list: vi.fn(async () => [current]),
    inspect: vi.fn(async (_credentials: unknown, resourceId: string) => ({
      ...current,
      resourceId,
    })),
    create: vi.fn(),
    start: vi.fn(async () => current),
    stop: vi.fn(async () => current),
    rename: vi.fn(),
    delete: vi.fn(),
    sshAccess: vi.fn(async () => ({
      user: "ubuntu",
      endpoint: { host: "203.0.113.9", port: 22 },
      hostKey: null,
    })),
  };

  const store = new CloudHostStore({
    get: () => backend.value,
    set: (_key, value) => {
      backend.value = JSON.parse(JSON.stringify(value));
    },
  });
  const registry = new CloudProviderRegistry();
  const vault = new KeychainCloudCredentialVault(
    path.join(root, "cloud-credentials.json"),
    fakeCipher()
  );
  let cloudHosts: InstanceType<typeof CloudHosts> | null = null;
  const watch = watchPluginCloudProviders({
    providers: registry,
    statusChanged: () => cloudHosts?.changed(),
  });
  const accounts = new CloudAccountService({
    store,
    vault,
    providers: registry,
    apiUrlFor: (id) => registry.apiUrlFor(id),
    platform: "darwin",
    now: () => NOW,
    unavailableReason: (id) => watch.unavailableReason(id),
    pluginProviderLabel: (id) => watch.label(id),
  });
  // The host list lives in its own store, so a restart finds the hosts it had.
  const hosts: HostDescriptor[] = options.hosts ?? [];
  const forget = vi.fn(async (hostId: string) => {
    const index = hosts.findIndex((host) => host.id === hostId);
    if (index >= 0) hosts.splice(index, 1);
  });
  const lifecycle = new CloudHostLifecycle({
    store,
    accounts,
    files: new CloudSshFiles(path.join(root, "cloud"), (async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      spawnError: null,
      timedOut: false,
    })) as never),
    clientDir: root,
    hosts: {
      add: (name: string, connection: HostConnection) => {
        const descriptor = { id: `host-${name}`, name, connection } as HostDescriptor;
        hosts.push(descriptor);
        return descriptor;
      },
      get: (id) => hosts.find((host) => host.id === id) ?? null,
      list: () => hosts,
      forget,
      disconnect: async () => {},
      onChange: () => () => {},
    },
    changed: () => {},
    sleep: async () => {},
    now: () => NOW,
  });
  cloudHosts = new CloudHosts({ accounts, store, emit: () => {} });
  cloudHosts.attachLifecycle(lifecycle);
  registry.onChange(() => {
    accounts.rememberPluginProviders();
    cloudHosts!.providersChanged();
  });
  accounts.rememberPluginProviders();

  const set = (state: PluginState) => {
    plugin.state = state;
    if (state === "enabled") {
      publishPluginCloudProviders(PLUGIN, [contribution()], "Acme Clouds");
      bindPluginCloudProvider(PLUGIN, "ec2", impl as unknown as CloudProviderImpl);
    } else {
      withdrawPluginCloudProviders(PLUGIN);
    }
  };

  return {
    backend,
    store,
    registry,
    vault,
    accounts,
    lifecycle,
    cloudHosts: cloudHosts!,
    hosts,
    forget,
    impl,
    set,
    setMachine: (next: CloudProviderResource) => (current = next),
    dispose: () => {
      watch.dispose();
      cloudHosts!.dispose();
      lifecycle.dispose();
    },
  };
}

/**
 * An account kept from an earlier session (connecting one for a plugin's
 * provider waits on #17352), the plugin loading as Daintree starts, and a host
 * on the account.
 */
async function connectedWithHost(env: ReturnType<typeof runtime>) {
  env.store.putAccount({
    id: ACCOUNT,
    providerId: PROVIDER,
    displayName: "Work",
    identity: "octocat",
    scope: { kind: "personal", id: "personal", name: "Personal" },
    apiUrl: "https://ec2.example.com",
    keyHint: "0001",
    credentialRevision: "rev-1",
    addedAt: NOW,
    validation: { status: "valid", checkedAt: NOW },
    lastProvisioning: null,
    pluginProvider: null,
  });
  await env.vault.put(ACCOUNT, CREDENTIALS);
  env.set("enabled");
  const { hostId } = await env.lifecycle.importMachine({
    accountId: ACCOUNT,
    resourceId: "i-0123456789",
    name: "build",
  });
  return hostId;
}

/** Another account kept beside the first, with its own credentials. */
async function anotherAccount(
  env: ReturnType<typeof runtime>,
  id: string,
  displayName: string,
  providerId: string = PROVIDER
) {
  env.store.putAccount({
    id,
    providerId,
    displayName,
    identity: null,
    scope: { kind: "personal", id: "personal", name: "Personal" },
    apiUrl: "https://ec2.example.com",
    keyHint: null,
    credentialRevision: "rev-1",
    addedAt: NOW,
    validation: { status: "valid", checkedAt: NOW },
    lastProvisioning: null,
    pluginProvider: null,
  });
  await env.vault.put(id, CREDENTIALS);
}

const LABEL = {
  pluginName: "Acme Clouds",
  providerName: "EC2",
  dashboardUrl: "https://console.example.com/ec2",
};

describe("a plugin's cloud accounts and machines when the plugin goes", () => {
  it("lists them as unavailable while it's off, and brings them back with no new connect", async () => {
    const env = runtime();
    const hostId = await connectedWithHost(env);
    // Its provider's registration named it on the account, for when the plugin is gone.
    expect(env.store.account(ACCOUNT)?.pluginProvider).toEqual(LABEL);

    env.set("disabled");
    const [account] = env.accounts.summaries();
    expect(account).toMatchObject({
      id: ACCOUNT,
      providerUnavailable: expect.stringContaining("which is turned off"),
      pluginProvider: LABEL,
      hostCount: 1,
    });
    const [host] = env.lifecycle.statuses();
    expect(host).toMatchObject({
      hostId,
      providerUnavailable: expect.stringContaining("which is turned off"),
      pluginProvider: LABEL,
      machine: "running",
      machineName: "build",
      resourceId: "i-0123456789",
      observedAt: NOW,
    });
    expect(env.cloudHosts.snapshot().providers).toEqual([]);

    env.impl.inspect.mockClear();
    env.setMachine(machine({ machine: "stopped", rawState: "stopped" }));
    env.set("enabled");
    expect(env.accounts.summaries()[0]).toMatchObject({ providerUnavailable: null });
    // The same account and credentials reach the provider again: nothing was connected anew.
    await env.lifecycle.refresh(hostId);
    expect(env.impl.inspect).toHaveBeenCalledTimes(1);
    expect(env.impl.inspect.mock.calls[0]![0]).toMatchObject({ values: CREDENTIALS });
    expect(env.impl.checkCredentials).not.toHaveBeenCalled();
    expect(env.lifecycle.statuses()[0]).toMatchObject({
      hostId,
      providerUnavailable: null,
      machine: "stopped",
    });
    env.dispose();
  });

  it("keeps a blocked plugin's machines listed, named and linked, through a restart that never loads it", async () => {
    const env = runtime();
    const hostId = await connectedWithHost(env);
    env.set("blocked");
    env.dispose();
    clearPluginCloudProviders();

    // The next start: the blocklist keeps the plugin from loading, so nothing ever declares its provider.
    const restarted = runtime({ backend: env.backend, hosts: env.hosts });
    restarted.set("blocked");
    // Its first pass drops bindings whose host is gone: this one's host is still listed.
    restarted.lifecycle.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted.store.bindings()).toHaveLength(1);
    expect(restarted.hosts.map((host) => host.id)).toEqual([hostId]);
    expect(restarted.accounts.summaries()).toEqual([
      expect.objectContaining({
        id: ACCOUNT,
        providerUnavailable: expect.stringContaining("which Daintree blocked"),
        pluginProvider: LABEL,
      }),
    ]);
    expect(restarted.lifecycle.statuses()).toEqual([
      expect.objectContaining({
        hostId,
        providerUnavailable: expect.stringContaining("which Daintree blocked"),
        pluginProvider: LABEL,
        machine: "running",
        observedAt: NOW,
      }),
    ]);
    // A person's Retry while it's blocked can't ask anything, and leaves when it was last seen.
    const bindingId = restarted.store.bindings()[0]!.id;
    await expect(
      restarted.lifecycle.ensureAccess(bindingId, undefined, { fresh: true })
    ).rejects.toBeTruthy();
    expect(restarted.store.binding(bindingId)!.observation?.observedAt).toBe(NOW);
    expect(restarted.impl.inspect).not.toHaveBeenCalled();
    restarted.dispose();
  });

  it("names a removed plugin's accounts and hosts for its uninstall, and keeps them for a reinstall", async () => {
    const env = runtime();
    const hostId = await connectedWithHost(env);
    env.set("uninstalled");

    expect(env.cloudHosts.pluginCloudAccounts().get(PLUGIN)).toEqual([
      { id: ACCOUNT, name: "Work", providerName: "EC2", hosts: [{ hostId, name: "build" }] },
    ]);
    // Kept: everything stays, credentials sealed, and a reinstall picks it all up.
    expect(await env.vault.get(ACCOUNT)).toEqual(CREDENTIALS);
    env.set("enabled");
    expect(env.accounts.summaries()[0]).toMatchObject({ id: ACCOUNT, providerUnavailable: null });
    expect(env.lifecycle.statuses()[0]).toMatchObject({ hostId, providerUnavailable: null });
    env.dispose();
  });

  it("removes the accounts and their hosts on uninstall when asked, deleting the sealed credentials and touching no machine", async () => {
    const env = runtime();
    const hostId = await connectedWithHost(env);
    // Another account of the same plugin that the uninstall didn't list.
    await anotherAccount(env, "ca_acmeplugin3", "Spare");
    const { hostId: spareHost } = await env.lifecycle.importMachine({
      accountId: "ca_acmeplugin3",
      resourceId: "i-0000000003",
      name: "spare",
    });
    const file = path.join(root, "cloud-credentials.json");
    expect(await fs.readFile(file, "utf-8")).toContain(ACCOUNT);
    env.set("uninstalled");

    env.cloudHosts.requirePluginAccounts(PLUGIN, [ACCOUNT]);
    await env.cloudHosts.removePluginAccounts(PLUGIN, [ACCOUNT]);

    expect(env.forget.mock.calls).toEqual([[hostId]]);
    expect(env.hosts.map((host) => host.id)).toEqual([spareHost]);
    expect(env.store.bindings().map((binding) => binding.accountId)).toEqual(["ca_acmeplugin3"]);
    expect(env.store.accounts().map((account) => account.id)).toEqual(["ca_acmeplugin3"]);
    expect(await env.vault.get(ACCOUNT)).toBeNull();
    expect(await env.vault.get("ca_acmeplugin3")).toEqual(CREDENTIALS);
    // Read back from disk by a fresh vault: the sealed set is gone, not just forgotten in memory.
    const reopened = new KeychainCloudCredentialVault(file, fakeCipher());
    expect(await reopened.get(ACCOUNT)).toBeNull();
    expect(await reopened.get("ca_acmeplugin3")).toEqual(CREDENTIALS);
    expect(await fs.readFile(file, "utf-8")).not.toContain(ACCOUNT);
    expect(env.impl.stop).not.toHaveBeenCalled();
    expect(env.impl.delete).not.toHaveBeenCalled();
    env.dispose();
  });

  it("refuses to remove another provider's account for a plugin's uninstall", async () => {
    const env = runtime();
    env.store.putAccount({
      id: "ca_builtin0001",
      providerId: "boat",
      displayName: "Boat",
      identity: null,
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://api.boat.dev",
      keyHint: null,
      credentialRevision: "rev-1",
      addedAt: NOW,
      validation: { status: "valid", checkedAt: NOW },
      lastProvisioning: null,
      pluginProvider: null,
    });
    await env.vault.put("ca_builtin0001", CREDENTIALS);
    await anotherAccount(env, "ca_otherplug01", "Theirs", "other.clouds.ec2");
    for (const foreign of ["ca_builtin0001", "ca_otherplug01"]) {
      expect(() => env.cloudHosts.requirePluginAccounts(PLUGIN, [foreign])).toThrow(
        expect.objectContaining({ userMessage: expect.stringContaining("doesn't belong") })
      );
    }
    // An id already gone is nothing to refuse.
    expect(() => env.cloudHosts.requirePluginAccounts(PLUGIN, ["ca_gonegone01"])).not.toThrow();
    // Nor does a removal asked for directly ever reach past the plugin's own namespace.
    await env.cloudHosts.removePluginAccounts(PLUGIN, ["ca_builtin0001", "ca_otherplug01"]);
    expect(env.store.accounts().map((account) => account.id)).toEqual([
      "ca_builtin0001",
      "ca_otherplug01",
    ]);
    expect(await env.vault.get("ca_builtin0001")).toEqual(CREDENTIALS);
    expect(await env.vault.get("ca_otherplug01")).toEqual(CREDENTIALS);
    env.dispose();
  });

  it("names each account a removal couldn't finish, and still removes the rest", async () => {
    const env = runtime();
    await connectedWithHost(env);
    await anotherAccount(env, "ca_acmeplugin2", "Spare");
    await anotherAccount(env, "ca_acmeplugin4", "Old");
    env.set("uninstalled");
    const remove = env.accounts.removeAccount.bind(env.accounts);
    vi.spyOn(env.accounts, "removeAccount").mockImplementation(async (id) => {
      if (id === ACCOUNT) throw new Error("the keychain is locked");
      if (id === "ca_acmeplugin2") throw new Error("a machine key may still work");
      return remove(id);
    });

    const failure = await env.cloudHosts
      .removePluginAccounts(PLUGIN, [ACCOUNT, "ca_acmeplugin2", "ca_acmeplugin4"])
      .then(
        () => null,
        (error: { userMessage?: string }) => error.userMessage ?? ""
      );
    expect(failure).toContain("uninstalled, but these cloud accounts are still on this device");
    expect(failure).toContain("Work (the keychain is locked)");
    expect(failure).toContain("Spare (a machine key may still work)");
    expect(failure).not.toContain("Old");
    expect(env.store.account("ca_acmeplugin4")).toBeNull();
    expect(await env.vault.get("ca_acmeplugin4")).toBeNull();
    expect(await env.vault.get(ACCOUNT)).toEqual(CREDENTIALS);
    expect(await env.vault.get("ca_acmeplugin2")).toEqual(CREDENTIALS);
    env.dispose();
  });

  it("registers the provider anyway when what it's called can't be written", async () => {
    const env = runtime();
    await anotherAccount(env, ACCOUNT, "Work");
    const saved = env.backend.value;
    // A settings file: each read is a fresh copy, so a write that failed changed nothing.
    Object.defineProperty(env.backend, "value", {
      get: () => JSON.parse(JSON.stringify(saved)),
      set: () => {
        throw new Error("disk full");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => env.set("enabled")).not.toThrow();
    expect(env.registry.has(PROVIDER)).toBe(true);
    expect(env.accounts.summaries()[0]).toMatchObject({
      providerUnavailable: null,
      pluginProvider: null,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    env.dispose();
  });
});
