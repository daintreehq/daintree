import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import type {
  CloudHostCreatedFor,
  CloudHostCreateRequest,
  CloudHostImportRequest,
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
import { CloudHostStore, type CloudHostsValue } from "../CloudHostStore.js";
import { CloudSshFiles } from "../CloudSshFiles.js";
import type { CloudProvider, ProviderCatalog, ProviderResource } from "../provider.js";
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

function fakeProvider(
  state: { machine: ProviderResource },
  sshTrust?: CloudSshTrust,
  transport?: CloudSshTransport
): CloudProvider {
  const real = new BoatProvider(() => {
    throw new Error("unused");
  });
  return {
    id: "boat",
    info: (platform) => {
      const info = real.info(platform);
      return {
        ...info,
        capabilities: {
          ...info.capabilities,
          sshTrust: sshTrust ?? info.capabilities.sshTrust,
          transport: transport ?? info.capabilities.transport,
        },
      };
    },
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
      hostKey: sshTrust === "confirm-on-first-connect" ? null : HOST_KEY,
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
  options: {
    activity?: () => Activity;
    now?: () => number;
    adapt?: (provider: CloudProvider) => void;
    sshTrust?: CloudSshTrust;
    transport?: CloudSshTransport;
  } = {}
) {
  const state = { machine: resource(initial) };
  const provider = fakeProvider(state, options.sshTrust, options.transport);
  options.adapt?.(provider);
  /** What ssh-keyscan prints for the machine; `byTypes` answers a scan of named algorithms. */
  const scan: { output: string; byTypes: Record<string, string> } = {
    output: `[203.0.113.10]:22001 ${HOST_KEY}\n`,
    byTypes: {},
  };
  let backendValue: unknown;
  const backend = {
    get: () => backendValue,
    set: (_key: "cloudHosts", value: CloudHostsValue) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  };
  // What outlives a restart: the settings file, the keychain and the host list.
  const vault = new MemoryCloudCredentialVault();
  const hosts: HostDescriptor[] = [];
  const listeners = new Set<() => void>();
  const disconnect = vi.fn(async () => {});
  const run = vi.fn(async (cmd: string, args: string[]) => {
    if (cmd.endsWith("ssh-keyscan")) {
      const types = args[args.indexOf("-t") + 1]!;
      const stdout = scan.byTypes[types] ?? scan.output;
      return { code: 0, stdout, stderr: "", spawnError: null, timedOut: false };
    }
    const keyPath = args[args.length - 1]!;
    await fs.writeFile(keyPath, "PRIVATE");
    await fs.writeFile(`${keyPath}.pub`, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClient daintree");
    return { code: 0, stdout: "", stderr: "", spawnError: null, timedOut: false };
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
    return { store, accounts, lifecycle };
  };
  const { store, accounts, lifecycle } = build();
  const account = await accounts.addAccount({
    providerId: "boat",
    apiKey: "boat_live_x",
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
    run.mock.calls.filter((call) => String(call[0]).endsWith("ssh-keyscan")).length;

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
    await expect(env.lifecycle.ensureAccess(env.bindingId)).rejects.toBeInstanceOf(
      UnusableConnectionError
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
      if (made) state.machine = resource({ name: "build-box", labels: sent.labels });
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
