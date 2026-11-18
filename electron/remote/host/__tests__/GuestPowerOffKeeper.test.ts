// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestPowerOffTarget } from "../../cloud/machineKeeperLink.js";
import { HostIdleTracker } from "../HostIdleTracker.js";
import { GuestPowerOffKeeper } from "../GuestPowerOffKeeper.js";
import type {
  GuestPowerOffSystem,
  IdentityCheck,
  PowerOffOutcome,
  StoredGuestPowerOff,
} from "../guestPowerOffSystem.js";

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;

const TARGET: GuestPowerOffTarget = {
  provider: "aws",
  accountId: "123456789012",
  region: "eu-west-1",
  instanceId: "i-0abc0000000000001",
};
const OTHER: GuestPowerOffTarget = { ...TARGET, instanceId: "i-0abc0000000000002" };

function harness(options: { stored?: StoredGuestPowerOff | null; bootId?: string } = {}) {
  const clock = { wall: Date.parse("2026-11-18T09:00:00Z"), mono: 1_000 };
  let busy = false;
  let readHook: (() => void) | null = null;
  const identity = { result: { ok: true } as IdentityCheck };
  const probe = { problem: null as string | null };
  const outcomes: PowerOffOutcome[] = [];
  let stored = options.stored ?? null;
  const system = {
    unsupported: vi.fn(() => null as string | null),
    verifyIdentity: vi.fn(async (_target: GuestPowerOffTarget) => identity.result),
    probePowerOff: vi.fn(async () => probe.problem),
    powerOff: vi.fn(async () => outcomes.shift() ?? ({ kind: "accepted" } as PowerOffOutcome)),
    bootId: vi.fn(async () => options.bootId ?? "boot-1"),
    loadArm: vi.fn(async () => stored),
    saveArm: vi.fn(async (arm: StoredGuestPowerOff | null) => {
      stored = arm;
    }),
  } satisfies GuestPowerOffSystem;
  const tracker = new HostIdleTracker({
    read: async () => {
      readHook?.();
      return { agents: { active: busy ? 1 : 0, unreadable: 0 }, shellViews: false };
    },
    idleAfterMinutes: () => IDLE / MINUTE,
    clock: () => ({ ...clock }),
  });
  const keeper = new GuestPowerOffKeeper({
    idle: tracker,
    system,
    now: () => clock.wall,
    tickMs: 24 * 60 * MINUTE,
  });
  return {
    keeper,
    tracker,
    system,
    identity,
    probe,
    outcomes,
    stored: () => stored,
    setBusy(next: boolean) {
      busy = next;
    },
    onRead(hook: (() => void) | null) {
      readHook = hook;
    },
    advance(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
    },
    async pass(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
      await tracker.check();
      await keeper.tick();
    },
    /** Idle from now, then past its idle time. */
    async idleOut() {
      await this.pass(0);
      await this.pass(IDLE + MINUTE);
    },
  };
}

let current: ReturnType<typeof harness> | null = null;
function make(options: Parameters<typeof harness>[0] = {}) {
  current = harness(options);
  return current;
}

afterEach(() => {
  current?.keeper.dispose();
  current?.tracker.dispose();
  current = null;
});

