// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuestPowerOffTarget } from "../../cloud/machineKeeperLink.js";
import type { HostWorkReading } from "../HostIdleTracker.js";
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
const BOOT = "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const TARGET: GuestPowerOffTarget = {
  provider: "aws",
  accountId: "123456789012",
  region: "eu-west-1",
  instanceId: "i-0abc0000000000001",
};
const OTHER: GuestPowerOffTarget = { ...TARGET, instanceId: "i-0abc0000000000002" };

/** A promise and the means to settle it, for holding a step open. */
function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function harness(options: { stored?: StoredGuestPowerOff | null; bootId?: string | null } = {}) {
  const clock = { wall: Date.parse("2026-11-18T09:00:00Z"), mono: 1_000 };
  let busy = false;
  /** Replaces the next idle read, to hold it open or have it see something else. */
  let nextRead: (() => Promise<HostWorkReading>) | null = null;
  const identity = { result: { ok: true } as IdentityCheck, hold: null as Promise<void> | null };
  const probe = { problem: null as string | null };
  const outcomes: PowerOffOutcome[] = [];
  let stored = options.stored ?? null;
  const saveFailures: Error[] = [];
  const launch = vi.fn(async () => outcomes.shift() ?? ({ kind: "accepted" } as PowerOffOutcome));
  const prepare = { hold: null as Promise<void> | null, problem: null as string | null };
  const system = {
    unsupported: vi.fn(() => null as string | null),
    verifyIdentity: vi.fn(async (_target: GuestPowerOffTarget) => {
      if (identity.hold) await identity.hold;
      return identity.result;
    }),
    probePowerOff: vi.fn(async () => probe.problem),
    preparePowerOff: vi.fn(async () => {
      if (prepare.hold) await prepare.hold;
      return prepare.problem ?? launch;
    }),
    bootId: vi.fn(async () => (options.bootId === undefined ? BOOT : options.bootId)),
    loadArm: vi.fn(async () => stored),
    saveArm: vi.fn(async (arm: StoredGuestPowerOff | null) => {
      const failure = saveFailures.shift();
      if (failure) throw failure;
      stored = arm;
    }),
  } satisfies GuestPowerOffSystem;
  const tracker = new HostIdleTracker({
    read: () => {
      const read = nextRead;
      nextRead = null;
      return read
        ? read()
        : Promise.resolve({
            agents: { active: busy ? 1 : 0, unreadable: 0 },
            shellViews: false,
          });
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
    launch,
    identity,
    probe,
    prepare,
    outcomes,
    saveFailures,
    stored: () => stored,
    setBusy(next: boolean) {
      busy = next;
    },
    holdNextRead(read: () => Promise<HostWorkReading>) {
      nextRead = read;
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

const IDLE_READING: HostWorkReading = { agents: { active: 0, unreadable: 0 }, shellViews: false };
const BUSY_READING: HostWorkReading = { agents: { active: 1, unreadable: 0 }, shellViews: false };

describe("GuestPowerOffKeeper (#17362)", () => {
  it("does nothing until it's given a machine", async () => {
    const h = make();
    await h.idleOut();
    expect(h.system.preparePowerOff).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.keeper.stopsWhenIdle()).toBe(false);
  });

  it("keeps the permission for this boot, and powers off once with work gone", async () => {
    const h = make();
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: true,
      problem: null,
    });
    expect(h.stored()).toEqual({ bootId: BOOT, target: TARGET });
    expect(h.keeper.stopsWhenIdle()).toBe(true);
    await h.pass(0);
    await h.pass(IDLE - MINUTE);
    expect(h.launch).not.toHaveBeenCalled();
    await h.pass(2 * MINUTE);
    await h.pass(MINUTE);
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it("looks again with a read of its own, not one already under way, before powering off", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.pass(0);
    h.advance(IDLE + MINUTE);
    // A read that started before the work began, and ends after it, still says idle.
    const older = gate<HostWorkReading>();
    h.holdNextRead(() => older.promise);
    const checking = h.tracker.check();
    const ticking = h.keeper.tick();
    // The keeper's own read is the one that finds the work.
    h.holdNextRead(async () => BUSY_READING);
    older.release(IDLE_READING);
    await checking;
    await ticking;
    expect(h.launch).not.toHaveBeenCalled();
    expect(h.tracker.observation().busy).toBe(true);
  });

  it("never launches for a permission taken back, or replaced, during its last look", async () => {
    for (const change of ["revoke", "replace"] as const) {
      const h = make();
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.pass(0);
      h.advance(IDLE + MINUTE);
      const read = gate<HostWorkReading>();
      h.holdNextRead(() => read.promise);
      const ticking = h.keeper.tick();
      await vi.waitFor(() => expect(h.system.preparePowerOff).toHaveBeenCalled());
      await (change === "revoke"
        ? h.keeper.set({ target: TARGET, enabled: false })
        : h.keeper.set({ target: OTHER, enabled: true }));
      read.release(IDLE_READING);
      await ticking;
      expect(h.launch).not.toHaveBeenCalled();
      h.keeper.dispose();
      h.tracker.dispose();
    }
  });

  it("drops the permission the moment a take-back arrives, even behind a grant still being checked", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.pass(0);
    h.advance(IDLE + MINUTE);
    // A repeat grant held in its metadata check, then the take-back.
    const verify = gate();
    h.identity.hold = verify.promise;
    const regrant = h.keeper.set({ target: TARGET, enabled: true });
    // Its check is under way before the take-back arrives.
    await vi.waitFor(() => expect(h.system.verifyIdentity).toHaveBeenCalledTimes(2));
    const revoke = h.keeper.set({ target: TARGET, enabled: false });
    // Another machine's take-back arriving later hides nothing.
    void h.keeper.set({ target: OTHER, enabled: false });
    expect(h.keeper.status().armed).toBe(false);
    await h.keeper.tick();
    expect(h.launch).not.toHaveBeenCalled();
    h.identity.hold = null;
    verify.release();
    // The older grant, finishing its check after the take-back, doesn't bring it back.
    await expect(regrant).resolves.toMatchObject({ armed: false });
    await expect(revoke).resolves.toMatchObject({ armed: false });
    expect(h.stored()).toBeNull();
    await h.pass(IDLE);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("never sends a second power-off while one whose answer was lost may still happen", async () => {
    const h = make();
    h.outcomes.push({ kind: "unknown" });
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.idleOut();
    expect(h.launch).toHaveBeenCalledTimes(1);
    // Taken back and given again meanwhile: the machine may still be going down.
    await h.keeper.set({ target: TARGET, enabled: false });
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.pass(4 * MINUTE + 50_000);
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.keeper.status().problem).toBeNull();
    // Still running once it should have happened: it counts as use, and a full idle time comes first.
    await h.pass(20_000);
    expect(h.keeper.status().problem).toMatch(/kept running/);
    expect(h.keeper.stopsWhenIdle()).toBe(false);
    await h.pass(IDLE - 2 * MINUTE);
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.pass(IDLE + MINUTE);
    expect(h.launch).toHaveBeenCalledTimes(2);
  });

  it("says why a refused power-off didn't happen, keeps it through a repeated permission, and waits before trying again", async () => {
    const h = make();
    h.outcomes.push({ kind: "refused", problem: "This machine refused to power itself off." });
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.idleOut();
    expect(h.launch).toHaveBeenCalledTimes(1);
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: true,
      problem: "This machine refused to power itself off.",
    });
    expect(h.keeper.stopsWhenIdle()).toBe(false);
    await h.pass(30_000);
    expect(h.launch).toHaveBeenCalledTimes(1);
    await h.pass(2 * MINUTE);
    expect(h.launch).toHaveBeenCalledTimes(2);
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
  });

  describe("and a Shell's claim on the same idle time (#17922)", () => {
    const shellClaims = async (h: ReturnType<typeof harness>) =>
      h.tracker.tryClaim(await h.tracker.checkFresh(), Symbol("shell-link"));

    it("never powers off on an idle time a Shell claimed first, given the permission before or after", async () => {
      for (const grantFirst of [true, false]) {
        const h = make();
        if (grantFirst) await h.keeper.set({ target: TARGET, enabled: true });
        await h.pass(0);
        h.advance(IDLE + MINUTE);
        expect(await shellClaims(h)).toBe(true);
        if (!grantFirst) await h.keeper.set({ target: TARGET, enabled: true });
        for (let i = 0; i < 3; i++) await h.pass(MINUTE);
        expect(h.system.preparePowerOff).not.toHaveBeenCalled();
        expect(h.launch).not.toHaveBeenCalled();
        h.keeper.dispose();
        h.tracker.dispose();
      }
    });

    it("never launches when a Shell claims while the power-off is being prepared", async () => {
      const h = make();
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.pass(0);
      h.advance(IDLE + MINUTE);
      const prepared = gate();
      h.prepare.hold = prepared.promise;
      const ticking = h.keeper.tick();
      await vi.waitFor(() => expect(h.system.preparePowerOff).toHaveBeenCalled());
      expect(await shellClaims(h)).toBe(true);
      prepared.release();
      await ticking;
      expect(h.launch).not.toHaveBeenCalled();
    });

    it("refuses a Shell the idle time it powered off on, accepted, lost or refused", async () => {
      for (const outcome of [
        { kind: "accepted" },
        { kind: "unknown" },
        { kind: "refused", problem: "This machine refused to power itself off." },
      ] satisfies PowerOffOutcome[]) {
        const h = make();
        h.outcomes.push(outcome);
        await h.keeper.set({ target: TARGET, enabled: true });
        await h.idleOut();
        expect(h.launch).toHaveBeenCalledTimes(1);
        expect(await shellClaims(h)).toBe(false);
        h.keeper.dispose();
        h.tracker.dispose();
      }
    });

    it("tries a refused power-off again on its own claim, never on one a Shell holds", async () => {
      const h = make();
      h.outcomes.push({ kind: "refused", problem: "This machine refused to power itself off." });
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.idleOut();
      expect(await shellClaims(h)).toBe(false);
      await h.pass(3 * MINUTE);
      expect(h.launch).toHaveBeenCalledTimes(2);

      // Taken back after a refusal: given again, it holds no claim to retry on.
      const other = make();
      other.outcomes.push({
        kind: "refused",
        problem: "This machine refused to power itself off.",
      });
      await other.keeper.set({ target: TARGET, enabled: true });
      await other.idleOut();
      await other.keeper.set({ target: TARGET, enabled: false });
      await other.keeper.set({ target: TARGET, enabled: true });
      await other.pass(3 * MINUTE);
      expect(other.launch).toHaveBeenCalledTimes(1);
      h.keeper.dispose();
      h.tracker.dispose();
    });

    it("refuses a Shell while its power-off is still being asked of the OS", async () => {
      const h = make();
      const asked = gate<PowerOffOutcome>();
      h.launch.mockImplementationOnce(() => asked.promise);
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.pass(0);
      h.advance(IDLE + MINUTE);
      const ticking = h.keeper.tick();
      await vi.waitFor(() => expect(h.launch).toHaveBeenCalledTimes(1));
      expect(await shellClaims(h)).toBe(false);
      asked.release({ kind: "accepted" });
      await ticking;
    });

    it("never retries a refused power-off on an idle time a Shell claimed after newer work", async () => {
      const h = make();
      h.outcomes.push({ kind: "refused", problem: "This machine refused to power itself off." });
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.idleOut();
      expect(h.launch).toHaveBeenCalledTimes(1);
      h.tracker.noteWork();
      await h.pass(0);
      h.advance(IDLE + MINUTE);
      const prepared = gate();
      h.prepare.hold = prepared.promise;
      const ticking = h.keeper.tick();
      await vi.waitFor(() => expect(h.system.preparePowerOff).toHaveBeenCalledTimes(2));
      expect(await shellClaims(h)).toBe(true);
      prepared.release();
      await ticking;
      expect(h.launch).toHaveBeenCalledTimes(1);
    });

    it("never takes a later idle time a Shell claimed as use, for its power-off that didn't happen", async () => {
      const h = make();
      h.outcomes.push({ kind: "unknown" });
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.idleOut();
      expect(h.launch).toHaveBeenCalledTimes(1);
      // Still running; an agent works and finishes, and a Shell claims the idle time after it.
      h.tracker.noteWork();
      await h.tracker.check();
      h.advance(IDLE + MINUTE);
      expect(await shellClaims(h)).toBe(true);
      // The keeper settles its old power-off past its settle time: no new idle time for it to take.
      await h.pass(MINUTE);
      expect(h.keeper.status().problem).toMatch(/kept running/);
      // A full idle time from the next check, as a restart at the settle would have given it.
      await h.pass(0);
      await h.pass(IDLE + MINUTE);
      await h.pass(MINUTE);
      expect(h.launch).toHaveBeenCalledTimes(1);
    });

    it("leaves the idle time to a Shell when its permission went during its last look", async () => {
      const h = make();
      await h.keeper.set({ target: TARGET, enabled: true });
      await h.pass(0);
      h.advance(IDLE + MINUTE);
      const read = gate<HostWorkReading>();
      h.holdNextRead(() => read.promise);
      const ticking = h.keeper.tick();
      await vi.waitFor(() => expect(h.system.preparePowerOff).toHaveBeenCalled());
      await h.keeper.set({ target: TARGET, enabled: false });
      read.release(IDLE_READING);
      await ticking;
      expect(h.launch).not.toHaveBeenCalled();
      expect(await shellClaims(h)).toBe(true);
    });
  });

  it("says why it can't power off when the OS has no way to, and waits before looking again", async () => {
    const h = make();
    h.prepare.problem = "This machine has no systemctl to power itself off with.";
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.idleOut();
    expect(h.keeper.status().problem).toMatch(/systemctl/);
    await h.pass(30_000);
    expect(h.system.preparePowerOff).toHaveBeenCalledTimes(1);
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
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("keeps a permission it holds when its metadata can't be read for a repeat, and drops it when it names another machine", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    h.identity.result = { ok: false, definite: false, problem: "unreadable" };
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: true,
      problem: null,
    });
    expect(h.keeper.stopsWhenIdle()).toBe(true);
    h.identity.result = { ok: false, definite: true, problem: "another machine" };
    await expect(h.keeper.set({ target: TARGET, enabled: true })).resolves.toEqual({
      armed: false,
      problem: "another machine",
    });
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("gives the permission up when taken back for its machine, and ignores one taken back for another", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await expect(h.keeper.set({ target: OTHER, enabled: false })).resolves.toMatchObject({
      armed: true,
    });
    expect(h.stored()).toEqual({ bootId: BOOT, target: TARGET });
    await expect(h.keeper.set({ target: TARGET, enabled: false })).resolves.toMatchObject({
      armed: false,
    });
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("keeps trying to remove a saved permission it couldn't, on its own timer, and says so meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const h = make();
      await h.keeper.set({ target: TARGET, enabled: true });
      h.saveFailures.push(new Error("EROFS"));
      await expect(h.keeper.set({ target: TARGET, enabled: false })).resolves.toEqual({
        armed: false,
        problem: expect.stringContaining("couldn't remove"),
      });
      expect(h.stored()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
      expect(h.stored()).toBeNull();
      expect(h.keeper.status()).toEqual({ armed: false, problem: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never removes a permission saved after the one a pending removal was for", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    h.saveFailures.push(new Error("EROFS"));
    await h.keeper.set({ target: TARGET, enabled: false });
    // A new grant is being checked when the pass that retries the removal comes.
    const verify = gate();
    h.identity.hold = verify.promise;
    const regrant = h.keeper.set({ target: TARGET, enabled: true });
    await vi.waitFor(() => expect(h.system.verifyIdentity).toHaveBeenCalledTimes(2));
    const ticking = h.keeper.tick();
    h.identity.hold = null;
    verify.release();
    await regrant;
    await ticking;
    expect(h.stored()).toEqual({ bootId: BOOT, target: TARGET });
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
  });

  it("keeps what it saved when it shuts down partway through a repeat grant", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    const saving = gate();
    const save = h.system.saveArm.getMockImplementation()!;
    h.system.saveArm.mockImplementationOnce(async (arm) => {
      await saving.promise;
      return save(arm);
    });
    const regrant = h.keeper.set({ target: TARGET, enabled: true });
    await vi.waitFor(() => expect(h.system.saveArm).toHaveBeenCalledTimes(2));
    h.keeper.dispose();
    saving.release();
    await regrant;
    // Shutting down isn't a take-back: the next start in this boot finds it.
    expect(h.stored()).toEqual({ bootId: BOOT, target: TARGET });
  });

  it("finishes a take-back that arrived while a repeat grant was saving, even when shutting down", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    const saving = gate();
    const save = h.system.saveArm.getMockImplementation()!;
    h.system.saveArm.mockImplementationOnce(async (arm) => {
      await saving.promise;
      return save(arm);
    });
    const regrant = h.keeper.set({ target: TARGET, enabled: true });
    await vi.waitFor(() => expect(h.system.saveArm).toHaveBeenCalledTimes(2));
    const revoke = h.keeper.set({ target: TARGET, enabled: false });
    h.keeper.dispose();
    saving.release();
    await regrant;
    await revoke;
    expect(h.stored()).toBeNull();
  });

  it("checks a restore against take-backs from when it was asked for, not when its turn came", async () => {
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    // A grant holds the queue; the restore is asked for, then the take-back arrives.
    const verify = gate();
    h.identity.hold = verify.promise;
    const granting = h.keeper.set({ target: OTHER, enabled: true });
    await vi.waitFor(() => expect(h.system.verifyIdentity).toHaveBeenCalledTimes(1));
    const restoring = h.keeper.restore();
    const revoke = h.keeper.set({ target: TARGET, enabled: false });
    h.identity.hold = null;
    h.identity.result = { ok: false, definite: true, problem: "another machine" };
    verify.release();
    await granting;
    await restoring;
    await revoke;
    expect(h.keeper.status().armed).toBe(false);
    expect(h.stored()).toBeNull();
    expect(h.system.verifyIdentity).toHaveBeenCalledTimes(1);
  });

  it("keeps a deferred restore through another machine's take-back, and drops it for its own", async () => {
    const boot = { id: null as string | null };
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    h.system.bootId.mockImplementation(async () => boot.id);
    await h.keeper.restore();
    await h.keeper.set({ target: OTHER, enabled: false });
    expect(h.stored()).not.toBeNull();
    boot.id = BOOT;
    await h.pass(3 * MINUTE);
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });

    const again = make({ stored: { bootId: BOOT, target: TARGET } });
    again.system.bootId.mockImplementation(async () => null);
    await again.keeper.restore();
    await again.keeper.set({ target: TARGET, enabled: false });
    expect(again.stored()).toBeNull();
    again.system.bootId.mockImplementation(async () => BOOT);
    await again.pass(3 * MINUTE);
    expect(again.keeper.status().armed).toBe(false);
    h.keeper.dispose();
    h.tracker.dispose();
  });

  it("takes back up a permission from this boot after a restart, checked against the machine again", async () => {
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    await h.keeper.restore();
    expect(h.system.verifyIdentity).toHaveBeenCalledWith(TARGET, expect.anything());
    expect(h.system.probePowerOff).toHaveBeenCalled();
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
    await h.idleOut();
    expect(h.launch).toHaveBeenCalledTimes(1);
  });

  it("forgets a permission from another boot without asking anything of the machine", async () => {
    const h = make({ stored: { bootId: "0f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b", target: TARGET } });
    await h.keeper.restore();
    expect(h.system.verifyIdentity).not.toHaveBeenCalled();
    expect(h.system.probePowerOff).not.toHaveBeenCalled();
    expect(h.stored()).toBeNull();
    expect(h.keeper.status().armed).toBe(false);
  });

  it("keeps a saved permission it can't place in a boot yet, without acting on it, and looks again later", async () => {
    const boot = { id: null as string | null };
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    h.system.bootId.mockImplementation(async () => boot.id);
    await h.keeper.restore();
    expect(h.stored()).not.toBeNull();
    expect(h.keeper.status().armed).toBe(false);
    expect(h.system.bootId).toHaveBeenCalledTimes(1);
    // Not looked at again until its pause is over.
    await h.pass(30_000);
    expect(h.system.bootId).toHaveBeenCalledTimes(1);
    expect(h.system.verifyIdentity).not.toHaveBeenCalled();
    boot.id = BOOT;
    await h.pass(3 * MINUTE);
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
  });

  it("never takes back up a saved permission taken back while it was reading the boot", async () => {
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    const boot = gate<string | null>();
    h.system.bootId.mockImplementationOnce(() => boot.promise);
    const restoring = h.keeper.restore();
    await vi.waitFor(() => expect(h.system.bootId).toHaveBeenCalled());
    const revoke = h.keeper.set({ target: TARGET, enabled: false });
    boot.release(BOOT);
    await restoring;
    await revoke;
    expect(h.system.verifyIdentity).not.toHaveBeenCalled();
    expect(h.keeper.status().armed).toBe(false);
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("checks a restored permission again later while its machine or sudo can't answer yet", async () => {
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    h.identity.result = { ok: false, definite: false, problem: "unreadable" };
    await h.keeper.restore();
    expect(h.keeper.status().armed).toBe(false);
    h.identity.result = { ok: true };
    h.probe.problem = "sudo not ready";
    await h.pass(30_000);
    expect(h.system.verifyIdentity).toHaveBeenCalledTimes(1);
    await h.pass(3 * MINUTE);
    expect(h.keeper.status().armed).toBe(false);
    expect(h.stored()).not.toBeNull();
    h.probe.problem = null;
    await h.pass(10 * MINUTE);
    expect(h.keeper.status()).toEqual({ armed: true, problem: null });
  });

  it("drops a restored permission for a machine its metadata says it isn't", async () => {
    const h = make({ stored: { bootId: BOOT, target: TARGET } });
    h.identity.result = { ok: false, definite: true, problem: "another machine" };
    await h.keeper.restore();
    expect(h.stored()).toBeNull();
    await h.idleOut();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it("never acts after it's disposed, even mid-step", async () => {
    const h = make();
    await h.keeper.set({ target: TARGET, enabled: true });
    await h.pass(0);
    h.advance(IDLE + MINUTE);
    const prepared = gate();
    h.prepare.hold = prepared.promise;
    const ticking = h.keeper.tick();
    await vi.waitFor(() => expect(h.system.preparePowerOff).toHaveBeenCalled());
    h.keeper.dispose();
    prepared.release();
    await ticking;
    expect(h.launch).not.toHaveBeenCalled();
    await expect(h.keeper.set({ target: TARGET, enabled: true })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  });
});
