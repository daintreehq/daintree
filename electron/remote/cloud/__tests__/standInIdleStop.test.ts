// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostConnection, HostDescriptor } from "../../../../shared/types/remoteHosts.js";
import { AppError } from "../../../utils/errorTypes.js";

/** The machine as both its provider and its own host read it, and the stops its host sent. */
const world = vi.hoisted(() => ({
  machine: null as unknown,
  hostStops: 0,
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/nonexistent/daintree-test-user-data" },
}));
vi.mock("../boat/boatMachineDriver.js", () => ({
  boatMachineDriver: () => ({
    inspect: async () => world.machine,
    renew: async () => world.machine,
    stop: async () => {
      world.hostStops += 1;
      world.machine = {
        ...(world.machine as object),
        machine: "stopped",
        rawState: "stopped",
      };
      return null;
    },
    failure: () => ({ kind: "retry" }),
  }),
}));

const { BOAT_PRODUCTION_API_URL, BoatApiError } = await import("../boat/BoatClient.js");
const { BoatProvider } = await import("../boat/BoatProvider.js");
const { CloudAccountService } = await import("../CloudAccountService.js");
const { MemoryCloudCredentialVault } = await import("../CloudCredentialVault.js");
const { CloudGuestPowerOff } = await import("../CloudGuestPowerOff.js");
const { CloudHostLifecycle } = await import("../CloudHostLifecycle.js");
const { CloudHostStore } = await import("../CloudHostStore.js");
const { CloudMachineKeys, MACHINE_KEY_TTL_DAYS } = await import("../CloudMachineKeys.js");
const { CloudSshFiles } = await import("../CloudSshFiles.js");
const { MachineKeeperLinkMethod } = await import("../machineKeeperLink.js");
const { HostIdleTracker } = await import("../../host/HostIdleTracker.js");
const { LinkMethod } = await import("../../host/linkMethods.js");
const { installMachineKeeperHost } = await import("../../host/machineKeeperHost.js");
const { _resetRemoteServicesForTest, getRemoteService, registerRemoteService } =
  await import("../../runtime.js");

import type { CloudProviderId } from "../../../../shared/types/cloudHosts.js";
import type { GuestPowerOffSystem, IdentityCheck } from "../../host/guestPowerOffSystem.js";
import type { LinkSession } from "../../link/session.js";
import type { CloudProvider, GuestPowerOffCheck, ProviderResource } from "../provider.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const IDLE_MINUTES = 30;
const HOST = "host-build";
const ACCOUNT = "ca_abcdefgh";
const BINDING = "cb_abcdefgh";
const TARGET = {
  provider: "aws" as const,
  accountId: "123456789012",
  region: "eu-west-1",
  instanceId: "i-0abc0000000000001",
};
const GCE_TARGET = {
  provider: "gce" as const,
  project: "daintree-test",
  zone: "europe-west1-b",
  instanceId: "1234567890123",
};
const MACHINES = {
  boat: "bx_23456789",
  aws: "eu-west-1/i-0abc0000000000001",
  gce: "europe-west1-b/1234567890123",
} as const;
const ADMIN_MISSING = () =>
  new BoatApiError("forbidden", "missing account.admin", 403, "api_key_action_forbidden", null);
const NEEDS_PASSWORD =
  "The login Daintree runs as on this machine can't power it off without a password, so it can't stop itself when idle.";

type Kind = keyof typeof MACHINES;
type Handler = (payload: unknown) => unknown;

function resource(kind: Kind, overrides: Partial<ProviderResource> = {}): ProviderResource {
  return {
    resourceId: MACHINES[kind],
    name: "build",
    machine: "running",
    rawState: "running",
    machineType: "default",
    vcpu: 4,
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

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-stand-in-"));
  _resetRemoteServicesForTest();
  world.hostStops = 0;
});

const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  _resetRemoteServicesForTest();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * The machine's own host, as Host mode runs it: a real idle clock and the
 * real keepers and handlers, its OS and metadata server played by the test.
 * Its clock stays behind this machine's, which the keepers there read.
 */