describe("GuestPowerOffKeeper (#17362)", () => {
  it("does nothing until it's given a machine", async () => {
    const h = make();
    await h.idleOut();
    expect(h.system.powerOff).not.toHaveBeenCalled();
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });

  it("keeps the permission for this boot, and powers off once with work gone", async () => {
    const h = make();
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: true,
      problem: null,
    });
    expect(h.stored()).toEqual({ bootId: "boot-1", target: TARGET });
    expect(h.keeper.stopsWhenIdle()).toBe(true);
    await h.idleOut();
    await h.pass(MINUTE);
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
  });

  it("holds off when work starts during the last read before powering off", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.pass(0);
    h.advance(IDLE + MINUTE);
    // The keeper's own fresh read is the one that finds work.
    h.onRead(() => h.setBusy(true));
    await h.keeper.tick();
    expect(h.system.powerOff).not.toHaveBeenCalled();
    expect(h.tracker.observation().busy).toBe(true);
  });

  it("never sends a second power-off for one whose answer was lost, until it has had time to happen", async () => {
    const h = make();
    h.outcomes.push({ kind: "unknown" });
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.idleOut();
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
    await h.pass(MINUTE);
    await h.pass(MINUTE);
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
    // Still running long after: it didn't happen, so it counts as use and a full idle time comes first.
    await h.pass(5 * MINUTE);
    expect(h.keeper.status().problem).toMatch(/kept running/);
    expect(h.keeper.stopsWhenIdle()).toBe(false);
    await h.pass(IDLE - 2 * MINUTE);
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
    await h.pass(IDLE + MINUTE);
    expect(h.system.powerOff).toHaveBeenCalledTimes(2);
  });

  it("says why a refused power-off didn't happen, keeps it through a repeated permission, and tries again later", async () => {
    const h = make();
    h.outcomes.push({ kind: "refused", problem: "This machine refused to power itself off." });
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.idleOut();
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: true,
      problem: "This machine refused to power itself off.",
    });
    expect(h.keeper.stopsWhenIdle()).toBe(false);
    await h.pass(10 * MINUTE);
    expect(h.system.powerOff).toHaveBeenCalledTimes(2);
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
  });

  it("refuses a machine its metadata doesn't name, or a login sudo won't let power off", async () => {
    const h = make();
    h.identity.result = { ok: false, definite: true, problem: "another machine" };
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: false,
      problem: "another machine",
    });
    h.identity.result = { ok: true };
    h.probe.problem = "needs a password";
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: false,
      problem: "needs a password",
    });
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.system.powerOff).not.toHaveBeenCalled();
  });

  it("gives the permission up when taken back for its machine, and ignores one taken back for another", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await expect(h.keeper.set({ target: OTHER, enabled: false })).resolves.toMatchObject({
      armed: true,
    });
    await expect(h.keeper.set({ target: TARGET, enabled: false })).resolves.toMatchObject({
      armed: false,
    });
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.system.powerOff).not.toHaveBeenCalled();
  });

  it("drops a machine it held once its metadata names another", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    h.identity.result = { ok: false, definite: true, problem: "another machine" };
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: false,
      problem: "another machine",
    });
    await h.idleOut();
    expect(h.system.powerOff).not.toHaveBeenCalled();
  });

  it("takes back up a permission from this boot after a restart, checked against the machine again", async () => {
    const h = make({ stored: { bootId: "boot-1", target: TARGET } });
    await h.keeper.restore();
    expect(h.system.verifyIdentity).toHaveBeenCalledWith(TARGET, expect.anything());
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
    await h.idleOut();
    expect(h.system.powerOff).toHaveBeenCalledTimes(1);
  });

  it("forgets a permission from another boot without asking anything of the machine", async () => {
    const h = make({ stored: { bootId: "boot-0", target: TARGET }, bootId: "boot-1" });
    await h.keeper.restore();
    expect(h.system.verifyIdentity).not.toHaveBeenCalled();
    expect(h.system.probePowerOff).not.toHaveBeenCalled();
    expect(h.stored()).toBeNull();
    expect(h.keeper.status().armed).toBe(false);
  });

  it("checks a restored permission again later when the metadata can't be read yet", async () => {
    const h = make({ stored: { bootId: "boot-1", target: TARGET } });
    h.identity.result = { ok: false, definite: false, problem: "unreadable" };
    await h.keeper.restore();
    expect(h.keeper.status().armed).toBe(false);
    h.identity.result = { ok: true };
    await h.pass(3 * MINUTE);
    expect(h.keeper.status().armed).toBe(true);
  });

  it("never acts after it's disposed", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    h.keeper.dispose();
    await h.idleOut();
    expect(h.system.powerOff).not.toHaveBeenCalled();
    await expect(h.keeper.set({ target: TARGET, enabled: true })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
