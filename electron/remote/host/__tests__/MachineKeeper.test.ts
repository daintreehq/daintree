// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderResource } from "../../cloud/provider.js";
import type { MachineKeeperArmRequest } from "../../cloud/machineKeeperLink.js";
import { HostIdleTracker } from "../HostIdleTracker.js";
import { MachineKeeper, type MachineDriver } from "../MachineKeeper.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class KeyLost extends Error {}

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
    stoppedAt: null,
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

interface Machine {
  state: "running" | "stopped";
  deadline: number | null;
  lifetimeSeconds: number | null;
  stop: ProviderResource["stop"];
  snapshotsDisabled: boolean;
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
    snapshotsDisabled: false,
  };
  let failure: Error | null = null;
  const driver = {
    inspect: vi.fn(async () => {
      if (failure) throw failure;
      return resource(machine, now());
    }),
    renew: vi.fn(async (seconds: number) => {
      if (failure) throw failure;
      machine.deadline = now() + seconds * 1000;
      machine.lifetimeSeconds = seconds;
      return resource(machine, now());
    }),
    stop: vi.fn(async () => {
      if (failure) throw failure;
      machine.stop = { id: "stop_1", status: "pending", error: null };
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
    h.keeper.arm(h.request());
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

  it("renews by the lifetime set on the machine now, not the one it was given", async () => {
    const h = setup();
    h.keeper.arm(h.request());
    await h.pass();
    // The person shortened it from the desktop since.
    h.machine.lifetimeSeconds = 3600;
    h.advance(95 * MINUTE);
    await h.pass();
    expect(h.driver.renew).toHaveBeenCalledWith(3600, expect.anything());
  });

  it("leaves a deadline the desktop already moved, reading it before writing", async () => {
    const h = setup();
    h.keeper.arm(h.request());
    await h.pass();
    h.advance(95 * MINUTE);
    // The desktop's keeper got there first.
    h.machine.deadline = h.now() + 2 * HOUR;
    await h.pass();
    expect(h.driver.inspect).toHaveBeenCalledTimes(2);
    expect(h.driver.renew).not.toHaveBeenCalled();
  });

  it("stops the machine normally once the host has been idle for its idle time", async () => {
    const h = setup({ busy: false });
    h.keeper.arm(h.request());
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

  it("doesn't stop when the host sees work again on its last look", async () => {
    const h = setup({ busy: false });
    h.keeper.arm(h.request());
    await h.pass();
    h.advance(31 * MINUTE);
    await h.tracker.check();
    // An agent starts between the idle check and the stop.
    h.setBusy(true);
    await h.keeper.tick();
    expect(h.driver.inspect).toHaveBeenCalled();
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("joins a stop someone else began instead of sending its own", async () => {
    const h = setup({ busy: false });
    h.keeper.arm(h.request());
    await h.pass();
    h.machine.stop = { id: "stop_desktop", status: "pending", error: null };
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("doesn't renew a machine that is stopping", async () => {
    const h = setup();
    h.keeper.arm(h.request());
    await h.pass();
    h.machine.stop = { id: "stop_desktop", status: "pending", error: null };
    h.advance(95 * MINUTE);
    await h.pass();
    expect(h.driver.renew).not.toHaveBeenCalled();
  });

  it("has no deadline to renew with no lifetime, and still stops once idle", async () => {
    const h = setup({ lifetimeSeconds: null });
    h.keeper.arm(h.request());
    await h.pass();
    h.advance(3 * HOUR);
    await h.pass();
    expect(h.driver.renew).not.toHaveBeenCalled();

    h.setBusy(false);
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);
  });

  it("never stops a machine whose disk a stop wouldn't save", async () => {
    const h = setup({ busy: false });
    h.machine.snapshotsDisabled = true;
    h.keeper.arm(h.request());
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).not.toHaveBeenCalled();
  });

  it("takes a start that overtook its own stop as use, and the idle time starts over", async () => {
    const h = setup({ busy: false });
    h.keeper.arm(h.request());
    await h.pass();
    h.advance(31 * MINUTE);
    await h.pass();
    expect(h.driver.stop).toHaveBeenCalledTimes(1);

    // The desktop started it again; the stop never went through.
    h.machine.stop = { id: "stop_1", status: "superseded", error: null };
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

  it("lets go of a key the provider no longer accepts, and says why", async () => {
    const h = setup();
    h.fail(new KeyLost());
    h.keeper.arm(h.request());
    await h.keeper.tick();
    expect(h.keeper.status()).toEqual({
      grantId: null,
      resourceId: null,
      expiresAt: null,
      problem: "Boat no longer accepts the key.",
    });
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });

  it("backs off after a failure that may pass, then tries again", async () => {
    const h = setup();
    h.fail(new Error("network"));
    h.keeper.arm(h.request());
    await h.keeper.tick();
    expect(h.driver.inspect).toHaveBeenCalledTimes(1);
    h.advance(10_000);
    await h.pass();
    expect(h.driver.inspect).toHaveBeenCalledTimes(1);

    h.fail(null);
    h.advance(MINUTE);
    await h.pass();
    expect(h.driver.inspect).toHaveBeenCalledTimes(2);
    expect(h.keeper.status().grantId).toBe("mk_1");
  });

  it("refuses a key it can't use and keeps the one it holds", async () => {
    const h = setup();
    h.keeper.arm(h.request());
    h.driverFor.mockReturnValueOnce("This host reaches another Boat.");
    expect(() => h.keeper.arm(h.request({ grantId: "mk_2" }))).toThrow(
      "This host reaches another Boat."
    );
    expect(h.keeper.status().grantId).toBe("mk_1");
  });

  it("replaces the key it holds, and an expired one lapses by itself", async () => {
    const h = setup();
    h.keeper.arm(h.request());
    expect(h.keeper.arm(h.request({ grantId: "mk_2", expiresAt: h.now() + HOUR })).grantId).toBe(
      "mk_2"
    );
    await h.keeper.tick();
    h.advance(2 * HOUR);
    await h.pass();
    expect(h.keeper.status()).toMatchObject({
      grantId: null,
      problem: expect.stringMatching(/expired/),
    });
    expect(h.driver.renew).not.toHaveBeenCalled();
  });

  it("makes no request before it holds a key", async () => {
    const h = setup({ busy: false });
    h.advance(HOUR);
    await h.pass();
    expect(h.driver.inspect).not.toHaveBeenCalled();
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });
});
