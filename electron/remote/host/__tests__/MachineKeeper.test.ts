// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderResource } from "../../cloud/provider.js";
import type { MachineKeeperArmRequest } from "../../cloud/machineKeeperLink.js";
import { HostIdleTracker } from "../HostIdleTracker.js";
import { MachineKeeper, type MachineDriver } from "../MachineKeeper.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class KeyLost extends Error {}

interface Machine {
  state: "running" | "stopped";
  deadline: number | null;
  lifetimeSeconds: number | null;
  stop: ProviderResource["stop"];
  stoppedAt: string | null;
  snapshotsDisabled: boolean;
}

function resource(machine: Machine, at: number): ProviderResource {
  return {
    resourceId: "bx_23456789",
    name: "Build host",
    machine: machine.state,
    rawState: machine.state,
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    autoStopAt: machine.deadline === null ? null : new Date(machine.deadline).toISOString(),
    lifetimeSeconds: machine.lifetimeSeconds,
    stoppedAt: machine.stoppedAt,
    createdAt: new Date(at).toISOString(),
    stop: machine.stop,
    lastSnapshotAt: null,
    dataExpired: false,
    snapshotsDisabled: machine.snapshotsDisabled,
    labels: {},
    restricted: false,
    error: null,
  };
}

function harness(options: { lifetimeSeconds?: number | null; busy?: boolean } = {}) {
  const clock = { wall: Date.parse("2026-11-18T09:00:00Z"), mono: 1_000 };
  const now = () => clock.wall;
  let busy = options.busy ?? true;
  const lifetimeSeconds =
    options.lifetimeSeconds === undefined ? 2 * 3600 : options.lifetimeSeconds;
  // One machine both keepers act on, as Boat holds it.
  const machine: Machine = {
    state: "running",
    deadline: lifetimeSeconds === null ? null : now() + lifetimeSeconds * 1000,
    lifetimeSeconds,
    stop: null,
    stoppedAt: null,
    snapshotsDisabled: false,
  };
  let failure: Error | null = null;
  const failures: Error[] = [];
  const fails = () => {
    const once = failures.shift();
    if (once) throw once;
    if (failure) throw failure;
  };
  const driver = {
    inspect: vi.fn(async (_signal: AbortSignal) => {
      fails();
      return resource(machine, now());
    }),
    renew: vi.fn(async (seconds: number, _signal: AbortSignal) => {
      fails();
      machine.deadline = now() + seconds * 1000;
      machine.lifetimeSeconds = seconds;
      return resource(machine, now());
    }),
    stop: vi.fn(async (_signal: AbortSignal) => {
      machine.stop = { id: "stop_own", status: "pending", error: null };
      fails();
      return resource(machine, now());
    }),
    failure: (error: unknown) =>
      error instanceof KeyLost
        ? { kind: "lost" as const, problem: "Boat no longer accepts the key." }
        : { kind: "retry" as const },
  } satisfies MachineDriver;
  const tracker = new HostIdleTracker({
    read: async () => ({ agents: { active: busy ? 1 : 0, unreadable: 0 }, shellViews: false }),
    idleAfterMinutes: () => 30,
    clock: () => ({ ...clock }),
  });
  const driverFor = vi.fn((_request: MachineKeeperArmRequest): MachineDriver | string => driver);
  const keeper = new MachineKeeper({ idle: tracker, driverFor, now, tickMs: 10 * HOUR });
  const request = (overrides: Partial<MachineKeeperArmRequest> = {}): MachineKeeperArmRequest => ({
    grantId: "mk_1",
    provider: "boat",
    apiUrl: "https://boat.test/api/v1",
    scope: "personal",
    resourceId: "bx_23456789",
    secret: "boat_live_machinesecret",
    expiresAt: now() + 30 * 24 * HOUR,
    ...overrides,
  });
  return {
    keeper,
    tracker,
    driver,
    driverFor,
    machine,
    request,
    now,
    /** Arms and lets its first pass finish. */
    async arm(overrides: Partial<MachineKeeperArmRequest> = {}) {
      const status = await keeper.arm(request(overrides));
      await keeper.tick();
      return status;
    },
    advance(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
    },
    setBusy(next: boolean) {
      busy = next;
    },
    fail(error: Error | null) {
      failure = error;
    },
    failOnce(error: Error) {
      failures.push(error);
    },
    /** One idle check, then one keeper pass, as their timers would. */
    async pass() {
      await tracker.check();
      await keeper.tick();
    },
  };
}

