// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderResource } from "../../cloud/provider.js";

const driver = vi.hoisted(() => ({
  inspect: null as null | (() => Promise<unknown>),
  stop: null as null | (() => Promise<unknown>),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/nonexistent/daintree-test-user-data" },
}));
vi.mock("../../cloud/boat/boatMachineDriver.js", () => ({
  boatMachineDriver: () => ({
    inspect: () => driver.inspect!(),
    renew: vi.fn(),
    stop: () => driver.stop!(),
    failure: () => ({ kind: "retry" }),
  }),
}));

import { BOAT_PRODUCTION_API_URL } from "../../cloud/boat/BoatClient.js";
import {
  GUEST_POWER_OFF_METHOD,
  KeepAwakeLinkMethod,
  MachineKeeperLinkMethod,
} from "../../cloud/machineKeeperLink.js";
import type { GuestPowerOffSystem, StoredGuestPowerOff } from "../guestPowerOffSystem.js";
import { HostIdleTracker, type HostWorkReading } from "../HostIdleTracker.js";
import type { KeepAwakeListener } from "../KeepAwakeKeeper.js";
import { LinkMethod } from "../linkMethods.js";
import type { LinkSession } from "../../link/session.js";
import {
  _resetRemoteServicesForTest,
  getRemoteService,
  registerRemoteService,
} from "../../runtime.js";
import { installMachineKeeperHost } from "../machineKeeperHost.js";

type Handler = (payload: unknown) => unknown;

function linkedHost(
  guestSystem?: GuestPowerOffSystem,
  keepAwake?: { listen: () => Promise<KeepAwakeListener>; fetch?: typeof fetch }
) {
  const handlers = new Map<
    string,
    { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; handler: Handler }
  >();
  const session = {
    registerCallHandler: (method: string, schema: never, handler: Handler) => {
      handlers.set(method, { schema, handler });
      return () => handlers.delete(method);
    },
    onClose: () => () => {},
  } as unknown as LinkSession;
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const dispose = installMachineKeeperHost(
    {
      onSession: (next) => {
        listener = next;
        return () => (listener = null);
      },
    },
    { ...(guestSystem ? { guestSystem } : {}), ...(keepAwake ? { keepAwake } : {}) }
  );
  listener!({ session });
  /** As the link would: the payload checked against the method's schema, then handled. */
  const call = async (method: string, payload: unknown) => {
    const entry = handlers.get(method)!;
    const parsed = entry.schema.safeParse(payload);
    if (!parsed.success) throw new Error("VALIDATION");
    return entry.handler(parsed.data);
  };
  return { call, dispose };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  grantId: "mk_1",
  provider: "boat",
  apiUrl: BOAT_PRODUCTION_API_URL,
  scope: "personal",
  resourceId: "bx_23456789",
  secret: "boat_live_machinesecret",
  expiresAt: Date.now() + 86_400_000,
  ...overrides,
});

beforeEach(() => {
  _resetRemoteServicesForTest();
  registerRemoteService("hostIdle", {
    observation: () => ({ idleAfterMinutes: 30, lastWorkAt: 0, busy: true, idleEndsAt: null }),
    checkFresh: async () => {},
    noteWork: () => {},
  } as never);
  driver.inspect = async () => ({ machine: "running", stop: null }) as unknown as ProviderResource;
  driver.stop = async () => null;
});

afterEach(() => {
  _resetRemoteServicesForTest();
});