function cloudHost() {
  const clock = { wall: Date.now() - 6 * 60 * MINUTE, mono: 1_000 };
  const tracker = new HostIdleTracker({
    read: async () => ({ agents: { active: 0, unreadable: 0 }, shellViews: false }),
    idleAfterMinutes: () => IDLE_MINUTES,
    clock: () => ({ ...clock }),
  });
  registerRemoteService("hostIdle", tracker);
  const os = {
    identity: { ok: true } as IdentityCheck,
    probe: null as string | null,
    powerOffs: 0,
  };
  const system: GuestPowerOffSystem = {
    unsupported: () => null,
    verifyIdentity: async () => os.identity,
    probePowerOff: async () => os.probe,
    preparePowerOff: async () => async () => {
      os.powerOffs += 1;
      return { kind: "accepted" };
    },
    bootId: async () => "boot-1",
    loadArm: async () => null,
    saveArm: async () => {},
  };
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const uninstall = installMachineKeeperHost(
    {
      onSession: (next) => {
        listener = next;
        return () => (listener = null);
      },
    },
    { guestSystem: system }
  );
  cleanups.push(() => {
    uninstall();
    tracker.dispose();
  });
  let summary: { idle: ReturnType<typeof tracker.observation>; sampledAt: number } | null = null;
  return {
    clock,
    os,
    /** A link to the host, as both sides see it; `asked` records each method a Shell called. */
    link() {
      const handlers = new Map<
        string,
        {
          schema: { safeParse(v: unknown): { success: boolean; data?: unknown } };
          handler: Handler;
        }
      >();
      const asked: string[] = [];
      const session = {
        isOpen: true,
        registerCallHandler: (method: string, schema: never, handler: Handler) => {
          handlers.set(method, { schema, handler });
          return () => handlers.delete(method);
        },
        onClose: () => () => {},
        call: async (method: string, payload: unknown) => {
          asked.push(method);
          const entry = handlers.get(method);
          if (!entry) throw new AppError({ code: "UNSUPPORTED", message: `Unknown ${method}` });
          const parsed = entry.schema.safeParse(payload);
          if (!parsed.success) throw new AppError({ code: "VALIDATION", message: "Bad payload" });
          const answer = await entry.handler(parsed.data);
          // While the answer travels back.
          await hooks.beforeAnswer?.(method);
          return answer;
        },
      };
      const hooks: { beforeAnswer: ((method: string) => Promise<void>) | null } = {
        beforeAnswer: null,
      };
      listener!({ session: session as unknown as LinkSession });
      return { session: session as unknown as LinkSession, asked, hooks };
    },
    /** What the host tells its links of its clock, as its summaries do. */
    publish() {
      const observation = tracker.observation();
      const stops =
        getRemoteService("machineKeeper")?.stopsWhenIdle(observation.idleEndsAt) === true ||
        getRemoteService("guestPowerOff")?.stopsWhenIdle() === true;
      summary = {
        idle: stops ? { ...observation, stopsWhenIdle: true } : observation,
        sampledAt: clock.wall,
      };
    },
    summary: () => summary,
    /** Idle from a check now, then past its idle time, and its links told so. */
    async idleTimeEnds() {
      await tracker.check();
      clock.wall += IDLE_MINUTES * MINUTE + MINUTE;
      clock.mono += IDLE_MINUTES * MINUTE + MINUTE;
      this.publish();
    },
    /** The keepers' own passes, as their timers would run them. */
    async keepersPass() {
      await getRemoteService("machineKeeper")?.tick();
      await getRemoteService("guestPowerOff")?.tick();
    },
  };
}

/**
 * A provider as this device's keepers and lifecycle use it: Boat's issuer of
 * machine keys, or EC2's power-off check, with a normal stop.
 */