let current: ReturnType<typeof harness> | null = null;
function setup(options?: Parameters<typeof harness>[0]) {
  current = harness(options);
  return current;
}

afterEach(() => {
  current?.keeper.dispose();
  current?.tracker.dispose();
  current = null;
});

describe("MachineKeeper", () => {
  it("renews the machine's lifetime while an agent works, with no Shell attached", async () => {
    const h = setup();
    await h.arm();
    await h.pass();
    // Two hours left: nothing to move yet.
    expect(h.driver.renew).not.toHaveBeenCalled();

    for (let round = 1; round <= 2; round++) {
      h.advance(95 * MINUTE);
      await h.pass();
      expect(h.driver.renew).toHaveBeenCalledTimes(round);
      expect(h.machine.deadline).toBe(h.now() + 2 * HOUR);
    }
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("renews on its own timer, with nothing else driving it", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-18T09:00:00Z") });
    try {
      const h = setup();
      const keeper = new MachineKeeper({
        idle: h.tracker,
        driverFor: () => h.driver,
        now: () => Date.now(),
      });
      h.machine.deadline = Date.now() + 2 * HOUR;
      await keeper.arm(h.request());
      await vi.advanceTimersByTimeAsync(0);
      expect(h.driver.renew).not.toHaveBeenCalled();
      h.machine.deadline = Date.now() + 20 * MINUTE;
      // Its own reading has to age out before the moved deadline is read again.
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      expect(h.driver.renew).toHaveBeenCalledTimes(1);
      keeper.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a pass that never settles behind, and the next one renews", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-18T09:00:00Z") });
    const h = setup();
    const keeper = new MachineKeeper({ idle: h.tracker, driverFor: () => h.driver });
    await keeper.arm(h.request());
    h.driver.inspect.mockImplementationOnce(() => new Promise<ProviderResource>(() => {}));
    h.machine.deadline = Date.now() + 20 * MINUTE;
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(h.driver.renew).toHaveBeenCalled();
    keeper.dispose();
    vi.useRealTimers();
  });

  it("renews by the lifetime set on the machine now, not the one it was given", async () => {
    const h = setup();
    await h.arm();
    // The person shortened it from the desktop since.
    h.machine.lifetimeSeconds = 3600;
    h.advance(95 * MINUTE);
    await h.pass();
    expect(h.driver.renew).toHaveBeenCalledWith(3600, expect.anything());
  });

  it("leaves a deadline the desktop already moved, reading it before writing", async () => {
    const h = setup();
    await h.arm();
    // Within its reading's lifetime, the deadline it last read comes inside the margin.
    h.advance(9 * MINUTE);
    h.machine.lifetimeSeconds = 7200;
    const shortened = { ...h.machine, deadline: h.now() + 20 * MINUTE };
    h.driver.inspect.mockResolvedValueOnce(resource(shortened, h.now()));
    h.advance(MINUTE);
    await h.pass();
    expect(h.driver.renew).toHaveBeenCalledTimes(1);

    // The desktop moved it after that: read again before writing, nothing sent.
    h.advance(95 * MINUTE);
    h.machine.deadline = h.now() + 2 * HOUR;
    const reads = h.driver.inspect.mock.calls.length;
    await h.pass();
    expect(h.driver.inspect.mock.calls.length).toBe(reads + 1);
    expect(h.driver.renew).toHaveBeenCalledTimes(1);
  });

  it("stops the machine normally once the host has been idle for its idle time", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(29 * MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();

    h.advance(2 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
    // Followed, not sent again, while it saves.
    h.advance(MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
  });

  it("doesn't stop when work starts while the machine is being read", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(31 * MINUTE);
    await h.tracker.check();
    h.driver.inspect.mockImplementationOnce(async () => {
      // An agent starts between the idle check and the answer.
      h.setBusy(true);
      return resource(h.machine, h.now());
    });
    await h.keeper.tick();
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("joins a stop someone else began, and a start after it begins the idle time again", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(31 * MINUTE);
    h.machine.stop = { id: "stop_desktop", status: "pending", error: null };
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();

    // The person starts it again; this process carried on through it.
    h.machine.stop = { id: "stop_desktop", status: "superseded", error: null };
    h.advance(MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
    await h.pass();
    h.advance(29 * MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
    h.advance(2 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
  });

  it("takes a stop and start between two looks as use", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(31 * MINUTE);
    // Stopped and started again while this process was frozen.
    h.machine.stop = { id: "stop_desktop", status: "completed", error: null };
    h.machine.stoppedAt = new Date(h.now() - 5 * MINUTE).toISOString();
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
    expect(h.tracker.observation().idleEndsAt).toBe(h.now() + 30 * MINUTE);
  });

  it("never sends its stop twice when the answer to the first is lost", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(31 * MINUTE);
    h.driver.stop.mockImplementationOnce(async () => {
      // The answer never comes back, and Boat doesn't show the stop yet.
      throw new Error("socket hang up");
    });
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
    const reads = h.driver.inspect.mock.calls.length;
    h.advance(40_000);
    await h.pass();
    // Looked again past any backoff, and didn't send it again.
    expect(h.driver.inspect.mock.calls.length).toBeGreaterThan(reads);
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
    h.machine.stop = { id: "stop_own", status: "pending", error: null };

    // Boat took it after all and is saving.
    for (let i = 0; i < 3; i++) {
      h.advance(MINUTE);
      await h.pass();
    }
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
  });

  it("doesn't renew a machine that is stopping or retrying its save", async () => {
    for (const status of ["pending", "failing"] as const) {
      const h = setup();
      await h.arm();
      h.machine.stop = { id: "stop_desktop", status, error: null };
      h.advance(95 * MINUTE);
      await h.pass();
      expect(h.driver.renew).not.toHaveBeenCalled();
      h.keeper.dispose();
      h.tracker.dispose();
    }
  });

  it("has no deadline to renew with no lifetime, and still stops once idle", async () => {
    const h = setup({ lifetimeSeconds: null });
    // A deadline Boat still reports, with no lifetime set: nothing to renew it by.
    h.machine.deadline = h.now() + 10 * MINUTE;
    await h.arm();
    await h.pass();
    expect(h.driver.renew).not.toHaveBeenCalled();

    h.setBusy(false);
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
  });

  it("never stops a machine whose disk a stop wouldn't save, nor says it will", async () => {
    const h = setup({ busy: false });
    h.machine.snapshotsDisabled = true;
    await h.arm();
    expect(h.keeper.stopsWhenIdle()).toBe(false);
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("takes a start that overtook its own stop as use, and the idle time starts over", async () => {
    const h = setup({ busy: false });
    await h.arm();
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);

    // The desktop started it again; the stop never went through.
    h.machine.stop = { id: "stop_own", status: "superseded", error: null };
    // Not yet: its own stop may simply not show.
    await h.keeper.tick();
    expect(h.tracker.observation().busy).toBe(false);
    h.advance(2 * MINUTE);
    await h.keeper.tick();
    expect(h.tracker.observation().busy).toBe(true);

    await h.pass();
    h.advance(29 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
    h.advance(2 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(2);
  });

  it("lets go of a key the provider stops accepting, and says why", async () => {
    const h = setup();
    await h.arm();
    h.fail(new KeyLost());
    h.advance(95 * MINUTE);
    await h.pass();
    expect(h.keeper.status()).toEqual({
      grantId: null,
      resourceId: null,
      expiresAt: null,
      problem: "Boat no longer accepts the key.",
    });
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });

  it("backs off after a failure that may pass, doubling, then tries again", async () => {
    const h = setup();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      await h.arm();
      h.fail(new Error("network"));
      h.advance(95 * MINUTE);
      await h.pass();
      const reads = h.driver.inspect.mock.calls.length;
      // 30 s after the first failure, 60 s after the second.
      h.advance(20_000);
      await h.pass();
      expect(h.driver.inspect.mock.calls.length).toBe(reads);
      h.advance(15_000);
      await h.pass();
      expect(h.driver.inspect.mock.calls.length).toBe(reads + 1);
      h.advance(45_000);
      await h.pass();
      expect(h.driver.inspect.mock.calls.length).toBe(reads + 1);

      h.fail(null);
      h.advance(20_000);
      await h.pass();
      expect(h.driver.inspect.mock.calls.length).toBe(reads + 2);
      expect(h.keeper.status().grantId).toBe("mk_1");
    } finally {
      random.mockRestore();
    }
  });

  it("refuses a key it can't use, or that doesn't work, and keeps the one it holds", async () => {
    const h = setup();
    await h.arm();
    h.driverFor.mockReturnValueOnce("This host reaches another Boat.");
    await expect(h.keeper.arm(h.request({ grantId: "mk_2" }))).rejects.toThrow(
      "This host reaches another Boat."
    );
    h.failOnce(new KeyLost());
    await expect(h.keeper.arm(h.request({ grantId: "mk_3" }))).rejects.toThrow(
      "Boat no longer accepts the key."
    );
    expect(h.keeper.status().grantId).toBe("mk_1");
  });

  it("replaces the key it holds, and an expired one lapses by itself", async () => {
    const h = setup();
    await h.arm();
    expect(
      (await h.keeper.arm(h.request({ grantId: "mk_2", expiresAt: h.now() + HOUR }))).grantId
    ).toBe("mk_2");
    // A key ending before the idle time does isn't promised to stop it.
    expect(h.keeper.stopsWhenIdle(h.now() + 2 * HOUR)).toBe(false);
    expect(h.keeper.stopsWhenIdle(h.now() + 30 * MINUTE)).toBe(true);
    await h.keeper.tick();
    h.advance(2 * HOUR);
    await h.pass();
    expect(h.keeper.status()).toMatchObject({
      grantId: null,
      problem: expect.stringMatching(/expired/),
    });
    expect(h.driver.renew).not.toHaveBeenCalled();
  });

  it("sends nothing under a key let go while its read was out", async () => {
    const h = setup();
    await h.arm();
    h.advance(95 * MINUTE);
    let answer: ((value: ProviderResource) => void) | null = null;
    h.driver.inspect.mockImplementationOnce(
      () => new Promise<ProviderResource>((resolve) => (answer = resolve))
    );
    await h.tracker.check();
    const pass = h.keeper.tick();
    await vi.waitFor(() => expect(answer).not.toBeNull());
    h.keeper.dispose();
    answer!(resource(h.machine, h.now()));
    await pass;
    expect(h.driver.renew).not.toHaveBeenCalled();
  });

  it("takes keys in the order they came, and says what it holds once they're settled", async () => {
    const h = setup();
    let release: () => void = () => {};
    h.driver.inspect.mockImplementationOnce(
      () =>
        new Promise<ProviderResource>((resolve) => {
          release = () => resolve(resource(h.machine, h.now()));
        })
    );
    // A key from a link since gone is still being checked when a newer one arrives.
    const older = h.keeper.arm(h.request({ grantId: "mk_old" }));
    const newer = h.keeper.arm(h.request({ grantId: "mk_new" }));
    const asked = h.keeper.settledStatus();
    await vi.waitFor(() => expect(h.driver.inspect).toHaveBeenCalledTimes(1));
    // The newer one waits its turn rather than checking alongside.
    expect(h.keeper.status().grantId).toBeNull();
    release();
    await Promise.all([older, newer]);
    expect((await asked).grantId).toBe("mk_new");
    expect(h.keeper.status().grantId).toBe("mk_new");
  });

  it("turns away a key whose turn came too late for its sender to still be waiting", async () => {
    const h = setup();
    let release: () => void = () => {};
    h.driver.inspect.mockImplementationOnce(
      () =>
        new Promise<ProviderResource>((resolve) => {
          release = () => resolve(resource(h.machine, h.now()));
        })
    );
    const first = h.keeper.arm(h.request({ grantId: "mk_first" }));
    const late = h.keeper.arm(h.request({ grantId: "mk_late" }));
    await vi.waitFor(() => expect(h.driver.inspect).toHaveBeenCalledTimes(1));
    h.advance(25_000);
    release();
    await first;
    await expect(late).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.keeper.status().grantId).toBe("mk_first");
  });

  it("takes a key on trust when its first read hangs, even past an ignored abort", async () => {
    const h = setup();
    const keeper = new MachineKeeper({
      idle: h.tracker,
      driverFor: () => ({ ...h.driver, inspect: () => new Promise<ProviderResource>(() => {}) }),
      now: h.now,
      tickMs: 10 * HOUR,
      verifyTimeoutMs: 5,
    });
    try {
      await expect(keeper.arm(h.request())).resolves.toMatchObject({ grantId: "mk_1" });
      // And the next key isn't held up behind it.
      await expect(keeper.arm(h.request({ grantId: "mk_2" }))).resolves.toMatchObject({
        grantId: "mk_2",
      });
    } finally {
      keeper.dispose();
    }
  });

  it("makes no request before it holds a key", async () => {
    const h = setup({ busy: false });
    h.advance(HOUR);
    await h.pass();
    expect(h.driver.inspect).not.toHaveBeenCalled();
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });
});