describe("installMachineKeeperHost (#17361)", () => {
  it("refuses a key for another provider, another Boat, or something that isn't a Boat machine", async () => {
    const host = linkedHost();
    for (const bad of [
      { provider: "acme" },
      { apiUrl: "https://boat.example/api/v1" },
      { resourceId: "i-0123456789" },
    ]) {
      await expect(host.call(MachineKeeperLinkMethod.ARM, request(bad))).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    await expect(host.call(MachineKeeperLinkMethod.STATUS, null)).resolves.toMatchObject({
      grantId: null,
    });
    host.dispose();
  });

  it("answers what it holds only once a key handed over before the question is settled", async () => {
    let release: (() => void) | null = null;
    driver.inspect = () =>
      new Promise((resolve) => {
        release = () => resolve({ machine: "running", stop: null });
      });
    const host = linkedHost();
    const armed = host.call(MachineKeeperLinkMethod.ARM, request());
    const status = host.call(MachineKeeperLinkMethod.STATUS, null);
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await armed;
    await expect(status).resolves.toMatchObject({ grantId: "mk_1" });
    host.dispose();
  });

  it("takes the power-off permission for an EC2 or Compute Engine machine, and nothing else, over the link", async () => {
    const system = guestSystem();
    const host = linkedHost(system);
    const aws = {
      provider: "aws",
      accountId: "123456789012",
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    };
    const gce = {
      provider: "gce",
      project: "daintree-build",
      zone: "us-central1-a",
      instanceId: "9007199254740993123",
    };
    for (const target of [aws, gce]) {
      await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: true })).resolves.toEqual({
        armed: true,
        problem: null,
      });
      await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: false })).resolves.toEqual({
        armed: false,
        problem: null,
      });
    }
    // Anything that could carry a credential, or a machine named loosely, is turned away by the schema.
    for (const bad of [
      { target: aws, enabled: true, secret: "x" },
      { target: { ...aws, accessKeyId: "AKIA" }, enabled: true },
      { target: { ...aws, instanceId: "i-../../etc" }, enabled: true },
      { target: { ...gce, instanceId: "12ab" }, enabled: true },
      { target: { ...gce, serviceAccountKey: "{}" }, enabled: true },
      { target: { ...aws, provider: "boat" }, enabled: true },
    ]) {
      await expect(host.call(GUEST_POWER_OFF_METHOD, bad)).rejects.toThrow("VALIDATION");
    }
    expect(system.verifyIdentity).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("takes back up, with no Shell, a permission saved earlier in this boot", async () => {
    const target = {
      provider: "aws" as const,
      accountId: "123456789012",
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    };
    const system = guestSystem({ bootId: "boot-a", target });
    const host = linkedHost(system);
    await vi.waitFor(() =>
      expect(system.verifyIdentity).toHaveBeenCalledWith(target, expect.anything())
    );
    await expect(host.call(GUEST_POWER_OFF_METHOD, { target, enabled: false })).resolves.toEqual({
      armed: false,
      problem: null,
    });
    host.dispose();
  });
});

const QUIET: HostWorkReading = { agents: { active: 0, unreadable: 0 }, shellViews: false };

/** A host whose links each ask through their own handlers, over one real idle clock. */
function claimingHost(
  readFresh: () => Promise<HostWorkReading> = async () => QUIET,
  system: GuestPowerOffSystem = guestSystem()
) {
  const clock = { wall: 1_000_000, mono: 500 };
  const tracker = new HostIdleTracker({
    read: async () => QUIET,
    readFresh,
    idleAfterMinutes: () => 30,
    clock: () => ({ ...clock }),
  });
  registerRemoteService("hostIdle", tracker);
  let listener: ((ctx: { session: LinkSession }) => void) | null = null;
  const dispose = installMachineKeeperHost(
    {
      onSession: (next) => {
        listener = next;
        return () => (listener = null);
      },
    },
    { guestSystem: system }
  );
  const link = () => {
    const handlers = new Map<
      string,
      { schema: { safeParse(v: unknown): { success: boolean; data?: unknown } }; handler: Handler }
    >();
    const closers = new Set<() => void>();
    let open = true;
    const session = {
      get isOpen() {
        return open;
      },
      registerCallHandler: (method: string, schema: never, handler: Handler) => {
        handlers.set(method, { schema, handler });
        return () => handlers.delete(method);
      },
      onClose: (closer: () => void) => {
        closers.add(closer);
        return () => closers.delete(closer);
      },
    } as unknown as LinkSession;
    listener!({ session });
    /** As the link would: an unknown method or a payload its schema refuses is an error. */
    const call = async (method: string, payload: unknown) => {
      const entry = handlers.get(method);
      if (!entry) throw new Error("UNSUPPORTED");
      const parsed = entry.schema.safeParse(payload);
      if (!parsed.success) throw new Error("VALIDATION");
      return entry.handler(parsed.data);
    };
    return {
      handlers,
      call,
      claim: (payload: unknown = null) => call(LinkMethod.CLAIM_IDLE, payload),
      close() {
        open = false;
        for (const closer of closers) closer();
      },
    };
  };
  return {
    tracker,
    link,
    dispose,
    /** Idle from a check now, then past its idle time. */
    async idleOut() {
      await tracker.check();
      clock.wall += 31 * 60_000;
      clock.mono += 31 * 60_000;
    },
  };
}

