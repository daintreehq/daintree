import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  HostConnection,
  HostDescriptor,
  PendingHostPlacement,
} from "../../../../shared/types/remoteHosts.js";
import type {
  CloudHostCreatedFor,
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudLifetimeModel,
  CloudProviderCapabilities,
  CloudProviderId,
  CloudProvisioning,
  CloudSshTransport,
  CloudSshTrust,
} from "../../../../shared/types/cloudHosts.js";
import { TransportError, UnusableConnectionError } from "../../client/transport.js";
import { hostKeyFingerprint } from "../sshEndpoint.js";
import { BoatApiError } from "../boat/BoatClient.js";
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
import { CloudSshFiles } from "../CloudSshFiles.js";
import type {
  CloudProvider,
  ProviderCatalog,
  ProviderResource,
  RenewingCloudProvider,
} from "../provider.js";
import type { CommandResult, CommandRunner } from "../../client/commandRunner.js";

const pathLookup = vi.hoisted(() => ({ timesOut: false }));
vi.mock("../../../utils/findOnPath.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../utils/findOnPath.js")>();
  return {
    ...real,
    findOnPath: (command: string, options?: { onTimeout?: () => void }) => {
      if (!pathLookup.timesOut) return real.findOnPath(command, options);
      options?.onTimeout?.();
      return Promise.resolve(null);
    },
  };
});

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

/** Carries both SSH methods; its declared timing says which one the lifecycle may call. */
type FakeProvider = RenewingCloudProvider &
  Required<Pick<CloudProvider, "authorizeSsh" | "sshAccess">>;

