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
import type { LinkSession } from "../../link/session.js";
import type { SecretCipher } from "../../../services/plugin/secretCipher.js";

vi.mock("electron", () => ({ app: undefined, safeStorage: {} }));

const {
  bindPluginCloudProvider,
  clearPluginCloudProviders,
  publishPluginCloudProviders,
  setPluginCloudProviderRuntime,
} = await import("../../../services/plugin/pluginCloudProviders.js");
const { PluginCloudProviderTransportError } =
  await import("../../../services/plugin/pluginCloudProviderCalls.js");
const { pluginCloudConsentFingerprint } =
  await import("../../../services/plugin/pluginCloudProviderConsent.js");
const { CloudAccountService } = await import("../CloudAccountService.js");
const { KeychainCloudCredentialVault } = await import("../CloudCredentialVault.js");
const { CloudHostLifecycle } = await import("../CloudHostLifecycle.js");
const { CloudHostStore } = await import("../CloudHostStore.js");
const { CloudProviderRegistry } = await import("../CloudProviderRegistry.js");
const { CloudSshFiles } = await import("../CloudSshFiles.js");
const { watchPluginCloudProviders } = await import("../pluginCloudProviderRegistrations.js");
const { HostIdleTracker } = await import("../../host/HostIdleTracker.js");
const { LinkMethod } = await import("../../host/linkMethods.js");

const PLUGIN = "acme.clouds";
const PROVIDER = "acme.clouds.vm";
const ACCOUNT = "ca_acmeplugin1";
const RESOURCE = "vm-0123456789";
const START = Date.parse("2026-11-18T12:00:00Z");
const IDLE_MINUTES = 30;
const CREDENTIALS = { apiKey: "acme-key-0001" };

type Persistence = CloudProviderContribution["capabilities"]["persistence"];

function contribution(persistence: Partial<Persistence> = {}): CloudProviderContribution {
  return {
    id: "vm",
    name: "Acme VMs",
    description: "Machines on your Acme account.",
    apiUrl: "https://api.acme.example",
    apiKeyUrl: "https://acme.example/keys",
    dashboardUrl: "https://acme.example/console",
    docsUrl: "https://acme.example/docs",
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
        kept: "Its disk",
        lost: "Memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: true,
        ...persistence,
      },
      typicalStartSeconds: 60,
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
    resourceId: RESOURCE,
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "standard-2",
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

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-idle-stop-"));
});

afterEach(async () => {
  clearPluginCloudProviders();
  await fs.rm(root, { recursive: true, force: true });
});

/** One clock for the host, the provider and every device, which the tests move. */
function worldClock() {
  const clock = { wall: START, mono: 0 };
  return {
    now: () => clock.wall,
    stamp: () => ({ wall: clock.wall, mono: clock.mono }),
    advance(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
    },
  };
}

/**
 * The plugin's provider, bound once: a machine whose state the test sets,
 * and a stop that by default reports it stopping and then stopped.
 */
function acmePlugin(persistence: Partial<Persistence> = {}) {
  const declared = contribution(persistence);
  setPluginCloudProviderRuntime({
    activate: async () => {},
    isActivated: () => true,
    unavailableReason: () => "",
    startFailure: () => null,
  });
  let current = machine();
  const impl = {
    checkCredentials: vi.fn(async () => ({ identity: "octocat", scopes: [] })),
    validate: vi.fn(async () => ({ identity: "octocat" })),
    catalog: vi.fn(),
    list: vi.fn(async () => [current]),
    inspect: vi.fn(async () => current),
    create: vi.fn(),
    start: vi.fn(async () => current),
    stop: vi.fn(async (): Promise<CloudProviderResource> => {
      current = machine({ machine: "stopping", rawState: "stopping" });
      const answer = current;
      // The next read finds it stopped.
      current = machine({
        machine: "stopped",
        rawState: "stopped",
        stoppedAt: "2026-11-18T13:00:00Z",
      });
      return answer;
    }),
    rename: vi.fn(),
    delete: vi.fn(),
    sshAccess: vi.fn(async () => ({
      user: "ubuntu",
      endpoint: { host: "203.0.113.9", port: 22 },
      hostKey: null,
    })),
  };
  publishPluginCloudProviders(PLUGIN, [declared], "Acme Clouds");
  bindPluginCloudProvider(PLUGIN, "vm", impl as unknown as CloudProviderImpl);
  return {
    impl,
    consent: () => ({
      pluginId: PLUGIN,
      fingerprint: pluginCloudConsentFingerprint([
        { providerId: PROVIDER, contribution: declared },
      ]),
      approvedAt: START,
    }),
    current: () => current,
    setMachine: (next: CloudProviderResource) => {
      current = next;
    },
  };
}