describe("the idle claim a Shell makes over its link (#17922)", () => {
  const hosts: Array<ReturnType<typeof claimingHost>> = [];
  const make = (readFresh?: () => Promise<HostWorkReading>, system?: GuestPowerOffSystem) => {
    const host = claimingHost(readFresh, system);
    hosts.push(host);
    return host;
  };
  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.dispose();
      host.tracker.dispose();
    }
  });

  it("grants one of two links asking at once, and nobody after it, the winner included", async () => {
    const host = make();
    await host.idleOut();
    const a = host.link();
    const b = host.link();
    const answers = await Promise.all([a.claim(), b.claim()]);
    expect(answers).toContainEqual({ granted: true });
    expect(answers).toContainEqual({ granted: false });
    await expect(a.claim()).resolves.toEqual({ granted: false });
    await expect(b.claim()).resolves.toEqual({ granted: false });
    await expect(host.link().claim()).resolves.toEqual({ granted: false });
  });

  it("refuses when the reading taken for the claim finds work", async () => {
    let fresh = QUIET;
    const host = make(async () => fresh);
    await host.idleOut();
    fresh = { agents: { active: 1, unreadable: 0 }, shellViews: false };
    await expect(host.link().claim()).resolves.toEqual({ granted: false });
  });

  it("keeps an idle time spent after the link it went to drops, for a resumed link too", async () => {
    const host = make();
    await host.idleOut();
    const first = host.link();
    await expect(first.claim()).resolves.toEqual({ granted: true });
    first.close();
    expect(first.handlers.has(LinkMethod.CLAIM_IDLE)).toBe(false);
    // The same Shell back on a resumed link is a new link, and so is another device.
    const resumed = host.link();
    await expect(resumed.claim()).resolves.toEqual({ granted: false });

    // New work starts the next idle time, and that one can be claimed once it ends.
    host.tracker.noteWork();
    await host.idleOut();
    await expect(resumed.claim()).resolves.toEqual({ granted: true });
  });

  it("claims nothing for a link that drops before the host decides", async () => {
    let release: (() => void) | null = null;
    const host = make(() =>
      release === null
        ? new Promise<HostWorkReading>((resolve) => (release = () => resolve(QUIET)))
        : Promise.resolve(QUIET)
    );
    await host.idleOut();
    const dropping = host.link();
    const answer = dropping.claim();
    await vi.waitFor(() => expect(release).not.toBeNull());
    dropping.close();
    release!();
    await expect(answer).resolves.toEqual({ granted: false });
    await expect(host.link().claim()).resolves.toEqual({ granted: true });
  });

  it("claims nothing once Host mode stops, a claim already reading included", async () => {
    let release: (() => void) | null = null;
    const host = make(
      () => new Promise<HostWorkReading>((resolve) => (release = () => resolve(QUIET)))
    );
    await host.idleOut();
    const answer = host.link().claim();
    await vi.waitFor(() => expect(release).not.toBeNull());
    host.dispose();
    release!();
    await expect(answer).resolves.toEqual({ granted: false });
    expect(host.tracker.mayClaim(Symbol("keeper"))).toBe(true);
  });

  it("shares one idle time between the keepers installed here and a link, whichever claims first", async () => {
    const target = {
      provider: "aws",
      accountId: "123456789012",
      region: "eu-west-1",
      instanceId: "i-0abc0000000000001",
    };
    for (const shellFirst of [true, false]) {
      const launch = vi.fn(async () => ({ kind: "accepted" as const }));
      const system = { ...guestSystem(), preparePowerOff: vi.fn(async () => launch) };
      const host = make(undefined, system);
      const shell = host.link();
      await host.idleOut();
      if (shellFirst) await expect(shell.claim()).resolves.toEqual({ granted: true });
      await shell.call(GUEST_POWER_OFF_METHOD, { target, enabled: true });
      await getRemoteService("guestPowerOff")!.tick();
      expect(launch).toHaveBeenCalledTimes(shellFirst ? 0 : 1);
      if (!shellFirst) await expect(shell.claim()).resolves.toEqual({ granted: false });
    }
  });

  it("shares one idle time between the machine's own keeper here and a link, whichever claims first", async () => {
    for (const shellFirst of [true, false]) {
      const stop = vi.fn(async () => null);
      driver.stop = stop;
      const host = make();
      const shell = host.link();
      await host.idleOut();
      if (shellFirst) await expect(shell.claim()).resolves.toEqual({ granted: true });
      await shell.call(MachineKeeperLinkMethod.ARM, request());
      await getRemoteService("machineKeeper")!.tick();
      expect(stop).toHaveBeenCalledTimes(shellFirst ? 0 : 1);
      if (!shellFirst) await expect(shell.claim()).resolves.toEqual({ granted: false });
    }
  });

  it("takes no payload a Shell could name an owner or a claim in", async () => {
    const host = make();
    await host.idleOut();
    await expect(host.link().claim({ owner: "keeper" })).rejects.toThrow("VALIDATION");
    await expect(host.link().claim({ claimId: "old" })).rejects.toThrow("VALIDATION");
    await expect(host.link().claim({})).resolves.toEqual({ granted: true });
  });
});