function provider(kind: Kind) {
  const real = new BoatProvider(() => {
    throw new Error("unused");
  });
  const issue = vi.fn(async () => ({
    keyId: `sak_${issue.mock.calls.length}`,
    secret: `boat_live_machinesecret${issue.mock.calls.length}`,
    expiresAt: Date.now() + MACHINE_KEY_TTL_DAYS * DAY,
  }));
  const check = vi.fn(async (): Promise<GuestPowerOffCheck> => ({
    eligible: true,
    target: kind === "gce" ? GCE_TARGET : TARGET,
  }));
  const stop = vi.fn(async (_credentials: unknown, _resourceId: string, _options?: unknown) => {
    world.machine = resource(kind, { machine: "stopped", rawState: "stopped" });
    return resource(kind, { machine: "stopping", rawState: "stopping" });
  });
  const impl = {
    id: kind,
    info: (platform: NodeJS.Platform) => {
      const info = real.info(platform);
      if (kind === "boat") return info;
      return {
        ...info,
        name: kind === "gce" ? "Compute Engine" : "AWS",
        capabilities: {
          ...info.capabilities,
          persistence: { ...info.capabilities.persistence, retentionDays: null },
          lifetime:
            kind === "gce"
              ? { kind: "fixed-at-create", canChangeWhileStopped: true }
              : { kind: "none" },
        },
      };
    },
    describeError: (error: unknown) => real.describeError(error),
    inspect: vi.fn(async () => world.machine),
    list: vi.fn(async () => [world.machine]),
    stop,
    ...(kind === "boat"
      ? {
          machineKeys: {
            issue,
            revoke: vi.fn(async () => {}),
            findByName: vi.fn(async () => []),
          },
        }
      : { checkGuestPowerOff: check }),
  } as unknown as CloudProvider;
  return { impl, issue, check, stop };
}

/** This device: its store, keychain, keepers and lifecycle, linked to the host. */
async function device(kind: Kind) {
  const host = cloudHost();
  const fake = provider(kind);
  world.machine = resource(kind);
  let backendValue: unknown;
  const store = new CloudHostStore({
    get: () => backendValue,
    set: (_key, value) => {
      backendValue = JSON.parse(JSON.stringify(value));
    },
  });
  const vault = new MemoryCloudCredentialVault();
  const apiUrl = BOAT_PRODUCTION_API_URL;
  const accounts = new CloudAccountService({
    store,
    vault,
    providers: new Map<CloudProviderId, CloudProvider>([[kind, fake.impl]]),
    apiUrlFor: () => apiUrl,
    platform: "darwin",
    now: () => host.clock.wall,
  });
  store.putAccount({
    id: ACCOUNT,
    providerId: kind,
    displayName: "Work",
    identity: "octocat",
    scope:
      kind === "boat"
        ? { kind: "personal", id: "personal", name: "Personal" }
        : { kind: "account", id: TARGET.accountId, name: TARGET.accountId },
    apiUrl,
    keyHint: "abcd",
    credentialRevision: null,
    addedAt: 0,
    validation: { status: "valid", checkedAt: 0 },
    lastProvisioning: null,
    pluginProvider: null,
  });
  await vault.put(ACCOUNT, { apiKey: "account-key" });
  store.putBinding({
    id: BINDING,
    hostId: HOST,
    accountId: ACCOUNT,
    providerId: kind,
    resourceId: MACHINES[kind],
    ownership: "imported",
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
  });
  const descriptor = {
    id: HOST,
    name: "build",
    connection: { kind: "cloud", bindingId: BINDING } as HostConnection,
  } as HostDescriptor;
  let link = host.link();
  const sessionFor = (hostId: string) => (hostId === HOST ? link.session : null);
  const now = () => host.clock.wall;
  const keys = new CloudMachineKeys({
    store,
    accounts,
    hosts: { get: (id) => (id === HOST ? descriptor : null) },
    sessionFor,
    changed: () => {},
    now,
  });
  const guest = new CloudGuestPowerOff({
    store,
    accounts,
    hosts: { get: (id) => (id === HOST ? descriptor : null) },
    sessionFor,
    changed: () => {},
    now,
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
      add: () => descriptor,
      get: (id) => (id === HOST ? descriptor : null),
      list: () => [descriptor],
      forget: async () => {},
      disconnect: async () => {},
      onChange: () => () => {},
    },
    changed: () => {},
    now,
    sleep: async (ms) => {
      host.clock.wall += ms;
      host.clock.mono += ms;
    },
    machineKeys: keys,
    guestPowerOff: guest,
    idleClaims: {
      sessionFor,
      idleOn: (_hostId, asked) => (asked === link.session ? host.summary() : null),
    },
  });
  cleanups.push(() => {
    lifecycle.dispose();
    keys.dispose();
    guest.dispose();
  });
  await lifecycle.refresh(HOST);
  return {
    host,
    fake,
    keys,
    guest,
    lifecycle,
    status: () => lifecycle.statuses()[0]!,
    get link() {
      return link;
    },
    /** This device's keepers on its link, as a link coming up runs them. */
    async armed() {
      await keys.arm(HOST, link.session);
      await guest.arm(HOST, link.session);
    },
    relink() {
      link = host.link();
    },
    standInClaims: () => link.asked.filter((m) => m === LinkMethod.CLAIM_IDLE_STAND_IN).length,
  };
}