/**
 * The machine's host: a real idle tracker on the shared clock, reading what
 * the test says is there, and the claim it answers on each link as Host mode
 * does. `summary` is what the host last told its links of its clock.
 */
function fakeHost(clock: ReturnType<typeof worldClock>) {
  let reading = { agents: { active: 0, unreadable: 0 }, shellViews: false };
  const tracker = new HostIdleTracker({
    read: async () => reading,
    idleAfterMinutes: () => IDLE_MINUTES,
    clock: clock.stamp,
  });
  let summary: { idle: ReturnType<typeof tracker.observation>; sampledAt: number } | null = null;
  const claims = vi.fn();
  return {
    tracker,
    claims,
    setWork(active: number) {
      reading = { agents: { active, unreadable: 0 }, shellViews: false };
    },
    /** A summary taken now, as every link hears it. */
    publish() {
      summary = { idle: tracker.observation(), sampledAt: clock.now() };
    },
    summary: () => summary,
    /** A link to the host, claiming as itself; `unsupported` answers as a host from before the claim. */
    link(options: { unsupported?: boolean; beforeAnswer?: () => Promise<void> } = {}) {
      const claimant = Symbol("shell-link");
      const session = {
        isOpen: true,
        call: async (method: string) => {
          if (method !== LinkMethod.CLAIM_IDLE) throw new Error(`unexpected ${method}`);
          claims(session);
          if (options.unsupported) {
            throw Object.assign(new Error("Unknown method"), { code: "UNSUPPORTED" });
          }
          const fresh = await tracker.checkFresh();
          const granted = session.isOpen && tracker.tryClaim(fresh, claimant);
          await options.beforeAnswer?.();
          return { granted };
        },
      };
      return session;
    },
  };
}

/** One device: its own store, keychain and lifecycle, linked to the host over `session`. */
function device(
  name: string,
  clock: ReturnType<typeof worldClock>,
  host: ReturnType<typeof fakeHost>,
  session: { isOpen: boolean } | null
) {
  const dir = path.join(root, name);
  const backend: { value: unknown } = { value: undefined };
  const store = new CloudHostStore({
    get: () => backend.value,
    set: (_key, value) => {
      backend.value = JSON.parse(JSON.stringify(value));
    },
  });
  const registry = new CloudProviderRegistry();
  const vault = new KeychainCloudCredentialVault(
    path.join(dir, "cloud-credentials.json"),
    fakeCipher()
  );
  const watch = watchPluginCloudProviders({ providers: registry, statusChanged: () => {} });
  const accounts = new CloudAccountService({
    store,
    vault,
    providers: registry,
    apiUrlFor: (id) => registry.apiUrlFor(id),
    platform: "darwin",
    now: clock.now,
    unavailableReason: (id) => watch.unavailableReason(id),
    pluginConsent: (id) => watch.consentSubject(id),
    pluginProviderLabel: (id) => watch.label(id),
  });
  const hosts: HostDescriptor[] = [];
  const link = { session };
  const idleOn = vi.fn((_hostId: string, asked: LinkSession) =>
    asked === (link.session as unknown) ? host.summary() : null
  );
  const lifecycle = new CloudHostLifecycle({
    store,
    accounts,
    files: new CloudSshFiles(path.join(dir, "cloud"), (async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      spawnError: null,
      timedOut: false,
    })) as never),
    clientDir: dir,
    hosts: {
      add: (hostName: string, connection: HostConnection) => {
        const descriptor = { id: `host-${hostName}`, name: hostName, connection } as HostDescriptor;
        hosts.push(descriptor);
        return descriptor;
      },
      get: (id) => hosts.find((entry) => entry.id === id) ?? null,
      list: () => hosts,
      forget: async () => {},
      disconnect: async () => {},
      onChange: () => () => {},
    },
    changed: () => {},
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    idleClaims: {
      sessionFor: () => (link.session as LinkSession | null) ?? null,
      idleOn,
    },
  });
  return {
    store,
    vault,
    accounts,
    lifecycle,
    link,
    idleOn,
    dispose: () => {
      watch.dispose();
      lifecycle.dispose();
    },
  };
}