describe("the claim a Shell makes standing in for a refused self-stop (#17924)", () => {
  const hosts: Array<ReturnType<typeof claimingHost>> = [];
  const make = (system?: GuestPowerOffSystem) => {
    const host = claimingHost(undefined, system);
    hosts.push(host);
    return host;
  };
  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.dispose();
      host.tracker.dispose();
    }
  });
  const standIn = (link: ReturnType<ReturnType<typeof claimingHost>["link"]>) =>
    link.call(LinkMethod.CLAIM_IDLE_STAND_IN, null);

  it("is granted while no keeper here stops the machine, and holds the idle time like any claim", async () => {
    const host = make();
    await host.idleOut();
    const shell = host.link();
    await expect(standIn(shell)).resolves.toEqual({ granted: true });
    await expect(standIn(shell)).resolves.toEqual({ granted: false });
    await expect(host.link().claim()).resolves.toEqual({ granted: false });
  });

  it("leaves the idle time to the machine's own keeper once another device gave it a working key", async () => {
    const stop = vi.fn(async () => null);
    driver.stop = stop;
    const host = make();
    // Armed while the host still had work, so its keeper has claimed nothing when the Shell asks.
    await host.link().call(MachineKeeperLinkMethod.ARM, request());
    await getRemoteService("machineKeeper")!.tick();
    await host.idleOut();
    await expect(standIn(host.link())).resolves.toEqual({ granted: false });
    expect(stop).not.toHaveBeenCalled();
    await getRemoteService("machineKeeper")!.tick();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the idle time to the power-off keeper once its host may power the machine off", async () => {
    const launch = vi.fn(async () => ({ kind: "accepted" as const }));
    const host = make({ ...guestSystem(), preparePowerOff: vi.fn(async () => launch) });
    const shell = host.link();
    await host.idleOut();
    await shell.call(GUEST_POWER_OFF_METHOD, {
      target: {
        provider: "aws",
        accountId: "123456789012",
        region: "eu-west-1",
        instanceId: "i-0abc0000000000001",
      },
      enabled: true,
    });
    await expect(standIn(shell)).resolves.toEqual({ granted: false });
    await getRemoteService("guestPowerOff")!.tick();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("takes no payload", async () => {
    const host = make();
    await host.idleOut();
    await expect(
      host.link().call(LinkMethod.CLAIM_IDLE_STAND_IN, { owner: "keeper" })
    ).rejects.toThrow("VALIDATION");
  });
});

describe("installMachineKeeperHost keep-awake (#17918)", () => {
  it("opens no port until a Shell asks, then takes a URL for it over the link and lets it go on dispose", async () => {
    let closed = 0;
    const listener: KeepAwakeListener = {
      port: 40_100,
      expect: () => {},
      take: () => true,
      close: () => {
        closed += 1;
      },
    };
    const listen = vi.fn(async () => listener);
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const { call, dispose } = linkedHost(undefined, {
      listen,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(listen).not.toHaveBeenCalled();
    expect(getRemoteService("keepAwake")).toBeTruthy();
    await expect(call(KeepAwakeLinkMethod.STATUS, null)).resolves.toMatchObject({ port: 40_100 });
    expect(listen).toHaveBeenCalledTimes(1);

    const url = "https://ab12cd34ef-40100.agent37.app/?a37_token=tok_secret_value";
    // Nothing the schema doesn't name, and nothing past its bounds.
    await expect(
      call(KeepAwakeLinkMethod.ARM, {
        resourceId: "ab12cd34ef",
        url,
        expiresAt: Date.now() + 86_400_000,
        apiKey: "x",
      })
    ).rejects.toThrow("VALIDATION");
    await expect(
      call(KeepAwakeLinkMethod.ARM, {
        resourceId: "ab12cd34ef",
        url: `${url}&pad=${"x".repeat(2048)}`,
        expiresAt: Date.now() + 86_400_000,
      })
    ).rejects.toThrow("VALIDATION");
    expect(fetch).not.toHaveBeenCalled();
    const status = await call(KeepAwakeLinkMethod.ARM, {
      resourceId: "ab12cd34ef",
      url,
      expiresAt: Date.now() + 86_400_000,
    });
    expect(status).toMatchObject({ port: 40_100, problem: null });
    expect(JSON.stringify(status)).not.toContain("tok_secret_value");
    expect(fetch).toHaveBeenCalledTimes(1);

    dispose();
    expect(closed).toBe(1);
    expect(getRemoteService("keepAwake")).toBeFalsy();
  });
});

function guestSystem(saved: StoredGuestPowerOff | null = null) {
  return {
    unsupported: () => null,
    verifyIdentity: vi.fn(async () => ({ ok: true as const })),
    probePowerOff: async () => null,
    preparePowerOff: vi.fn(async () => async () => ({ kind: "accepted" as const })),
    bootId: async () => saved?.bootId ?? "boot-a",
    loadArm: async () => saved,
    saveArm: async () => {},
  } satisfies GuestPowerOffSystem;
}