function fakeProvider(
  state: { machine: ProviderResource },
  sshTrust?: CloudSshTrust,
  transport?: CloudSshTransport,
  lifetime?: CloudLifetimeModel,
  sshKey: "at-create" | "after-create" = "after-create"
): FakeProvider {
  const real = new BoatProvider(() => {
    throw new Error("unused");
  });
  const access = {
    user: "user",
    endpoint: { host: "203.0.113.10", port: 22001 },
    hostKey: sshTrust === "confirm-on-first-connect" ? null : HOST_KEY,
  };
  return {
    id: "boat",
    info: (platform) => {
      const info = real.info(platform);
      const { capabilities } = info;
      return {
        ...info,
        capabilities: {
          ...capabilities,
          sshTrust: sshTrust ?? capabilities.sshTrust,
          transport: transport ?? capabilities.transport,
          tunnel:
            transport === "provider-command"
              ? { command: "acme", args: ["tunnel", "%h"], installUrl: "https://example.com/acme" }
              : capabilities.tunnel,
          lifetime: lifetime ?? capabilities.lifetime,
          provisioning: { ...capabilities.provisioning, sshKey },
        },
      };
    },
    describeError: (error) => real.describeError(error),
    checkCredentials: vi.fn(async () => ({
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
    authorizeSsh: vi.fn(async () => access),
    sshAccess: vi.fn(async () => access),
  } as FakeProvider;
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
  options: {
    activity?: () => Activity;
    now?: () => number;
    adapt?: (provider: CloudProvider) => void;
    sshTrust?: CloudSshTrust;
    transport?: CloudSshTransport;
    findCommand?: (command: string) => Promise<string | null>;
    lifetime?: CloudLifetimeModel;
    sshKey?: "at-create" | "after-create";
    onMachineStarted?: (hostId: string) => void;
    machineKeys?: ConstructorParameters<typeof CloudHostLifecycle>[0]["machineKeys"];
    guestPowerOff?: ConstructorParameters<typeof CloudHostLifecycle>[0]["guestPowerOff"];
    worktreeGone?: (worktreePath: string) => Promise<boolean | null>;
    onWorktreeRemoved?: (listener: (worktreeId: string) => void) => () => void;
  } = {}
) {
  const state = { machine: resource(initial) };
  const provider = fakeProvider(
    state,
    options.sshTrust,
    options.transport,
    options.lifetime,
    options.sshKey
  );
  options.adapt?.(provider);
  /** What ssh-keyscan prints for the machine; `byTypes` answers a scan of named algorithms. */
  const scan: { output: string; byTypes: Record<string, string> } = {
    output: `[203.0.113.10]:22001 ${HOST_KEY}\n`,
    byTypes: {},
  };
  let backendValue: unknown;
  const backend = {
    get: vi.fn(() => backendValue),
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  };
  // What outlives a restart: the settings file, the keychain and the host list.
  const vault = new MemoryCloudCredentialVault();
  const hosts: HostDescriptor[] = [];
  const listeners = new Set<() => void>();
  const disconnect = vi.fn(async () => {});
  // Every key it makes is new, and its private half holds its public one, which `-y` prints.
  let generated = 0;
  const run = vi.fn(async (cmd: string, args: string[]): Promise<CommandResult> => {
    if (path.basename(cmd).startsWith("ssh-keyscan")) {
      const types = args[args.indexOf("-t") + 1]!;
      const stdout = scan.byTypes[types] ?? scan.output;
      return { code: 0, stdout, stderr: "", spawnError: null, timedOut: false };
    }
    // Only ssh-keygen makes files; anything else (a master's `-O exit`) just answers.
    if (cmd !== "ssh-keygen") {
      return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
    }
    const keyPath = args[args.length - 1]!;
    const ok = { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
    if (args.includes("-y")) {
      if ((await fs.stat(keyPath)).mode & 0o077) return { ...ok, code: 255 };
      return { ...ok, stdout: `${await fs.readFile(keyPath, "utf8")}\n` };
    }
    generated += 1;
    const made = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClient${generated} ${path.basename(keyPath)}`;
    await fs.writeFile(keyPath, made);
    await fs.writeFile(`${keyPath}.pub`, made);
    return ok;
  });
  const files = new CloudSshFiles(path.join(root, "cloud"), run as unknown as CommandRunner);
  const build = () => {
    const store = new CloudHostStore(backend);
    const accounts = new CloudAccountService({
      store,
      vault,
      providers: new Map<CloudProviderId, CloudProvider>([["boat", provider]]),
      apiUrlFor: () => "https://boat.dev/api/v1",
      platform: "darwin",
    });
    const lifecycle = new CloudHostLifecycle({
      store,
      accounts,
      files,
      clientDir: root,
      hosts: {
        add: (name: string, connection: HostConnection, pendingPlacement) => {
          const descriptor = {
            id: name,
            name,
            connection,
            ...(pendingPlacement ? { pendingPlacement } : {}),
          } as HostDescriptor;
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
      onMachineStarted: options.onMachineStarted,
      now: options.now,
      findCommand: options.findCommand,
      machineKeys: options.machineKeys,
      guestPowerOff: options.guestPowerOff,
      worktreeGone: options.worktreeGone,
      onWorktreeRemoved: options.onWorktreeRemoved,
    });
    return { store, accounts, lifecycle };
  };
  const { store, accounts, lifecycle } = build();
  const account = await accounts.addAccount({
    providerId: "boat",
    credentials: { apiKey: "boat_live_x" },
    scopeId: "personal",
  });
  /** Ends this run and starts the next over the same settings, keychain and hosts. */
  const restart = (current: CloudHostLifecycle) => {
    current.dispose();
    const next = build();
    next.lifecycle.start();
    return next;
  };
  return {
    lifecycle,
    accounts,
    provider,
    store,
    state,
    account,
    hosts,
    disconnect,
    files,
    run,
    restart,
    scan,
    backend,
  };
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

  it("sends the lifetime saved while a Retry was looking, not the one it began with (#17928)", async () => {
    const { lifecycle, provider, store } = await setup();
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
    let answer: (found: ProviderResource[]) => void = () => {};
    vi.mocked(provider.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const retry = lifecycle.retryCreate("build");
    await vi.waitFor(() => expect(provider.list).toHaveBeenCalled());
    await lifecycle.setLifetime("build", 8);
    answer([]);
    await retry;
    expect(vi.mocked(provider.create).mock.calls[1]![1].lifetimeSeconds).toBe(8 * 3600);
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

  it("reads a create the provider turned down as refused, so Retry sends a fresh one", async () => {
    const turnedDown = new Error("Size is not available in this region.");
    const { lifecycle, provider, store } = await setup(
      {},
      {
        adapt: (provider) => {
          const describe = provider.describeError.bind(provider);
          provider.describeError = (error) =>
            error === turnedDown
              ? { code: "refused", message: `Acme turned this down: ${turnedDown.message}`, at: 0 }
              : describe(error);
        },
      }
    );
    vi.mocked(provider.create).mockRejectedValueOnce(turnedDown);
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "refused",
      message: "Acme turned this down: Size is not available in this region.",
    });
    await lifecycle.retryCreate("build");
    const keys = vi.mocked(provider.create).mock.calls.map(([, request]) => request.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
    expect(keys[1]).not.toBe(keys[0]);
    // Nothing was made by the refusal, so the retry doesn't go looking for it first.
    expect(provider.list).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]).toMatchObject({ resourceId: "bx_23456789", lastError: null });
  });

  it("keeps looking for a lost create's machine when a retry is turned down", async () => {
    const { lifecycle, provider, store } = await setup();
    vi.mocked(provider.create)
      .mockRejectedValueOnce(new BoatApiError("timeout", "slow", null, null, null))
      .mockRejectedValueOnce(new BoatApiError("payment-required", "limit", 402, null, null));
    const request = { accountId: store.accounts()[0]!.id, name: "build", machineType: "default" };
    await lifecycle.create({ ...request, lifetimeHours: 2 });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const firstSent = store.bindings()[0]?.creation?.sentAt;
    expect(firstSent).toEqual(expect.any(Number));
    await expect(lifecycle.retryCreate("build")).rejects.toThrow();
    // The retry was sent and turned down: that says nothing of the first request's machine.
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown");
    expect(store.bindings()[0]?.creation?.sentAt).toBe(firstSent);
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
    const error = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect((error as Error).message).toBe("The cloud machine is stopped. Start it to connect.");
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

  it("reuses a direct machine's route after a restart without asking for access again", async () => {
    const { lifecycle, provider, bindingId, restart } = await imported({ machine: "running" });
    const route = await lifecycle.ensureAccess(bindingId);
    const written = await fs.readFile(route.configPath, "utf8");
    const next = restart(lifecycle).lifecycle;
    await next.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(route.configPath, "utf8")).toBe(written);
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

describe("CloudHostLifecycle access through a provider's tunnel", () => {
  const INSTALL_URL = "https://example.com/acme-cli";
  const TUNNEL = { command: "acme", args: ["tunnel", "%h"], installUrl: INSTALL_URL };
  const TUNNEL_ACCESS = {
    user: "root",
    endpoint: { host: "ab12cd34ef.acme.example", port: 22 },
    hostKey: null,
  };

  type Declared = Pick<CloudProviderCapabilities, "sshTrust" | "transport" | "tunnel">;

  /**
   * A provider whose machines are reached through its `acme` CLI, as `declared`
   * says at each call. The finder knows only `acme`, at `installed.path`.
   */
  async function tunnelled(sshTrust: CloudSshTrust, installed: { path?: string | null }) {
    const declared: Declared = { sshTrust, transport: "provider-command", tunnel: TUNNEL };
    const findCommand = vi.fn(async (command: string) =>
      command === "acme" ? (installed.path ?? null) : "/usr/bin/unexpected"
    );
    const env = await setup({ machine: "running" }, "path" in installed ? { findCommand } : {});
    const base = env.provider.info.bind(env.provider);
    env.provider.info = (platform) => {
      const info = base(platform);
      return { ...info, name: "Acme", capabilities: { ...info.capabilities, ...declared } };
    };
    vi.mocked(env.provider.authorizeSsh).mockImplementation(async () =>
      declared.sshTrust === "provider-tunnel"
        ? TUNNEL_ACCESS
        : { ...TUNNEL_ACCESS, hostKey: HOST_KEY }
    );
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    return { ...env, declared, findCommand, bindingId: env.store.bindings()[0]!.id };
  }

  it("names a missing command and where to get it, without asking for access", async () => {
    const { lifecycle, provider, bindingId, findCommand } = await tunnelled("provider-tunnel", {
      path: null,
    });
    const error = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    const { message, detail } = error as UnusableConnectionError;
    for (const said of [message, detail]) {
      expect(said).toContain("acme command");
      expect(said).toContain(INSTALL_URL);
    }
    expect(findCommand).toHaveBeenCalledWith("acme");
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "ssh-tunnel-command-missing",
      message: detail,
    });
  });

  it("dials through the tunnel once it is installed, and says nothing was pinned", async () => {
    const installed = { path: null as string | null };
    const { lifecycle, store, bindingId } = await tunnelled("provider-tunnel", installed);
    // Confirmed under an earlier declaration: not what a tunnel-trusted dial pins.
    store.updateBinding(bindingId, (b) => ({ ...b, trustedHostKey: { key: HOST_KEY, at: 1 } }));
    await expect(lifecycle.ensureAccess(bindingId)).rejects.toBeInstanceOf(UnusableConnectionError);
    expect(lifecycle.statuses()[0]?.lastError?.code).toBe("ssh-tunnel-command-missing");
    installed.path = "/Users/Jo Smith/.local/bin/acme";
    const route = await lifecycle.ensureAccess(bindingId);
    const config = await fs.readFile(route.configPath, "utf8");
    expect(config).toContain('  ProxyCommand "/Users/Jo Smith/.local/bin/acme" "tunnel" "%h"\n');
    expect(config).toContain("  StrictHostKeyChecking no\n");
    expect(lifecycle.statuses()[0]).toMatchObject({
      lastError: null,
      lastEndpoint: "root@ab12cd34ef.acme.example",
      hostKeyFingerprint: null,
    });
  });

  it("looks for the command again before reusing access, and retires the old route when it moved", async () => {
    const installed = { path: "/opt/acme/bin/acme" as string | null };
    const { lifecycle, provider, bindingId, files } = await tunnelled("provider-tunnel", installed);
    await lifecycle.ensureAccess(bindingId);
    const generation = lifecycle.accessGeneration(bindingId);
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    expect(lifecycle.accessGeneration(bindingId)).toBe(generation);

    installed.path = null;
    await expect(lifecycle.ensureAccess(bindingId)).rejects.toBeInstanceOf(UnusableConnectionError);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);

    installed.path = "/usr/local/bin/acme";
    // What the master being closed was opened with: the old command's route.
    const closedWith: string[] = [];
    const close = vi.spyOn(files, "closeMaster").mockImplementation(async (_dir, id) => {
      closedWith.push(await fs.readFile(files.route(id).configPath, "utf8"));
    });
    const route = await lifecycle.ensureAccess(bindingId);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closedWith[0]).toContain('ProxyCommand "/opt/acme/bin/acme"');
    expect(await fs.readFile(route.configPath, "utf8")).toContain(
      'ProxyCommand "/usr/local/bin/acme"'
    );
    expect(lifecycle.accessGeneration(bindingId)).not.toBe(generation);
  });

  it("asks again, and pins, when the provider stops vouching for its machines through the tunnel", async () => {
    const { lifecycle, provider, bindingId, declared } = await tunnelled("provider-tunnel", {
      path: "/opt/acme/bin/acme",
    });
    await lifecycle.ensureAccess(bindingId);
    declared.sshTrust = "pinned-from-api";
    const route = await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(route.configPath, "utf8")).toContain("StrictHostKeyChecking yes");
    expect(lifecycle.statuses()[0]?.hostKeyFingerprint).toMatch(/^SHA256:/);
  });

  it("asks again, and unpins, when the provider starts vouching for its machines through the tunnel", async () => {
    const { lifecycle, provider, bindingId, declared } = await tunnelled("pinned-from-api", {
      path: "/opt/acme/bin/acme",
    });
    await lifecycle.ensureAccess(bindingId);
    declared.sshTrust = "provider-tunnel";
    const route = await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(route.configPath, "utf8")).toContain("StrictHostKeyChecking no");
    expect(lifecycle.statuses()[0]?.hostKeyFingerprint).toBeNull();
  });

  it("clears what stood in the way of SSH once a dial gets through, and nothing else", async () => {
    const { lifecycle, store, bindingId } = await tunnelled("provider-tunnel", {
      path: "/opt/acme/bin/acme",
    });
    await lifecycle.ensureAccess(bindingId);
    const setError = (code: "ssh-authorization" | "billing") =>
      store.updateBinding(bindingId, (current) => ({
        ...current,
        lastError: { code, message: code, at: 1 },
      }));
    setError("billing");
    await lifecycle.ensureAccess(bindingId);
    expect(lifecycle.statuses()[0]?.lastError?.code).toBe("billing");
    setError("ssh-authorization");
    await lifecycle.ensureAccess(bindingId);
    expect(lifecycle.statuses()[0]?.lastError).toBeNull();
  });

  it("retries a PATH lookup that ran out of time rather than calling the command missing", async () => {
    const { lifecycle, provider, bindingId } = await tunnelled("provider-tunnel", {});
    pathLookup.timesOut = true;
    const error = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    pathLookup.timesOut = false;
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(UnusableConnectionError);
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]?.lastError).toBeNull();
  });

  it("refuses a declaration that changed after registering, leaving what was stored", async () => {
    const { lifecycle, provider, store, bindingId, declared } = await tunnelled("provider-tunnel", {
      path: "/opt/acme/bin/acme",
    });
    store.updateBinding(bindingId, (current) => ({
      ...current,
      lastError: { code: "billing", message: "billing", at: 1 },
    }));
    declared.tunnel = null;
    const error = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect((error as UnusableConnectionError).detail).toMatch(/needs a tunnel/);
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]?.lastError?.code).toBe("billing");
    declared.tunnel = TUNNEL;
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
  });

  it("reuses an earlier run's route only while it is what the provider declares now", async () => {
    const { lifecycle, provider, bindingId, declared, restart } = await tunnelled(
      "pinned-from-api",
      { path: "/opt/acme/bin/acme" }
    );
    await lifecycle.ensureAccess(bindingId);
    const unchanged = restart(lifecycle).lifecycle;
    await unchanged.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);

    Object.assign(declared, { transport: "direct", tunnel: null });
    const next = restart(unchanged).lifecycle;
    const route = await next.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(route.configPath, "utf8")).not.toContain("ProxyCommand");
  });

  it("takes a key exactly when the provider doesn't vouch through the tunnel", async () => {
    const refused = async (sshTrust: CloudSshTrust, hostKey: string | null) => {
      const { lifecycle, provider, bindingId } = await tunnelled(sshTrust, {
        path: "/opt/acme/bin/acme",
      });
      vi.mocked(provider.authorizeSsh).mockResolvedValueOnce({ ...TUNNEL_ACCESS, hostKey });
      await expect(lifecycle.ensureAccess(bindingId)).rejects.toBeInstanceOf(
        UnusableConnectionError
      );
      return lifecycle.statuses()[0]?.lastError;
    };
    expect(await refused("provider-tunnel", HOST_KEY)).toMatchObject({
      code: "ssh-authorization",
      message: expect.stringMatching(/returned a host key to pin/),
    });
    expect(await refused("pinned-from-api", null)).toMatchObject({
      code: "ssh-authorization",
      message: expect.stringMatching(/didn't say which host key the machine has/),
    });
  });

  it("still pins the key when the tunnel only carries the connection", async () => {
    const { lifecycle, bindingId } = await tunnelled("pinned-from-api", {
      path: "/opt/acme/bin/acme",
    });
    const route = await lifecycle.ensureAccess(bindingId);
    const config = await fs.readFile(route.configPath, "utf8");
    expect(config).toContain('ProxyCommand "/opt/acme/bin/acme" "tunnel" "%h"');
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(lifecycle.statuses()[0]?.hostKeyFingerprint).toMatch(/^SHA256:/);
  });
});

describe("CloudHostLifecycle host keys confirmed on first connect", () => {
  const NEW_KEY = `ssh-ed25519 ${Buffer.alloc(51, 7).toString("base64")}`;
  const RSA_KEY = `ssh-rsa ${Buffer.alloc(64, 3).toString("base64")}`;

  async function confirming(transport?: CloudSshTransport) {
    const env = await setup(
      { machine: "running" },
      { sshTrust: "confirm-on-first-connect", transport }
    );
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = env.store.bindings()[0]!.id;
    return { ...env, bindingId };
  }

  const keyscans = (run: { mock: { calls: unknown[][] } }) =>
    run.mock.calls.filter((call) => path.basename(String(call[0])).startsWith("ssh-keyscan"))
      .length;

  async function pinnedKey(route: { configPath: string }): Promise<string> {
    return fs.readFile(path.join(path.dirname(route.configPath), "known_hosts"), "utf8");
  }

  /** Trusts the key on offer and dials, as a person confirming the first connect does. */
  async function trusted(env: Awaited<ReturnType<typeof confirming>>) {
    await env.lifecycle.ensureAccess(env.bindingId).catch(() => {});
    await env.lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY));
    return env.lifecycle.ensureAccess(env.bindingId);
  }

  it("asks before trusting the first key, then pins exactly the key the person trusted", async () => {
    const env = await confirming();
    const { lifecycle, bindingId, files } = env;
    const refused = await lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnusableConnectionError);
    expect((refused as Error).message).toMatch(/confirm this machine's host key/i);
    expect(await files.exists(bindingId)).toBe(false);
    expect(lifecycle.statuses()[0]!.hostKeyReview).toMatchObject({
      reason: "first-connect",
      fingerprint: hostKeyFingerprint(HOST_KEY),
      keyType: "ED25519",
      previousFingerprint: null,
    });

    await lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY));
    const route = await lifecycle.ensureAccess(bindingId);
    expect(await pinnedKey(route)).toBe(`dtc-${bindingId} ${HOST_KEY}\n`);
    expect(await fs.readFile(route.configPath, "utf8")).toContain("StrictHostKeyChecking yes");
    const status = lifecycle.statuses()[0]!;
    expect(status.hostKeyReview).toBeNull();
    expect(status.hostKeyFingerprint).toBe(hostKeyFingerprint(HOST_KEY));
  });

  it("keeps a trusted key the machine still presents, through a restart and a stop and start", async () => {
    const env = await confirming();
    env.scan.output = `203.0.113.10 ${RSA_KEY}\n`;
    await env.lifecycle.ensureAccess(env.bindingId).catch(() => {});
    await env.lifecycle.trustHostKey("build", hostKeyFingerprint(RSA_KEY));
    await env.lifecycle.ensureAccess(env.bindingId);
    const { lifecycle: next } = env.restart(env.lifecycle);
    env.state.machine = resource({ machine: "stopped", rawState: "archived" });
    await next.startMachine("build");
    // It now also offers a key a first connect would prefer; the one trusted is kept.
    env.scan.output = `# 203.0.113.10:22001 SSH-2.0-OpenSSH_9.6\n[203.0.113.10]:22001 ${HOST_KEY}\n203.0.113.10 ${RSA_KEY}\n`;
    const scansBefore = keyscans(env.run);
    const route = await next.ensureAccess(env.bindingId);
    expect(keyscans(env.run)).toBe(scansBefore + 1);
    expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${RSA_KEY}\n`);
    expect(next.statuses()[0]!.hostKeyReview).toBeNull();
  });

  it("reuses fresh access only while it pins the key that is still trusted", async () => {
    const env = await confirming();
    await trusted(env);
    const scansBefore = keyscans(env.run);
    await env.lifecycle.ensureAccess(env.bindingId);
    expect(keyscans(env.run)).toBe(scansBefore);
    // Access left from a key that is no longer the trusted one never skips the look.
    env.store.updateBinding(env.bindingId, (current) => ({ ...current, trustedHostKey: null }));
    const refused = await env.lifecycle.ensureAccess(env.bindingId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnusableConnectionError);
    expect(keyscans(env.run)).toBe(scansBefore + 1);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview?.reason).toBe("first-connect");
  });

  it("asks for confirmation even when the provider's API names a key", async () => {
    const env = await confirming();
    vi.mocked(env.provider.authorizeSsh).mockResolvedValue({
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: HOST_KEY,
    });
    await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toBeInstanceOf(
      UnusableConnectionError
    );
    expect(await env.files.exists(env.bindingId)).toBe(false);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview?.reason).toBe("first-connect");
  });

  it("checks a trusted key a partial scan missed before calling it a change", async () => {
    const env = await confirming();
    const route = await trusted(env);
    // The ED25519 connection dropped while RSA answered; asked on its own, it answers.
    env.scan.output = `203.0.113.10 ${RSA_KEY}\n`;
    env.scan.byTypes = { ed25519: `[203.0.113.10]:22001 ${HOST_KEY}\n` };
    await env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true });
    expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${HOST_KEY}\n`);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();

    // Asked on its own and still missing: the machine no longer has it.
    env.scan.byTypes = { ed25519: "" };
    await expect(
      env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true })
    ).rejects.toThrow(/identity changed/i);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview?.fingerprint).toBe(
      hostKeyFingerprint(RSA_KEY)
    );
  });

  it("refuses two different keys of one kind without offering either", async () => {
    const env = await confirming();
    env.scan.output = `203.0.113.10 ${HOST_KEY}\n203.0.113.10 ${NEW_KEY}\n`;
    await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
      /two different host keys/
    );
    expect(env.store.bindings()[0]!.offeredHostKey).toBeNull();
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
  });

  it("refuses a changed key, says the identity changed, and keeps the old pin", async () => {
    const env = await confirming();
    const route = await trusted(env);
    env.scan.output = `[203.0.113.10]:22001 ${NEW_KEY}\n`;
    const refused = await env.lifecycle
      .ensureAccess(env.bindingId, undefined, { fresh: true })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnusableConnectionError);
    expect((refused as Error).message).toMatch(/identity changed/i);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toMatchObject({
      reason: "changed",
      fingerprint: hostKeyFingerprint(NEW_KEY),
      previousFingerprint: hostKeyFingerprint(HOST_KEY),
    });
    expect(env.store.bindings()[0]!.trustedHostKey?.key).toBe(HOST_KEY);
    expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${HOST_KEY}\n`);
    // Asking again never accepts it by itself.
    await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toBeInstanceOf(
      UnusableConnectionError
    );
  });

  it("pins a changed key only once the person trusts the fingerprint they were shown", async () => {
    const env = await confirming();
    await trusted(env);
    env.scan.output = `[203.0.113.10]:22001 ${NEW_KEY}\n`;
    await env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true }).catch(() => {});
    await expect(
      env.lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY))
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.store.bindings()[0]!.trustedHostKey?.key).toBe(HOST_KEY);

    const closeMaster = vi.spyOn(env.files, "closeMaster");
    await env.lifecycle.trustHostKey("build", hostKeyFingerprint(NEW_KEY));
    const route = await env.lifecycle.ensureAccess(env.bindingId);
    expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${NEW_KEY}\n`);
    // A master opened against the old key never carries the new connection.
    expect(closeMaster).toHaveBeenCalled();
    expect(env.lifecycle.accessGeneration(env.bindingId)).toContain(NEW_KEY);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
  });

  it("drops an offered key once the machine presents the trusted one again", async () => {
    const env = await confirming();
    await trusted(env);
    env.scan.output = `[203.0.113.10]:22001 ${NEW_KEY}\n`;
    await env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true }).catch(() => {});
    expect(env.lifecycle.statuses()[0]!.hostKeyReview?.reason).toBe("changed");
    env.scan.output = `[203.0.113.10]:22001 ${HOST_KEY}\n`;
    await env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true });
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
    await expect(
      env.lifecycle.trustHostKey("build", hostKeyFingerprint(NEW_KEY))
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.store.bindings()[0]!.trustedHostKey?.key).toBe(HOST_KEY);
  });

  it("names the change when ssh itself refuses the key between looks", async () => {
    const env = await confirming();
    await trusted(env);
    env.scan.output = `[203.0.113.10]:22001 ${NEW_KEY}\n`;
    const refused = await env.lifecycle.recheckHostKey(env.bindingId).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(UnusableConnectionError);
    expect((refused as Error).message).toMatch(/identity changed/i);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview?.reason).toBe("changed");
  });

  it("looks again after a refusal even while a dial on the old access is under way", async () => {
    const env = await confirming();
    await trusted(env);
    env.scan.output = `[203.0.113.10]:22001 ${NEW_KEY}\n`;
    let release!: (value: boolean) => void;
    const exists = vi.spyOn(env.files, "exists");
    exists.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const dial = env.lifecycle.ensureAccess(env.bindingId);
    await vi.waitFor(() => expect(exists).toHaveBeenCalled());
    const recheck = env.lifecycle.recheckHostKey(env.bindingId).catch((e: unknown) => e);
    release(true);
    await dial;
    const refused = await recheck;
    expect(refused).toBeInstanceOf(UnusableConnectionError);
    expect((refused as Error).message).toMatch(/identity changed/i);
  });

  it("lets a cancelled dial go while its recheck waits on another resolution", async () => {
    const env = await confirming();
    await trusted(env);
    let release!: (value: boolean) => void;
    const exists = vi.spyOn(env.files, "exists");
    exists.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        })
    );
    const dial = env.lifecycle.ensureAccess(env.bindingId);
    await vi.waitFor(() => expect(exists).toHaveBeenCalled());
    const abort = new AbortController();
    const recheck = env.lifecycle.recheckHostKey(env.bindingId, abort.signal);
    abort.abort();
    await expect(recheck).rejects.toBeInstanceOf(TransportError);
    release(true);
    await dial;
  });

  it("retries a machine that presents no key yet instead of refusing it", async () => {
    const env = await confirming();
    env.scan.output = "";
    const error = await env.lifecycle.ensureAccess(env.bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(UnusableConnectionError);
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
  });

  it("refuses a provider-command transport rather than dialling it directly", async () => {
    const env = await confirming("provider-command");
    await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
      /through the provider's own connection/
    );
    expect(env.provider.authorizeSsh).not.toHaveBeenCalled();
    expect(keyscans(env.run)).toBe(0);
  });

  it("leaves a provider that pins from its API alone", async () => {
    const env = await setup({ machine: "running" });
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = env.store.bindings()[0]!.id;
    await env.lifecycle.ensureAccess(bindingId);
    await env.lifecycle.recheckHostKey(bindingId);
    expect(keyscans(env.run)).toBe(0);
    // Even with a key on offer, there is nothing for the person to vouch for.
    env.store.updateBinding(bindingId, (current) => ({
      ...current,
      offeredHostKey: { key: HOST_KEY, at: 1 },
    }));
    await expect(
      env.lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY))
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(env.store.bindings()[0]!.trustedHostKey).toBeNull();
    env.store.updateBinding(bindingId, (current) => ({ ...current, offeredHostKey: null }));

    // Its API naming no key is a failed setup, never a first-connect prompt.
    vi.mocked(env.provider.authorizeSsh).mockResolvedValueOnce({
      user: "user",
      endpoint: { host: "203.0.113.10", port: 22001 },
      hostKey: null,
    });
    await expect(
      env.lifecycle.ensureAccess(bindingId, undefined, { fresh: true })
    ).rejects.toBeInstanceOf(UnusableConnectionError);
    expect(env.lifecycle.statuses()[0]!.lastError?.code).toBe("ssh-authorization");
    expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
  });

  describe("when the provider's API vouches for a first key when it can", () => {
    const OTHER_KEY = `ssh-rsa ${Buffer.alloc(64, 7).toString("base64")}`;
    const ECDSA_KEY =
      "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=";

    async function vouching() {
      const env = await setup({ machine: "running" }, { sshTrust: "api-or-confirm" });
      await env.lifecycle.importMachine({
        accountId: env.store.accounts()[0]!.id,
        resourceId: "bx_23456789",
        name: "build",
      });
      return { ...env, bindingId: env.store.bindings()[0]!.id };
    }

    const reports = (env: Awaited<ReturnType<typeof vouching>>, hostKey: string | null) =>
      vi.mocked(env.provider.authorizeSsh).mockResolvedValue({
        user: "user",
        endpoint: { host: "203.0.113.10", port: 22001 },
        hostKey,
      });

    it("trusts the key the API reports once the machine presents exactly it", async () => {
      const env = await vouching();
      const route = await env.lifecycle.ensureAccess(env.bindingId);
      expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${HOST_KEY}\n`);
      const status = env.lifecycle.statuses()[0]!;
      expect(status.hostKeyReview).toBeNull();
      expect(status.hostKeyFingerprint).toBe(hostKeyFingerprint(HOST_KEY));
    });

    it("asks the person while the API has no key yet, and takes the API's once it does", async () => {
      const env = await vouching();
      reports(env, null);
      await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
        /confirm this machine's host key/i
      );
      expect(env.lifecycle.statuses()[0]!.hostKeyReview?.reason).toBe("first-connect");

      reports(env, HOST_KEY);
      const route = await env.lifecycle.ensureAccess(env.bindingId);
      expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${HOST_KEY}\n`);
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
    });

    it("refuses a machine presenting another key than the API reports, offering neither", async () => {
      const env = await vouching();
      reports(env, OTHER_KEY);
      env.scan.byTypes = { rsa: "" };
      await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
        /isn't the one its provider reports/
      );
      expect(await env.files.exists(env.bindingId)).toBe(false);
      const status = env.lifecycle.statuses()[0]!;
      expect(status.hostKeyReview).toBeNull();
      expect(status.hostKeyFingerprint).toBeNull();
      expect(status.lastError?.code).toBe("ssh-authorization");
    });

    it("looks for the reported key on its own before calling it a mismatch", async () => {
      const env = await vouching();
      reports(env, ECDSA_KEY);
      // The full scan lost the ECDSA connection; asked for ECDSA alone, it answers.
      env.scan.byTypes = { ecdsa: `203.0.113.10 ${ECDSA_KEY}\n` };
      const route = await env.lifecycle.ensureAccess(env.bindingId);
      expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${ECDSA_KEY}\n`);
      const typed = env.run.mock.calls
        .filter((call) => path.basename(String(call[0])).startsWith("ssh-keyscan"))
        .map((call) => (call[1] as string[])[(call[1] as string[]).indexOf("-t") + 1]);
      expect(typed).toEqual(["ed25519,ecdsa,rsa", "ecdsa"]);
    });

    it("drops a key it offered earlier once the API reports a different one", async () => {
      const env = await vouching();
      reports(env, null);
      await env.lifecycle.ensureAccess(env.bindingId).catch(() => {});
      expect(env.lifecycle.statuses()[0]!.hostKeyReview?.fingerprint).toBe(
        hostKeyFingerprint(HOST_KEY)
      );
      // The console now reports another key than the machine presents: nothing stays on offer.
      reports(env, OTHER_KEY);
      env.scan.byTypes = { rsa: "" };
      await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
        /isn't the one its provider reports/
      );
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
      await expect(
        env.lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY))
      ).rejects.toThrow(/no new host key/);
    });

    it("withdraws an offered key as soon as the API reports another, before the machine answers", async () => {
      const env = await vouching();
      reports(env, null);
      await env.lifecycle.ensureAccess(env.bindingId).catch(() => {});
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).not.toBeNull();
      // sshd doesn't answer this time: the earlier offer still can't be trusted.
      reports(env, OTHER_KEY);
      env.scan.output = "";
      await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toThrow(
        /didn't present a host key|didn't answer with a host key/
      );
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).toBeNull();
    });

    it("lets the person confirm the key while the API still has none", async () => {
      const env = await vouching();
      reports(env, null);
      await env.lifecycle.ensureAccess(env.bindingId).catch(() => {});
      await env.lifecycle.trustHostKey("build", hostKeyFingerprint(HOST_KEY));
      const route = await env.lifecycle.ensureAccess(env.bindingId);
      expect(await pinnedKey(route)).toBe(`dtc-${env.bindingId} ${HOST_KEY}\n`);
    });

    it("looks again after ssh refuses the key, offering the change for review", async () => {
      const env = await vouching();
      await env.lifecycle.ensureAccess(env.bindingId);
      reports(env, OTHER_KEY);
      env.scan.output = `203.0.113.10 ${OTHER_KEY}\n`;
      env.scan.byTypes = { ed25519: "" };
      await expect(env.lifecycle.recheckHostKey(env.bindingId)).rejects.toThrow(
        /identity changed/i
      );
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).toMatchObject({
        reason: "changed",
        fingerprint: hostKeyFingerprint(OTHER_KEY),
      });
    });

    it("never lets the API's key replace a key already trusted", async () => {
      const env = await vouching();
      await env.lifecycle.ensureAccess(env.bindingId);
      reports(env, OTHER_KEY);
      env.scan.output = `203.0.113.10 ${OTHER_KEY}\n`;
      env.scan.byTypes = { ed25519: "" };
      await expect(
        env.lifecycle.ensureAccess(env.bindingId, undefined, { fresh: true })
      ).rejects.toThrow(/identity changed/i);
      expect(env.lifecycle.statuses()[0]!.hostKeyReview).toMatchObject({
        reason: "changed",
        fingerprint: hostKeyFingerprint(OTHER_KEY),
        previousFingerprint: hostKeyFingerprint(HOST_KEY),
      });
    });
  });
});

describe("CloudHostLifecycle.hostPackagesLogin", () => {
  const withLogin = (provider: CloudProvider) =>
    Object.assign(provider, { hostPackagesLogin: "root" });

  it("names the provider's login only for a machine Daintree created there", async () => {
    const { lifecycle, store } = await setup({}, { adapt: withLogin });
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(store.bindings()[0]?.resourceId).toBeTruthy());
    expect(lifecycle.hostPackagesLogin(store.bindings()[0]!.id)).toBe("root");
    expect(lifecycle.hostPackagesLogin("nothing-bound")).toBeNull();
  });

  it("names none for an imported machine, or on a provider that declares none", async () => {
    const imported = await setup({ machine: "running" }, { adapt: withLogin });
    await imported.lifecycle.importMachine({
      accountId: imported.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(imported.lifecycle.hostPackagesLogin(imported.store.bindings()[0]!.id)).toBeNull();

    const plain = await setup();
    await plain.lifecycle.create({
      accountId: plain.store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(plain.store.bindings()[0]?.resourceId).toBeTruthy());
    expect(plain.lifecycle.hostPackagesLogin(plain.store.bindings()[0]!.id)).toBeNull();
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

  describe("the ask to turn on the host's MCP server (#18187)", () => {
    const createRequest = (accountId: string, extra: Record<string, unknown> = {}) =>
      ({
        accountId,
        name: "build",
        machineType: "default",
        lifetimeHours: 2,
        ...extra,
      }) as CloudHostCreateRequest;
    const importRequest = (accountId: string, extra: Record<string, unknown> = {}) =>
      ({ accountId, resourceId: "bx_23456789", name: "build", ...extra }) as CloudHostImportRequest;
    /** Each binding as it was written, before any later change to the same object. */
    const recordWrites = (store: CloudHostStore) => {
      const writes: StoredCloudBinding[] = [];
      const put = store.putBinding.bind(store);
      vi.spyOn(store, "putBinding").mockImplementation((binding) => {
        writes.push(structuredClone(binding));
        put(binding);
      });
      return writes;
    };

    it("keeps a yes with the binding's first write, for a new machine and an existing one", async () => {
      const created = await setup();
      const createWrites = recordWrites(created.store);
      await created.lifecycle.create(
        createRequest(created.store.accounts()[0]!.id, { mcpServerOnConnect: true })
      );
      expect(createWrites[0]).toMatchObject({ hostId: null, mcpServerOnConnect: true });
      expect(created.store.bindings()[0]?.mcpServerOnConnect).toBe(true);
      await vi.waitFor(() => expect(created.lifecycle.statuses()[0]?.operation).toBeNull());

      const imported = await setup({ machine: "stopped" });
      const importWrites = recordWrites(imported.store);
      await imported.lifecycle.importMachine(
        importRequest(imported.store.accounts()[0]!.id, { mcpServerOnConnect: true })
      );
      expect(importWrites[0]).toMatchObject({
        hostId: null,
        ownership: "imported",
        mcpServerOnConnect: true,
      });
      expect(imported.store.bindings()[0]?.mcpServerOnConnect).toBe(true);
    });

    it.each([{}, { mcpServerOnConnect: false }])(
      "keeps no ask for a request that doesn't say yes (%o)",
      async (extra) => {
        const created = await setup();
        await created.lifecycle.create(createRequest(created.store.accounts()[0]!.id, extra));
        expect(created.store.bindings()[0]).not.toHaveProperty("mcpServerOnConnect");
        await vi.waitFor(() => expect(created.lifecycle.statuses()[0]?.operation).toBeNull());

        const imported = await setup({ machine: "stopped" });
        await imported.lifecycle.importMachine(
          importRequest(imported.store.accounts()[0]!.id, extra)
        );
        expect(imported.store.bindings()[0]).not.toHaveProperty("mcpServerOnConnect");
      }
    );

    it.each(["yes", 1, 0, null])(
      "refuses a muddled answer (%o), writing nothing",
      async (value) => {
        const { lifecycle, provider, store } = await setup();
        const accountId = store.accounts()[0]!.id;
        await expect(
          lifecycle.create(createRequest(accountId, { mcpServerOnConnect: value }))
        ).rejects.toMatchObject({ code: "VALIDATION" });
        await expect(
          lifecycle.importMachine(importRequest(accountId, { mcpServerOnConnect: value }))
        ).rejects.toMatchObject({ code: "VALIDATION" });
        expect(store.bindings()).toEqual([]);
        expect(provider.create).not.toHaveBeenCalled();
      }
    );

    it("never keeps one for a machine made for a worktree, which offers no such choice", async () => {
      const { lifecycle, store } = await setup();
      await lifecycle.create(createRequest(store.accounts()[0]!.id, { mcpServerOnConnect: true }), {
        hostId: null,
        projectId: "0f1e2d3c",
        worktreeId: "/Users/me/code/app-worktrees/feature-login",
        projectName: "app",
        worktreeName: "feature/login",
        hostName: null,
      });
      expect(store.bindings()[0]?.createdFor).not.toBeNull();
      expect(store.bindings()[0]).not.toHaveProperty("mcpServerOnConnect");
      await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    });
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

  // What was last found about starting Daintree there went with the reboot (#17546).
  it("says once that a machine it started came up, before any view hears it is running", async () => {
    const onMachineStarted = vi.fn();
    const { lifecycle, accounts, store } = await setup(
      { machine: "stopped" },
      { onMachineStarted }
    );
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await lifecycle.refresh("build");
    expect(onMachineStarted).not.toHaveBeenCalled();
    const toldWhenViewsHeard: boolean[] = [];
    const views = new CloudHosts({
      accounts,
      store,
      emit: (snapshot) => {
        if (snapshot.hosts[0]?.machine === "running") {
          toldWhenViewsHeard.push(onMachineStarted.mock.calls.length > 0);
        }
      },
    });
    views.attachLifecycle(lifecycle);
    try {
      await lifecycle.startMachine("build");
      expect(onMachineStarted).toHaveBeenCalledExactlyOnceWith("build");
      expect(toldWhenViewsHeard[0]).toBe(true);
      await lifecycle.refresh("build");
      expect(onMachineStarted).toHaveBeenCalledOnce();
    } finally {
      views.dispose();
    }
  });

  it("doesn't take a first look at a running machine for one coming up", async () => {
    const onMachineStarted = vi.fn();
    const { lifecycle, store, state } = await setup({}, { onMachineStarted });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    // A binding kept without an observation: its next look is its first.
    store.updateBinding(store.bindings()[0]!.id, (current) => ({ ...current, observation: null }));
    state.machine = resource({ machine: "running", stoppedAt: "2026-11-14T10:00:00Z" });
    await lifecycle.refresh("build");
    expect(onMachineStarted).not.toHaveBeenCalled();
  });

  it("says a machine came up when a stop and start were only observed, and not for one that never stopped", async () => {
    const onMachineStarted = vi.fn();
    const { lifecycle, store, state } = await setup({}, { onMachineStarted });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await lifecycle.refresh("build");
    expect(onMachineStarted).not.toHaveBeenCalled();
    // Stopped and started again between two looks: only its stop time says so.
    state.machine = resource({ machine: "running", stoppedAt: "2026-11-14T10:00:00Z" });
    await lifecycle.refresh("build");
    expect(onMachineStarted).toHaveBeenCalledExactlyOnceWith("build");
    state.machine = resource({ machine: "stopped", stoppedAt: "2026-11-14T11:00:00Z" });
    await lifecycle.refresh("build");
    state.machine = resource({ machine: "running", stoppedAt: null });
    await lifecycle.refresh("build");
    await lifecycle.refresh("build");
    expect(onMachineStarted).toHaveBeenCalledTimes(2);
  });

  it("drops a save failure it saw on the way once the stop completes", async () => {
    const { lifecycle, provider, store } = await setup({ machine: "running" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    vi.mocked(provider.inspect).mockResolvedValueOnce(
      resource({
        machine: "stopping",
        rawState: "archiving",
        stop: { id: "stop_1", status: "failing", error: "disk busy" },
      })
    );
    let sawFailure = false;
    const statuses = vi.spyOn(store, "updateBinding");
    await lifecycle.stopMachine("build");
    for (const call of statuses.mock.results) {
      const binding = call.value as { lastError: { code: string } | null } | null;
      if (binding?.lastError?.code === "stop-failing") sawFailure = true;
    }
    expect(sawFailure).toBe(true);
    const status = lifecycle.statuses()[0]!;
    expect(status.machine).toBe("stopped");
    expect(status.lastError).toBeNull();
  });

  it("lets a good answer supersede a failure to get one, but not a refused start", async () => {
    const { lifecycle, provider, store } = await setup({ machine: "stopped" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    vi.mocked(provider.inspect).mockRejectedValueOnce(
      new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null)
    );
    await lifecycle.refresh("build").catch(() => {});
    expect(lifecycle.statuses()[0]!.machine).toBe("unknown");
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("not-found");
    await lifecycle.refresh("build");
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();

    // A start Boat refused for its start limit: reading the machine fine changes nothing.
    vi.mocked(provider.start).mockRejectedValueOnce(
      new BoatApiError("rate-limited", "start limit", 429, "start_limit", null)
    );
    await lifecycle.startMachine("build").catch(() => {});
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("rate-limited");
    await lifecycle.refresh("build");
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("rate-limited");
  });

  it("keeps a running machine's lifetime when the provider refuses the change", async () => {
    const { lifecycle, provider, store } = await setup({ machine: "running" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const before = lifecycle.statuses()[0]!.lifetimeSeconds;
    vi.mocked(provider.renewLifetime).mockRejectedValueOnce(
      new BoatApiError("invalid-request", "ttl too long", 400, "invalid_ttl", null)
    );
    await expect(lifecycle.setLifetime("build", 24)).rejects.toBeTruthy();
    expect(lifecycle.statuses()[0]!.lifetimeSeconds).toBe(before);
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
      resource({
        resourceId: "bx_found0000",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
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
      resource({
        resourceId: "bx_found0000",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
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
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalled());
    vi.mocked(provider.inspect).mockImplementation(async () => state.machine);
    // A Start the create refuses changes nothing it records.
    const writes = vi.spyOn(store, "updateBinding");
    await expect(lifecycle.startMachine("build")).rejects.toThrow(
      /creating operation is under way/
    );
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
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

  it("lets a dial reading the account across a running observation reach the machine, not the stop it read first", async () => {
    const { lifecycle, accounts, provider, store, state } = await setup({ machine: "stopped" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await lifecycle.refresh("build");
    const bindingId = store.bindings()[0]!.id;
    let release: () => void = () => {};
    const credentials = accounts.credentials.bind(accounts);
    vi.spyOn(accounts, "credentials").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return credentials(...args);
    });
    const dial = lifecycle.ensureAccess(bindingId);
    await vi.waitFor(() => expect(accounts.credentials).toHaveBeenCalled());
    state.machine = resource({ machine: "running" });
    await lifecycle.refresh("build");
    release();
    await expect(dial).resolves.toMatchObject({ target: `dtc-${bindingId}` });
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
  });

  it("resolves no access for a host removed while a dial read the account", async () => {
    const { lifecycle, accounts, provider, store } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = store.bindings()[0]!.id;
    let release: () => void = () => {};
    const credentials = accounts.credentials.bind(accounts);
    vi.spyOn(accounts, "credentials").mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return credentials(...args);
    });
    const dial = lifecycle.ensureAccess(bindingId);
    await vi.waitFor(() => expect(accounts.credentials).toHaveBeenCalled());
    store.removeBinding(bindingId);
    release();
    await expect(dial).rejects.toBeInstanceOf(UnusableConnectionError);
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
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

  it("gets a missing public half back from the account's private key instead of replacing it", async () => {
    const { files, run, account } = await setup();
    const key = await files.publicKey(account.id);
    const pub = path.join(root, "cloud", "keys", `${account.id}_ed25519.pub`);
    await fs.rm(pub);
    await fs.chmod(pub.slice(0, -".pub".length), 0o644);
    expect(await files.publicKey(account.id)).toBe(key);
    expect((await fs.readFile(pub, "utf8")).trim()).toBe(key);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toContain("-y");

    // An ssh-keygen that can't be asked leaves the private key in place.
    await fs.rm(pub);
    run.mockResolvedValueOnce({
      code: null,
      stdout: "",
      stderr: "",
      spawnError: "spawn ssh-keygen ENOENT",
      timedOut: false,
    });
    await expect(files.publicKey(account.id)).rejects.toThrow("ENOENT");
    await expect(fs.access(pub.slice(0, -".pub".length))).resolves.toBeUndefined();
  });

  it("replaces a public half whose private key is gone with a new pair (#17929)", async () => {
    const { files, run, account } = await setup();
    const key = await files.publicKey(account.id);
    const keyPath = path.join(root, "cloud", "keys", `${account.id}_ed25519`);
    await fs.rm(keyPath);
    expect(await files.hasKey(account.id)).toBe(false);
    const make = run.getMockImplementation()!;
    let staleAtGenerate: boolean | null = null;
    run.mockImplementationOnce(async (...args) => {
      // A cut-short ssh-keygen must not leave the old public half beside a new private key.
      staleAtGenerate = await fs.access(`${keyPath}.pub`).then(
        () => true,
        () => false
      );
      return make(...args);
    });
    const made = await files.publicKey(account.id);
    expect(staleAtGenerate).toBe(false);
    expect(made).not.toBe(key);
    expect((await fs.readFile(`${keyPath}.pub`, "utf8")).trim()).toBe(made);
    // The fake's private half holds its public one: the pair on disk belongs together.
    expect((await fs.readFile(keyPath, "utf8")).trim()).toBe(made);
    expect(await files.hasKey(account.id)).toBe(true);
  });

  it("removes an account's key only once the key being made for it is written", async () => {
    const { files, run, account } = await setup();
    const make = run.getMockImplementation()!;
    let release: () => void = () => {};
    run.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return make(...args);
    });
    const made = files.publicKey(account.id);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    const forgotten = files.forgetAccount(account.id);
    release();
    await Promise.all([made, forgotten]);
    expect(await fs.readdir(path.join(root, "cloud", "keys"))).toEqual([]);
  });
});

describe("CloudHostLifecycle lifetime models", () => {
  const NONE: CloudLifetimeModel = { kind: "none" };
  const IDLE: CloudLifetimeModel = { kind: "idle-sleep", idleSeconds: 1800 };
  const FIXED: CloudLifetimeModel = { kind: "fixed-at-create", canChangeWhileStopped: true };
  const FIXED_FOR_GOOD: CloudLifetimeModel = {
    kind: "fixed-at-create",
    canChangeWhileStopped: false,
  };

  async function createWith(lifetime: CloudLifetimeModel, lifetimeHours: number | null) {
    const env = await setup({}, { lifetime });
    const created = env.lifecycle.create({
      accountId: env.store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours,
    });
    return { ...env, created };
  }

  it("creates a machine with no lifetime, or an idle sleep, without sending one", async () => {
    for (const lifetime of [NONE, IDLE]) {
      const { created, provider, lifecycle } = await createWith(lifetime, null);
      await created;
      await vi.waitFor(() => expect(provider.create).toHaveBeenCalled());
      expect(vi.mocked(provider.create).mock.calls[0]![1].lifetimeSeconds).toBeNull();
      expect(lifecycle.statuses()[0]!.lifetime).toEqual(lifetime);
    }
  });

  it("refuses a lifetime the provider wouldn't hold, before anything is written", async () => {
    for (const lifetime of [NONE, IDLE]) {
      const { created, provider, store, hosts } = await createWith(lifetime, 2);
      await expect(created).rejects.toThrow(/doesn't take a lifetime/);
      expect(provider.create).not.toHaveBeenCalled();
      expect(store.bindings()).toEqual([]);
      expect(hosts).toEqual([]);
    }
  });

  /** Swaps the provider's lifetime model in place, as an update to its plugin would. */
  function nowDescribes(provider: CloudProvider, lifetime: CloudLifetimeModel) {
    const info = provider.info;
    provider.info = (platform) => {
      const described = info(platform);
      return { ...described, capabilities: { ...described.capabilities, lifetime } };
    };
  }

  async function lostCreate() {
    const env = await setup();
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("network", "lost", null, null, null)
    );
    await env.lifecycle.create({
      accountId: env.store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown")
    );
    return env;
  }

  it("refuses to retry a create whose limit its provider no longer takes, rather than drop it", async () => {
    const { lifecycle, provider } = await lostCreate();
    nowDescribes(provider, NONE);
    await expect(lifecycle.retryCreate("build")).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringMatching(/no longer takes a lifetime/),
    });
    expect(provider.create).toHaveBeenCalledTimes(1);
    // The lost first request may still have made it: removal must still go the delete way.
    expect(lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("deletes any machine it finds"),
    });
  });

  it("points to the account, not removal, when its provider can't delete machines", async () => {
    const { lifecycle, provider } = await lostCreate();
    const info = provider.info;
    provider.info = (platform) => {
      const described = info(platform);
      return {
        ...described,
        capabilities: { ...described.capabilities, lifetime: NONE, deletion: false },
      };
    };
    await expect(lifecycle.retryCreate("build")).rejects.toThrow(/check your Boat account/);
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("outcome-unknown");
  });

  it("refuses a first create whose limit its provider stopped taking before it was sent", async () => {
    const { lifecycle, provider, store } = await setup();
    vi.mocked(provider.catalog).mockImplementationOnce(async (credentials) => {
      nowDescribes(provider, IDLE);
      return fakeProvider({ machine: resource() }).catalog(credentials);
    });
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.lastError?.code).toBe("unsupported"));
    expect(provider.create).not.toHaveBeenCalled();
    expect(store.bindings()[0]!.creation!.sentAt).toBeNull();
  });

  it("asks no provider for a machine when its provider was replaced during the lookup", async () => {
    const { lifecycle, provider, accounts } = await lostCreate();
    const replacement = fakeProvider({ machine: resource() });
    vi.mocked(provider.list).mockImplementationOnce(async () => {
      vi.spyOn(accounts, "provider").mockReturnValue(replacement);
      return [];
    });
    await expect(lifecycle.retryCreate("build")).rejects.toThrow(/changed while the machine/);
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(replacement.create).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringMatching(/changed while the machine.*checks once/),
    });
  });

  it("asks nothing of a provider replaced while a first create read its key", async () => {
    const { lifecycle, provider, store, accounts } = await setup();
    const replacement = fakeProvider({ machine: resource() });
    const read = accounts.credentials.bind(accounts);
    // The first read is the catalog's; the second is the create's own.
    vi.spyOn(accounts, "credentials")
      .mockImplementationOnce(read)
      .mockImplementationOnce(async (...args) => {
        vi.spyOn(accounts, "provider").mockReturnValue(replacement);
        return read(...args);
      });
    await lifecycle.create({
      accountId: store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
        code: "failed",
        message: expect.stringMatching(/Retry asks again/),
      })
    );
    expect(provider.create).not.toHaveBeenCalled();
    expect(replacement.create).not.toHaveBeenCalled();
  });

  it("writes nothing for a create whose provider was replaced while its sizes were read", async () => {
    const { lifecycle, provider, store, accounts, hosts } = await setup();
    const replacement = fakeProvider({ machine: resource() });
    const sizes = provider.catalog;
    vi.mocked(provider.catalog).mockImplementationOnce(async (credentials) => {
      vi.spyOn(accounts, "provider").mockReturnValue(replacement);
      return fakeProvider({ machine: resource() }).catalog(credentials);
    });
    await expect(
      lifecycle.create({
        accountId: store.accounts()[0]!.id,
        name: "build",
        machineType: "default",
        lifetimeHours: 2,
      })
    ).rejects.toThrow(/changed while the machine was being set up/);
    expect(sizes).toHaveBeenCalledTimes(1);
    expect(store.bindings()).toEqual([]);
    expect(hosts).toEqual([]);
    expect(provider.create).not.toHaveBeenCalled();
    expect(replacement.create).not.toHaveBeenCalled();
  });

  it("creates a machine with a fixed runtime limit from the same choices", async () => {
    const { created, provider } = await createWith(FIXED_FOR_GOOD, 8);
    await created;
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalled());
    expect(vi.mocked(provider.create).mock.calls[0]![1].lifetimeSeconds).toBe(8 * 3600);
    const odd = await createWith(FIXED, 3);
    await expect(odd.created).rejects.toThrow(/Choose how long/);
  });

  it("starts with a limit only where the provider takes one at start", async () => {
    const cases: [CloudLifetimeModel, object][] = [
      [FIXED, { lifetimeSeconds: 7200 }],
      [FIXED_FOR_GOOD, {}],
      [NONE, {}],
      [IDLE, {}],
    ];
    for (const [lifetime, options] of cases) {
      const { lifecycle, provider, store } = await setup({ machine: "stopped" }, { lifetime });
      await lifecycle.importMachine({
        accountId: store.accounts()[0]!.id,
        resourceId: "bx_23456789",
        name: "build",
      });
      await lifecycle.startMachine("build");
      expect(vi.mocked(provider.start).mock.calls[0]![2]).toEqual(options);
    }
  });

  it("changes a fixed limit only while the machine is stopped, for its next start", async () => {
    const running = await setup({ machine: "running" }, { lifetime: FIXED });
    await running.lifecycle.importMachine({
      accountId: running.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await expect(running.lifecycle.setLifetime("build", 4)).rejects.toThrow(/only while/);
    expect(running.store.bindings()[0]!.lifetimeSeconds).toBe(7200);

    const stopped = await setup({ machine: "stopped" }, { lifetime: FIXED });
    await stopped.lifecycle.importMachine({
      accountId: stopped.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await stopped.lifecycle.setLifetime("build", 4);
    expect(stopped.provider.renewLifetime).not.toHaveBeenCalled();
    await stopped.lifecycle.startMachine("build");
    expect(vi.mocked(stopped.provider.start).mock.calls[0]![2]).toEqual({
      lifetimeSeconds: 4 * 3600,
    });
  });

  it("has no lifetime to change on a provider that doesn't let it change", async () => {
    for (const lifetime of [FIXED_FOR_GOOD, NONE, IDLE]) {
      const { lifecycle, provider, store } = await setup({ machine: "stopped" }, { lifetime });
      await lifecycle.importMachine({
        accountId: store.accounts()[0]!.id,
        resourceId: "bx_23456789",
        name: "build",
      });
      await expect(lifecycle.setLifetime("build", 4)).rejects.toBeTruthy();
      expect(store.bindings()[0]!.lifetimeSeconds).toBe(7200);
      expect(provider.renewLifetime).not.toHaveBeenCalled();
    }
  });
});

describe("CloudHostLifecycle lifetime keeper", () => {
  const NOW = Date.parse("2026-11-14T12:00:00Z");

  async function keeper(
    activity: Activity,
    autoStopInMinutes: number,
    machine: Partial<ProviderResource> = {},
    lifetime?: CloudLifetimeModel
  ) {
    const clock = { now: NOW };
    const env = await setup(
      {
        machine: "running",
        lifetimeSeconds: 7200,
        autoStopAt: new Date(NOW + autoStopInMinutes * 60_000).toISOString(),
        ...machine,
      },
      { activity: () => activity, now: () => clock.now, lifetime }
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

  it("never renews a machine whose provider can't move its deadline", async () => {
    const models: CloudLifetimeModel[] = [
      { kind: "none" },
      { kind: "fixed-at-create", canChangeWhileStopped: true },
      { kind: "idle-sleep", idleSeconds: 1800 },
    ];
    for (const lifetime of models) {
      // A deadline near and in use here: only the provider's lifetime model says no.
      const { lifecycle, provider } = await keeper(
        { connected: true, busy: true, shown: true },
        5,
        {},
        lifetime
      );
      await lifecycle.renewDue();
      expect(provider.renewLifetime).not.toHaveBeenCalled();
      expect(lifecycle.statuses()[0]!.lastError).toBeNull();
    }
  });

  it("skips a provider that says its lifetime renews but has no renewal method", async () => {
    // Boat's own model is renewable: only the missing method stands between it and a renewal.
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: true }, 5);
    delete (provider as { renewLifetime?: unknown }).renewLifetime;
    await expect(lifecycle.renewDue()).resolves.toBeUndefined();
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
    expect(lifecycle.statuses()[0]!.keptRunningAt).toBeNull();
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
    const { lifecycle, provider, disconnect } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    let release: () => void = () => {};
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return resource({ machine: "running" });
    });
    const renewing = lifecycle.renewDue();
    await vi.waitFor(() => expect(provider.renewLifetime).toHaveBeenCalled());
    const stopping = lifecycle.stopMachine("build");
    // The stop holds the machine while the renewal settles, and lets go of nothing until it has.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lifecycle.statuses()[0]!.operation?.kind).toBe("stopping");
    await expect(lifecycle.startMachine("build")).rejects.toThrow(
      /stopping operation is under way/
    );
    expect(disconnect).not.toHaveBeenCalled();
    expect(provider.stop).not.toHaveBeenCalled();
    release();
    await Promise.all([renewing, stopping]);
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
    expect(vi.mocked(provider.stop).mock.invocationCallOrder[0]!).toBeGreaterThan(
      vi.mocked(provider.renewLifetime).mock.invocationCallOrder[0]!
    );
  });

  it("leaves a deadline the machine's own keeper already moved, reading it before writing", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    state.machine = resource({
      machine: "running",
      autoStopAt: new Date(NOW + 7_200_000).toISOString(),
    });
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]).toMatchObject({
      autoStopAt: new Date(NOW + 7_200_000).toISOString(),
      keptRunningAt: null,
      lastError: null,
    });
  });

  it("never renews a machine stopping by itself, and starts nothing", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    state.machine = resource({
      machine: "running",
      autoStopAt: new Date(NOW + 10 * 60_000).toISOString(),
      stop: { id: "stop_1", status: "pending", error: null },
    });
    await lifecycle.renewDue();
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("reports no failure for a renewal refused because the machine stopped itself meanwhile", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      state.machine = resource({ machine: "stopping", rawState: "archiving" });
      throw new BoatApiError("conflict", "stopping", 409, "sandbox_stopping", null);
    });
    await lifecycle.renewDue();
    expect(lifecycle.statuses()[0]).toMatchObject({ machine: "stopping", lastError: null });
    expect(provider.start).not.toHaveBeenCalled();
  });

  it("records no failed renewal when only its read before writing failed", async () => {
    const { lifecycle, provider } = await keeper({ connected: true, busy: true, shown: false }, 10);
    vi.mocked(provider.inspect).mockRejectedValueOnce(
      new BoatApiError("not-found", "gone", 404, null, null)
    );
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
    // The read's own finding stays, not a renewal that was never sent.
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("not-found");
  });

  it("clears an earlier failed renewal once the machine's own keeper moved the deadline", async () => {
    const { lifecycle, provider, state, clock } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockRejectedValueOnce(
      new BoatApiError("server", "down", 500, null, null)
    );
    await lifecycle.renewDue();
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("lifetime-renewal");
    state.machine = resource({
      machine: "running",
      autoStopAt: new Date(NOW + 7_200_000).toISOString(),
    });
    clock.now = NOW + 3 * 60_000;
    await lifecycle.renewDue();
    expect(provider.renewLifetime).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("clears a failed renewal when any read shows the deadline moved, not only its own", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockRejectedValueOnce(
      new BoatApiError("server", "down", 500, null, null)
    );
    await lifecycle.renewDue();
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("lifetime-renewal");
    state.machine = resource({
      machine: "running",
      autoStopAt: new Date(NOW + 7_200_000).toISOString(),
    });
    await lifecycle.refresh("build");
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("reports no failed renewal when the machine's own keeper moved the deadline as it failed", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      state.machine = resource({
        machine: "running",
        autoStopAt: new Date(NOW + 7_200_000).toISOString(),
      });
      throw new BoatApiError("conflict", "busy", 409, null, null);
    });
    await lifecycle.renewDue();
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("keeps a failed renewal shown while the machine's state can't be read", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockRejectedValueOnce(
      new BoatApiError("server", "down", 500, null, null)
    );
    await lifecycle.renewDue();
    state.machine = resource({ machine: "unknown", rawState: "weird" });
    await lifecycle.refresh("build");
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("lifetime-renewal");
  });

  it("still reports a failed renewal when the machine is in error rather than stopping", async () => {
    const { lifecycle, provider, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    vi.mocked(provider.renewLifetime).mockImplementationOnce(async () => {
      state.machine = resource({ machine: "error", rawState: "error" });
      throw new BoatApiError("server", "down", 500, null, null);
    });
    await lifecycle.renewDue();
    expect(lifecycle.statuses()[0]!.lastError?.code).toBe("lifetime-renewal");
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

  it("keeps a Stop's intent when a Start it refused arrives while the stop fails (#17549)", async () => {
    const { lifecycle, provider, store } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    let fail: (error: Error) => void = () => {};
    vi.mocked(provider.stop).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalled());
    await expect(lifecycle.startMachine("build")).rejects.toThrow(
      /stopping operation is under way/
    );
    fail(new BoatApiError("server", "down", 500, null, null));
    await expect(stopping).rejects.toThrow();
    expect(store.bindings()[0]!.intent).toBe("stop");
    // The provider still reports it running after the failed stop: the keeper leaves it to stop.
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
    expect(provider.start).not.toHaveBeenCalled();
  });

  it("keeps a Stop's intent when a Start it refused arrives while the stop runs out of time (#17549)", async () => {
    const { lifecycle, provider, store, state, clock } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    // The provider takes the stop, but the machine never gets there.
    vi.mocked(provider.stop).mockImplementationOnce(async () =>
      resource({ machine: "stopping", rawState: "archiving" })
    );
    let release: () => void = () => {};
    vi.mocked(provider.inspect).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return state.machine;
    });
    const inspected = vi.mocked(provider.inspect).mock.calls.length;
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(inspected + 1));
    await expect(lifecycle.startMachine("build")).rejects.toThrow(
      /stopping operation is under way/
    );
    clock.now = NOW + 16 * 60_000;
    release();
    await expect(stopping).rejects.toThrow(/hasn't finished stopping/);
    expect(lifecycle.statuses()[0]!.machine).toBe("running");
    expect(store.bindings()[0]!.intent).toBe("stop");
    await lifecycle.renewDue();
    expect(provider.renewLifetime).not.toHaveBeenCalled();
  });

  it("holds the machine for a Stop while it lets go of the link, and shares it with a second Stop", async () => {
    const { lifecycle, provider, store, disconnect } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    let release: () => void = () => {};
    disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    let fail: (error: Error) => void = () => {};
    vi.mocked(provider.stop).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    const first = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    expect(lifecycle.statuses()[0]!.operation?.kind).toBe("stopping");
    await expect(lifecycle.startMachine("build")).rejects.toThrow(
      /stopping operation is under way/
    );
    const writes = vi.spyOn(store, "updateBinding");
    const second = lifecycle.stopMachine("build");
    expect(writes).not.toHaveBeenCalled();
    writes.mockRestore();
    expect(provider.stop).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalled());
    fail(new BoatApiError("server", "down", 500, null, null));
    const [one, two] = await Promise.allSettled([first, second]);
    expect(one.status).toBe("rejected");
    expect(two.status).toBe("rejected");
    expect((two as PromiseRejectedResult).reason).toBe((one as PromiseRejectedResult).reason);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(store.bindings()[0]!.intent).toBe("stop");
  });

  it("lets a Delete cancel a Stop still letting go of the link, before the provider hears of it", async () => {
    const { lifecycle, provider, disconnect, hosts } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    let release: () => void = () => {};
    disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    const deleting = lifecycle.deleteMachine("build", "bx_23456789");
    release();
    await expect(stopping).rejects.toThrow(/Cancelled/);
    await deleting;
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(hosts).toHaveLength(0);
  });

  it("ends a Stop as cancelled when its host goes while it lets go of the link", async () => {
    const { lifecycle, provider, store, hosts, disconnect } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    let release: () => void = () => {};
    disconnect.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    hosts.splice(0, 1);
    lifecycle.start();
    try {
      await vi.waitFor(() => expect(store.bindings()).toHaveLength(0));
      release();
      await expect(stopping).rejects.toThrow(/Cancelled/);
      expect(provider.stop).not.toHaveBeenCalled();
    } finally {
      lifecycle.dispose();
    }
  });

  it("never sends a Stop that a shutdown cancelled while its key was read", async () => {
    const { lifecycle, provider, accounts } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    const read = accounts.credentials.bind(accounts);
    let release: () => void = () => {};
    const credentials = vi
      .spyOn(accounts, "credentials")
      .mockImplementationOnce(async (account, signal) => {
        await new Promise<void>((resolve) => (release = resolve));
        return read(account, signal);
      });
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(credentials).toHaveBeenCalled());
    lifecycle.dispose();
    release();
    await expect(stopping).rejects.toThrow(/Cancelled/);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(lifecycle.statuses()[0]!.lastError).toBeNull();
  });

  it("deletes a machine whose Stop claimed it first after both superseded a Start", async () => {
    const { lifecycle, provider, hosts } = await keeper(
      { connected: true, busy: true, shown: false },
      10,
      { machine: "stopped", rawState: "archived" }
    );
    let release: () => void = () => {};
    vi.mocked(provider.start).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return resource({ machine: "starting", rawState: "provisioning" });
    });
    const starting = lifecycle.startMachine("build");
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalled());
    const stopping = lifecycle.stopMachine("build");
    const deleting = lifecycle.deleteMachine("build", "bx_23456789");
    release();
    await expect(starting).rejects.toThrow(/Cancelled/);
    await expect(stopping).rejects.toThrow(/Cancelled/);
    await deleting;
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(hosts).toHaveLength(0);
  });

  it("deletes a machine a Start claimed while the delete let go of the link", async () => {
    const { lifecycle, provider, hosts, disconnect, state } = await keeper(
      { connected: true, busy: true, shown: false },
      10,
      { machine: "stopped", rawState: "archived" }
    );
    let linkDropped: () => void = () => {};
    disconnect.mockImplementationOnce(
      () => new Promise<void>((resolve) => (linkDropped = resolve))
    );
    let started: () => void = () => {};
    vi.mocked(provider.start).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (started = resolve));
      state.machine = resource({ machine: "running" });
      return resource({ machine: "starting", rawState: "provisioning" });
    });
    const deleting = lifecycle.deleteMachine("build", "bx_23456789");
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    const starting = lifecycle.startMachine("build");
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalled());
    linkDropped();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A Stop asked for now waits on the same Start, behind the delete: it can't take the machine.
    const stopping = lifecycle.stopMachine("build");
    started();
    await expect(starting).rejects.toThrow(/Cancelled/);
    await expect(stopping).rejects.toThrow(/deleting operation is under way/);
    await deleting;
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(hosts).toHaveLength(0);
  });

  it("leaves the intent and the link alone when a delete under way refuses a Stop", async () => {
    const { lifecycle, provider, store, disconnect } = await keeper(
      { connected: true, busy: true, shown: false },
      10
    );
    await lifecycle.startMachine("build");
    expect(store.bindings()[0]!.intent).toBe("run");
    let fail: (error: Error) => void = () => {};
    vi.mocked(provider.delete).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject))
    );
    const deleting = lifecycle.deleteMachine("build", "bx_23456789");
    await vi.waitFor(() => expect(provider.delete).toHaveBeenCalled());
    const linksDropped = disconnect.mock.calls.length;
    await expect(lifecycle.stopMachine("build")).rejects.toThrow(/deleting operation is under way/);
    expect(disconnect).toHaveBeenCalledTimes(linksDropped);
    fail(new BoatApiError("server", "down", 500, null, null));
    await expect(deleting).rejects.toThrow();
    expect(store.bindings()[0]!.intent).toBe("run");
    expect(provider.stop).not.toHaveBeenCalled();
  });
});

describe("CloudHostLifecycle guest power-off (#17362)", () => {
  it("shows why a machine can't power itself off once idle, and checks linked machines on its keeper pass", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let problem: string | null = "Needs a password to power off.";
      let env: Awaited<ReturnType<typeof setup>> | null = null;
      const guestPowerOff = {
        // Only for the binding it's asked about.
        problemFor: vi.fn((bindingId: string): string | null =>
          bindingId === env?.store.bindings()[0]?.id ? problem : null
        ),
        standsInFor: vi.fn(() => false),
        arm: vi.fn(async () => {}),
        tick: vi.fn(async () => {}),
        forgetRemoved: vi.fn(),
      };
      env = await setup({ machine: "running" }, { guestPowerOff });
      env.lifecycle.start();
      await env.lifecycle.importMachine({
        accountId: env.store.accounts()[0]!.id,
        resourceId: "bx_23456789",
        name: "build",
      });
      expect(env.lifecycle.statuses()[0]!.selfStopProblem).toBe("Needs a password to power off.");
      problem = null;
      expect(env.lifecycle.statuses()[0]!.selfStopProblem).toBeNull();
      const before = guestPowerOff.tick.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(guestPowerOff.tick.mock.calls.length - before).toBe(2);
      env.lifecycle.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CloudHostLifecycle machine keys (#17361)", () => {
  it("revokes the keys a removed host's machine was given, and shows why one can't stop itself", async () => {
    const machineKeys = {
      problemFor: vi.fn((): string | null => "This machine can't stop itself when idle."),
      standsInFor: vi.fn(() => false),
      tick: vi.fn(async () => {}),
      revokePending: vi.fn(async () => {}),
      forgetRemoved: vi.fn(),
    };
    const env = await setup({ machine: "running" }, { machineKeys });
    env.lifecycle.start();
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(env.lifecycle.statuses()[0]!.selfStopProblem).toBe(
      "This machine can't stop itself when idle."
    );
    const binding = env.store.bindings()[0]!;
    env.store.putMachineKey({
      id: "mk_1",
      bindingId: binding.id,
      accountId: binding.accountId,
      providerId: "boat",
      resourceId: "bx_23456789",
      name: "daintree-mk_1",
      keyId: "sak_1",
      expiresAt: Date.now() + 86_400_000,
      state: "active",
      createdAt: Date.now(),
    });
    env.hosts.splice(0, env.hosts.length);
    await (
      env.lifecycle as unknown as { dropOrphanBindings(): Promise<void> }
    ).dropOrphanBindings();
    expect(env.store.machineKeys()).toEqual([
      expect.objectContaining({ id: "mk_1", state: "revoke" }),
    ]);
    expect(machineKeys.revokePending).toHaveBeenCalled();
    env.lifecycle.dispose();
  });
});

describe("CloudHostLifecycle background timers (#17795)", () => {
  const HOUR = 60 * 60_000;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function quiet() {
    const machineKeys = {
      problemFor: vi.fn((): string | null => null),
      standsInFor: vi.fn(() => false),
      tick: vi.fn(async () => {}),
      revokePending: vi.fn(async () => {}),
      forgetRemoved: vi.fn(),
    };
    const guestPowerOff = {
      problemFor: vi.fn((): string | null => null),
      standsInFor: vi.fn(() => false),
      arm: vi.fn(async () => {}),
      tick: vi.fn(async () => {}),
      forgetRemoved: vi.fn(),
    };
    const env = await setup({ machine: "running" }, { machineKeys, guestPowerOff });
    return { ...env, machineKeys, guestPowerOff };
  }

  function pendingKey(
    env: Awaited<ReturnType<typeof quiet>>,
    state: "revoke" | "issuing" | "active"
  ) {
    // An issue is recorded before the provider is asked: no key id or expiry yet.
    const issued = state !== "issuing";
    env.store.putMachineKey({
      id: "mk_1",
      bindingId: env.store.bindings()[0]?.id ?? "gone",
      accountId: env.account.id,
      providerId: "boat",
      resourceId: "bx_23456789",
      name: "daintree-mk_1",
      keyId: issued ? "sak_1" : null,
      expiresAt: issued ? Date.now() + 86_400_000 : null,
      state,
      createdAt: Date.now(),
    });
  }

  it("reads nothing and wakes for nothing over an hour with no cloud machine", async () => {
    const env = await quiet();
    env.lifecycle.start();
    await vi.advanceTimersByTimeAsync(0);
    env.backend.get.mockClear();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(vi.getTimerCount()).toBe(0);
    expect(env.backend.get).not.toHaveBeenCalled();
    expect(env.machineKeys.tick).not.toHaveBeenCalled();
    expect(env.guestPowerOff.tick).not.toHaveBeenCalled();
    env.lifecycle.dispose();
  });

  it("starts watching with the first machine and stops once the last one is removed", async () => {
    const env = await quiet();
    env.lifecycle.start();
    const polls = vi.spyOn(env.lifecycle as unknown as { pollDue(): Promise<void> }, "pollDue");
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveBeenCalledTimes(12);
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(1);
    expect(env.guestPowerOff.tick).toHaveBeenCalledTimes(1);

    expect(env.guestPowerOff.forgetRemoved).not.toHaveBeenCalled();
    await env.lifecycle.forgetAccountHosts(env.account.id);
    expect(env.store.bindings()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // No keeper pass comes to forget what was found about the machine.
    expect(env.guestPowerOff.forgetRemoved).toHaveBeenCalledWith([]);
    env.backend.get.mockClear();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(env.backend.get).not.toHaveBeenCalled();
    expect(polls).toHaveBeenCalledTimes(12);
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(1);
    env.lifecycle.dispose();
  });

  it("keeps each pass on schedule while the store is written to", async () => {
    const env = await quiet();
    env.lifecycle.start();
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const polls = vi.spyOn(env.lifecycle as unknown as { pollDue(): Promise<void> }, "pollDue");
    const bindingId = env.store.bindings()[0]!.id;
    // Every 2 seconds, more often than either pass: one restarted by a write would never come.
    for (let second = 0; second < 120; second += 2) {
      env.store.updateBinding(bindingId, (binding) => ({ ...binding }));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(polls).toHaveBeenCalledTimes(24);
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(2);
    env.lifecycle.dispose();
  });

  it("watches only a binding with both its machine and its host", async () => {
    const env = await quiet();
    env.lifecycle.start();
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const { id, hostId, resourceId } = env.store.bindings()[0]!;
    env.store.updateBinding(id, (binding) => ({ ...binding, hostId: null }));
    expect(vi.getTimerCount()).toBe(0);
    // What was found about the machine goes; the binding that stays is kept.
    expect(env.guestPowerOff.forgetRemoved).toHaveBeenCalledWith([
      expect.objectContaining({ id, hostId: null }),
    ]);
    env.store.updateBinding(id, (binding) => ({ ...binding, hostId, resourceId: null }));
    expect(vi.getTimerCount()).toBe(0);
    env.store.updateBinding(id, (binding) => ({ ...binding, resourceId }));
    expect(vi.getTimerCount()).toBe(2);
    env.lifecycle.dispose();
  });

  it("starts the keeper alone when a key is marked for revoking, not for one in use", async () => {
    const env = await quiet();
    env.lifecycle.start();
    pendingKey(env, "active");
    expect(vi.getTimerCount()).toBe(0);
    env.store.updateMachineKey("mk_1", (key) => ({ ...key, state: "revoke" }));
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(1);
    env.lifecycle.dispose();
  });

  it("picks up a key left to revoke that a hand edit restored, once settings reload", async () => {
    const env = await quiet();
    env.lifecycle.start();
    pendingKey(env, "revoke");
    const edited = env.backend.get();
    env.store.removeMachineKey("mk_1");
    expect(vi.getTimerCount()).toBe(0);
    env.backend.set("cloudHosts", edited as CloudHostsValue);
    expect(vi.getTimerCount()).toBe(0);
    env.store.reloaded();
    expect(vi.getTimerCount()).toBe(1);
    env.lifecycle.dispose();
  });

  it("keeps the keeper for a removed machine's key until it is revoked, without polling", async () => {
    const env = await quiet();
    env.lifecycle.start();
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    pendingKey(env, "active");
    await env.lifecycle.forgetAccountHosts(env.account.id);
    expect(env.store.machineKeys()).toEqual([
      expect.objectContaining({ id: "mk_1", state: "revoke" }),
    ]);
    expect(vi.getTimerCount()).toBe(1);
    env.machineKeys.tick.mockClear();
    env.backend.get.mockClear();
    await vi.advanceTimersByTimeAsync(HOUR);
    // Every keeper pass, and not one poll: each of those reads the bindings.
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(60);
    expect(env.backend.get).not.toHaveBeenCalled();

    env.store.removeMachineKey("mk_1");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(env.machineKeys.tick).toHaveBeenCalledTimes(60);
    env.lifecycle.dispose();
  });

  it.each(["revoke", "issuing"] as const)(
    "keeps the keeper for a %s key a previous run left, with no machine left",
    async (state) => {
      const env = await quiet();
      pendingKey(env, state);
      const next = env.restart(env.lifecycle);
      expect(vi.getTimerCount()).toBe(1);
      // An issue left behind becomes the keeper's to look for once it is old enough, with no write to say so.
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(env.machineKeys.tick).toHaveBeenCalledTimes(11);
      next.lifecycle.dispose();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("leaves a pending key to the keys service, and runs no keeper without one", async () => {
    const env = await setup({ machine: "running" });
    env.store.putMachineKey({
      id: "mk_1",
      bindingId: "gone",
      accountId: env.account.id,
      providerId: "boat",
      resourceId: "bx_23456789",
      name: "daintree-mk_1",
      keyId: "sak_1",
      expiresAt: Date.now() + 86_400_000,
      state: "revoke",
      createdAt: Date.now(),
    });
    env.lifecycle.start();
    expect(vi.getTimerCount()).toBe(0);
    env.lifecycle.dispose();
  });

  it("clears its timers on dispose and arms nothing after", async () => {
    const env = await quiet();
    const listeners = (env.store as unknown as { listeners: Set<unknown> }).listeners;
    env.lifecycle.start();
    expect(listeners.size).toBe(1);
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    env.lifecycle.dispose();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    pendingKey(env, "revoke");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("CloudHostLifecycle worktree marks", () => {
  const MARK: CloudHostCreatedFor = {
    hostId: null,
    projectId: "0f1e2d3c",
    worktreeId: "/Users/me/code/app-worktrees/feature-login",
    projectName: "app",
    worktreeName: "feature/login",
    hostName: null,
  };
  const request = (accountId: string): CloudHostCreateRequest => ({
    accountId,
    name: "build",
    machineType: "default",
    lifetimeHours: 2,
  });
  /** A lost answer to a create the provider did act on, when `made`. */
  const loseAnswer = (
    provider: CloudProvider,
    state: { machine: ProviderResource },
    made: boolean
  ) =>
    vi.mocked(provider.create).mockImplementationOnce(async (_c, sent) => {
      if (made) {
        state.machine = resource({
          name: "build-box",
          labels: sent.labels,
          createdAt: new Date().toISOString(),
        });
      }
      throw new BoatApiError("network", "lost", null, null, null);
    });

  it("writes the mark with the create, before the host is added or the provider asked", async () => {
    const { lifecycle, provider, store, state, account, hosts } = await setup();
    const put = vi.spyOn(store, "putBinding");
    const hostsAtWrite: number[] = [];
    put.mockImplementation(function (this: CloudHostStore, binding) {
      hostsAtWrite.push(hosts.length);
      return CloudHostStore.prototype.putBinding.call(this, binding);
    });
    let markedWhenSent: unknown = null;
    vi.mocked(provider.create).mockImplementationOnce(async (_c, sent) => {
      markedWhenSent = store.bindings()[0]?.createdFor;
      state.machine = resource({ name: "build-box", labels: sent.labels });
      return resource({ name: "build-box", machine: "starting", rawState: "provisioning" });
    });
    await lifecycle.create(request(account.id), MARK);
    expect(put.mock.calls[0]?.[0]).toMatchObject({ hostId: null, createdFor: MARK });
    expect(hostsAtWrite[0]).toBe(0);
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalled());
    expect(markedWhenSent).toEqual(MARK);
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.resourceId).toBe("bx_23456789"));
    expect(store.bindings()[0]?.creation).toBeNull();
    expect(lifecycle.statuses()[0]).toMatchObject({ createdFor: MARK, machineName: "build-box" });
  });

  it("adds the host with its worktree waiting, before the provider is asked", async () => {
    const { lifecycle, provider, store, state, account, hosts } = await setup();
    const placement: PendingHostPlacement = {
      projectId: MARK.projectId,
      worktreeId: MARK.worktreeId,
      worktreePath: MARK.worktreeId,
      label: MARK.worktreeName,
      requestedAt: 1_000,
      createdMachine: true,
    };
    let waitingWhenSent: unknown = null;
    vi.mocked(provider.create).mockImplementationOnce(async (_c, sent) => {
      waitingWhenSent = hosts[0]?.pendingPlacement;
      state.machine = resource({ name: "build-box", labels: sent.labels });
      return resource({ name: "build-box", machine: "starting", rawState: "provisioning" });
    });
    const { hostId } = await lifecycle.create(request(account.id), MARK, placement);
    expect(hosts.find((host) => host.id === hostId)?.pendingPlacement).toEqual(placement);
    expect(store.bindings()[0]).toMatchObject({ hostId, createdFor: MARK });
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalled());
    expect(waitingWhenSent).toEqual(placement);
  });

  it("adds no host to wait on when the mark is refused", async () => {
    const { lifecycle, provider, store, account, hosts } = await setup();
    const placement: PendingHostPlacement = {
      projectId: "0f1e2d3c",
      worktreeId: "/w",
      worktreePath: "/w",
      label: "w",
      requestedAt: 1,
      createdMachine: true,
    };
    await expect(
      lifecycle.create(request(account.id), { ...MARK, worktreeName: "" }, placement)
    ).rejects.toThrow(/missing its project or path/);
    expect(hosts).toHaveLength(0);
    expect(store.bindings()).toHaveLength(0);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("keeps the mark through a restart mid-create when the machine turns up", async () => {
    const { lifecycle, provider, state, account, restart } = await setup();
    loseAnswer(provider, state, true);
    await lifecycle.create(request(account.id), MARK);
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
    const next = restart(lifecycle);
    await vi.waitFor(() => expect(next.lifecycle.statuses()[0]?.resourceId).toBe("bx_23456789"));
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      createdFor: MARK,
      machineName: "build-box",
    });
    next.lifecycle.dispose();
  });

  it("keeps the mark through a restart mid-create, and the retry that follows", async () => {
    const { lifecycle, provider, state, account, restart } = await setup();
    loseAnswer(provider, state, false);
    await lifecycle.create(request(account.id), MARK);
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const next = restart(lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.lastError?.message).toMatch(/Setup didn't finish/)
    );
    // Before the machine exists, the name it was asked for stands in.
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: null,
      createdFor: MARK,
      machineName: "build",
    });
    await next.lifecycle.retryCreate("build");
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: "bx_23456789",
      createdFor: MARK,
    });
    next.lifecycle.dispose();
  });

  it("keeps the mark, and the name last reported, through a restart after the machine exists", async () => {
    const { lifecycle, state, account, restart } = await setup();
    await lifecycle.create(request(account.id), MARK);
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    // Renamed on the provider since: the next reading carries the new name.
    state.machine = resource({ name: "renamed-box" });
    await lifecycle.refresh("build");
    expect(lifecycle.statuses()[0]?.machineName).toBe("renamed-box");
    const next = restart(lifecycle);
    expect(next.store.bindings()[0]?.creation).toBeNull();
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      createdFor: MARK,
      machineName: "renamed-box",
    });
    next.lifecycle.dispose();
  });

  it("never marks a machine created from Settings or imported, even with a mark in the request", async () => {
    const { lifecycle, store, account } = await setup();
    await lifecycle.create({ ...request(account.id), createdFor: MARK } as CloudHostCreateRequest);
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    expect(store.bindings()[0]?.createdFor).toBeNull();
    expect(lifecycle.statuses()[0]?.createdFor).toBeNull();

    const other = await setup();
    const put = vi.spyOn(other.store, "putBinding");
    await other.lifecycle.importMachine({
      accountId: other.account.id,
      resourceId: "bx_23456789",
      name: "imported",
      createdFor: MARK,
    } as CloudHostImportRequest);
    // The write itself, not only the reader, leaves the mark out.
    expect(put.mock.calls[0]?.[0]).toMatchObject({ ownership: "imported", createdFor: null });
    expect(other.store.bindings()[0]).toMatchObject({ ownership: "imported", createdFor: null });
    expect(other.lifecycle.statuses()[0]?.createdFor).toBeNull();
  });

  it("refuses a mark missing the worktree's identity, and takes 'local' as this device", async () => {
    const { lifecycle, provider, store, account } = await setup();
    await expect(
      lifecycle.create(request(account.id), { ...MARK, worktreeId: "" })
    ).rejects.toThrow(/missing its project or path/);
    expect(store.bindings()).toEqual([]);
    expect(provider.create).not.toHaveBeenCalled();

    await lifecycle.create(request(account.id), { ...MARK, hostId: "local", hostName: "Local" });
    expect(store.bindings()[0]?.createdFor).toEqual(MARK);
  });

  it("drops a marked machine's binding with its host, leaving the machine alone", async () => {
    const { lifecycle, provider, store, hosts, account } = await setup();
    lifecycle.start();
    await lifecycle.create(request(account.id), MARK);
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    hosts.splice(0, 1);
    await (lifecycle as unknown as { dropOrphanBindings(): Promise<void> }).dropOrphanBindings();
    expect(store.bindings()).toEqual([]);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    lifecycle.dispose();
  });
});

/** What an EC2-shaped provider takes: a region and an image always, a subnet when asked. */
const TAKES: CloudProvisioning = {
  location: "required",
  image: "required",
  network: "optional",
  sshKey: "at-create",
};

function offered(): NonNullable<ProviderCatalog["provisioning"]> {
  const choice = (id: string, label: string, locations: string[] | null = null) => ({
    id,
    label,
    description: null,
    available: true,
    reason: null,
    locations,
  });
  return {
    location: {
      label: "Region",
      defaultId: "us-east-1",
      choices: [
        choice("us-east-1", "US East (N. Virginia)"),
        choice("eu-west-1", "Europe (Ireland)"),
        { ...choice("ap-south-2", "Asia Pacific (Hyderabad)"), available: false, reason: "opt-in" },
      ],
    },
    image: {
      label: "AMI",
      defaultId: null,
      choices: [
        choice("ami-use1", "Ubuntu 24.04", ["us-east-1"]),
        choice("ami-euw1", "Ubuntu 24.04", ["eu-west-1"]),
        choice("ami-any", "Debian 12"),
      ],
    },
    network: {
      label: "Subnet",
      defaultId: null,
      choices: [choice("subnet-euw1a", "eu-west-1a", ["eu-west-1"])],
    },
  };
}

function offerRegions(provider: CloudProvider, takes: () => CloudProvisioning = () => TAKES): void {
  const info = provider.info.bind(provider);
  provider.info = (platform) => {
    const base = info(platform);
    return { ...base, capabilities: { ...base.capabilities, provisioning: takes() } };
  };
  const catalog = provider.catalog;
  provider.catalog = vi.fn(async (credentials) => ({
    ...(await catalog(credentials)),
    provisioning: offered(),
  }));
}

describe("CloudHostLifecycle provisioning", () => {
  const IRELAND = { location: "eu-west-1", image: "ami-euw1", network: "subnet-euw1a" };

  function request(accountId: string, name = "build"): CloudHostCreateRequest {
    return { accountId, name, machineType: "default", lifetimeHours: 2, provisioning: IRELAND };
  }

  it("sends the region, image and subnet it checked, in the first write, and shows them on the host", async () => {
    const { lifecycle, provider, account, store } = await setup({}, { adapt: offerRegions });
    const put = vi.spyOn(store, "putBinding");
    await lifecycle.create(request(account.id));
    const picks = {
      location: { label: "Region", id: "eu-west-1", value: "Europe (Ireland)" },
      image: { label: "AMI", id: "ami-euw1", value: "Ubuntu 24.04" },
      network: { label: "Subnet", id: "subnet-euw1a", value: "eu-west-1a" },
    };
    // Kept from the first write, so a restart before the host is added still knows them.
    expect(put.mock.calls[0]?.[0]).toMatchObject({ hostId: null, provisioning: picks });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.machine).toBe("running"));
    expect(vi.mocked(provider.create).mock.calls[0]?.[1].provisioning).toEqual(IRELAND);
    expect(lifecycle.statuses()[0]?.provisioning).toEqual(picks);
    expect(store.account(account.id)?.lastProvisioning).toEqual(IRELAND);
  });

  it("looks for an unanswered create's machine where it was sent", async () => {
    const { lifecycle, provider, account, store } = await setup({}, { adapt: offerRegions });
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const bindingId = store.bindings()[0]!.id;
    vi.mocked(provider.list).mockResolvedValueOnce([
      resource({
        resourceId: "bx_found0000",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
    ]);
    await lifecycle.retryCreate("build");
    expect(provider.list).toHaveBeenCalledWith(expect.anything(), {
      label: `daintree-binding=${bindingId}`,
      location: "eu-west-1",
    });
    expect(store.bindings()[0]!.resourceId).toBe("bx_found0000");
  });

  it("offers the account's last choice with every catalog, cached or read again", async () => {
    const { lifecycle, provider, account, accounts } = await setup({}, { adapt: offerRegions });
    expect((await accounts.catalog(account.id)).lastChoice).toBeNull();
    await lifecycle.create(request(account.id));
    const reads = vi.mocked(provider.catalog).mock.calls.length;
    const cached = await accounts.catalog(account.id);
    expect(provider.catalog).toHaveBeenCalledTimes(reads);
    expect(cached.lastChoice).toEqual(IRELAND);
    expect(cached.provisioning.location?.defaultId).toBe("us-east-1");
    expect((await accounts.catalog(account.id, { refresh: true })).lastChoice).toEqual(IRELAND);
    // The create goes on in the background, making the account's SSH key.
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
  });

  it("refuses a missing region, an unavailable one, or an image from another region before anything is sent", async () => {
    const { lifecycle, provider, account, store, hosts } = await setup({}, { adapt: offerRegions });
    const attempts: CloudHostCreateRequest["provisioning"][] = [
      undefined,
      { location: null, image: "ami-use1", network: null },
      { location: "ap-south-2", image: "ami-any", network: null },
      { location: "us-east-1", image: "ami-euw1", network: null },
      { location: "us-east-1", image: "ami-use1", network: "subnet-euw1a" },
      { location: "us-east-1", image: "ami-gone", network: null },
    ];
    for (const provisioning of attempts) {
      await expect(
        lifecycle.create({ ...request(account.id), provisioning })
      ).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(provider.create).not.toHaveBeenCalled();
    expect(store.bindings()).toEqual([]);
    expect(hosts).toEqual([]);
    expect(store.account(account.id)?.lastProvisioning).toBeNull();
  });

  it("refuses a region for a provider that takes none, and leaves Boat's hosts without any", async () => {
    const { lifecycle, provider, account, store } = await setup();
    await expect(
      lifecycle.create({ ...request(account.id), provisioning: IRELAND })
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await lifecycle.create({ ...request(account.id), provisioning: undefined });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.machine).toBe("running"));
    expect(vi.mocked(provider.create).mock.calls[0]?.[1].provisioning).toEqual({
      location: null,
      image: null,
      network: null,
    });
    expect(lifecycle.statuses()[0]?.provisioning).toBeNull();
    expect(store.account(account.id)?.lastProvisioning).toBeNull();
  });

  it("retries a create after a restart with the choice it was made with, not the account's latest", async () => {
    const { lifecycle, provider, account, store, restart } = await setup(
      {},
      { adapt: offerRegions }
    );
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("network", "lost", null, null, null)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown")
    );
    // A later create in another region moves what the account remembers.
    const VIRGINIA = { location: "us-east-1", image: "ami-use1", network: null };
    await lifecycle.create({ ...request(account.id, "other"), provisioning: VIRGINIA });
    await vi.waitFor(() =>
      expect(lifecycle.statuses().find((s) => s.hostId === "other")?.machine).toBe("running")
    );
    expect(store.account(account.id)?.lastProvisioning).toEqual(VIRGINIA);
    expect(lifecycle.statuses().find((s) => s.hostId === "other")?.provisioning?.network).toEqual({
      label: "Subnet",
      id: null,
      value: "Chosen by Boat",
    });

    const next = restart(lifecycle);
    // Every machine this fake makes has one id; the replay answers with this host's own.
    vi.mocked(provider.create).mockResolvedValueOnce(
      resource({ resourceId: "bx_build0001", machine: "starting", rawState: "provisioning" })
    );
    await next.lifecycle.retryCreate("build");
    const calls = vi.mocked(provider.create).mock.calls;
    const first = calls[0]![1];
    const retried = calls[calls.length - 1]![1];
    expect(retried.provisioning).toEqual(IRELAND);
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(
      next.lifecycle.statuses().find((s) => s.hostId === "build")?.provisioning?.location
    ).toEqual({ label: "Region", id: "eu-west-1", value: "Europe (Ireland)" });
    expect(next.store.account(account.id)?.lastProvisioning).toEqual(VIRGINIA);
    expect(next.store.bindings().find((b) => b.hostId === "build")?.resourceId).toBe(
      "bx_build0001"
    );
  });

  it("won't send a retry whose saved choice can't be read back, even where nothing is required", async () => {
    const optional: CloudProvisioning = {
      location: "optional",
      image: "optional",
      network: "optional",
      sshKey: "at-create",
    };
    const { lifecycle, provider, account, store } = await setup(
      {},
      { adapt: (p) => offerRegions(p, () => optional) }
    );
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("payment-required", "pay", 402, null, null)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.lastError?.code).toBe("billing"));
    const binding = store.bindings()[0]!;
    store.putBinding({ ...binding, provisioning: { location: 5 } as never });
    store.updateBinding(binding.id, (current) => ({ ...current, intent: "run" }));
    expect(store.bindings()[0]?.provisioning).toBe("unreadable");
    await expect(lifecycle.retryCreate("build")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]?.lastError?.message).toMatch(/can't read back/);
  });

  it("won't send a retry the provider now needs a region for that its create never named", async () => {
    let takes: CloudProvisioning = {
      location: "none",
      image: "none",
      network: "none",
      sshKey: "after-create",
    };
    const { lifecycle, provider, account } = await setup(
      {},
      { adapt: (p) => offerRegions(p, () => takes) }
    );
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("payment-required", "pay", 402, null, null)
    );
    await lifecycle.create({ ...request(account.id), provisioning: undefined });
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.lastError?.code).toBe("billing"));
    takes = TAKES;
    await expect(lifecycle.retryCreate("build")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]?.lastError?.message).toMatch(/never named/);
  });
});

describe("CloudHostLifecycle.deleteMachine by the provider's declaration (#17346)", () => {
  function withoutDeletion(provider: CloudProvider): void {
    const declared = provider.info.bind(provider);
    provider.info = (platform) => {
      const info = declared(platform);
      return { ...info, capabilities: { ...info.capabilities, deletion: false } };
    };
  }

  it("refuses a confirmed machine before touching the link, the provider or the host", async () => {
    const { lifecycle, provider, store, hosts, disconnect } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    withoutDeletion(provider);
    disconnect.mockClear();
    await expect(lifecycle.deleteMachine("build", "bx_23456789")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      userMessage: "Daintree can't delete machines on Boat. Delete it in Boat's console.",
    });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
    expect(store.bindings()[0]!.resourceId).toBe("bx_23456789");
  });

  it("leaves an operation under way running when it refuses", async () => {
    const { lifecycle, provider, store, state } = await setup({ machine: "stopped" });
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    let release: () => void = () => {};
    vi.mocked(provider.inspect).mockImplementation(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return state.machine;
    });
    const starting = lifecycle.startMachine("build");
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation?.kind).toBe("starting"));
    withoutDeletion(provider);
    await expect(lifecycle.deleteMachine("build", "bx_23456789")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(lifecycle.statuses()[0]?.operation?.kind).toBe("starting");
    vi.mocked(provider.inspect).mockImplementation(async () => state.machine);
    release();
    await starting.catch(() => {});
  });

  it("asks again before the delete itself, so a provider replaced meanwhile isn't asked", async () => {
    const { lifecycle, provider, store, hosts, disconnect } = await setup();
    await lifecycle.importMachine({
      accountId: store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    // Revoked after the first check, while the link is let go.
    disconnect.mockImplementationOnce(async () => withoutDeletion(provider));
    await expect(lifecycle.deleteMachine("build", "bx_23456789")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(provider.delete).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
  });

  it("refuses an unanswered create's host without looking for its machine", async () => {
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
    withoutDeletion(provider);
    vi.mocked(provider.list).mockClear();
    await expect(lifecycle.deleteMachine("build", null)).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
  });
});

describe("CloudHostLifecycle SSH key at create", () => {
  const request = (accountId: string): CloudHostCreateRequest => ({
    accountId,
    name: "build",
    machineType: "default",
    lifetimeHours: 2,
  });

  it("hands a create-time-key provider the account's key with every create, a retry included", async () => {
    const { lifecycle, provider, files, account } = await setup({}, { sshKey: "at-create" });
    vi.mocked(provider.create)
      .mockRejectedValueOnce(new BoatApiError("timeout", "slow", null, null, null))
      .mockRejectedValueOnce(new BoatApiError("payment-required", "pay", 402, null, null));
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    await lifecycle.retryCreate("build").catch(() => {});
    await lifecycle.retryCreate("build");
    const accountKey = await files.publicKey(account.id);
    expect(accountKey).toMatch(/^ssh-ed25519 /);
    const sent = vi.mocked(provider.create).mock.calls.map(([, sentRequest]) => sentRequest);
    expect(sent).toHaveLength(3);
    for (const each of sent) expect(each.publicKey).toBe(accountKey);
    // The lost create's retry is the same request; the refused one's gets a fresh idempotency key only.
    expect(sent[1]!.idempotencyKey).toBe(sent[0]!.idempotencyKey);
    expect(sent[2]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
  });

  it("puts the key on an imported machine through a create-time-key provider that can (#17347)", async () => {
    const { lifecycle, provider, store, files, account } = await setup(
      { machine: "running" },
      { sshKey: "at-create" }
    );
    await lifecycle.importMachine({
      accountId: account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const readKey = vi.spyOn(files, "publicKey");
    await lifecycle.ensureAccess(store.bindings()[0]!.id);
    // It never took the key with a create: the key is read and authorized, not assumed.
    expect(readKey).toHaveBeenCalledWith(account.id);
    expect(provider.authorizeSsh).toHaveBeenCalledWith(
      expect.anything(),
      "bx_23456789",
      await readKey.mock.results[0]!.value
    );
    expect(provider.sshAccess).not.toHaveBeenCalled();
  });

  it("assumes an imported machine holds the key when the provider can't put it there", async () => {
    const { lifecycle, provider, store, account } = await setup(
      { machine: "running" },
      { sshKey: "at-create" }
    );
    delete (provider as { authorizeSsh?: unknown }).authorizeSsh;
    await lifecycle.importMachine({
      accountId: account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    await lifecycle.ensureAccess(store.bindings()[0]!.id);
    expect(provider.sshAccess).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
  });

  /** The commands the fake runner was asked to run, by name. */
  const ran = (run: { mock: { calls: unknown[][] } }) => run.mock.calls.map(([cmd]) => cmd);

  it("reaches a machine that took its key at create without authorizing a key", async () => {
    const { lifecycle, provider, store, run, account } = await setup({}, { sshKey: "at-create" });
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    const bindingId = store.bindings()[0]!.id;
    run.mockClear();
    const route = await lifecycle.ensureAccess(bindingId);
    const config = await fs.readFile(route.configPath, "utf8");
    expect(config).toContain("HostName 203.0.113.10");
    expect(provider.sshAccess).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    // The key on disk is only read, to see it is still the one the machine took.
    expect(ran(run)).not.toContain("ssh-keygen");
    // The identity the route dials with is the key the create handed over.
    const identity = /IdentityFile "(.+)"/.exec(config)![1]!;
    expect((await fs.readFile(`${identity}.pub`, "utf8")).trim()).toBe(
      vi.mocked(provider.create).mock.calls[0]![1].publicKey
    );
  });

  /** A created, running machine reached once, so a route to it is on disk and cached. */
  const createdAndReached = async (options: Parameters<typeof setup>[1] = {}) => {
    const harness = await setup({}, { sshKey: "at-create", ...options });
    await harness.lifecycle.create(request(harness.account.id));
    await vi.waitFor(() =>
      expect(harness.lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    const bindingId = harness.store.bindings()[0]!.id;
    const route = await harness.lifecycle.ensureAccess(bindingId);
    const keyPath = /IdentityFile "(.+)"/.exec(await fs.readFile(route.configPath, "utf8"))![1]!;
    const createKey = vi.mocked(harness.provider.create).mock.calls[0]![1].publicKey!;
    vi.mocked(harness.provider.sshAccess).mockClear();
    harness.run.mockClear();
    return { ...harness, bindingId, keyPath, createKey };
  };

  const LOST = [
    ["both key files", ["", ".pub"]],
    ["the private key", [""]],
  ] as const;

  /** What is left of the public half once `suffixes` were removed: gone, or the create's key. */
  const leftPublicHalf = async (keyPath: string, suffixes: readonly string[]) =>
    suffixes.includes(".pub")
      ? expect(fs.access(`${keyPath}.pub`)).rejects.toMatchObject({ code: "ENOENT" })
      : expect(fs.readFile(`${keyPath}.pub`, "utf8")).resolves.toBeTruthy();

  it.each(LOST)(
    "makes and registers a new key for a created machine that lost %s (#17929)",
    async (_lost, suffixes) => {
      const { lifecycle, provider, bindingId, keyPath, createKey } = await createdAndReached();
      for (const suffix of suffixes) await fs.rm(`${keyPath}${suffix}`);
      await leftPublicHalf(keyPath, suffixes);
      // The new key is still on its way to the machine: the provider's wait is the answer.
      const delivering = new BoatApiError("network", "lost", null, null, null);
      vi.mocked(provider.authorizeSsh).mockRejectedValueOnce(delivering);
      const waiting = await lifecycle.ensureAccess(bindingId).catch((error: unknown) => error);
      expect(waiting).toBeInstanceOf(TransportError);
      expect(waiting).not.toBeInstanceOf(UnusableConnectionError);
      expect((waiting as TransportError).detail).toBe(provider.describeError(delivering).message);
      // A wait, not a refusal: nothing parks the host.
      expect(lifecycle.statuses()[0]?.lastError).toBeNull();
      const madeKey = (await fs.readFile(`${keyPath}.pub`, "utf8")).trim();
      expect(madeKey).toMatch(/^ssh-ed25519 /);
      expect(madeKey).not.toBe(createKey);
      expect(provider.authorizeSsh).toHaveBeenLastCalledWith(
        expect.anything(),
        "bx_23456789",
        madeKey
      );
      // The key is on disk again, but the machine still predates it: the retry waits on the provider too.
      await lifecycle.ensureAccess(bindingId);
      expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
      expect(provider.authorizeSsh).toHaveBeenLastCalledWith(
        expect.anything(),
        "bx_23456789",
        madeKey
      );
      expect(provider.sshAccess).not.toHaveBeenCalled();
      expect((await fs.readFile(`${keyPath}.pub`, "utf8")).trim()).toBe(madeKey);
      expect(lifecycle.statuses()[0]?.lastError).toBeNull();
      // Once the machine holds it, the route is reused without asking again.
      await lifecycle.ensureAccess(bindingId);
      expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
    }
  );

  it.each(LOST)(
    "says the host's key is missing, and makes none, when the provider can't give a created machine another after it lost %s (#17929)",
    async (_lost, suffixes) => {
      let clock = 1_000_000;
      const { lifecycle, provider, store, run, bindingId, keyPath } = await createdAndReached({
        now: () => clock,
      });
      delete (provider as { authorizeSsh?: unknown }).authorizeSsh;
      for (const suffix of suffixes) await fs.rm(`${keyPath}${suffix}`);
      const error = await lifecycle.ensureAccess(bindingId).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnusableConnectionError);
      expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
        code: "ssh-authorization",
        message: expect.stringMatching(/SSH key is missing/),
      });
      expect((error as UnusableConnectionError).detail).toBe(
        lifecycle.statuses()[0]?.lastError?.message
      );
      expect(provider.sshAccess).not.toHaveBeenCalled();
      expect(ran(run)).not.toContain("ssh-keygen");
      await expect(fs.access(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
      await leftPublicHalf(keyPath, suffixes);
      // Dialled again later, the same refusal is kept as it was, not written again.
      const recorded = store.bindings()[0]!.lastError;
      clock += 1_000;
      await expect(lifecycle.ensureAccess(bindingId)).rejects.toBeInstanceOf(
        UnusableConnectionError
      );
      expect(store.bindings()[0]!.lastError).toEqual(recorded);
    }
  );

  it("reaches a created machine whose key is intact through a provider that can't give it another", async () => {
    const { lifecycle, provider, run, bindingId } = await createdAndReached();
    delete (provider as { authorizeSsh?: unknown }).authorizeSsh;
    await lifecycle.ensureAccess(bindingId, undefined, { fresh: true });
    expect(provider.sshAccess).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
    expect(lifecycle.statuses()[0]?.lastError).toBeNull();
    expect(ran(run)).not.toContain("ssh-keygen");
  });

  it("puts a key made since on a created machine that holds an older one, before reusing its route (#17929)", async () => {
    const { lifecycle, provider, files, account, bindingId, keyPath, createKey } =
      await createdAndReached();
    // Something else on the account (another create, an import's dial) made the key again.
    await fs.rm(keyPath);
    const remade = await files.publicKey(account.id);
    expect(remade).not.toBe(createKey);
    const authorize = vi.mocked(provider.authorizeSsh).getMockImplementation()!;
    let release: () => void = () => {};
    vi.mocked(provider.authorizeSsh).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => (release = resolve));
      return authorize(...args);
    });
    let settled = false;
    const dial = lifecycle.ensureAccess(bindingId).finally(() => (settled = true));
    await vi.waitFor(() => expect(provider.authorizeSsh).toHaveBeenCalled());
    // The cached route waits on the key reaching the machine; it isn't handed out meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    release();
    await dial;
    expect(provider.authorizeSsh).toHaveBeenCalledWith(expect.anything(), "bx_23456789", remade);
    expect(provider.sshAccess).not.toHaveBeenCalled();
    // Once it holds the key, the route is reused again without asking the provider.
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    expect(provider.sshAccess).not.toHaveBeenCalled();
  });

  it("makes no key for a created host removed while its dial waited (#17929)", async () => {
    // The dial waits on the tunnel's command while the host and its account go.
    let held: Promise<void> | null = null;
    const findCommand = vi.fn(async () => {
      await held;
      return "/opt/acme/bin/acme";
    });
    const { lifecycle, provider, store, run, files, account, bindingId, keyPath } =
      await createdAndReached({ transport: "provider-command", findCommand });
    await fs.rm(keyPath);
    await fs.rm(`${keyPath}.pub`);
    let release: () => void = () => {};
    held = new Promise<void>((resolve) => (release = resolve));
    findCommand.mockClear();
    const dial = lifecycle.ensureAccess(bindingId).catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(findCommand).toHaveBeenCalled());
    store.removeBinding(bindingId);
    await files.forgetAccount(account.id);
    release();
    expect(await dial).toBeInstanceOf(UnusableConnectionError);
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(ran(run)).not.toContain("ssh-keygen");
    expect(await files.hasKey(account.id)).toBe(false);
  });

  it("authorizes nothing for a created host removed while its key was read (#17929)", async () => {
    const { lifecycle, provider, store, files, bindingId, keyPath } = await createdAndReached();
    await fs.rm(keyPath);
    const make = files.publicKey.bind(files);
    vi.spyOn(files, "publicKey").mockImplementationOnce(async (accountId) => {
      store.removeBinding(bindingId);
      return make(accountId);
    });
    const error = await lifecycle.ensureAccess(bindingId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
  });

  it("puts the key on again when its route couldn't be written after it was put on (#17929)", async () => {
    const { lifecycle, provider, files, bindingId, keyPath } = await createdAndReached();
    await fs.rm(keyPath);
    vi.spyOn(files, "write").mockRejectedValueOnce(new Error("disk full"));
    await expect(lifecycle.ensureAccess(bindingId)).rejects.toThrow("disk full");
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    // Nothing vouches for the route on disk: the next dial bypasses it and asks again.
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
    await lifecycle.ensureAccess(bindingId);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(2);
  });

  it("puts the key on a created machine once after a restart, which can't know what it holds (#17929)", async () => {
    const { lifecycle, provider, store, run, bindingId, createKey, restart } =
      await createdAndReached();
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(store.bindings()[0]!.access).not.toBeNull();
    const next = restart(lifecycle);
    try {
      expect(next.store.bindings()[0]!.access).not.toBeNull();
      await next.lifecycle.ensureAccess(bindingId);
      expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
      expect(provider.authorizeSsh).toHaveBeenCalledWith(
        expect.anything(),
        "bx_23456789",
        createKey
      );
      await next.lifecycle.ensureAccess(bindingId, undefined, { fresh: true });
      expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
      expect(provider.sshAccess).toHaveBeenCalledTimes(1);
      expect(ran(run)).not.toContain("ssh-keygen");
    } finally {
      next.lifecycle.dispose();
    }
  });

  it("keeps the key a created machine took when only its public half is gone (#17929)", async () => {
    const { lifecycle, provider, bindingId, keyPath, createKey } = await createdAndReached();
    const privateKey = await fs.readFile(keyPath, "utf8");
    await fs.rm(`${keyPath}.pub`);
    const route = await lifecycle.ensureAccess(bindingId, undefined, { fresh: true });
    expect(provider.sshAccess).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(await fs.readFile(route.configPath, "utf8")).toContain(`IdentityFile "${keyPath}"`);
    expect(await fs.readFile(keyPath, "utf8")).toBe(privateKey);
    // The dial got the public half back from the private one; no new key replaced it.
    expect((await fs.readFile(`${keyPath}.pub`, "utf8")).trim()).toBe(createKey);
  });

  it("sends nothing when the account's key can't be made, and says why", async () => {
    const { lifecycle, provider, store, run, account } = await setup({}, { sshKey: "at-create" });
    run.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "ssh-keygen: not found",
      spawnError: null,
      timedOut: false,
    });
    await lifecycle.create(request(account.id));
    const idempotencyKey = store.bindings()[0]!.creation!.idempotencyKey;
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.lastError).not.toBeNull());
    expect(provider.create).not.toHaveBeenCalled();
    expect(store.bindings()[0]!.creation).toMatchObject({ sentAt: null, idempotencyKey });
    expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "ssh-authorization",
      message: expect.stringContaining("ssh-keygen: not found"),
    });

    // Once the key can be made, Retry sends the create it never sent, under the same idempotency key.
    await lifecycle.retryCreate("build");
    expect(vi.mocked(provider.create).mock.calls[0]![1]).toMatchObject({
      idempotencyKey,
      publicKey: expect.stringMatching(/^ssh-ed25519 /),
    });
    expect(lifecycle.statuses()[0]).toMatchObject({ resourceId: "bx_23456789", lastError: null });
  });

  it("leaves an after-create provider's create keyless and authorizes the key once the machine exists", async () => {
    const { lifecycle, provider, store, files, run, account } = await setup();
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    expect(vi.mocked(provider.create).mock.calls[0]![1].publicKey).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    await lifecycle.ensureAccess(store.bindings()[0]!.id);
    expect(provider.authorizeSsh).toHaveBeenCalledWith(
      expect.anything(),
      "bx_23456789",
      await files.publicKey(account.id)
    );
    expect(provider.sshAccess).not.toHaveBeenCalled();
  });

  it("keeps an earlier unanswered create in doubt when the key can't be made for its retry", async () => {
    const { lifecycle, provider, store, files, account } = await setup({}, { sshKey: "at-create" });
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
    const sent = store.bindings()[0]!.creation!;
    vi.spyOn(files, "publicKey").mockRejectedValueOnce(new Error("disk full"));
    await expect(lifecycle.retryCreate("build")).rejects.toThrow("disk full");
    expect(provider.list).toHaveBeenCalled();
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(store.bindings()[0]!.creation).toEqual(sent);
    expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("earlier request"),
    });
  });

  it("asks nobody for a machine when the provider was replaced while the key was made", async () => {
    const { lifecycle, provider, accounts, files, account } = await setup(
      {},
      { sshKey: "at-create" }
    );
    const make = files.publicKey.bind(files);
    vi.spyOn(files, "publicKey").mockImplementationOnce(async (accountId) => {
      vi.spyOn(accounts, "provider").mockReturnValue({ ...provider });
      return make(accountId);
    });
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("replaced"),
      })
    );
    expect(provider.create).not.toHaveBeenCalled();
  });

  it("keeps an earlier unanswered create in doubt when the provider is replaced during its retry", async () => {
    const { lifecycle, provider, store, accounts, files, account } = await setup(
      {},
      { sshKey: "at-create" }
    );
    vi.mocked(provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    const sent = store.bindings()[0]!.creation!;
    const make = files.publicKey.bind(files);
    vi.spyOn(files, "publicKey").mockImplementationOnce(async (accountId) => {
      vi.spyOn(accounts, "provider").mockReturnValue({ ...provider });
      return make(accountId);
    });
    await expect(lifecycle.retryCreate("build")).rejects.toThrow("replaced");
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(store.bindings()[0]!.creation).toEqual(sent);
    expect(lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown");
  });

  it("offers Retry for a create Daintree quit before sending", async () => {
    const { lifecycle, provider, files, account, restart } = await setup(
      {},
      { sshKey: "at-create" }
    );
    vi.spyOn(files, "publicKey").mockReturnValueOnce(new Promise<string>(() => {}));
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(files.publicKey).toHaveBeenCalled());
    const next = restart(lifecycle);
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: null,
      operation: null,
      lastError: { code: "failed" },
    });
    await next.lifecycle.retryCreate("build");
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(next.lifecycle.statuses()[0]).toMatchObject({ resourceId: "bx_23456789" });
    next.lifecycle.dispose();
  });

  it("says to recreate a host Daintree quit before sending whose choices can't be read back", async () => {
    const { lifecycle, store, files, account, restart } = await setup({}, { sshKey: "at-create" });
    vi.spyOn(files, "publicKey").mockReturnValueOnce(new Promise<string>(() => {}));
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(files.publicKey).toHaveBeenCalled());
    store.putBinding({ ...store.bindings()[0]!, provisioning: { location: 5 } as never });
    const next = restart(lifecycle);
    expect(next.lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "failed",
      message: expect.stringContaining("Remove the host and create it again"),
    });
    next.lifecycle.dispose();
  });

  it("refuses access when the provider declares a key timing it doesn't know", async () => {
    const { lifecycle, provider, store, account } = await setup(
      {},
      {
        sshKey: "on-boot" as "at-create",
      }
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() =>
      expect(lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    await expect(lifecycle.ensureAccess(store.bindings()[0]!.id)).rejects.toBeInstanceOf(
      UnusableConnectionError
    );
    expect(lifecycle.statuses()[0]?.lastError?.message).toContain("unknown SSH key timing");
    expect(provider.authorizeSsh).not.toHaveBeenCalled();
    expect(provider.sshAccess).not.toHaveBeenCalled();
  });

  it("takes a create the provider couldn't make as asked for a refusal, keeping its words", async () => {
    const { lifecycle, provider, account } = await setup({}, { sshKey: "at-create" });
    const refusal = new Error("no network there");
    vi.mocked(provider.create).mockRejectedValueOnce(refusal);
    const describe = provider.describeError.bind(provider);
    vi.spyOn(provider, "describeError").mockImplementation((error) =>
      error === refusal
        ? { code: "unsupported", message: "us-east-2 has no default VPC.", at: Date.now() }
        : describe(error)
    );
    await lifecycle.create(request(account.id));
    await vi.waitFor(() => expect(lifecycle.statuses()[0]?.operation).toBeNull());
    expect(lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "unsupported",
      message: "us-east-2 has no default VPC.",
    });
    await lifecycle.retryCreate("build");
    const sent = vi.mocked(provider.create).mock.calls.map(([, sentRequest]) => sentRequest);
    // Nothing was made, so its retry is a new create.
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  });
});

describe("CloudHostLifecycle stale inspections (#17548)", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  async function host(machine: Partial<ProviderResource>) {
    let clock = 1_000_000;
    const env = await setup(machine, { now: () => clock });
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = env.store.bindings()[0]!.id;
    const tick = (ms: number) => {
      clock += ms;
    };
    // The next read is held until the test answers it.
    const holdNextInspect = () => {
      const held = deferred<ProviderResource>();
      vi.mocked(env.provider.inspect)
        .mockClear()
        .mockImplementationOnce(() => held.promise);
      return held;
    };
    const pollDue = () => (env.lifecycle as unknown as { pollDue(): Promise<void> }).pollDue();
    return { ...env, bindingId, tick, holdNextInspect, pollDue };
  }

  it("keeps a start's running state and access over a refresh that was sent before it", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    const held = holdNextInspect();
    const refreshing = lifecycle.refresh("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.startMachine("build");
    tick(1_000);
    await lifecycle.ensureAccess(bindingId);
    const newer = store.binding(bindingId)!;
    expect(newer.observation?.machine).toBe("running");
    expect(newer.access).not.toBeNull();

    tick(1_000);
    held.resolve(resource({ machine: "stopped", rawState: "archived" }));
    await refreshing;
    const after = store.binding(bindingId)!;
    expect(after.observation).toEqual(newer.observation);
    expect(after.access).toEqual(newer.access);
    expect(lifecycle.statuses()[0]!.machine).toBe("running");
  });

  it("ignores a not-found from a poll that was sent before a start", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect, pollDue } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    tick(60 * 60_000);
    const held = holdNextInspect();
    const polling = pollDue();
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.startMachine("build");
    tick(1_000);
    await lifecycle.ensureAccess(bindingId);
    const newer = store.binding(bindingId)!;

    tick(1_000);
    held.reject(new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null));
    await polling;
    const after = store.binding(bindingId)!;
    expect(after.observation).toEqual(newer.observation);
    expect(after.access).toEqual(newer.access);
    expect(after.lastError).toBeNull();
    expect(lifecycle.statuses()[0]!.machine).toBe("running");
  });

  it("keeps a stop's stopped state over a poll that was sent before it", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect, pollDue } = await host({
      machine: "running",
    });
    tick(60 * 60_000);
    const held = holdNextInspect();
    const polling = pollDue();
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.stopMachine("build");
    const newer = store.binding(bindingId)!;
    expect(newer.observation?.machine).toBe("stopped");

    tick(1_000);
    held.resolve(resource({ machine: "running" }));
    await polling;
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    expect(lifecycle.statuses()[0]!.machine).toBe("stopped");
  });

  it("resolves a refresh quietly when its not-found was overtaken by a start", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    const held = holdNextInspect();
    const refreshing = lifecycle.refresh("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.startMachine("build");
    const newer = store.binding(bindingId)!;

    tick(1_000);
    held.reject(new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null));
    await expect(refreshing).resolves.toBeUndefined();
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    expect(store.binding(bindingId)!.lastError).toBeNull();
  });

  it("keeps a newer not-found over an older read that answers after it", async () => {
    const { lifecycle, provider, store, bindingId, tick, pollDue } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    tick(60 * 60_000);
    const older = deferred<ProviderResource>();
    vi.mocked(provider.inspect)
      .mockClear()
      .mockImplementationOnce(() => older.promise)
      .mockRejectedValueOnce(
        new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null)
      );
    const polling = pollDue();
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await expect(lifecycle.refresh("build")).rejects.toBeTruthy();
    const newer = store.binding(bindingId)!;
    expect(newer.observation?.machine).toBe("unknown");

    tick(1_000);
    older.resolve(resource({ machine: "stopped", rawState: "archived" }));
    await polling;
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    expect(store.binding(bindingId)!.lastError?.code).toBe("not-found");
  });

  it("takes both reads when they answer in the order they were sent", async () => {
    const { lifecycle, provider, store, bindingId, tick, pollDue } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    tick(60 * 60_000);
    const first = deferred<ProviderResource>();
    const second = deferred<ProviderResource>();
    vi.mocked(provider.inspect)
      .mockClear()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const polling = pollDue();
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    const refreshing = lifecycle.refresh("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(2));

    tick(1_000);
    first.resolve(resource({ machine: "stopped", rawState: "archived" }));
    await polling;
    expect(store.binding(bindingId)!.observation).toMatchObject({
      machine: "stopped",
      observedAt: 1_000_000 + 60 * 60_000 + 1_000,
    });
    tick(1_000);
    second.resolve(resource({ machine: "running" }));
    await refreshing;
    expect(store.binding(bindingId)!.observation).toMatchObject({
      machine: "running",
      observedAt: 1_000_000 + 60 * 60_000 + 2_000,
    });
  });

  it("dials on the newer observation when the dial's own read was overtaken", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    tick(60 * 60_000);
    const held = holdNextInspect();
    vi.mocked(provider.inspect).mockResolvedValueOnce(resource({ machine: "running" }));
    const dialing = lifecycle.ensureAccess(bindingId);
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.refresh("build");
    expect(store.binding(bindingId)!.observation?.machine).toBe("running");

    held.reject(new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null));
    const route = await dialing;
    expect(route.target).toBe(`dtc-${bindingId}`);
    expect(provider.authorizeSsh).toHaveBeenCalledTimes(1);
    expect(store.binding(bindingId)!.lastError).toBeNull();
  });

  it("asks again before starting when the start's own read was overtaken", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    const preflight = holdNextInspect();
    const again = deferred<ProviderResource>();
    vi.mocked(provider.inspect)
      .mockResolvedValueOnce(resource({ machine: "stopped", rawState: "archived" }))
      .mockImplementationOnce(() => again.promise);
    const starting = lifecycle.startMachine("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.refresh("build");
    const newer = store.binding(bindingId)!;

    preflight.resolve(resource({ machine: "stopped", rawState: "archived" }));
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(3));
    expect(provider.start).not.toHaveBeenCalled();
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    again.resolve(resource({ machine: "stopped", rawState: "archived" }));
    await starting;
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect(lifecycle.statuses()[0]!.machine).toBe("running");
  });

  it("ends a stop's wait on a newer read that saw it stopped", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "running",
    });
    const round = holdNextInspect();
    vi.mocked(provider.inspect).mockResolvedValueOnce(
      resource({ machine: "stopped", rawState: "archived" })
    );
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    await lifecycle.refresh("build");
    const newer = store.binding(bindingId)!;
    expect(newer.observation?.machine).toBe("stopped");

    // Past the stop's deadline: the newer word must count before the deadline does.
    tick(16 * 60_000);
    round.resolve(resource({ machine: "stopping", rawState: "archiving" }));
    await stopping;
    expect(provider.inspect).toHaveBeenCalledTimes(2);
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
  });

  it("keeps a stop's not-found over a refresh that was sent before it", async () => {
    const { lifecycle, provider, store, bindingId, tick, holdNextInspect } = await host({
      machine: "running",
    });
    const stopReply = deferred<ProviderResource>();
    vi.mocked(provider.stop).mockImplementationOnce(() => stopReply.promise);
    const stopping = lifecycle.stopMachine("build");
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    const older = holdNextInspect();
    vi.mocked(provider.inspect).mockRejectedValueOnce(
      new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null)
    );
    const refreshing = lifecycle.refresh("build");
    await vi.waitFor(() => expect(provider.inspect).toHaveBeenCalledTimes(1));
    tick(1_000);
    stopReply.resolve(resource({ machine: "stopping", rawState: "archiving" }));
    await expect(stopping).rejects.toBeTruthy();
    const newer = store.binding(bindingId)!;
    expect(newer.observation?.machine).toBe("unknown");
    expect(newer.lastError?.code).toBe("not-found");

    tick(1_000);
    older.resolve(resource({ machine: "running" }));
    await refreshing;
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    expect(store.binding(bindingId)!.lastError?.code).toBe("not-found");
  });

  it("keeps a refresh over a lifetime change's reply that was sent before it", async () => {
    const { lifecycle, provider, store, bindingId, tick } = await host({ machine: "running" });
    const renewed = deferred<ProviderResource>();
    vi.mocked(provider.renewLifetime).mockImplementationOnce(() => renewed.promise);
    const setting = lifecycle.setLifetime("build", 4);
    await vi.waitFor(() => expect(provider.renewLifetime).toHaveBeenCalledTimes(1));
    tick(1_000);
    vi.mocked(provider.inspect).mockResolvedValueOnce(
      resource({ autoStopAt: "2026-11-17T12:00:00.000Z" })
    );
    await lifecycle.refresh("build");
    const newer = store.binding(bindingId)!;

    tick(1_000);
    renewed.resolve(resource({ autoStopAt: "2026-11-17T10:00:00.000Z" }));
    await setting;
    expect(store.binding(bindingId)!.observation).toEqual(newer.observation);
    expect(store.binding(bindingId)!.lifetimeSeconds).toBe(4 * 3600);
  });

  it("still takes a read sent after the last observation", async () => {
    const { lifecycle, provider, store, bindingId, tick } = await host({
      machine: "stopped",
      rawState: "archived",
    });
    await lifecycle.startMachine("build");
    tick(1_000);
    vi.mocked(provider.inspect).mockResolvedValueOnce(
      resource({ machine: "stopped", rawState: "archived" })
    );
    await lifecycle.refresh("build");
    expect(store.binding(bindingId)!.observation).toMatchObject({
      machine: "stopped",
      observedAt: 1_001_000,
    });
  });
});

describe("CloudHostLifecycle with a provider that takes the key at create and sleeps idle machines (#17347)", () => {
  const IDLE: CloudLifetimeModel = { kind: "idle-sleep", idleSeconds: 900 };

  /** The fake provider as Agent 37 declares itself: an idle sleep, and the key with the create. */
  function atCreate(provider: CloudProvider) {
    const info = provider.info;
    provider.info = (platform) => {
      const described = info(platform);
      return {
        ...described,
        capabilities: {
          ...described.capabilities,
          provisioning: { ...described.capabilities.provisioning, sshKey: "at-create" },
        },
      };
    };
  }

  async function create(env: Awaited<ReturnType<typeof setup>>) {
    await env.lifecycle.create({
      accountId: env.store.accounts()[0]!.id,
      name: "build",
      machineType: "default",
      lifetimeHours: null,
    });
  }

  it("never sends a lost create again for a provider with no idempotency key, only looks again", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    vi.mocked(env.provider.list).mockResolvedValue([]);
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]?.lastError?.message).toContain("never asks for another")
    );
    await vi.waitFor(() => expect(env.lifecycle.statuses()[0]?.operation).toBeNull());
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(/remove the host/);
    expect(env.provider.list).toHaveBeenCalledTimes(1);
    expect(env.provider.create).toHaveBeenCalledTimes(1);
    expect(env.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown");
    expect(env.store.bindings()[0]!.creation!.sentAt).toEqual(expect.any(Number));

    // Once the machine shows up, the next look binds it.
    const bindingId = env.store.bindings()[0]!.id;
    vi.mocked(env.provider.list).mockResolvedValue([
      resource({
        resourceId: "bx_found0001",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
    ]);
    await env.lifecycle.retryCreate("build");
    expect(env.store.bindings()[0]!.resourceId).toBe("bx_found0001");
    expect(env.provider.create).toHaveBeenCalledTimes(1);
  });

  it("tells a restart's miss to look again, not to create, for a provider that only looks", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    vi.mocked(env.provider.list).mockResolvedValue([]);
    await create(env);
    await vi.waitFor(() => expect(env.lifecycle.statuses()[0]?.operation).toBeNull());
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.lastError?.message).toContain("hasn't shown a machine")
    );
    expect(next.lifecycle.statuses()[0]?.lastError?.message).not.toContain("Retry to create it");
    expect(env.provider.create).toHaveBeenCalledTimes(1);
    next.lifecycle.dispose();
  });

  /** A create that went out just before Daintree quit: the mark stays, with no answer and no error. */
  async function quitWhileSent(env: Awaited<ReturnType<typeof setup>>) {
    vi.mocked(env.provider.create).mockImplementationOnce(() => new Promise(() => {}));
    await create(env);
    await vi.waitFor(() => expect(env.provider.create).toHaveBeenCalledTimes(1));
    expect(env.store.bindings()[0]).toMatchObject({
      creation: { sentAt: expect.any(Number) },
      lastError: null,
    });
  }

  it("leaves a startup lookup that couldn't reach the provider with a Retry, which finds the machine once online (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    await quitWhileSent(env);
    const bindingId = env.store.bindings()[0]!.id;
    const hint = async (lifecycle: CloudHostLifecycle) =>
      (
        (await lifecycle
          .ensureAccess(bindingId)
          .catch((e: unknown) => e)) as UnusableConnectionError
      ).detail;
    // While the create is still out, there is no Retry to point to.
    expect(await hint(env.lifecycle)).not.toContain("retry");
    vi.mocked(env.provider.list).mockRejectedValueOnce(
      new BoatApiError("network", "offline", null, null, null)
    );
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() => expect(next.lifecycle.statuses()[0]?.lastError).not.toBeNull());
    // What Settings needs to offer Retry, which the connect message points to.
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      resourceId: null,
      operation: null,
      providerUnavailable: null,
      lastError: {
        code: "outcome-unknown",
        message: expect.stringContaining("Retry looks for it again"),
      },
    });
    expect(next.store.bindings()[0]!.creation).toEqual(env.store.bindings()[0]!.creation);
    expect(await hint(next.lifecycle)).toContain("to retry");
    vi.mocked(env.provider.list).mockResolvedValue([
      resource({
        resourceId: "bx_found0001",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
    ]);
    await next.lifecycle.retryCreate("build");
    expect(next.store.bindings()[0]).toMatchObject({ resourceId: "bx_found0001", lastError: null });
    expect(env.provider.create).toHaveBeenCalledTimes(1);
    next.lifecycle.dispose();
  });

  it("keeps what a Retry found over a startup lookup that fails after it (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    await quitWhileSent(env);
    let failStartup: (error: unknown) => void = () => {};
    vi.mocked(env.provider.list)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failStartup = reject;
          })
      )
      .mockResolvedValue([]);
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() => expect(env.provider.list).toHaveBeenCalledTimes(1));
    await expect(next.lifecycle.retryCreate("build")).rejects.toThrow(/remove the host/);
    const said = next.lifecycle.statuses()[0]!.lastError;
    expect(said?.message).toContain("isn't in the account");
    failStartup(new BoatApiError("network", "offline", null, null, null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next.lifecycle.statuses()[0]!.lastError).toEqual(said);
    next.lifecycle.dispose();
  });

  it("says why a startup lookup couldn't be made when the account's credentials are gone (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    await quitWhileSent(env);
    const gone = vi.spyOn(MemoryCloudCredentialVault.prototype, "get").mockResolvedValue(null);
    onTestFinished(() => gone.mockRestore());
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() => expect(next.lifecycle.statuses()[0]?.lastError).not.toBeNull());
    expect(next.lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("Replace them in Settings"),
    });
    expect(env.provider.list).not.toHaveBeenCalled();
    next.lifecycle.dispose();
  });

  it("sends a create again with its own key once online, after a startup lookup that couldn't reach a same-key provider (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    await quitWhileSent(env);
    const key = env.store.bindings()[0]!.creation!.idempotencyKey;
    vi.mocked(env.provider.list).mockRejectedValueOnce(
      new BoatApiError("network", "offline", null, null, null)
    );
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown")
    );
    expect(next.lifecycle.statuses()[0]!.lastError!.message).toContain("asks for it again");
    vi.mocked(env.provider.list).mockResolvedValue([]);
    const looked = vi.mocked(env.provider.list).mock.calls.length;
    await next.lifecycle.retryCreate("build");
    expect(vi.mocked(env.provider.list).mock.calls.length).toBe(looked + 1);
    expect(env.provider.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(env.provider.create).mock.calls[1]![1].idempotencyKey).toBe(key);
    expect(vi.mocked(env.provider.list).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(env.provider.create).mock.invocationCallOrder[1]!
    );
    expect(next.store.bindings()[0]).toMatchObject({ resourceId: "bx_23456789", lastError: null });
    next.lifecycle.dispose();
  });

  it("leaves Retry to a Retry still looking when the startup lookup failed, which records its own failure (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    await quitWhileSent(env);
    const failures: Array<(error: unknown) => void> = [];
    const held = () =>
      new Promise<ProviderResource[]>((_resolve, reject) => {
        failures.push(reject);
      });
    vi.mocked(env.provider.list).mockImplementationOnce(held).mockImplementationOnce(held);
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() => expect(failures).toHaveLength(1));
    const retry = next.lifecycle.retryCreate("build").catch((error: unknown) => error);
    await vi.waitFor(() => expect(failures).toHaveLength(2));
    failures[0]!(new BoatApiError("network", "offline", null, null, null));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(next.store.bindings()[0]!.lastError).toBeNull();
    failures[1]!(new BoatApiError("network", "offline", null, null, null));
    await retry;
    expect(next.lifecycle.statuses()[0]).toMatchObject({
      operation: null,
      lastError: {
        code: "outcome-unknown",
        message: expect.stringContaining("Retry looks for it again"),
      },
    });
    next.lifecycle.dispose();
  });

  it("gives an earlier run's error way to why this startup's lookup failed (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
    vi.mocked(env.provider.list).mockRejectedValueOnce(
      new BoatApiError("network", "offline", null, null, null)
    );
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.lastError?.message).toContain("couldn't look")
    );
    next.lifecycle.dispose();
  });

  /** A provider that readies each create first, held until the test lets it finish. */
  function readies(env: Awaited<ReturnType<typeof setup>>) {
    const send = vi.fn(async () => resource({ machine: "running" }));
    let finish: () => void = () => {};
    const prepareCreate = vi.fn<NonNullable<CloudProvider["prepareCreate"]>>(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(send);
        })
    );
    (env.provider as CloudProvider).prepareCreate = prepareCreate;
    return { send, prepareCreate, finish: () => finish() };
  }

  it("asks nobody when the provider was replaced while the create was readied (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    const { send, prepareCreate, finish } = readies(env);
    await create(env);
    await vi.waitFor(() => expect(prepareCreate).toHaveBeenCalled());
    vi.spyOn(env.accounts, "provider").mockReturnValue({ ...env.provider });
    finish();
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]?.lastError).toMatchObject({
        message: expect.stringContaining("replaced while the machine was readied"),
      })
    );
    expect(send).not.toHaveBeenCalled();
    expect(env.store.bindings()[0]!.creation!.sentAt).toBeNull();
  });

  it("refuses a key replacement for a provider that can't say whose a key is while a create is readied (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    const { send, prepareCreate, finish } = readies(env);
    await create(env);
    await vi.waitFor(() => expect(prepareCreate).toHaveBeenCalled());
    vi.mocked(env.provider.checkCredentials).mockResolvedValueOnce({
      identity: null,
      scopes: [{ scope: { kind: "personal", id: "personal", name: "Personal" }, active: true }],
    });
    // Nothing is marked as sent yet, but the create is about to be sent with this account's key.
    await expect(
      env.accounts.replaceCredentials(env.account.id, { apiKey: "boat_live_y" })
    ).rejects.toThrow(/hasn't been confirmed yet/);
    finish();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(prepareCreate.mock.calls[0]![0].values).toEqual({ apiKey: "boat_live_x" });
  });

  it("refuses a Retry while the host is being removed, so nothing is made after its look (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
    let answer: (found: ProviderResource[]) => void = () => {};
    vi.mocked(env.provider.list).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const removing = env.lifecycle.deleteMachine("build", null);
    await vi.waitFor(() => expect(env.provider.list).toHaveBeenCalled());
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(/being removed/);
    answer([]);
    await removing;
    expect(env.hosts).toHaveLength(0);
    expect(env.provider.create).toHaveBeenCalledTimes(1);
  });

  /** A sent create whose answer was lost, with Retry on offer. */
  async function lostAnswer(env: Awaited<ReturnType<typeof setup>>) {
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
  }

  /** Each `list` from now on held until the test answers it, in the order they were asked. */
  function holdLists(env: Awaited<ReturnType<typeof setup>>) {
    const held: Array<{ answer: (found: ProviderResource[]) => void; fail: (e: unknown) => void }> =
      [];
    vi.mocked(env.provider.list).mockImplementation(
      () =>
        new Promise((answer, fail) => {
          held.push({ answer, fail });
        })
    );
    return held;
  }

  it("keeps Retry refused while a second removal of the host is still looking (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    await lostAnswer(env);
    const held = holdLists(env);
    const first = env.lifecycle.deleteMachine("build", null).catch((error: unknown) => error);
    const second = env.lifecycle.deleteMachine("build", null);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[0]!.fail(new BoatApiError("network", "offline", null, null, null));
    expect(await first).toBeInstanceOf(Error);
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(/being removed/);
    held[1]!.answer([]);
    await second;
    expect(env.hosts).toHaveLength(0);
    expect(env.provider.create).toHaveBeenCalledTimes(1);
  });

  it("deletes the machine a restart's lookup bound while the removal looked (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    await quitWhileSent(env);
    const held = holdLists(env);
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const bindingId = next.store.bindings()[0]!.id;
    const removing = next.lifecycle.deleteMachine("build", null);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[0]!.answer([
      resource({
        resourceId: "bx_found0001",
        labels: { "daintree-binding": bindingId },
        createdAt: new Date().toISOString(),
      }),
    ]);
    await vi.waitFor(() => expect(next.store.bindings()[0]?.resourceId).toBe("bx_found0001"));
    held[1]!.answer([]);
    await removing;
    expect(env.provider.delete).toHaveBeenCalledWith(expect.anything(), "bx_found0001");
    expect(env.hosts).toHaveLength(0);
    next.lifecycle.dispose();
  });

  it("marks nothing and sends nothing when the create is stopped while it is readied (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    const { send, prepareCreate, finish } = readies(env);
    await create(env);
    await vi.waitFor(() => expect(prepareCreate).toHaveBeenCalled());
    env.lifecycle.dispose();
    finish();
    await vi.waitFor(() => expect(env.store.bindings()[0]!.lastError).not.toBeNull());
    expect(send).not.toHaveBeenCalled();
    expect(env.store.bindings()[0]).toMatchObject({
      creation: { sentAt: null },
      lastError: { message: expect.stringMatching(/stopped while the machine was readied/) },
    });
  });

  it("keeps an earlier unanswered create in doubt when readying its retry fails (#17928)", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    const send = vi
      .fn<() => Promise<ProviderResource>>()
      .mockRejectedValueOnce(new BoatApiError("network", "lost", null, null, null));
    const prepareCreate = vi.fn<NonNullable<CloudProvider["prepareCreate"]>>(async () => send);
    (env.provider as CloudProvider).prepareCreate = prepareCreate;
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]).toMatchObject({
        operation: null,
        lastError: { code: "outcome-unknown" },
      })
    );
    const sent = env.store.bindings()[0]!.creation!;
    expect(sent.sentAt).toEqual(expect.any(Number));
    vi.mocked(env.provider.list).mockResolvedValue([]);
    prepareCreate.mockRejectedValueOnce(new BoatApiError("network", "offline", null, null, null));
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow();
    expect(env.store.bindings()[0]!.creation).toEqual(sent);
    expect(env.lifecycle.statuses()[0]!.lastError).toMatchObject({
      code: "outcome-unknown",
      message: expect.stringContaining("earlier request"),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("binds the machine made as a lost create was sent, never a later copy carrying its labels", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("network", "lost", null, null, null)
    );
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown")
    );
    await vi.waitFor(() => expect(env.lifecycle.statuses()[0]?.operation).toBeNull());
    const sentAt = env.store.bindings()[0]!.creation!.sentAt!;
    const labels = { "daintree-binding": env.store.bindings()[0]!.id };
    vi.mocked(env.provider.list).mockResolvedValue([
      resource({
        resourceId: "bx_fork00001",
        labels,
        createdAt: new Date(sentAt + 2 * 3_600_000).toISOString(),
      }),
      resource({ resourceId: "bx_orig00001", labels, createdAt: new Date(sentAt).toISOString() }),
    ]);
    await env.lifecycle.retryCreate("build");
    expect(env.store.bindings()[0]!.resourceId).toBe("bx_orig00001");
  });

  it("looks again before dialling a machine that sleeps by itself, so a dial never wakes one", async () => {
    let now = 1_000_000;
    const env = await setup({ machine: "running" }, { lifetime: IDLE, now: () => now });
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const bindingId = env.store.bindings()[0]!.id;
    await env.lifecycle.refresh("build");
    // It fell asleep moments after a look that found it running.
    env.state.machine = resource({ machine: "stopped", rawState: "sleeping", asleep: true });
    now += 5_000;
    const inspections = vi.mocked(env.provider.inspect).mock.calls.length;
    const error = await env.lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect(vi.mocked(env.provider.inspect).mock.calls.length).toBeGreaterThan(inspections);
    expect(env.provider.authorizeSsh).not.toHaveBeenCalled();
  });

  it("treats a key the provider refused ahead of the machine as nothing made: Retry sends afresh", async () => {
    const env = await setup({}, { lifetime: IDLE, adapt: atCreate });
    const refusal = new Error("key refused");
    const described = env.provider.describeError;
    env.provider.describeError = (error) =>
      error === refusal
        ? { code: "ssh-authorization", message: "Didn't take the key", at: 0 }
        : described(error);
    vi.mocked(env.provider.create).mockRejectedValueOnce(refusal);
    await create(env);
    await vi.waitFor(() =>
      expect(env.lifecycle.statuses()[0]?.lastError?.code).toBe("ssh-authorization")
    );
    await vi.waitFor(() => expect(env.lifecycle.statuses()[0]?.operation).toBeNull());
    expect(env.store.bindings()[0]!.creation!.sentAt).toBeNull();
    // A request the provider rejected as invalid made nothing either, and keeps its reason.
    const invalidRequest = new Error("invalid");
    const before = env.provider.describeError;
    env.provider.describeError = (error) =>
      error === invalidRequest
        ? { code: "unsupported", message: "Refused: bad shape", at: 0 }
        : before(error);
    vi.mocked(env.provider.create).mockRejectedValueOnce(invalidRequest);
    await env.lifecycle.retryCreate("build").catch(() => {});
    expect(env.lifecycle.statuses()[0]?.lastError).toMatchObject({
      code: "unsupported",
      message: "Refused: bad shape",
    });
    expect(env.store.bindings()[0]!.creation!.sentAt).toBeNull();
    await env.lifecycle.retryCreate("build");
    // Nothing was sent before either refusal, so nothing is looked for: the create goes again.
    expect(env.provider.list).not.toHaveBeenCalled();
    expect(env.provider.create).toHaveBeenCalledTimes(3);
  });

  it("reads an asleep machine as asleep, and refuses a dial to it in those words", async () => {
    const env = await setup(
      {
        machine: "stopped",
        rawState: "sleeping",
        asleep: true,
        idleSleep: { enabled: true, idleSeconds: 600 },
      },
      { lifetime: IDLE }
    );
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    const status = env.lifecycle.statuses()[0]!;
    expect(status).toMatchObject({ machine: "stopped", asleep: true });
    // Its own idle time, not the provider's default.
    expect(status.lifetime).toEqual({ kind: "idle-sleep", idleSeconds: 600 });
    const bindingId = env.store.bindings()[0]!.id;
    const error = await env.lifecycle.ensureAccess(bindingId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnusableConnectionError);
    expect(String((error as Error).message)).toContain("asleep");
    expect(env.provider.start).not.toHaveBeenCalled();
    expect(env.provider.authorizeSsh).not.toHaveBeenCalled();
  });

  it("says a machine with sleeping turned off runs until it's stopped, and survives a restart", async () => {
    const env = await setup(
      { machine: "running", idleSleep: { enabled: false, idleSeconds: 900 } },
      { lifetime: IDLE }
    );
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(env.lifecycle.statuses()[0]!.lifetime).toEqual({ kind: "none" });
    expect(env.lifecycle.statuses()[0]!.asleep).toBe(false);
    const next = env.restart(env.lifecycle);
    expect(next.lifecycle.statuses()[0]!.lifetime).toEqual({ kind: "none" });
    next.lifecycle.dispose();
  });

  it("keeps the provider's own words for a provider that doesn't report sleep per machine", async () => {
    const env = await setup({ machine: "running" }, { lifetime: IDLE });
    await env.lifecycle.importMachine({
      accountId: env.store.accounts()[0]!.id,
      resourceId: "bx_23456789",
      name: "build",
    });
    expect(env.lifecycle.statuses()[0]!.lifetime).toEqual(IDLE);
  });
});

describe("CloudHostLifecycle with its worktree's delete (#17360)", () => {
  const ROOT = "/Users/me/code/app-worktrees/feature-login";
  const MARK: CloudHostCreatedFor = {
    hostId: null,
    projectId: "0f1e2d3c",
    worktreeId: ROOT,
    projectName: "app",
    worktreeName: "feature/login",
    hostName: null,
  };
  const WORKTREE = { hostId: null, projectId: MARK.projectId, worktreeId: ROOT };
  const request = (accountId: string): CloudHostCreateRequest => ({
    accountId,
    name: "build",
    machineType: "default",
    lifetimeHours: 2,
  });
  const choose = (choice: "stop" | "delete") => [
    { hostId: "build", resourceId: "bx_23456789", choice },
  ];

  /** A machine made for the worktree (or, with null, from Settings), up and running. */
  async function marked(
    mark: CloudHostCreatedFor | null = MARK,
    options: Parameters<typeof setup>[1] = {}
  ) {
    const gone = { value: true as boolean | null };
    const worktreeGone = vi.fn(async (_path: string): Promise<boolean | null> => gone.value);
    const ctx = await setup({}, { worktreeGone, ...options });
    await ctx.lifecycle.create(request(ctx.account.id), mark);
    await vi.waitFor(() =>
      expect(ctx.lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null })
    );
    return { ...ctx, gone, worktreeGone };
  }

  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const cleanupOf = (store: CloudHostStore) => store.bindings()[0]?.worktreeCleanup ?? null;

  it("stops the machine once its worktree is gone, keeping the host and saying it's stopped", async () => {
    const { lifecycle, provider, store, hosts, worktreeGone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    expect(cleanupOf(store)).toMatchObject({ choice: "stop", phase: "waiting" });
    expect(provider.stop).not.toHaveBeenCalled();

    const outcomes = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(worktreeGone).toHaveBeenCalledWith(ROOT);
    expect(outcomes).toEqual([
      { hostId: "build", machineName: "build", choice: "stop", error: null },
    ]);
    expect(provider.stop).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
    expect(provider.delete).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
    expect(store.bindings()[0]).toMatchObject({ intent: "stop", worktreeCleanup: null });
    expect(lifecycle.statuses()[0]).toMatchObject({ machine: "stopped", worktreeCleanup: null });
  });

  it("deletes the machine once its worktree is gone, and the host with it", async () => {
    const { lifecycle, provider, store, hosts } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const outcomes = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(outcomes).toEqual([
      { hostId: "build", machineName: "build", choice: "delete", error: null },
    ]);
    expect(provider.delete).toHaveBeenCalledWith(expect.anything(), "bx_23456789");
    expect(provider.stop).not.toHaveBeenCalled();
    expect(hosts).toEqual([]);
    lifecycle.start();
    await vi.waitFor(() => expect(store.bindings()).toEqual([]));
    lifecycle.dispose();
  });

  it("keeps a machine left out of the choices, dropping what an earlier attempt chose", async () => {
    const { lifecycle, provider, store, hosts } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    // The person deletes again and keeps it this time.
    lifecycle.prepareWorktreeCleanup(WORKTREE, []);
    expect(cleanupOf(store)).toBeNull();
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true)).toEqual([]);
    expect(provider.stop).not.toHaveBeenCalled();
    expect(provider.delete).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
  });

  it("never touches a machine unless its mark names exactly the worktree being deleted", async () => {
    const others: Array<CloudHostCreatedFor | null> = [
      null,
      { ...MARK, worktreeId: `${ROOT}-2` },
      { ...MARK, projectId: "aaaaaaaa" },
      { ...MARK, hostId: "devbox", hostName: "devbox" },
    ];
    for (const mark of others) {
      const { lifecycle, provider, store, hosts } = await marked(mark);
      expect(() => lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"))).toThrow(
        /wasn't created for this worktree/
      );
      expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true)).toEqual([]);
      expect(cleanupOf(store)).toBeNull();
      expect(provider.stop).not.toHaveBeenCalled();
      expect(provider.delete).not.toHaveBeenCalled();
      expect(hosts.map((host) => host.id)).toEqual(["build"]);
    }
  });

  it("leaves another worktree's choice alone when this one settles", async () => {
    const { lifecycle, provider, store } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const sibling = { ...WORKTREE, worktreeId: `${ROOT}-2` };
    expect(await lifecycle.settleWorktreeCleanup(sibling, true)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("refuses a machine that changed since it was confirmed, writing nothing", async () => {
    const { lifecycle, store } = await marked();
    expect(() =>
      lifecycle.prepareWorktreeCleanup(WORKTREE, [
        { hostId: "build", resourceId: "bx_99999999", choice: "delete" },
      ])
    ).toThrow(/changed since you confirmed/);
    expect(() =>
      lifecycle.prepareWorktreeCleanup({ hostId: null, projectId: MARK.projectId }, [])
    ).toThrow(/missing its project or path/);
    expect(cleanupOf(store)).toBeNull();
  });

  it("leaves the machine while the worktree is still there, dropping the choice only on a refusal", async () => {
    const { lifecycle, provider, store, gone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    gone.value = false;
    // Even a delete reported as done: only the missing root counts on this device.
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    // A lost answer: the delete may still be removing it, so the choice waits on.
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, null)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, false)).toEqual([]);
    expect(cleanupOf(store)).toBeNull();
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("carries out a choice whose worktree went though its delete's answer was lost", async () => {
    const { lifecycle, provider } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    const outcomes = await lifecycle.settleWorktreeCleanup(WORKTREE, null);
    expect(outcomes[0]).toMatchObject({ choice: "stop", error: null });
    expect(provider.stop).toHaveBeenCalledTimes(1);
  });

  it("waits when nothing can tell, until the person checks again", async () => {
    const { lifecycle, provider, store, gone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    gone.value = null;
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, false)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(lifecycle.statuses()[0]?.worktreeCleanup).toMatchObject({
      phase: "waiting",
      worktreeHostId: null,
    });
    await expect(lifecycle.retryWorktreeCleanup("build")).rejects.toThrow(/couldn't tell/);
    // A look while its delete may still be running never drops the choice.
    gone.value = false;
    await expect(lifecycle.retryWorktreeCleanup("build")).rejects.toThrow(/still there/);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(provider.stop).not.toHaveBeenCalled();

    gone.value = true;
    await lifecycle.retryWorktreeCleanup("build");
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(cleanupOf(store)).toBeNull();
  });

  it("never lets an answer about an earlier attempt change a later one", async () => {
    const { lifecycle, provider, store, worktreeGone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const probe = deferred<boolean | null>();
    worktreeGone.mockImplementationOnce(() => probe.promise);
    const settling = lifecycle.settleWorktreeCleanup(WORKTREE, false);
    await vi.waitFor(() => expect(worktreeGone).toHaveBeenCalledTimes(1));
    // The card's Retry writes the choice again before the first answer lands.
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const retried = cleanupOf(store)!.attemptId;
    probe.resolve(false);
    expect(await settling).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting", attemptId: retried });
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("never lets a stale 'gone' run a later attempt's choice", async () => {
    const { lifecycle, provider, store, worktreeGone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const probe = deferred<boolean | null>();
    worktreeGone.mockImplementationOnce(() => probe.promise);
    const settling = lifecycle.settleWorktreeCleanup(WORKTREE, true);
    await vi.waitFor(() => expect(worktreeGone).toHaveBeenCalledTimes(1));
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    probe.resolve(true);
    expect(await settling).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(provider.delete).not.toHaveBeenCalled();
  });

  it("settles only the delete an answer belongs to", async () => {
    const { lifecycle, provider, store } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"), "mutation-b");
    // A late answer from an earlier delete of a worktree at the same path, or one naming none.
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true, "mutation-a")).toEqual([]);
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting", mutationId: "mutation-b" });
    expect(provider.delete).not.toHaveBeenCalled();
    const [outcome] = await lifecycle.settleWorktreeCleanup(WORKTREE, true, "mutation-b");
    expect(outcome).toMatchObject({ choice: "delete", error: null });
  });

  it("sends no delete through a provider replaced while its credentials were read", async () => {
    const { lifecycle, provider, store, accounts } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const read = accounts.credentials.bind(accounts);
    const registered = vi.spyOn(accounts, "provider");
    vi.spyOn(accounts, "credentials").mockImplementation(async (...args) => {
      const credentials = await read(...args);
      registered.mockReturnValue({ ...provider } as CloudProvider);
      return credentials;
    });
    const [outcome] = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(outcome?.error).toMatch(/changed while the machine was being deleted/);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(cleanupOf(store)).toMatchObject({ phase: "failed" });
  });

  it("says a Check again that lost the race to a failed delete failed, without sending it again", async () => {
    let heard: (worktreeId: string) => void = () => {};
    const { lifecycle, provider, store, worktreeGone, gone } = await marked(MARK, {
      onWorktreeRemoved: (listener) => {
        heard = listener;
        return () => {};
      },
    });
    lifecycle.start();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    gone.value = null;
    await lifecycle.settleWorktreeCleanup(WORKTREE, null);
    const look = deferred<boolean | null>();
    worktreeGone.mockImplementationOnce(() => look.promise);
    const checking = lifecycle.retryWorktreeCleanup("build");
    await vi.waitFor(() => expect(worktreeGone).toHaveBeenCalledTimes(2));
    vi.mocked(provider.delete).mockRejectedValueOnce(
      new BoatApiError("server", "Upstream exploded", 500, null, null)
    );
    gone.value = true;
    heard(ROOT);
    await vi.waitFor(() => expect(cleanupOf(store)).toMatchObject({ phase: "failed" }));
    look.resolve(true);
    await expect(checking).rejects.toThrow(/Upstream exploded/);
    expect(provider.delete).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
  });

  it("waits for a provider that leaves partway, rather than failing", async () => {
    const { lifecycle, provider, store, accounts, disconnect } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const unavailable = vi.spyOn(accounts, "providerUnavailable");
    const supported = vi.spyOn(accounts, "requireSupported");
    // Gone while the link is let go, before the delete is sent.
    disconnect.mockImplementationOnce(async () => {
      unavailable.mockReturnValue("Its plugin is disabled");
      supported.mockImplementation(() => {
        throw new Error("Unknown cloud provider boat");
      });
    });
    const [outcome] = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(outcome?.error).toBe("Its plugin is disabled");
    expect(provider.delete).not.toHaveBeenCalled();
    expect(cleanupOf(store)).toMatchObject({
      phase: "due",
      error: { message: "Its plugin is disabled" },
    });
    unavailable.mockRestore();
    supported.mockRestore();
    lifecycle.providersChanged();
    await vi.waitFor(() => expect(provider.delete).toHaveBeenCalledTimes(1));
  });

  it("ends a start under way before its stop, so the machine doesn't come back up", async () => {
    const { lifecycle, provider, store, state } = await marked();
    state.machine = resource({ machine: "stopped", rawState: "archived" });
    await lifecycle.refresh("build");
    const started = deferred<ProviderResource | null>();
    vi.mocked(provider.start).mockImplementationOnce(() => started.promise);
    const starting = lifecycle.startMachine("build");
    await vi.waitFor(() => expect(provider.start).toHaveBeenCalledTimes(1));
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    const settling = lifecycle.settleWorktreeCleanup(WORKTREE, true);
    // The start lands after it was superseded: the stop still follows.
    state.machine = resource({ machine: "running" });
    started.resolve(resource({ machine: "starting", rawState: "provisioning" }));
    await starting.catch(() => {});
    const [outcome] = await settling;
    expect(outcome).toMatchObject({ error: null });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(store.bindings()[0]?.intent).toBe("stop");
    expect(lifecycle.statuses()[0]).toMatchObject({ machine: "stopped", worktreeCleanup: null });
  });

  it("runs a delete once when a removal is heard while its delete settles, keeping a failure", async () => {
    let heard: (worktreeId: string) => void = () => {};
    const { lifecycle, provider, store, worktreeGone } = await marked(MARK, {
      onWorktreeRemoved: (listener) => {
        heard = listener;
        return () => {};
      },
    });
    lifecycle.start();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const first = deferred<boolean | null>();
    const second = deferred<boolean | null>();
    worktreeGone
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    heard(ROOT);
    const settling = lifecycle.settleWorktreeCleanup(WORKTREE, true);
    await vi.waitFor(() => expect(worktreeGone).toHaveBeenCalledTimes(2));
    vi.mocked(provider.delete).mockRejectedValueOnce(
      new BoatApiError("server", "Upstream exploded", 500, null, null)
    );
    first.resolve(true);
    await vi.waitFor(() => expect(cleanupOf(store)).toMatchObject({ phase: "failed" }));
    // The second look lands after the failure: it never sends the delete again.
    second.resolve(true);
    const [outcome] = await settling;
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(outcome?.error).toContain("Upstream exploded");
    expect(cleanupOf(store)).toMatchObject({ phase: "failed" });
    lifecycle.dispose();
  });

  it("runs a choice waiting when Daintree quit once the worktree is found gone", async () => {
    const { lifecycle, provider, store, hosts, restart } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const next = restart(lifecycle);
    await vi.waitFor(() => expect(hosts).toEqual([]));
    expect(provider.delete).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(next.store.bindings()).toEqual([]));
    expect(store.bindings()).toEqual([]);
    next.lifecycle.dispose();
  });

  it("drops a choice waiting when Daintree quit if the worktree is still there", async () => {
    const { lifecycle, provider, gone, restart, hosts } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    gone.value = false;
    const next = restart(lifecycle);
    await vi.waitFor(() => expect(cleanupOf(next.store)).toBeNull());
    expect(provider.delete).not.toHaveBeenCalled();
    expect(hosts.map((host) => host.id)).toEqual(["build"]);
    next.lifecycle.dispose();
  });

  it("runs a delete again after a quit partway, and the quitting run leaves it due", async () => {
    const { lifecycle, provider, store, hosts, restart } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    const sent = deferred<void>();
    const resent = deferred<void>();
    vi.mocked(provider.delete)
      .mockImplementationOnce(() => sent.promise)
      .mockImplementationOnce(() => resent.promise);
    const quitting = lifecycle.settleWorktreeCleanup(WORKTREE, true);
    await vi.waitFor(() => expect(provider.delete).toHaveBeenCalledTimes(1));
    expect(cleanupOf(store)).toMatchObject({ phase: "due" });

    const next = restart(lifecycle);
    await vi.waitFor(() => expect(provider.delete).toHaveBeenCalledTimes(2));
    // The old run's call fails as the process goes: it never records a failure.
    sent.reject(new BoatApiError("cancelled", "Cancelled", null, null, null));
    await quitting;
    expect(cleanupOf(next.store)).toMatchObject({ phase: "due", error: null });

    // Already gone at the provider by the time it's asked again.
    resent.reject(new BoatApiError("not-found", "No such sandbox", 404, "sandbox_not_found", null));
    await vi.waitFor(() => expect(hosts).toEqual([]));
    expect(vi.mocked(provider.delete).mock.calls[1]?.[1]).toBe("bx_23456789");
    next.lifecycle.dispose();
  });

  it("finishes a stop that was under way when Daintree quit without asking for another", async () => {
    const { lifecycle, provider, store, state, restart } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    // The stop goes out; Daintree quits before its answer comes back.
    vi.mocked(provider.stop).mockImplementationOnce(() => {
      state.machine = resource({ machine: "stopping", rawState: "archiving" });
      return new Promise(() => {});
    });
    void lifecycle.settleWorktreeCleanup(WORKTREE, true);
    await vi.waitFor(() => expect(provider.stop).toHaveBeenCalledTimes(1));
    expect(cleanupOf(store)).toMatchObject({ phase: "due" });

    let stoppingReads = 0;
    vi.mocked(provider.inspect).mockImplementation(async () => {
      if (state.machine.machine === "stopping" && ++stoppingReads > 1) {
        state.machine = resource({ machine: "stopped", rawState: "archived" });
      }
      return state.machine;
    });
    const next = restart(lifecycle);
    await vi.waitFor(() => expect(cleanupOf(next.store)).toBeNull());
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(next.lifecycle.statuses()[0]).toMatchObject({ machine: "stopped" });
    expect(next.store.bindings()[0]?.intent).toBe("stop");
    next.lifecycle.dispose();
  });

  it("asks for no stop of a machine its provider reports deleted", async () => {
    const { lifecycle, provider, store, state } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    state.machine = resource({ machine: "deleted", rawState: "deleted" });
    const [outcome] = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(outcome).toMatchObject({ error: null });
    expect(provider.stop).not.toHaveBeenCalled();
    expect(cleanupOf(store)).toBeNull();
  });

  it("keeps a failed delete with its error for Retry, never retrying by itself", async () => {
    const { lifecycle, provider, store, hosts, restart } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    vi.mocked(provider.delete).mockRejectedValueOnce(
      new BoatApiError("server", "Upstream exploded", 500, null, null)
    );
    const [outcome] = await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(outcome).toMatchObject({ choice: "delete" });
    expect(outcome?.error).toContain("Upstream exploded");
    expect(lifecycle.statuses()[0]?.worktreeCleanup).toMatchObject({
      choice: "delete",
      phase: "failed",
      error: { code: "provider-unreachable", message: outcome!.error },
    });
    expect(hosts.map((host) => host.id)).toEqual(["build"]);

    const next = restart(lifecycle);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(cleanupOf(next.store)).toMatchObject({
      phase: "failed",
      error: { message: expect.stringContaining("Upstream exploded") },
    });

    await next.lifecycle.retryWorktreeCleanup("build");
    expect(provider.delete).toHaveBeenCalledTimes(2);
    expect(hosts).toEqual([]);
    expect(store.bindings().every((binding) => binding.hostId !== "build")).toBe(true);
    next.lifecycle.dispose();
  });

  it("never lets a replay of the same delete arm a machine the person chose to keep", async () => {
    const { lifecycle, provider, store, gone } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"), "mutation-a");
    gone.value = false;
    await lifecycle.settleWorktreeCleanup(WORKTREE, null, "mutation-a");
    lifecycle.dismissWorktreeCleanup("build");
    // The reconnect replays the parked delete with the options it was confirmed with.
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"), "mutation-a");
    expect(cleanupOf(store)).toBeNull();
    gone.value = true;
    expect(await lifecycle.settleWorktreeCleanup(WORKTREE, true, "mutation-a")).toEqual([]);
    expect(provider.delete).not.toHaveBeenCalled();
    // A later delete of the worktree asks afresh.
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"), "mutation-b");
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting", mutationId: "mutation-b" });
  });

  it("lets the person keep a machine whose stop failed", async () => {
    const { lifecycle, provider, store } = await marked();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("stop"));
    vi.mocked(provider.stop).mockRejectedValueOnce(
      new BoatApiError("server", "Upstream exploded", 500, null, null)
    );
    await lifecycle.settleWorktreeCleanup(WORKTREE, true);
    expect(cleanupOf(store)).toMatchObject({ phase: "failed" });
    lifecycle.dismissWorktreeCleanup("build");
    expect(cleanupOf(store)).toBeNull();
    await expect(lifecycle.retryWorktreeCleanup("build")).rejects.toThrow(/nothing left to do/);
  });

  it("takes a worktree on another host from its host's answer, and never on a guess", async () => {
    const remote = { ...MARK, hostId: "devbox", hostName: "devbox" };
    const ref = { ...WORKTREE, hostId: "devbox" };
    const { lifecycle, provider, store, worktreeGone } = await marked(remote);

    lifecycle.prepareWorktreeCleanup(ref, choose("delete"));
    expect(await lifecycle.settleWorktreeCleanup(ref, null)).toEqual([]);
    expect(cleanupOf(store)).toMatchObject({ phase: "waiting" });
    expect(await lifecycle.settleWorktreeCleanup(ref, false)).toEqual([]);
    expect(cleanupOf(store)).toBeNull();
    expect(provider.delete).not.toHaveBeenCalled();

    lifecycle.prepareWorktreeCleanup(ref, choose("stop"));
    const outcomes = await lifecycle.settleWorktreeCleanup(ref, true);
    expect(outcomes[0]).toMatchObject({ error: null });
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(worktreeGone).not.toHaveBeenCalled();
  });

  it("leaves a worktree on another host unconfirmed after a quit, with no Retry that acts", async () => {
    const remote = { ...MARK, hostId: "devbox", hostName: "devbox" };
    const ref = { ...WORKTREE, hostId: "devbox" };
    const { lifecycle, provider, worktreeGone, restart } = await marked(remote);
    lifecycle.prepareWorktreeCleanup(ref, choose("delete"));
    const next = restart(lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.worktreeCleanup).toMatchObject({
        phase: "unconfirmed",
        worktreeHostId: "devbox",
        error: { message: expect.stringMatching(/quit before it heard/) },
      })
    );
    await expect(next.lifecycle.retryWorktreeCleanup("build")).rejects.toThrow(/can't tell/);
    // A later answer from the host doesn't run it either: the worktree is deleted again to ask.
    expect(await next.lifecycle.settleWorktreeCleanup(ref, true)).toEqual([]);
    expect(provider.delete).not.toHaveBeenCalled();
    expect(worktreeGone).not.toHaveBeenCalled();
    next.lifecycle.prepareWorktreeCleanup(ref, []);
    expect(cleanupOf(next.store)).toBeNull();
    next.lifecycle.dispose();
  });

  it("runs a choice when a removal is heard and the worktree's root is gone", async () => {
    let heard: (worktreeId: string) => void = () => {};
    const stopListening = vi.fn();
    const { lifecycle, provider, gone, hosts } = await marked(MARK, {
      onWorktreeRemoved: (listener) => {
        heard = listener;
        return stopListening;
      },
    });
    gone.value = false;
    lifecycle.start();
    lifecycle.prepareWorktreeCleanup(WORKTREE, choose("delete"));
    // A monitor pruned while the folder is still there proves nothing.
    heard(ROOT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.delete).not.toHaveBeenCalled();
    gone.value = true;
    heard(ROOT);
    await vi.waitFor(() => expect(hosts).toEqual([]));
    expect(provider.delete).toHaveBeenCalledTimes(1);
    lifecycle.dispose();
    expect(stopListening).toHaveBeenCalled();
  });
});

describe("CloudHostLifecycle with a lost create's label on a machine it didn't make (#17927)", () => {
  const SENT = Date.parse("2026-11-17T10:00:00.000Z");
  const minutesAfterSend = (minutes: number) => new Date(SENT + minutes * 60_000).toISOString();

  /** A host whose create went out at SENT and whose answer was lost. */
  async function lostCreate(options: { lookupOnly?: boolean; now?: () => number } = {}) {
    const env = await setup({}, { now: options.now ?? (() => SENT) });
    if (options.lookupOnly) {
      (env.provider as { createReplay?: string }).createReplay = "lookup-only";
    }
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await env.lifecycle.create({
      accountId: env.account.id,
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
    await vi.waitFor(() => expect(env.lifecycle.statuses()[0]?.operation).toBeNull());
    const bindingId = env.store.bindings()[0]!.id;
    const labelled = (overrides: Partial<ProviderResource>) =>
      resource({ labels: { daintree: "1", "daintree-binding": bindingId }, ...overrides });
    const bindingOf = (hostId: string) => env.store.bindings().find((b) => b.hostId === hostId);
    return { ...env, bindingId, labelled, bindingOf };
  }

  it("never binds a fork that outlived its deleted original: not on Retry, a restart, or removal", async () => {
    const env = await lostCreate({ lookupOnly: true });
    // The original is gone from the list; only a copy made two hours later carries its labels,
    // beside a machine another create labelled while this one was sent.
    vi.mocked(env.provider.list).mockResolvedValue([
      env.labelled({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(120) }),
      resource({
        resourceId: "bx_other0001",
        labels: { daintree: "1", "daintree-binding": "cb_someone0001" },
        createdAt: minutesAfterSend(1),
      }),
    ]);
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(/isn't in the account/);
    expect(env.bindingOf("build")!.resourceId).toBeNull();
    const next = env.restart(env.lifecycle);
    await vi.waitFor(() =>
      expect(next.lifecycle.statuses()[0]?.lastError?.message).toContain("hasn't shown a machine")
    );
    expect(next.store.bindings()[0]!.resourceId).toBeNull();
    await next.lifecycle.deleteMachine("build", null);
    expect(env.provider.delete).not.toHaveBeenCalled();
    expect(env.hosts).toEqual([]);
    expect(env.provider.create).toHaveBeenCalledTimes(1);
    next.lifecycle.dispose();
  });

  it("lets the fork be added as a host of its own, and still binds the original while it lives", async () => {
    const env = await lostCreate();
    const original = env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) });
    const fork = env.labelled({
      resourceId: "bx_fork00001",
      name: "copy",
      createdAt: minutesAfterSend(120),
    });
    vi.mocked(env.provider.list).mockResolvedValue([original, fork]);
    vi.mocked(env.provider.inspect).mockResolvedValueOnce(fork);
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_fork00001",
      name: "copy",
    });
    await env.lifecycle.retryCreate("build");
    expect(env.bindingOf("build")!.resourceId).toBe("bx_orig00001");
    expect(env.bindingOf("copy")!.resourceId).toBe("bx_fork00001");
  });

  const UNCLEAR = /can't tell whether a machine carrying this host's label/;
  const MISSING = /isn't in the account/;
  type Rows = (r: (o: Partial<ProviderResource>) => ProviderResource) => ProviderResource[];
  it.each<[string, Rows, RegExp]>([
    [
      "two made while it was sent",
      (r) => [
        r({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) }),
        r({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(3) }),
      ],
      UNCLEAR,
    ],
    [
      "one whose create time is unknown beside one made while it was sent",
      (r) => [
        r({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) }),
        r({ resourceId: "bx_fork00001", createdAt: null }),
      ],
      UNCLEAR,
    ],
    [
      "a lone one whose create time is unknown",
      (r) => [r({ resourceId: "bx_orig00001", createdAt: null })],
      UNCLEAR,
    ],
    [
      "a deleted original and a copy made long after",
      (r) => [
        r({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1), machine: "deleted" }),
        r({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(120) }),
      ],
      MISSING,
    ],
    [
      "an older machine its labels were copied onto, beside the original",
      (r) => [
        r({ resourceId: "bx_older0001", createdAt: minutesAfterSend(-1) }),
        r({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) }),
      ],
      UNCLEAR,
    ],
    [
      "a machine made well before it was sent",
      (r) => [r({ resourceId: "bx_older0001", createdAt: minutesAfterSend(-10) })],
      MISSING,
    ],
  ])(
    "binds and deletes nothing when it can't tell its machine apart: %s",
    async (_, rows, said) => {
      const env = await lostCreate({ lookupOnly: true });
      vi.mocked(env.provider.list).mockResolvedValue(rows(env.labelled));
      await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(said);
      expect(env.bindingOf("build")!.resourceId).toBeNull();
      await env.lifecycle.deleteMachine("build", null);
      expect(env.provider.delete).not.toHaveBeenCalled();
      expect(env.hosts).toEqual([]);
    }
  );

  it("says after a restart that it saw machines it can't tell apart, not that there are none", async () => {
    const env = await lostCreate({ lookupOnly: true });
    vi.mocked(env.provider.list).mockResolvedValue([
      env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) }),
      env.labelled({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(2) }),
    ]);
    const next = env.restart(env.lifecycle);
    try {
      await vi.waitFor(() =>
        expect(next.lifecycle.statuses()[0]?.lastError?.message).toMatch(UNCLEAR)
      );
      expect(next.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown");
      expect(next.store.bindings()[0]!.resourceId).toBeNull();
    } finally {
      next.lifecycle.dispose();
    }
  });

  it("reserves the machine a later replay may have made, but binds and deletes it only once it can tell", async () => {
    let now = SENT;
    const env = await lostCreate({ now: () => now });
    now = SENT + 60 * 60_000;
    vi.mocked(env.provider.list).mockResolvedValue([]);
    vi.mocked(env.provider.create).mockRejectedValueOnce(
      new BoatApiError("timeout", "slow", null, null, null)
    );
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow();
    // Made around the replay: the replay's own machine, or a copy made then; nothing says which.
    const made = env.labelled({ resourceId: "bx_late00001", createdAt: minutesAfterSend(61) });
    vi.mocked(env.provider.list).mockResolvedValue([made]);
    const listed = await env.accounts.listResources(env.account.id);
    expect(listed.find((r) => r.resourceId === "bx_late00001")?.boundHostId).toBe("build");
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(UNCLEAR);
    expect(env.provider.create).toHaveBeenCalledTimes(2);
    expect(env.bindingOf("build")!.resourceId).toBeNull();
    await env.lifecycle.deleteMachine("build", null);
    expect(env.provider.delete).not.toHaveBeenCalled();
    expect(env.hosts).toEqual([]);
  });

  it("asks a provider with an idempotency key for no other machine when it can't tell its own apart", async () => {
    const env = await lostCreate();
    vi.mocked(env.provider.list).mockResolvedValue([
      env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) }),
      env.labelled({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(2) }),
    ]);
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(UNCLEAR);
    expect(env.provider.create).toHaveBeenCalledTimes(1);
    expect(env.lifecycle.statuses()[0]?.lastError?.code).toBe("outcome-unknown");
    expect(env.bindingOf("build")!.resourceId).toBeNull();
  });

  it("lists the machine a pending create may have made as that host's, and won't import it", async () => {
    const env = await lostCreate();
    const original = env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) });
    const fork = env.labelled({ resourceId: "bx_fork00001", createdAt: minutesAfterSend(120) });
    const held = resource({ resourceId: "bx_held00001" });
    vi.mocked(env.provider.inspect).mockResolvedValueOnce(held);
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_held00001",
      name: "held",
    });
    vi.mocked(env.provider.list).mockResolvedValue([original, fork, held]);
    const listed = await env.accounts.listResources(env.account.id);
    expect(listed.find((r) => r.resourceId === "bx_orig00001")?.boundHostId).toBe("build");
    expect(listed.find((r) => r.resourceId === "bx_fork00001")?.boundHostId).toBeNull();
    expect(listed.find((r) => r.resourceId === "bx_held00001")?.boundHostId).toBe("held");
    vi.mocked(env.provider.inspect).mockResolvedValueOnce(original);
    await expect(
      env.lifecycle.importMachine({
        accountId: env.account.id,
        resourceId: "bx_orig00001",
        name: "other",
      })
    ).rejects.toThrow(/build is still being set up/);
    expect(env.hosts.map((host) => host.id)).toEqual(["build", "held"]);
  });

  it("refuses an import whose inspect was out while the recovery bound the machine", async () => {
    const env = await lostCreate();
    const original = env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) });
    vi.mocked(env.provider.list).mockResolvedValue([original]);
    let release: () => void = () => {};
    vi.mocked(env.provider.inspect).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return original;
    });
    const importing = env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_orig00001",
      name: "other",
    });
    await vi.waitFor(() => expect(env.provider.inspect).toHaveBeenCalled());
    await env.lifecycle.retryCreate("build");
    expect(env.bindingOf("build")!.resourceId).toBe("bx_orig00001");
    release();
    await expect(importing).rejects.toThrow(/already in your host list as build/);
    await env.lifecycle.deleteMachine("build", "bx_orig00001");
    expect(vi.mocked(env.provider.delete).mock.calls).toEqual([
      [expect.anything(), "bx_orig00001"],
    ]);
    expect(env.hosts).toEqual([]);
  });

  it("never takes a machine an import landed on while the recovery looked, and removal keeps it", async () => {
    const env = await lostCreate();
    const original = env.labelled({ resourceId: "bx_orig00001", createdAt: minutesAfterSend(1) });
    let answer: (rows: ProviderResource[]) => void = () => {};
    vi.mocked(env.provider.list).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    const retrying = env.lifecycle.retryCreate("build");
    await vi.waitFor(() => expect(env.provider.list).toHaveBeenCalled());
    // An inspect that carries no labels, so the import can't see the pending create.
    vi.mocked(env.provider.inspect).mockResolvedValueOnce({ ...original, labels: {} });
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_orig00001",
      name: "other",
    });
    answer([original]);
    await expect(retrying).rejects.toThrow(/already in your host list as other/);
    expect(env.bindingOf("build")!.resourceId).toBeNull();

    vi.mocked(env.provider.list).mockResolvedValue([original]);
    // So what the restart says is its own look's, not the Retry's.
    env.store.updateBinding(env.bindingId, (current) => ({ ...current, lastError: null }));
    const next = env.restart(env.lifecycle);
    try {
      await vi.waitFor(() =>
        expect(
          next.lifecycle.statuses().find((s) => s.hostId === "build")?.lastError?.message
        ).toContain("already in your host list as other")
      );
      // Still unsettled, so removing it warns before a delete it may make.
      expect(next.lifecycle.statuses().find((s) => s.hostId === "build")?.lastError?.code).toBe(
        "outcome-unknown"
      );
      expect(next.store.bindings().find((b) => b.hostId === "build")!.resourceId).toBeNull();
      await next.lifecycle.deleteMachine("build", null);
      expect(env.provider.delete).not.toHaveBeenCalled();
      expect(env.hosts.map((host) => host.id)).toEqual(["other"]);
      expect(next.store.bindings().find((b) => b.hostId === "other")!.resourceId).toBe(
        "bx_orig00001"
      );
    } finally {
      next.lifecycle.dispose();
    }
  });

  it("binds nothing when a same-key replay answers with a machine another host holds", async () => {
    const env = await lostCreate();
    vi.mocked(env.provider.inspect).mockResolvedValueOnce(resource({ resourceId: "bx_orig00001" }));
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_orig00001",
      name: "other",
    });
    vi.mocked(env.provider.list).mockResolvedValue([]);
    vi.mocked(env.provider.create).mockResolvedValueOnce(
      resource({ resourceId: "bx_orig00001", machine: "starting", rawState: "provisioning" })
    );
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(
      /already in your host list as other/
    );
    expect(env.bindingOf("build")!.resourceId).toBeNull();
    await env.lifecycle.deleteMachine("build", null);
    expect(env.provider.delete).not.toHaveBeenCalled();
    expect(env.bindingOf("other")!.resourceId).toBe("bx_orig00001");
  });

  it("deletes the machine a Retry bound while removal was looking", async () => {
    const env = await lostCreate();
    vi.mocked(env.provider.list).mockImplementationOnce(async () => {
      env.store.updateBinding(env.bindingId, (current) => ({
        ...current,
        resourceId: "bx_orig00001",
        creation: null,
      }));
      return [];
    });
    await env.lifecycle.deleteMachine("build", null);
    expect(vi.mocked(env.provider.delete).mock.calls).toEqual([
      [expect.anything(), "bx_orig00001"],
    ]);
    expect(env.hosts).toEqual([]);
  });

  it("never lets removal's older look replace the machine bound while it looked", async () => {
    const env = await lostCreate();
    const seen = env.labelled({ resourceId: "bx_seen00001", createdAt: minutesAfterSend(1) });
    let answer: (rows: ProviderResource[]) => void = () => {};
    vi.mocked(env.provider.list).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    const removing = env.lifecycle.deleteMachine("build", null);
    await vi.waitFor(() => expect(env.provider.list).toHaveBeenCalledTimes(1));
    // Retry is refused while the removal looks; a restart's lookup that began first can still bind.
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(/being removed/);
    env.store.updateBinding(env.bindingId, (current) => ({
      ...current,
      resourceId: "bx_named0001",
      creation: null,
    }));
    answer([seen]);
    await removing;
    expect(vi.mocked(env.provider.delete).mock.calls).toEqual([
      [expect.anything(), "bx_named0001"],
    ]);
    expect(env.hosts).toEqual([]);
  });

  it("fails a Retry that names the machine a provider answered with after the host settled on another", async () => {
    const env = await lostCreate();
    vi.mocked(env.provider.list).mockResolvedValue([]);
    vi.mocked(env.provider.create).mockImplementationOnce(async () => {
      env.store.updateBinding(env.bindingId, (current) => ({
        ...current,
        resourceId: "bx_first0001",
        creation: null,
      }));
      return resource({
        resourceId: "bx_extra0001",
        name: "build-2",
        machine: "starting",
        rawState: "provisioning",
      });
    });
    await expect(env.lifecycle.retryCreate("build")).rejects.toThrow(
      /answered with a machine \(build-2\)/
    );
    expect(env.bindingOf("build")!.resourceId).toBe("bx_first0001");
    expect(env.lifecycle.statuses()[0]?.lastError?.message).toContain("Check your Boat account");
  });

  it("never deletes a machine another host also holds, however the two came to share it", async () => {
    const env = await lostCreate();
    vi.mocked(env.provider.inspect).mockResolvedValueOnce(resource({ resourceId: "bx_orig00001" }));
    await env.lifecycle.importMachine({
      accountId: env.account.id,
      resourceId: "bx_orig00001",
      name: "other",
    });
    // As an earlier version could leave them: the stuck host bound to the same machine.
    env.store.updateBinding(env.bindingId, (current) => ({
      ...current,
      resourceId: "bx_orig00001",
      creation: null,
    }));
    await expect(env.lifecycle.deleteMachine("build", "bx_orig00001")).rejects.toThrow(
      /also in your host list as other/
    );
    expect(env.provider.delete).not.toHaveBeenCalled();
    expect(env.hosts.map((host) => host.id)).toEqual(["build", "other"]);
  });
});