describe("stopping a machine from the desktop when its own idle stop was refused (#17924)", () => {
  it("stops a Boat machine refused a key once, on the idle time its host granted, with one send", async () => {
    const env = await device("boat");
    env.fake.issue.mockRejectedValue(ADMIN_MISSING());
    await env.armed();
    expect(env.status().selfStopProblem).toMatch(/can't stop itself when idle/);
    expect(env.status().linkedIdleStop).toEqual({ kind: "stops" });

    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();

    expect(env.standInClaims()).toBe(1);
    expect(env.fake.stop).toHaveBeenCalledTimes(1);
    expect(env.fake.stop.mock.calls[0]![1]).toBe(MACHINES.boat);
    expect(env.fake.stop.mock.calls[0]![2]).toEqual({ once: true });
    expect(env.status()).toMatchObject({ machine: "stopped", operation: null });
    expect(world.hostStops).toBe(0);

    // One idle time, once.
    await env.lifecycle.stopIdleDue();
    expect(env.standInClaims()).toBe(1);
  });

  it("refuses an idle stop through a provider with no stop, as a stop it never sent", async () => {
    const env = await device("boat");
    env.fake.issue.mockRejectedValue(ADMIN_MISSING());
    await env.armed();
    const describeError = vi.spyOn(env.fake.impl, "describeError");
    delete (env.fake.impl as { stop?: unknown }).stop;

    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();

    expect(env.standInClaims()).toBe(1);
    // Never read as a stop whose answer was lost, which would go looking for its outcome.
    expect(describeError).not.toHaveBeenCalled();
    expect(env.status()).toMatchObject({ machine: "running", lastError: null });
  });

  it.each(["aws", "gce"] as const)(
    "stops an %s machine whose login sudo won't let power off, once it confirmed it is that machine",
    async (kind) => {
      const env = await device(kind);
      env.host.os.probe = NEEDS_PASSWORD;
      await env.armed();
      expect(env.status().selfStopProblem).toBe(NEEDS_PASSWORD);
      expect(env.status().linkedIdleStop).toEqual({ kind: "stops" });

      await env.host.idleTimeEnds();
      await env.lifecycle.stopIdleDue();

      expect(env.standInClaims()).toBe(1);
      // Asked again at the provider right before the claim, as well as when the link came up.
      expect(env.fake.check).toHaveBeenCalledTimes(2);
      expect(env.fake.stop).toHaveBeenCalledTimes(1);
      expect(env.fake.stop.mock.calls[0]![1]).toBe(MACHINES[kind]);
      expect(env.fake.stop.mock.calls[0]![2]).toEqual({ once: true });
      expect(env.host.os.powerOffs).toBe(0);
      expect(env.status()).toMatchObject({ machine: "stopped" });
    }
  );

  it("sends no stop on a granted idle time once the machine turned unsuitable while the answer travelled", async () => {
    const env = await device("aws");
    env.host.os.probe = NEEDS_PASSWORD;
    await env.armed();
    await env.host.idleTimeEnds();
    env.link.hooks.beforeAnswer = async (method) => {
      if (method !== LinkMethod.CLAIM_IDLE_STAND_IN) return;
      // The keeper's own look lands first: the instance joined an Auto Scaling group.
      env.fake.check.mockResolvedValue({
        eligible: false,
        target: TARGET,
        problem: "It belongs to an Auto Scaling group, which may replace it once it stops.",
      });
      await env.guest.arm(HOST, env.link.session);
    };
    await env.lifecycle.stopIdleDue();
    expect(env.standInClaims()).toBe(1);
    // Granted to this link, and spent: nobody stops the grouped instance on it.
    expect(getRemoteService("hostIdle")!.mayClaim(Symbol("anyone"))).toBe(false);
    expect(env.fake.stop).not.toHaveBeenCalled();
    expect(env.status().selfStopProblem).toMatch(/Auto Scaling group/);
  });

  it("still stops on a granted idle time when the self-stop was accepted while the answer travelled, once", async () => {
    const env = await device("boat");
    env.fake.issue.mockRejectedValueOnce(ADMIN_MISSING());
    await env.armed();
    await env.host.idleTimeEnds();
    env.link.hooks.beforeAnswer = async (method) => {
      if (method !== LinkMethod.CLAIM_IDLE_STAND_IN) return;
      // The account's key may now make keys: the machine takes one, after the host granted this link.
      env.host.clock.wall += 61 * MINUTE;
      await env.keys.tick();
    };
    await env.lifecycle.stopIdleDue();
    expect(env.status().selfStopProblem).toBeNull();
    expect(env.fake.stop).toHaveBeenCalledTimes(1);
    expect(env.fake.stop.mock.calls[0]![2]).toEqual({ once: true });
    // The idle time was this link's: the machine's own keeper never acts on it.
    await env.host.keepersPass();
    expect(world.hostStops).toBe(0);
  });

  it("never stops a machine whose host answered as another machine, and keeps saying why", async () => {
    const env = await device("aws");
    env.host.os.identity = {
      ok: false,
      definite: true,
      problem:
        "This host runs on another machine than the one Daintree has for it, so it won't power itself off.",
    };
    await env.armed();
    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();

    expect(env.standInClaims()).toBe(0);
    expect(env.fake.stop).not.toHaveBeenCalled();
    expect(env.status().selfStopProblem).toMatch(/runs on another machine/);
    expect(env.status().linkedIdleStop).toBeNull();
  });

  it("never stops an EC2 machine the provider found unsuitable, and keeps saying why", async () => {
    const env = await device("aws");
    env.fake.check.mockResolvedValue({
      eligible: false,
      target: TARGET,
      problem: "It belongs to an Auto Scaling group, which may replace it once it stops.",
    });
    await env.armed();
    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();

    expect(env.standInClaims()).toBe(0);
    expect(env.fake.stop).not.toHaveBeenCalled();
    expect(env.status().selfStopProblem).toMatch(/Auto Scaling group/);
    expect(env.status().linkedIdleStop).toBeNull();
  });

  it("asks no claim for an EC2 machine that turned unsuitable since its last check, and says why", async () => {
    const env = await device("aws");
    env.host.os.probe = NEEDS_PASSWORD;
    await env.armed();
    expect(env.status().linkedIdleStop).toEqual({ kind: "stops" });
    env.fake.check.mockResolvedValue({
      eligible: false,
      target: TARGET,
      problem: "It belongs to an Auto Scaling group, which may replace it once it stops.",
    });

    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();

    expect(env.standInClaims()).toBe(0);
    expect(env.fake.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(env.status().selfStopProblem).toMatch(/Auto Scaling group/));
    expect(env.status().linkedIdleStop).toBeNull();
  });

  it("has the host's permission taken back when the check before the claim finds the machine unsuitable, even if an older look armed it meanwhile", async () => {
    const env = await device("aws");
    env.host.os.probe = NEEDS_PASSWORD;
    await env.armed();
    await env.host.idleTimeEnds();
    const unsuitable = {
      eligible: false as const,
      target: TARGET,
      problem: "It belongs to an Auto Scaling group, which may replace it once it stops.",
    };
    env.fake.check.mockImplementationOnce(async () => {
      // The keeper's own look, with the provider's older answer, arms the host: sudo works now.
      env.host.os.probe = null;
      await env.guest.arm(HOST, env.link.session);
      expect(getRemoteService("guestPowerOff")!.stopsWhenIdle()).toBe(true);
      env.fake.check.mockResolvedValue(unsuitable);
      return unsuitable;
    });
    await env.lifecycle.stopIdleDue();
    expect(env.standInClaims()).toBe(0);
    expect(env.fake.stop).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(getRemoteService("guestPowerOff")!.stopsWhenIdle()).toBe(false));
    expect(env.status().selfStopProblem).toMatch(/Auto Scaling group/);
    await env.host.keepersPass();
    expect(env.host.os.powerOffs).toBe(0);
  });

  it("goes back to the machine stopping itself once its self-stop is accepted, with no stop from here", async () => {
    // Boat: the account's key may make keys an hour on.
    const boat = await device("boat");
    boat.fake.issue.mockRejectedValueOnce(ADMIN_MISSING());
    await boat.armed();
    expect(boat.status().linkedIdleStop).toEqual({ kind: "stops" });
    boat.host.clock.wall += 61 * MINUTE;
    await boat.keys.tick();
    expect(boat.fake.issue).toHaveBeenCalledTimes(2);
    expect(boat.status().selfStopProblem).toBeNull();
    expect(boat.status().linkedIdleStop).toBeNull();

    await boat.host.idleTimeEnds();
    expect(boat.host.summary()!.idle.stopsWhenIdle).toBe(true);
    await boat.lifecycle.stopIdleDue();
    await boat.host.keepersPass();
    expect(boat.standInClaims()).toBe(0);
    expect(boat.fake.stop).not.toHaveBeenCalled();
    expect(world.hostStops).toBe(1);
  });

  it("goes back to an EC2 machine powering itself off once sudo lets it, with no stop from here", async () => {
    const ec2 = await device("aws");
    ec2.host.os.probe = NEEDS_PASSWORD;
    await ec2.armed();
    expect(ec2.status().linkedIdleStop).toEqual({ kind: "stops" });
    ec2.host.os.probe = null;
    ec2.host.clock.wall += 6 * MINUTE;
    await ec2.guest.tick();
    expect(ec2.status().selfStopProblem).toBeNull();
    expect(ec2.status().linkedIdleStop).toBeNull();

    await ec2.host.idleTimeEnds();
    await ec2.lifecycle.stopIdleDue();
    await ec2.host.keepersPass();
    expect(ec2.standInClaims()).toBe(0);
    expect(ec2.fake.stop).not.toHaveBeenCalled();
    expect(ec2.host.os.powerOffs).toBe(1);
  });

  it("leaves the idle time to the host's keeper once another device armed it after the last summary", async () => {
    const env = await device("boat");
    env.fake.issue.mockRejectedValue(ADMIN_MISSING());
    await env.armed();
    await env.host.idleTimeEnds();
    expect(env.host.summary()!.idle.stopsWhenIdle).toBeUndefined();

    // The keeper's own pass reads this machine's clock: held back until this device has asked.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(env.host.clock.wall - 60 * MINUTE);
      // Another device, with a key that may make machine keys, hands the host one now.
      const other = env.host.link();
      await other.session.call(MachineKeeperLinkMethod.ARM, {
        grantId: "mk_otherdevice",
        provider: "boat",
        apiUrl: BOAT_PRODUCTION_API_URL,
        scope: "personal",
        resourceId: MACHINES.boat,
        secret: "boat_live_otherdevicesecret",
        expiresAt: Date.now() + 20 * DAY,
      });
      await env.lifecycle.stopIdleDue();
      expect(env.standInClaims()).toBe(1);
      expect(env.fake.stop).not.toHaveBeenCalled();

      vi.setSystemTime(env.host.clock.wall + MINUTE);
      await env.host.keepersPass();
      expect(world.hostStops).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says this device stops it only on the link its keeper found the refusal on", async () => {
    const env = await device("boat");
    env.fake.issue.mockRejectedValue(ADMIN_MISSING());
    await env.armed();
    expect(env.status().linkedIdleStop).toEqual({ kind: "stops" });
    env.relink();
    expect(env.status().linkedIdleStop).toBeNull();
    await env.host.idleTimeEnds();
    await env.lifecycle.stopIdleDue();
    expect(env.standInClaims()).toBe(0);
    // The new link's host still holds no key: the refusal carries over without another key asked for.
    await env.armed();
    expect(env.fake.issue).toHaveBeenCalledTimes(1);
    expect(env.status().linkedIdleStop).toEqual({ kind: "stops" });
  });
});
