import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import { TransportError, UnusableConnectionError } from "../../client/transport.js";
import { BoatApiError } from "../boat/BoatClient.js";
import { BoatProvider } from "../boat/BoatProvider.js";
import { CloudAccountService } from "../CloudAccountService.js";
import { MemoryCloudCredentialVault } from "../CloudCredentialVault.js";
import { CloudHostLifecycle } from "../CloudHostLifecycle.js";
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider, ProviderResource } from "../provider.js";
import type { CommandRunner } from "../../client/commandRunner.js";

const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

function resource(overrides: Partial<ProviderResource> = {}): ProviderResource {
  return {
    resourceId: "bx_23456789",
    name: "build",
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    autoStopAt: null,
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

function fakeProvider(state: { machine: ProviderResource }): CloudProvider {
  const real = new BoatProvider(() => {
    throw new Error("unused");
  });
  return {
    id: "boat",
    info: (platform) => real.info(platform),
    describeError: (error) => real.describeError(error),
    checkKey: vi.fn(async () => ({
      identity: "octocat",
      scopes: [
        { scope: { kind: "personal" as const, id: "personal", name: "Personal" }, active: true },
      ],
    })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(async () => ({
      machineTypes: [
        {
          id: "default",
          label: "Default",
          vcpu: 4,
          memoryGB: 8,
          hourlyDollars: 0.036,
          available: true,
          reason: null,
        },
        {
          id: "xlarge",
          label: "Extra large",
          vcpu: 16,
          memoryGB: 32,
          hourlyDollars: 0.2,
          available: false,
          reason: "plan",
        },
      ],
      canStart: true,
      includedHoursRemaining: null,
      startsRemaining: null,
      savedSnapshotDayDollars: null,
    })),
    list: vi.fn(async () => [state.machine]),
    inspect: vi.fn(async () => state.machine),
    create: vi.fn(async (_c, request) => {
      state.machine = resource({ machine: "running", labels: request.labels });
      return resource({ machine: "starting", rawState: "provisioning" });
    }),
    start: vi.fn(async () => {
      state.machine = resource({ machine: "running" });
      return resource({ machine: "starting", rawState: "provisioning" });
    }),
    stop: vi.fn(async () => {
      state.machine = resource({ machine: "stopped", rawState: "archived" });
      return resource({ machine: "stopping", rawState: "archiving" });
    }),
    renewLifetime: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(async () => {}),
    authorizeSsh: vi.fn(async () => ({
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: HOST_KEY,
    })),
  } as CloudProvider;
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-lifecycle-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

type Activity = { connected: boolean; busy: boolean; shown: boolean } | null;

async function setup(
  initial: Partial<ProviderResource> = {},
  options: { activity?: () => Activity; now?: () => number } = {}
) {
  const state = { machine: resource(initial) };
  const provider = fakeProvider(state);
  let backendValue: unknown;
  const store = new CloudHostStore({
    get: () => backendValue,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  });
  const accounts = new CloudAccountService({
    store,
    vault: new MemoryCloudCredentialVault(),
    providers: new Map<CloudProviderId, CloudProvider>([["boat", provider]]),
    apiUrlFor: () => "https://boat.dev/api/v1",
    platform: "darwin",
  });
  const account = await accounts.addAccount({
    providerId: "boat",
    apiKey: "boat_live_x",
    scopeId: "personal",
  });
  const hosts: HostDescriptor[] = [];
  const listeners = new Set<() => void>();
  const disconnect = vi.fn(async () => {});
  const run = vi.fn(async (_cmd: string, args: string[]) => {
    const keyPath = args[args.length - 1]!;
    await fs.writeFile(keyPath, "PRIVATE");
    await fs.writeFile(`${keyPath}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClient daintree");
    return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
  });
  const files = new CloudSshFiles(path.join(root, "cloud"), run as unknown as CommandRunner);
  const lifecycle = new CloudHostLifecycle({
    store,
    accounts,
    files,
    clientDir: root,
    hosts: {
      add: (name: string, connection: HostConnection) => {
        const descriptor = { id: name, name, connection } as HostDescriptor;
        hosts.push(descriptor);
        for (const listener of listeners) listener();
        return descriptor;
      },
      get: (id) => hosts.find((host) => host.id === id) ?? null,
      list: () => hosts,
      forget: async (id) => {
        hosts.splice(
          hosts.findIndex((host) => host.id === id),
          1
        );
        for (const listener of listeners) listener();
      },
      disconnect,
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    changed: () => {},
    sleep: async () => {},
    activity: options.activity,
    now: options.now,
  });
  return { lifecycle, provider, store, state, account, hosts, disconnect, files, run };
}

describe("CloudHostLifecycle.create", () => {
  it("saves the binding and idempotency key before asking for a machine", async () => {
    const { lifecycle, provider, store } = await setup();
    let savedBeforeCreate: unknown = null;
    vi.mocked(provider.create).mockImplementationOnce(async () => {
      savedBeforeCreate = store.bindings()[0]?.creation;
      throw new BoatApiError("network", "lost", null, null, null);
    });
    const { hostId } = await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalled());
    expect(savedBeforeCreate).toMatchObject({
      sentAt: expect.any(Number),
      idempotencyKey: expect.any(String),
    });
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown")
    );
    expect(hostId).toBe("build");
  });

  it("retries a lost create with the same key, and a refused one with a fresh key", async () => {
    const { lifecycle, provider, store } = await setup();
    vi.mocked(provider.create)
      .mockRejectedValueOnce(new BoatApiError("timeout", "slow", null, null, null))
      .mockRejectedValueOnce(new BoatApiError("payment-required", "pay", 402, null, null));
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    await lifecycle.retryCreate("build").catch(() => {});
    await lifecycle.retryCreate("build");
    const keys = vi.mocked(provider.create).mock.calls.map(([, request]) => request.idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(lifecycle.statuses()[0]).toMatchObject({
      machine: "running",
      resourceId: "bx_23456789",
    });
  });

  it("refuses a size the account can't have before anything is sent", async () => {
    const { lifecycle, provider, store } = await setup();
    await expect(
      lifecycle.create({
        accountId: store.accounts()[0]!.id,
        name: "big",
        machineType: "xlarge",
        lifetimeHours: 2,
      })
    ).rejects.toThrow(/isn't available/);
    expect(provider.create).not.toHaveBeenCalled();
    expect(store.bindings()).toEqual([]);
  });
});

describe("CloudHostLifecycle access", () => {
  async function imported(machine: Partial<ProviderResource>) {
    const env = await setup(machine);
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = env.store.bindings()[0]!.id;
    return { ...env, bindingId };
  }

  it("refuses a dial to a stopped machine without starting it", async () => {
    const { lifecycle, provider, bindingId } = await imported({
      machine: "stopped",
      rawState: "archived",
    });
    await expect(lifecycle.ensureAccess(bindingId)).rejects.toBeInstanceOf(UnusableConnectionError);
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
  });

  it("treats a machine still starting as worth retrying", async () => {
    const { lifecycle, bindingId } = await imported({
      machine: "starting",
      rawState: "provisioning",
    });
    const error = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(UnusableConnectionError);
  });

  it("writes a config that pins the provider's host key under the machine's alias", async () => {
    const { lifecycle, bindingId } = await imported({ machine: "running" });
    const route = await lifecycle.ensureAccess(bindingId);
    expect(route.target).toBe(`dtc-${bindingId}`);
    const config = await fs.readFile(route.configPath, "utf8");
    expect(config).toContain("HostName 203.0.113.10");
    expect(config).toContain("Port 22001");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain(`HostKeyAlias dtc-${bindingId}`);
    const knownHosts = await fs.readFile(
      path.join(path.dirname(route.configPath), "known_hosts"),
      "utf8"
    );
    expect(knownHosts).toBe(`dtc-${bindingId} ${HOST_KEY}\n`);
    const wrapper = await fs.readFile(route.sshPath, "utf8");
    expect(wrapper).toContain(`-F '${route.configPath}'`);
    expect((await fs.stat(route.configPath)).mode & 0o077).toBe(0);
  });

  it("reuses fresh access and resolves it again after a start", async () => {
    const { lifecycle, provider, bindingId, state } = await imported({ machine: "running" });
    await lifecycle.ensureAccess(bindingId);
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    state.machine = resource({ machine: "stopped", rawState: "archived" });
    await lifecycle.startMachine("build");
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
  });
});

describe("CloudHostLifecycle start, stop, import and removal", () => {
  it("imports without starting or changing the machine's lifetime", async () => {
    const { lifecycle, provider, store } = await setup({
      machine: "stopped",
      lifetimeSeconds: 600,
    });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
    expect(store.bindings()[0]).toMatchObject({ ownership: "imported", lifetimeSeconds: 600 });
  });

  it("won't import a machine already bound to a host", async () => {
    const { lifecycle, store } = await setup();
    const accountId = store.accounts()[0]!.id;
    await lifecycle.importMachine({ accountId, resourceId: "bx_23456789", name: "build" });
    await expect(
      lifecycle.importMachine({ accountId, resourceId: "bx_23456789", name: "again" })
    ).rejects.toThrow(/already in your host list as build/);
  });

  it("starts with the host's lifetime and stops after letting go of the link", async () => {
    const { lifecycle, provider, store, disconnect } = await setup({ machine: "stopped" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await lifecycle.setLifetime("build", 4);
    await lifecycle.startMachine("build");
    expect(vi.mocked(provider.start).mock.calls[0]![2]).toEqual({ lifetimeSeconds: 4 * 3600 });
    await lifecycle.stopMachine("build");
    expect(disconnect).toHaveBeenCalledWith("build");
    expect(disconnect.mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(provider.stop).mock.invocationCallOrder[0]!
    );
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
  });

  it("moves a running machine's own deadline when its lifetime changes", async () => {
    const { lifecycle, provider, store } = await setup({ machine: "running" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    vi.mocked(provider.renewLifetime).mockResolvedValue(resource({ machine: "running" }));
    await lifecycle.setLifetime("build", null);
    expect(vi.mocked(provider.renewLifetime).mock.calls[0]![2]).toBeNull();
    expect(store.bindings()[0]!.lifetimeSeconds).toBeNull();
  });

  it("won't start a machine whose saved disk expired, and creates nothing in its place", async () => {
    const { lifecycle, provider, store } = await setup({ machine: "stopped", dataExpired: false });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    vi.mocked(provider.inspect).mockResolvedValue(
      resource({ machine: "stopped", dataExpired: true })
    );
    await expect(lifecycle.startMachine("build")).rejects.toThrow(/saved disk/);
    expect(provider.start).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("deletes only the machine that was confirmed", async () => {
    const { lifecycle, provider, store, hosts } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await expect(lifecycle.deleteMachine("build", "bx_other000")).rejects.toThrow(/changed/);
    expect(provider.delete).not.toHaveBeenCalled();
    await lifecycle.deleteMachine("build", "bx_23456789");
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(hosts).toEqual([]);
  });

  it("drops a binding with its host, leaving the machine alone", async () => {
    const { lifecycle, provider, store, hosts } = await setup();
    lifecycle.start();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    hosts.splice(0, 1);
    await (lifecycle as unknown as { dropOrphanBindings(): Promise<void> }).dropOrphanBindings();
    expect(store.bindings()).toEqual([]);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    lifecycle.dispose();
  });
});

describe("CloudHostLifecycle review fixes", () => {
  it("keeps the create's key when the answer was cancelled, and finds the machine before asking again", async () => {
    const { lifecycle, provider, store } = await setup();
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("cancelled", "Cancelled", null, null, null)
    );
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const key = store.bindings()[0]!.creation!.idempotencyKey;
    expect(store.bindings()[0]!.creation!.sentAt).not.toBeNull();
    const bindingId = store.bindings()[0]!.id;
    // Boat had made it after all: the retry finds it by label and creates nothing.
    vi.mocked(provider.list).mockResolvedValueOnce([
      resource({ resourceId: "bx_found0000", labels: { "daintree-binding": bindingId } }),
    ]);
    await lifecycle.retryCreate("build");
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(provider.create).mock.calls[0]![1].idempotencyKey).toBe(key);
    expect(store.bindings()[0]!.resourceId).toBe("bx_found0000");
  });

  it("deletes the machine an unanswered create made instead of forgetting it", async () => {
    const { lifecycle, provider, store, hosts } = await setup();
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const bindingId = store.bindings()[0]!.id;
    vi.mocked(provider.list).mockResolvedValueOnce([
      resource({ resourceId: "bx_found0000", labels: { "daintree-binding": bindingId } }),
    ]);
    await lifecycle.deleteMachine("build", null);
    expect(vi.mocked(provider.delete).mock.calls[0]![1]).toBe("bx_found0000");
    expect(hosts).toEqual([]);
  });

  it("refuses to forget a host whose create can't be checked", async () => {
    const { lifecycle, provider, store, hosts } = await setup();
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    vi.mocked(provider.list).mockRejectedValueOnce(
      new BoatApiError("network", "down", null, null, null)
    );
    await expect(lifecycle.deleteMachine("build", null)).rejects.toThrow();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
  });

  it("lets Stop supersede a create whose machine is still coming up", async () => {
    const { lifecycle, provider, store, state } = await setup();
    let release: () => void = () => {};
    vi.mocked(provider.inspect).mockImplementation(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return state.machine;
    });
    vi.mocked(provider.create).mockImplementationOnce(async () => {
      state.machine = resource({ machine: "starting", rawState: "provisioning" });
      return state.machine;
    });
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(store.bindings()[0]?.resourceId).toBe("bx_23456789"));
    vi.mocked(provider.inspect).mockImplementation(async () => state.machine);
    const stopping = lifecycle.stopMachine("build");
    release();
    await stopping;
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
  });

  it("keeps one host when two imports of the same machine race", async () => {
    const { lifecycle, store, hosts } = await setup();
    const accountId = store.accounts()[0]!.id;
    const results = await Promise.allSettled([
      lifecycle.importMachine({ accountId, resourceId: "bx_23456789", name: "one" }),
      lifecycle.importMachine({ accountId, resourceId: "bx_23456789", name: "two" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(hosts).toHaveLength(1);
    expect(store.bindings()).toHaveLength(1);
  });

  it("resolves access again after a stop and start it only observed", async () => {
    const { lifecycle, provider, store, state } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = store.bindings()[0]!.id;
    await lifecycle.ensureAccess(bindingId);
    state.machine = resource({ machine: "stopped", stoppedAt: "2026-11-14T10:00:00Z" });
    await lifecycle.refresh("build");
    state.machine = resource({ machine: "running", stoppedAt: null });
    await lifecycle.refresh("build");
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
  });

  it("lets one caller give up without failing the others waiting on the same access", async () => {
    const { lifecycle, provider, store } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = store.bindings()[0]!.id;
    let release: () => void = () => {};
    const authorize = vi.mocked(provider.authorizeSsh).getMockImplementation()!;
    vi.mocked(provider.authorizeSsh).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return authorize(...args);
    });
    const abort = new AbortController();
    const first = lifecycle.ensureAccess(bindingId, abort.signal);
    const second = lifecycle.ensureAccess(bindingId);
    await vi.waitFor(() => expect(provider.authorizeSsh).toHaveBeenCalled());
    abort.abort();
    release();
    await expect(first).rejects.toBeInstanceOf(TransportError);
    await expect(second).resolves.toMatchObject({ target: `dtc-${bindingId}` });
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
  });

  it("runs one ssh-keygen for two machines of one account", async () => {
    const { files, run, account } = await setup();
    const [a, b] = await Promise.all([files.publicKey(account.id), files.publicKey(account.id)]);
    expect(a).toBe(b);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("CloudHostLifecycle lifetime keeper", () => {
  const NOW = Date.parse("2026-11-14T12:00:00Z");

  async function keeper(
    activity: Activity,
    autoStopInMinutes: number,
    machine: Partial<ProviderResource> = {}
  ) {
    const clock = { now: NOW };
    const env = await setup(
      {
        machine: "running",
        lifetimeSeconds: 7200,
        autoStopAt: new Date(NOW + autoStopInMinutes * 60_000).toISOString(),
        ...machine,
      },
      { activity: () => activity, now: () => clock.now }
    );
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    vi.mocked(env.provider.renewLifetime).mockResolvedValue(
      resource({ machine: "running", autoStopAt: new Date(NOW + 7_200_000).toISOString() })
    );
    return { ...env, clock };
  }

  it("moves the deadline later while agents work here and it is near", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: false }, 20);
    await lifecycle.renewDue();
    expect(provider.renewLifetime).toHaveBeenCalledWith(expect.anything(), "bx_23456789", 7200);
    expect(lifecycle.statuses()[0]).toMatchObject({
      keptRunningAt: NOW,
      autoStopAt: new Date(NOW + 7_200_000).toISOString(),
    });
  });

  it("keeps a machine a window shows running too", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: false, shown: true }, 20);
    await lifecycle.renewDue();
    expect(provider.renewLifetime).toHaveBeenCalledTimes(1);
  });

  it("leaves the deadline alone while it is far off, by half a short lifetime", async () => {
    const far = await keeper({ connected: true, busy: true, shown: true }, 90);
    await far.lifecycle.renewDue();
    expect(far.provider.renewLifetime).not.toHaveBeenCalled();
    // A one-hour lifetime renews at half of it (30 min), never with most of it left.
    const short = await keeper({ connected: true, busy: true, shown: true }, 40, {
      lifetimeSeconds: 3600,
    });
    await short.lifecycle.renewDue();
    expect(short.provider.renewLifetime).not.toHaveBeenCalled();
  });

  it("never renews for a machine nobody here uses, or one it can't reach", async () => {
    for (const activity of [
      { connected: true, busy: false, shown: false },
      { connected: false, busy: true, shown: true },
      null,
    ]) {
      const { lifecycle, provider } = await keeper(activity, 5);
      await lifecycle.renewDue();
      expect(provider.renewLifetime).not.toHaveBeenCalled();
    }
  });

  it("never renews a stopped machine, even one with a deadline still set", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: true }, 5, {
      machine: "stopped",
      rawState: "archived",
    });
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
  });

  it("retries a failed renewal after a pause, and clears the failure once it works", async () => {
    const { lifecycle, provider, clock } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockRejectedValueOnce(
      new BoatApiError("server", "down", 500, null, null)
    );
    await lifecycle.renewDue();
    await lifecycle.renewDue();
    expect(provider.renewLifetime).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("lifetime-renewal");
    expect(lifecycle.statuses()[0]!.keptRunningAt).toBeNull();
    clock.now = NOW + 3 * 60_000;
    await lifecycle.renewDue();
    expect(provider.renewLifetime).toHaveBeenCalledTimes(2);
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("lets a Stop asked for during a renewal win", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: false }, 10);
    let release: () => void = () => {};
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return resource({ machine: "running" });
    });
    const renewing = lifecycle.renewDue();
    await vi.waitFor(() => expect(provider.renewLifetime).toHaveBeenCalled());
    const stopping = lifecycle.stopMachine("build");
    release();
    await Promise.all([renewing, stopping]);
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
    expect(vi.mocked(provider.stop).mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(provider.renewLifetime).mock.invocationCallOrder[0]!
    );
  });

  it("sends a new lifetime after a renewal under way, never before it", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: false }, 10);
    let release: () => void = () => {};
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return resource({ machine: "running" });
    });
    const renewing = lifecycle.renewDue();
    await vi.waitFor(() => expect(provider.renewLifetime).toHaveBeenCalledTimes(1));
    const changing = lifecycle.setLifetime("build", 1);
    release();
    await Promise.all([renewing, changing]);
    const sent = vi.mocked(provider.renewLifetime).mock.calls.map((call) => call[2]);
    expect(sent).toEqual([7200, 3600]);
  });
});
