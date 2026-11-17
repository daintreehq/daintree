import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudHostsSnapshot } from "../../../../shared/types/cloudHosts.js";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";
import { BoatProvider } from "../boat/BoatProvider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import { CloudHosts } from "../CloudHosts.js";
import {
  CloudHostStore,
  type CloudHostsValue,
  type StoredCloudBinding,
} from "../CloudHostStore.js";
import { CloudProviderRegistry } from "../CloudProviderRegistry.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider, ProviderResource } from "../provider.js";
import type { CommandRunner } from "../../client/commandRunner.js";

const PLUGIN_PROVIDER = "acme.clouds.ec2";
const NOW = Date.parse("2026-11-14T12:00:00Z");

function resource(overrides: Partial<ProviderResource> = {}): ProviderResource {
  return {
    resourceId: "i-0123456789",
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    autoStopAt: new Date(NOW + 20 * 60_000).toISOString(),
    lifetimeSeconds: 7200,
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

function fakeProvider(id: string, machine: () => ProviderResource): CloudProvider {
  const boat = new BoatProvider(() => {
    throw new Error("unused");
  });
  return {
    id,
    info: (platform) => ({ ...boat.info(platform), id, name: `Provider ${id}` }),
    describeError: (error) => boat.describeError(error),
    checkKey: vi.fn(async () => ({
      identity: "octocat",
      scopes: [
        { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
      ],
    })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(async () => ({
      machineTypes: [],
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    })),
    list: vi.fn(async () => [machine()]),
    inspect: vi.fn(async () => machine()),
    create: vi.fn(),
    start: vi.fn(async () => machine()),
    stop: vi.fn(async () => machine()),
    renewLifetime: vi.fn(async () => machine()),
    rename: vi.fn(),
    delete: vi.fn(),
    authorizeSsh: vi.fn(),
  } as CloudProvider;
}

describe("CloudProviderRegistry", () => {
  it("registers a plugin's provider under an id nobody knew at build time", () => {
    const registry = new CloudProviderRegistry();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
    registry.register(provider, {
      owner: { kind: "plugin", pluginId: "acme.clouds" },
      apiUrl: "https://api.acme.test",
    });
    expect(registry.get(PLUGIN_PROVIDER)).toBe(provider);
    expect(registry.apiUrlFor(PLUGIN_PROVIDER)).toBe("https://api.acme.test");
    expect([...registry.values()]).toEqual([provider]);
  });

  it("keeps each owner inside its own namespace", () => {
    const registry = new CloudProviderRegistry();
    const plugin = { kind: "plugin" as const, pluginId: "acme.clouds" };
    // A plugin can't take a built-in's bare id, or another plugin's.
    expect(() =>
      registry.register(
        fakeProvider("boat", () => resource()),
        { owner: plugin, apiUrl: "" }
      )
    ).toThrow(/namespace/);
    expect(() =>
      registry.register(
        fakeProvider("other.clouds.ec2", () => resource()),
        {
          owner: plugin,
          apiUrl: "",
        }
      )
    ).toThrow(/namespace/);
    // Nor can a built-in take a plugin-shaped id.
    expect(() =>
      registry.register(
        fakeProvider(PLUGIN_PROVIDER, () => resource()),
        {
          owner: { kind: "built-in" },
          apiUrl: "",
        }
      )
    ).toThrow(/bare name/);
    expect(() =>
      registry.register(
        fakeProvider("Not An Id", () => resource()),
        {
          owner: { kind: "built-in" },
          apiUrl: "",
        }
      )
    ).toThrow(/Invalid/);
    expect([...registry.values()]).toEqual([]);
  });

  it("refuses a second provider under an id already held, and one that describes itself as another", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "built-in" as const };
    registry.register(new BoatProvider(() => ({}) as never), { owner, apiUrl: "a" });
    expect(() =>
      registry.register(new BoatProvider(() => ({}) as never), { owner, apiUrl: "b" })
    ).toThrow(/already registered/);
    expect(registry.apiUrlFor("boat")).toBe("a");
    const liar = fakeProvider("agent37", () => resource());
    liar.info = (platform) => ({ ...fakeProvider("boat", () => resource()).info(platform) });
    expect(() => registry.register(liar, { owner, apiUrl: "" })).toThrow(/describes itself/);
  });

  it("lets an old registration's remover leave a newer one in place", () => {
    const registry = new CloudProviderRegistry();
    const owner = { kind: "plugin" as const, pluginId: "acme.clouds" };
    const changes = vi.fn();
    const stopWatching = registry.onChange(changes);
    const first = registry.register(
      fakeProvider(PLUGIN_PROVIDER, () => resource()),
      {
        owner,
        apiUrl: "one",
      }
    );
    first();
    expect(registry.get(PLUGIN_PROVIDER)).toBeUndefined();
    expect(registry.apiUrlFor(PLUGIN_PROVIDER)).toBeNull();
    const again = fakeProvider(PLUGIN_PROVIDER, () => resource());
    registry.register(again, { owner, apiUrl: "two" });
    first();
    expect(registry.get(PLUGIN_PROVIDER)).toBe(again);
    expect(changes).toHaveBeenCalledTimes(3);
    stopWatching();
    registry.register(new BoatProvider(() => ({}) as never), {
      owner: { kind: "built-in" },
      apiUrl: "",
    });
    expect(changes).toHaveBeenCalledTimes(3);
  });
});

describe("cloud accounts and hosts whose provider isn't registered", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-providers-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function setup(raw?: unknown) {
    const clock = { now: NOW };
    let backendValue: unknown = raw;
    const store = new CloudHostStore({
      get: () => backendValue,
      set: (_key: "cloudHosts", value: CloudHostsValue) => {
        backendValue = JSON.parse(JSON.stringify(value));
      },
    });
    const registry = new CloudProviderRegistry();
    const vault = new MemoryCloudCredentialVault();
    const accounts = new CloudAccountService({
      store,
      vault,
      providers: registry,
      apiUrlFor: (id) => registry.apiUrlFor(id),
      platform: "darwin",
      now: () => clock.now,
    });
    const hosts: HostDescriptor[] = [];
    const disconnect = vi.fn(async () => {});
    const files = new CloudSshFiles(path.join(root, "cloud"), (async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      spawnError: null,
      timedOut: false,
    })) as unknown as CommandRunner);
    const lifecycle = new CloudHostLifecycle({
      store,
      accounts,
      files,
      clientDir: root,
      hosts: {
        add: (name: string, connection: HostConnection) => {
          const descriptor = { id: name, name, connection } as HostDescriptor;
          hosts.push(descriptor);
          return descriptor;
        },
        get: (id) => hosts.find((host) => host.id === id) ?? null,
        list: () => hosts,
        forget: async () => {},
        disconnect,
        onChange: () => () => {},
      },
      changed: () => {},
      sleep: async () => {},
      activity: () => ({ connected: true, busy: true, shown: true }),
      now: () => clock.now,
    });
    const emitted: CloudHostsSnapshot[] = [];
    const cloudHosts = new CloudHosts({ accounts, store, emit: (s) => emitted.push(s) });
    cloudHosts.attachLifecycle(lifecycle);
    registry.onChange(() => cloudHosts.providersChanged());
    return {
      store,
      registry,
      vault,
      accounts,
      lifecycle,
      cloudHosts,
      hosts,
      emitted,
      clock,
      disconnect,
    };
  }

  const pluginOwner = { kind: "plugin" as const, pluginId: "acme.clouds" };

  async function importedHost() {
    const env = await setup();
    let machine = resource();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => machine);
    const unregister = env.registry.register(provider, {
      owner: pluginOwner,
      apiUrl: "https://api.acme.test",
    });
    const account = await env.accounts.addAccount({
      providerId: PLUGIN_PROVIDER,
      apiKey: "acme_live_x",
      scopeId: "personal",
    });
    const { hostId } = await env.lifecycle.importMachine({
      accountId: account.id,
      resourceId: "i-0123456789",
      name: "build",
    });
    return {
      ...env,
      provider,
      unregister,
      account,
      hostId,
      setMachine: (next: ProviderResource) => (machine = next),
    };
  }

  it("lists them as unavailable, with what was last seen, and asks the provider nothing", async () => {
    const env = await importedHost();
    await env.accounts.catalog(env.account.id);
    expect(env.provider.catalog).toHaveBeenCalledTimes(1);
    env.unregister();
    expect(env.accounts.summaries()[0]).toMatchObject({
      id: env.account.id,
      providerId: PLUGIN_PROVIDER,
      providerUnavailable: expect.stringContaining("acme.clouds"),
      validation: { status: "valid" },
      hostCount: 1,
    });
    expect(env.lifecycle.statuses()[0]).toMatchObject({
      hostId: env.hostId,
      providerUnavailable: expect.stringContaining("acme.clouds"),
      machine: "running",
      resourceId: "i-0123456789",
    });
    const snapshot = env.cloudHosts.snapshot();
    expect(snapshot.providers).toEqual([]);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.hosts).toHaveLength(1);

    vi.mocked(env.provider.inspect).mockClear();
    await env.lifecycle.renewDue();
    await (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(env.provider.inspect).not.toHaveBeenCalled();

    // A catalog read while it was registered is no way around it.
    await expect(env.accounts.catalog(env.account.id)).rejects.toBeInstanceOf(AppError);
    expect(env.provider.catalog).toHaveBeenCalledTimes(1);
  });

  it("refuses a person's start, stop or lifetime change before anything here changes", async () => {
    const env = await importedHost();
    const id = env.store.bindings()[0]!.id;
    const set = (change: Partial<StoredCloudBinding>) =>
      env.store.updateBinding(id, (current) => ({ ...current, ...change }));
    env.unregister();
    const refused = {
      code: "UNSUPPORTED",
      userMessage: expect.stringContaining("acme.clouds"),
    };

    set({ intent: "stop" });
    await expect(env.lifecycle.startMachine(env.hostId)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.intent).toBe("stop");

    set({ intent: "run" });
    await expect(env.lifecycle.stopMachine(env.hostId)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.intent).toBe("run");
    expect(env.disconnect).not.toHaveBeenCalled();

    // A stopped machine's lifetime is otherwise only kept here, with no provider call to refuse it.
    set({ observation: { ...env.store.binding(id)!.observation!, machine: "stopped" } });
    expect(env.store.binding(id)!.lifetimeSeconds).toBe(7200);
    await expect(env.lifecycle.setLifetime(env.hostId, null)).rejects.toMatchObject(refused);
    expect(env.store.binding(id)!.lifetimeSeconds).toBe(7200);
    expect(env.provider.start).not.toHaveBeenCalled();
    expect(env.provider.stop).not.toHaveBeenCalled();
  });

  it("drops a renewal whose provider was replaced while its key was read", async () => {
    const env = await importedHost();
    const replacement = fakeProvider(PLUGIN_PROVIDER, () => resource());
    const read = env.vault.get.bind(env.vault);
    vi.spyOn(env.vault, "get").mockImplementationOnce(async (accountId) => {
      env.unregister();
      env.registry.register(replacement, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      return read(accountId);
    });
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(replacement.renewLifetime).not.toHaveBeenCalled();
    expect(env.store.bindings()[0]!.lastError).toBeNull();
  });

  it("polls again as soon as its provider is back, not after the time it was gone", async () => {
    const env = await importedHost();
    const poll = () => (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    vi.mocked(env.provider.inspect).mockClear();
    env.unregister();
    env.clock.now += 10 * 60_000;
    await poll();
    expect(env.provider.inspect).not.toHaveBeenCalled();
    env.registry.register(env.provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
    await poll();
    expect(env.provider.inspect).toHaveBeenCalledTimes(1);
  });

  it("renews other machines past one whose provider left", async () => {
    const env = await importedHost();
    const boatMachine = resource({ resourceId: "bx_23456789" });
    const boat = fakeProvider("boat", () => boatMachine);
    env.registry.register(boat, { owner: { kind: "built-in" }, apiUrl: "https://boat.test" });
    const boatAccount = await env.accounts.addAccount({
      providerId: "boat",
      apiKey: "boat_live_x",
      scopeId: "personal",
    });
    await env.lifecycle.importMachine({
      accountId: boatAccount.id,
      resourceId: "bx_23456789",
      name: "boat",
    });
    env.unregister();
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).not.toHaveBeenCalled();
    expect(boat.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("comes back with no new connect when the provider registers again", async () => {
    const env = await importedHost();
    await Promise.resolve();
    env.emitted.length = 0;
    env.unregister();
    await Promise.resolve();
    expect(env.emitted).toHaveLength(1);
    expect(env.emitted[0]).toMatchObject({
      providers: [],
      accounts: [{ id: env.account.id, providerUnavailable: expect.any(String) }],
      hosts: [{ hostId: env.hostId, providerUnavailable: expect.any(String) }],
    });
    env.registry.register(env.provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
    await Promise.resolve();
    expect(env.emitted).toHaveLength(2);
    expect(env.emitted[1]).toMatchObject({
      providers: [{ id: PLUGIN_PROVIDER }],
      accounts: [{ id: env.account.id, providerUnavailable: null }],
      hosts: [{ hostId: env.hostId, providerUnavailable: null }],
    });
    await env.lifecycle.renewDue();
    expect(env.provider.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("keeps an account and host stored under a provider this build doesn't have, and lets the account go", async () => {
    const env = await setup({
      version: 1,
      accounts: [
        {
          id: "ca_abcdefgh",
          providerId: "agent37",
          displayName: "Agent 37",
          identity: "octocat",
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.agent37.test",
          keyHint: "wxyz",
          addedAt: 1,
          validation: { status: "valid", checkedAt: 1 },
        },
        {
          id: "ca_ijklmnop",
          providerId: "agent37",
          displayName: "Spare",
          identity: null,
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.agent37.test",
          keyHint: null,
          addedAt: 1,
          validation: { status: "unknown", checkedAt: null, detail: null },
        },
      ],
      bindings: [
        {
          id: "cb_abcdefgh12",
          hostId: "h_agent37",
          accountId: "ca_abcdefgh",
          providerId: "agent37",
          resourceId: "inst_1",
          ownership: "imported",
          creation: null,
          lifetimeSeconds: null,
          intent: null,
          observation: {
            machine: "stopped",
            rawState: "sleeping",
            observedAt: 5,
          },
          access: null,
          lastError: null,
          createdAt: 1,
        },
      ],
    });
    expect(env.store.accounts().map((account) => account.id)).toEqual([
      "ca_abcdefgh",
      "ca_ijklmnop",
    ]);
    expect(env.accounts.summaries()[0]).toMatchObject({
      providerId: "agent37",
      providerUnavailable: expect.stringContaining("agent37"),
      hostCount: 1,
    });
    expect(env.lifecycle.statuses()).toEqual([
      expect.objectContaining({
        hostId: "h_agent37",
        providerUnavailable: expect.stringContaining("agent37"),
        machine: "stopped",
        observedAt: 5,
      }),
    ]);
    // Removing the unbound account needs nothing from its provider.
    await env.vault.put("ca_ijklmnop", "agent37_key");
    await env.accounts.removeAccount("ca_ijklmnop");
    expect(await env.vault.get("ca_ijklmnop")).toBeNull();
    expect(env.store.accounts().map((account) => account.id)).toEqual(["ca_abcdefgh"]);
    expect(env.store.bindings()).toHaveLength(1);
  });

  /** A create sent before a restart that never heard back, under the plugin's provider. */
  function pendingCreate() {
    return {
      version: 1,
      accounts: [
        {
          id: "ca_abcdefgh",
          providerId: PLUGIN_PROVIDER,
          displayName: "Acme",
          identity: "octocat",
          scope: { kind: "personal", id: "personal", name: "Personal" },
          apiUrl: "https://api.acme.test",
          keyHint: "wxyz",
          addedAt: 1,
          validation: { status: "valid", checkedAt: 1 },
        },
      ],
      bindings: [
        {
          id: "cb_abcdefgh12",
          hostId: "h_acme",
          accountId: "ca_abcdefgh",
          providerId: PLUGIN_PROVIDER,
          resourceId: null,
          ownership: "created-by-daintree",
          creation: {
            operationId: "op",
            idempotencyKey: "key",
            sentAt: 2,
            name: "build",
            machineType: "default",
          },
          lifetimeSeconds: 7200,
          intent: "run",
          observation: null,
          access: null,
          lastError: null,
          createdAt: 1,
        },
      ],
    };
  }

  async function pendingCreateEnv() {
    const env = await setup(pendingCreate());
    env.hosts.push({ id: "h_acme", name: "build" } as HostDescriptor);
    await env.vault.put("ca_abcdefgh", "acme_live_x");
    return env;
  }

  it("looks for a create a restart left unanswered once its provider registers", async () => {
    const env = await pendingCreateEnv();
    const created = resource({ labels: { "daintree-binding": "cb_abcdefgh12" } });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      expect(provider.list).not.toHaveBeenCalled();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
      expect(env.store.binding("cb_abcdefgh12")?.creation).toBeNull();
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("leaves a create a Retry finished while the provider was asked alone", async () => {
    const env = await pendingCreateEnv();
    const provider = fakeProvider(PLUGIN_PROVIDER, () => resource());
    let answer!: (found: ProviderResource[]) => void;
    vi.mocked(provider.list).mockImplementationOnce(
      () => new Promise<ProviderResource[]>((resolve) => (answer = resolve))
    );
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      // What a Retry leaves behind once its create is answered.
      env.store.updateBinding("cb_abcdefgh12", (current) => ({
        ...current,
        resourceId: "i-0123456789",
        creation: null,
      }));
      answer([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(env.store.binding("cb_abcdefgh12")).toMatchObject({
        resourceId: "i-0123456789",
        lastError: null,
      });
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("looks again when its provider left while it was being asked", async () => {
    const env = await pendingCreateEnv();
    const created = resource({ labels: { "daintree-binding": "cb_abcdefgh12" } });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    let unregister = () => {};
    vi.mocked(provider.list).mockImplementationOnce(async () => {
      unregister();
      throw new Error("worker stopped");
    });
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      unregister = env.registry.register(provider, {
        owner: pluginOwner,
        apiUrl: "https://api.acme.test",
      });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBeNull();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
    } finally {
      env.lifecycle.dispose();
    }
  });

  it("looks again when its provider came back before the old lookup failed", async () => {
    const env = await pendingCreateEnv();
    const created = resource({ labels: { "daintree-binding": "cb_abcdefgh12" } });
    const provider = fakeProvider(PLUGIN_PROVIDER, () => created);
    let fail!: (error: Error) => void;
    vi.mocked(provider.list).mockImplementationOnce(
      () => new Promise<ProviderResource[]>((_resolve, reject) => (fail = reject))
    );
    env.lifecycle.start();
    try {
      await vi.waitFor(() => expect(env.store.binding("cb_abcdefgh12")).not.toBeNull());
      const unregister = env.registry.register(provider, {
        owner: pluginOwner,
        apiUrl: "https://api.acme.test",
      });
      await vi.waitFor(() => expect(provider.list).toHaveBeenCalledTimes(1));
      unregister();
      env.registry.register(provider, { owner: pluginOwner, apiUrl: "https://api.acme.test" });
      fail(new Error("worker stopped"));
      await vi.waitFor(() =>
        expect(env.store.binding("cb_abcdefgh12")?.resourceId).toBe("i-0123456789")
      );
      expect(provider.list).toHaveBeenCalledTimes(2);
    } finally {
      env.lifecycle.dispose();
    }
  });
});