/** An account kept from earlier, and the machine imported as a host on it. */
async function withMachine(
  env: ReturnType<typeof device>,
  plugin: ReturnType<typeof acmePlugin>
): Promise<string> {
  env.store.putAccount(
    {
      id: ACCOUNT,
      providerId: PROVIDER,
      displayName: "Work",
      identity: "octocat",
      scope: { kind: "personal", id: "personal", name: "Personal" },
      apiUrl: "https://api.acme.example",
      keyHint: "0001",
      credentialRevision: "rev-1",
      addedAt: START,
      validation: { status: "valid", checkedAt: START },
      lastProvisioning: null,
      pluginProvider: null,
    },
    plugin.consent()
  );
  await env.vault.put(ACCOUNT, CREDENTIALS);
  const { hostId } = await env.lifecycle.importMachine({
    accountId: ACCOUNT,
    resourceId: RESOURCE,
    name: "build",
  });
  return hostId;
}

/** The host saw no work, then stayed idle past its idle time, and told its links so. */
async function idleTimeEnds(
  clock: ReturnType<typeof worldClock>,
  host: ReturnType<typeof fakeHost>
) {
  await host.tracker.check();
  clock.advance(IDLE_MINUTES * 60_000 + 1_000);
  host.publish();
}

describe("stopping an idle plugin provider's machine from the desktop (#17923)", () => {
  it("stops a machine once with the provider's normal stop when the host grants its ended idle time", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    const hostId = await withMachine(env, plugin);
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toEqual({ kind: "stops" });

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();

    expect(host.claims).toHaveBeenCalledTimes(1);
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    expect(plugin.impl.stop.mock.calls[0]![1]).toBe(RESOURCE);
    expect(env.lifecycle.statuses()[0]).toMatchObject({
      hostId,
      machine: "stopped",
      operation: null,
    });
    // Not the person's choice: what they last asked of the machine stays theirs.
    expect(env.store.bindings()[0]!.intent).not.toBe("stop");

    // The same idle time, heard again, is never asked about or acted on twice.
    host.publish();
    await env.lifecycle.stopIdleDue();
    expect(host.claims).toHaveBeenCalledTimes(1);
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    expect(plugin.impl.start).not.toHaveBeenCalled();
    env.dispose();
  });

  it("leaves a host that turned busy running: its fresh reading refuses the claim", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);

    await idleTimeEnds(clock, host);
    // An agent starts working after the summary that said the idle time ended.
    host.setWork(1);
    await env.lifecycle.stopIdleDue();

    expect(host.claims).toHaveBeenCalledTimes(1);
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    expect(env.lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null });
    env.dispose();
  });

  it("asks nothing of a host whose summary says it's in use", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);

    host.setWork(1);
    await host.tracker.check();
    clock.advance(IDLE_MINUTES * 60_000 + 1_000);
    host.publish();
    await env.lifecycle.stopIdleDue();

    expect(host.claims).not.toHaveBeenCalled();
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    env.dispose();
  });

  it("leaves a machine running on a provider whose stop still bills compute, reading nothing of its host", async () => {
    const clock = worldClock();
    const plugin = acmePlugin({ stoppedComputeBilled: true });
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toBeNull();

    await idleTimeEnds(clock, host);
    plugin.impl.inspect.mockClear();
    await env.lifecycle.stopIdleDue();

    expect(env.idleOn).not.toHaveBeenCalled();
    expect(host.claims).not.toHaveBeenCalled();
    expect(plugin.impl.inspect).not.toHaveBeenCalled();
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    env.dispose();
  });

  it("leaves a provider that doesn't keep a stopped machine's disk alone", async () => {
    const clock = worldClock();
    const plugin = acmePlugin({ retentionDays: 0 });
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();

    expect(host.claims).not.toHaveBeenCalled();
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    env.dispose();
  });

  it("never stops a machine whose snapshots are off, or one the provider sleeps by itself", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    const hostId = await withMachine(env, plugin);
    // Turned off since it was imported, as the provider now reports it.
    plugin.setMachine(machine({ snapshotsDisabled: true }));
    await env.lifecycle.refresh(hostId);
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toEqual({
      kind: "blocked",
      problem: expect.stringContaining("snapshots are off"),
    });

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();
    expect(host.claims).not.toHaveBeenCalled();

    // Sleeping turned on since it was last read: the read before asking catches it.
    plugin.setMachine(machine());
    await env.lifecycle.refresh(hostId);
    plugin.setMachine(machine({ idleSleep: { enabled: true, idleSeconds: 900 } }));
    await env.lifecycle.stopIdleDue();
    expect(host.claims).not.toHaveBeenCalled();
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toBeNull();
    env.dispose();
  });

  it("settles a stop whose answer was lost by reading the machine, sending it once", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);
    plugin.impl.stop.mockImplementationOnce(async () => {
      // It reached the provider, which began stopping it; the answer never came back.
      plugin.impl.inspect.mockImplementationOnce(async () =>
        machine({ machine: "stopping", rawState: "stopping" })
      );
      plugin.setMachine(machine({ machine: "stopped", rawState: "stopped" }));
      throw new PluginCloudProviderTransportError(
        "Couldn't reach Acme VMs: the plugin stopped before it answered."
      );
    });

    await idleTimeEnds(clock, host);
    const reads = plugin.impl.inspect.mock.calls.length;
    await env.lifecycle.stopIdleDue();

    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    expect(plugin.impl.inspect.mock.calls.length).toBeGreaterThan(reads + 1);
    expect(env.lifecycle.statuses()[0]).toMatchObject({
      machine: "stopped",
      operation: null,
      lastError: null,
    });
    env.dispose();
  });

  it("gives up on a lost stop answer while the machine still reads as running, and never sends it again", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);
    plugin.impl.stop.mockImplementationOnce(async () => {
      throw new PluginCloudProviderTransportError(
        "Couldn't reach Acme VMs: no answer within 30 seconds."
      );
    });

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();

    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    const [status] = env.lifecycle.statuses();
    expect(status).toMatchObject({ machine: "running", operation: null });
    expect(status!.lastError).toMatchObject({ code: "outcome-unknown" });
    expect(status!.lastError!.message).toContain("no second stop was sent");

    // The idle time stays spent here: later passes read, and never send again.
    host.publish();
    await env.lifecycle.stopIdleDue();
    clock.advance(60_000);
    host.publish();
    await env.lifecycle.stopIdleDue();
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    expect(host.claims).toHaveBeenCalledTimes(1);
    env.dispose();
  });

  it("records a stop the provider refused after one read, with nothing more sent", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    await withMachine(env, plugin);
    plugin.impl.stop.mockImplementationOnce(async () => {
      throw Object.assign(new Error("The key can't stop machines."), { code: "permission" });
    });

    await idleTimeEnds(clock, host);
    const reads = plugin.impl.inspect.mock.calls.length;
    await env.lifecycle.stopIdleDue();

    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    // The read before asking, and the one that settles the refusal.
    expect(plugin.impl.inspect.mock.calls.length).toBe(reads + 2);
    const [status] = env.lifecycle.statuses();
    expect(status).toMatchObject({ machine: "running", operation: null });
    expect(status!.lastError).toMatchObject({ code: "permission" });
    expect(status!.lastError!.message).toContain("The key can't stop machines.");
    env.dispose();
  });

  it("lets only one of two linked devices stop the machine, once", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    // Whoever is answered first waits for the other to ask: both read the machine running, and both ask.
    let bothAsked!: () => void;
    const asked = new Promise<void>((resolve) => (bothAsked = resolve));
    host.claims.mockImplementation(() => {
      if (host.claims.mock.calls.length === 2) bothAsked();
    });
    const a = device("a", clock, host, host.link({ beforeAnswer: () => asked }));
    const b = device("b", clock, host, host.link({ beforeAnswer: () => asked }));
    await withMachine(a, plugin);
    await withMachine(b, plugin);

    await idleTimeEnds(clock, host);
    await Promise.all([a.lifecycle.stopIdleDue(), b.lifecycle.stopIdleDue()]);

    expect(host.claims).toHaveBeenCalledTimes(2);
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    const machines = [a, b].map((env) => env.lifecycle.statuses()[0]!.machine);
    expect(machines).toContain("stopped");
    a.dispose();
    b.dispose();
  });

  it("lets a person's Stop join an idle stop under way, sending nothing more and recording their choice", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link());
    const hostId = await withMachine(env, plugin);
    let answer!: () => void;
    plugin.impl.stop.mockImplementationOnce(
      () =>
        new Promise<CloudProviderResource>((resolve) => {
          answer = () => {
            plugin.setMachine(machine({ machine: "stopped", rawState: "stopped" }));
            resolve(machine({ machine: "stopping", rawState: "stopping" }));
          };
        })
    );

    await idleTimeEnds(clock, host);
    const idleStop = env.lifecycle.stopIdleDue();
    await vi.waitFor(() => expect(plugin.impl.stop).toHaveBeenCalledTimes(1));
    expect(env.lifecycle.statuses()[0]!.operation?.kind).toBe("stopping");
    const personal = env.lifecycle.stopMachine(hostId);
    await vi.waitFor(() => expect(env.store.bindings()[0]!.intent).toBe("stop"));
    answer();
    await Promise.all([idleStop, personal]);

    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    expect(env.lifecycle.statuses()[0]).toMatchObject({ machine: "stopped", operation: null });
    env.dispose();
  });

  it("sends nothing when a person's Start begins while the host decides", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    let startedMeanwhile: Promise<void> | null = null;
    const env = device("a", clock, host, null);
    const hostId = await withMachine(env, plugin);
    env.link.session = host.link({
      beforeAnswer: async () => {
        // The machine reads as running, so the person's Start only checks it, and ends.
        startedMeanwhile = env.lifecycle.startMachine(hostId);
        await startedMeanwhile;
      },
    });

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();

    expect(startedMeanwhile).not.toBeNull();
    expect(host.claims).toHaveBeenCalledTimes(1);
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    expect(env.lifecycle.statuses()[0]).toMatchObject({ machine: "running", operation: null });
    env.dispose();
  });

  it("asks nothing while a person's operation is under way, or the link is down", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, null);
    const hostId = await withMachine(env, plugin);
    await idleTimeEnds(clock, host);

    // No link: the host's summary can't be its word now.
    await env.lifecycle.stopIdleDue();
    expect(host.claims).not.toHaveBeenCalled();

    // A person's Stop, held at the provider.
    env.link.session = host.link();
    let release!: () => void;
    plugin.impl.stop.mockImplementationOnce(
      () =>
        new Promise<CloudProviderResource>((resolve) => {
          release = () => resolve(machine({ machine: "stopped", rawState: "stopped" }));
        })
    );
    const stopping = env.lifecycle.stopMachine(hostId);
    await vi.waitFor(() => expect(plugin.impl.stop).toHaveBeenCalledTimes(1));
    await env.lifecycle.stopIdleDue();
    expect(host.claims).not.toHaveBeenCalled();
    plugin.setMachine(machine({ machine: "stopped", rawState: "stopped" }));
    release();
    await stopping;
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    env.dispose();
  });

  it("says when the host's Daintree is too old to grant the claim, on that link only", async () => {
    const clock = worldClock();
    const plugin = acmePlugin();
    const host = fakeHost(clock);
    const env = device("a", clock, host, host.link({ unsupported: true }));
    await withMachine(env, plugin);

    await idleTimeEnds(clock, host);
    await env.lifecycle.stopIdleDue();
    expect(plugin.impl.stop).not.toHaveBeenCalled();
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toEqual({
      kind: "blocked",
      problem: expect.stringContaining("too old"),
    });
    // Asked once on that link, however often its summary comes.
    clock.advance(60_000);
    host.publish();
    await env.lifecycle.stopIdleDue();
    expect(host.claims).toHaveBeenCalledTimes(1);

    // A new link, to an updated host, is asked afresh.
    env.link.session = host.link();
    expect(env.lifecycle.statuses()[0]!.linkedIdleStop).toEqual({ kind: "stops" });
    await env.lifecycle.stopIdleDue();
    expect(plugin.impl.stop).toHaveBeenCalledTimes(1);
    env.dispose();
  });
});
