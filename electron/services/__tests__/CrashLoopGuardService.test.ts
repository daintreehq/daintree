import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => ""),
}));

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

vi.mock("../../utils/fs.js", () => utilsMock);

import { CrashLoopGuardService, isSafeModeActive } from "../CrashLoopGuardService.js";

describe("isSafeModeActive", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "isSafeModeActive-"));
    appMock.getPath.mockReturnValue(tmpDir);
    statePath = path.join(tmpDir, "crash-loop-state.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no state file exists", () => {
    expect(isSafeModeActive(tmpDir)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("returns false on clean-exit state", () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 0,
        launches: [],
        cleanExit: true,
        lastReset: Date.now(),
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns false when crashes are below threshold", () => {
    const now = Date.now();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 2,
        launches: [now - 10000, now - 20000],
        cleanExit: false,
        lastReset: now - 60000,
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns false when launches are outside the crash window", () => {
    const now = Date.now();
    // 31, 35, 40 minutes ago — all outside the 30-min window
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 3,
        launches: [now - 31 * 60_000, now - 35 * 60_000, now - 40 * 60_000],
        cleanExit: false,
        lastReset: now - 30 * 60_000,
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns true for three slow-flap launches inside the wider window", () => {
    const now = Date.now();
    // Slow flap: crashes every 6 minutes — under the old 5-min window this
    // accumulated 0 strikes (each entry expired before the next crash).
    // With the 30-min window, three entries within ~18 minutes accumulate.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 3,
        launches: [now - 12 * 60_000, now - 6 * 60_000, now - 1_000],
        cleanExit: false,
        lastReset: now - 30 * 60_000,
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(true);
  });

  it("returns false on corrupted state file", () => {
    fs.writeFileSync(statePath, "not valid json!!!", "utf8");
    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns false on invalid state structure", () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 2, foo: "bar" }), "utf8");
    expect(isSafeModeActive(tmpDir)).toBe(false);
  });
});

describe("CrashLoopGuardService", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-guard-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
    statePath = path.join(tmpDir, "crash-loop-state.json");
    utilsMock.resilientAtomicWriteFileSync.mockImplementation(
      (fp: string, data: string, enc?: BufferEncoding) => {
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeState(state: Record<string, unknown>): void {
    fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
  }

  function readState(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
  }

  it("starts in normal mode on fresh install (no state file)", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("writes state file on initialize", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(fs.existsSync(statePath)).toBe(true);
    const state = readState();
    expect(state.version).toBe(1);
    expect(state.cleanExit).toBe(false);
    expect(state.crashes).toBe(0);
  });

  it("stays normal after clean exit and re-init", () => {
    const guard1 = new CrashLoopGuardService();
    guard1.initialize();
    guard1.markCleanExit();

    const guard2 = new CrashLoopGuardService();
    guard2.initialize();

    expect(guard2.isSafeMode()).toBe(false);
    expect(guard2.shouldRelaunch()).toBe(true);
  });

  it("enters safe mode after 3 consecutive unclean exits", () => {
    for (let i = 0; i < 3; i++) {
      const guard = new CrashLoopGuardService();
      guard.initialize();
      // Don't call markCleanExit — simulates crash
    }

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(true);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("disables relaunch after 5 consecutive unclean exits", () => {
    for (let i = 0; i < 5; i++) {
      const guard = new CrashLoopGuardService();
      guard.initialize();
    }

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(true);
    expect(guard.shouldRelaunch()).toBe(false);
  });

  it("resets counter after clean exit", () => {
    // Simulate 2 crashes
    for (let i = 0; i < 2; i++) {
      const guard = new CrashLoopGuardService();
      guard.initialize();
    }

    // Clean exit
    const guard3 = new CrashLoopGuardService();
    guard3.initialize();
    guard3.markCleanExit();

    // Next launch should be normal
    const guard4 = new CrashLoopGuardService();
    guard4.initialize();

    expect(guard4.isSafeMode()).toBe(false);
  });

  it("handles corrupted state file gracefully", () => {
    fs.writeFileSync(statePath, "not valid json!!!", "utf8");

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("quarantines a corrupt state file instead of silently discarding it", () => {
    fs.writeFileSync(statePath, "not valid json!!!", "utf8");

    const guard = new CrashLoopGuardService();
    guard.initialize();

    const quarantinedPath = guard.getQuarantinedStatePath();
    expect(quarantinedPath).toMatch(/crash-loop-state\.json\.corrupted\.\d+$/);
    expect(fs.existsSync(quarantinedPath!)).toBe(true);
    // The quarantined file still contains the original corrupt bytes.
    expect(fs.readFileSync(quarantinedPath!, "utf8")).toBe("not valid json!!!");
  });

  it("quarantines a state file with an invalid structure", () => {
    writeState({ version: 2, foo: "bar" });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    const quarantinedPath = guard.getQuarantinedStatePath();
    expect(quarantinedPath).toMatch(/crash-loop-state\.json\.corrupted\.\d+$/);
    expect(fs.existsSync(quarantinedPath!)).toBe(true);
  });

  it("does not quarantine when the state file is missing (first run)", () => {
    expect(fs.existsSync(statePath)).toBe(false);

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.getQuarantinedStatePath()).toBeNull();
    // No `.corrupted.*` siblings created.
    const siblings = fs
      .readdirSync(tmpDir)
      .filter((e) => e.startsWith("crash-loop-state.json.corrupted."));
    expect(siblings).toHaveLength(0);
  });

  it("does not quarantine a valid state file", () => {
    writeState({
      version: 1,
      crashes: 0,
      launches: [],
      cleanExit: true,
      lastReset: Date.now(),
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.getQuarantinedStatePath()).toBeNull();
  });

  describe("stale tmp sweep", () => {
    it("deletes a stale `.tmp` left by a crashed atomic write", () => {
      const staleTs = Date.now() - 6 * 60 * 1000; // 6 min ago, beyond 5-min TTL
      const tmpPath = path.join(tmpDir, `crash-loop-state.json.${staleTs}-abc123.tmp`);
      fs.writeFileSync(tmpPath, "stale data", "utf8");

      const guard = new CrashLoopGuardService();
      guard.initialize();

      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it("preserves a fresh `.tmp` (within the 5-min TTL)", () => {
      const freshTs = Date.now() - 60 * 1000; // 1 min ago
      const tmpPath = path.join(tmpDir, `crash-loop-state.json.${freshTs}-abc123.tmp`);
      fs.writeFileSync(tmpPath, "in-flight write", "utf8");

      const guard = new CrashLoopGuardService();
      guard.initialize();

      expect(fs.existsSync(tmpPath)).toBe(true);
    });

    it("only sweeps tmp files that match the crash-loop naming pattern", () => {
      const otherTmp = path.join(tmpDir, "settings.json.123-abc.tmp");
      fs.writeFileSync(otherTmp, "not ours", "utf8");

      const guard = new CrashLoopGuardService();
      guard.initialize();

      expect(fs.existsSync(otherTmp)).toBe(true);
    });
  });

  describe("corrupted sibling prune", () => {
    it("retains the 3 most-recent `.corrupted.*` siblings and prunes older ones", () => {
      // Drop 5 corrupted siblings with ascending timestamps so the prune sort
      // is well-defined.
      const timestamps = [1000, 2000, 3000, 4000, 5000];
      for (const ts of timestamps) {
        fs.writeFileSync(path.join(tmpDir, `crash-loop-state.json.corrupted.${ts}`), "x", "utf8");
      }

      const guard = new CrashLoopGuardService();
      guard.initialize();

      const survivors = fs
        .readdirSync(tmpDir)
        .filter((e) => e.startsWith("crash-loop-state.json.corrupted."))
        .sort();
      // The three newest (3000, 4000, 5000) survive — 1000 and 2000 are gone.
      expect(survivors).toEqual([
        "crash-loop-state.json.corrupted.3000",
        "crash-loop-state.json.corrupted.4000",
        "crash-loop-state.json.corrupted.5000",
      ]);
    });

    it("does not prune when there are 3 or fewer siblings", () => {
      for (const ts of [1000, 2000, 3000]) {
        fs.writeFileSync(path.join(tmpDir, `crash-loop-state.json.corrupted.${ts}`), "x", "utf8");
      }

      const guard = new CrashLoopGuardService();
      guard.initialize();

      const survivors = fs
        .readdirSync(tmpDir)
        .filter((e) => e.startsWith("crash-loop-state.json.corrupted."));
      expect(survivors).toHaveLength(3);
    });
  });

  it("accumulates slow-flap launches across the wider window (regression #8683)", () => {
    // Four unclean launches spaced 6 minutes apart — the fourth boot reads
    // three prior in-window launches and enters safe mode. Under the prior
    // 5-min rapid window with the stability-timer reset, this slow flap
    // silently accumulated zero strikes; with the 30-min lazy-decay window
    // it correctly trips at the third strike.
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(start + i * 6 * 60_000);
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.isSafeMode()).toBe(false);
    }

    vi.setSystemTime(start + 3 * 6 * 60_000);
    const fourth = new CrashLoopGuardService();
    fourth.initialize();
    expect(fourth.isSafeMode()).toBe(true);
    expect(fourth.shouldRelaunch()).toBe(true);
  });

  it("initialize is idempotent — second call is a no-op", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.initialize();

    const state = readState();
    expect(state.launches).toHaveLength(1);
  });

  describe("crash metadata", () => {
    it("getCrashCount tracks consecutive unclean exits", () => {
      for (let i = 0; i < 3; i++) {
        const guard = new CrashLoopGuardService();
        guard.initialize();
      }
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.getCrashCount()).toBe(3);
    });

    it("getLastCrashTimestamp returns the most recent prior unclean launch", () => {
      const start = Date.now();
      vi.setSystemTime(start);
      const guard1 = new CrashLoopGuardService();
      guard1.initialize();

      vi.setSystemTime(start + 10_000);
      const guard2 = new CrashLoopGuardService();
      guard2.initialize();

      // The previous (crash) launch is the one written by guard1 at `start`.
      expect(guard2.getLastCrashTimestamp()).toBe(start);
    });
  });

  describe("resetForNormalBoot", () => {
    it("clears state file and in-memory flags", () => {
      for (let i = 0; i < 3; i++) {
        const guard = new CrashLoopGuardService();
        guard.initialize();
      }
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.isSafeMode()).toBe(true);

      guard.resetForNormalBoot();

      expect(guard.isSafeMode()).toBe(false);
      expect(guard.shouldRelaunch()).toBe(true);
      expect(guard.getCrashCount()).toBe(0);
      expect(guard.getLastCrashTimestamp()).toBeUndefined();

      const state = readState();
      expect(state.crashes).toBe(0);
      expect(state.cleanExit).toBe(true);
      expect(state.launches).toEqual([]);
    });

    it("rethrows disk write failures and leaves in-memory flags unchanged", () => {
      for (let i = 0; i < 3; i++) {
        const guard = new CrashLoopGuardService();
        guard.initialize();
      }
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.isSafeMode()).toBe(true);

      // Capture the on-disk unclean sentinel — the reset failure must leave
      // it intact rather than silently truncating it via a fallback write.
      const stateBeforeReset = readState();
      expect(stateBeforeReset.cleanExit).toBe(false);

      // Force the underlying atomic write to throw so the user-initiated reset
      // surfaces the failure to the IPC layer instead of silently leaving the
      // unclean sentinel on disk via a non-atomic fallback write.
      utilsMock.resilientAtomicWriteFileSync.mockImplementationOnce(() => {
        throw new Error("EROFS: read-only filesystem");
      });

      expect(() => guard.resetForNormalBoot()).toThrow(/read-only/);
      expect(guard.isSafeMode()).toBe(true);
      expect(guard.getCrashCount()).toBe(3);
      expect(utilsMock.resilientAtomicWriteFileSync).toHaveBeenCalledWith(
        statePath,
        expect.any(String),
        "utf-8"
      );

      // The on-disk state is unchanged — no truncation, no partial write.
      expect(readState()).toEqual(stateBeforeReset);
    });

    it("rejects state files with non-numeric launch entries", () => {
      writeState({
        version: 1,
        crashes: 3,
        launches: [Date.now() - 1000, "bad", null],
        cleanExit: false,
        lastReset: Date.now(),
      });

      const guard = new CrashLoopGuardService();
      guard.initialize();

      expect(guard.isSafeMode()).toBe(false);
      expect(guard.getLastCrashTimestamp()).toBeUndefined();
    });
  });
});

function writeStateFile(statePath: string, state: Record<string, unknown>): void {
  fs.writeFileSync(statePath, JSON.stringify(state), "utf8");
}

function readStateFile(statePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
}

describe("CrashLoopGuardService adversarial", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00.000Z"));
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-guard-adv-"));
    appMock.getPath.mockReturnValue(tmpDir);
    statePath = path.join(tmpDir, "crash-loop-state.json");
    utilsMock.resilientAtomicWriteFileSync.mockImplementation(
      (fp: string, data: string, enc?: BufferEncoding) => {
        fs.writeFileSync(fp, data, enc ?? "utf-8");
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recovers a valid state file on the next boot when a prior atomic write transient-fails", () => {
    utilsMock.resilientAtomicWriteFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("rename race"), { code: "EPERM" });
    });

    const first = new CrashLoopGuardService();
    const second = new CrashLoopGuardService();

    // First boot's write fails and is swallowed by initialize's try/catch
    // (non-fatal). No state file is written. Second boot starts fresh and
    // produces a valid persisted state.
    first.initialize();
    expect(fs.existsSync(statePath)).toBe(false);

    second.initialize();

    const parsed = readStateFile(statePath);
    expect(parsed.version).toBe(1);
    expect(parsed.cleanExit).toBe(false);
    expect(Array.isArray(parsed.launches)).toBe(true);
    expect(parsed.launches).toHaveLength(1);
  });

  it("preserves the prior on-disk state when the next atomic write fails (no silent fallback)", () => {
    // Seed a known-good state via a successful initialize.
    const seed = new CrashLoopGuardService();
    seed.initialize();
    const stateBeforeFailure = readStateFile(statePath);

    // Next write fails — historically this fell back to a direct
    // (non-atomic) writeFileSync that could truncate the file. The fix
    // propagates the error and leaves the prior state intact.
    utilsMock.resilientAtomicWriteFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    // The on-disk state is unchanged — no truncation, no partial write.
    const stateAfterFailure = readStateFile(statePath);
    expect(stateAfterFailure).toEqual(stateBeforeFailure);
  });

  it("counts only launches strictly inside the crash-window boundary", () => {
    const now = Date.now();
    const window = 30 * 60_000;
    // One launch exactly at the window edge (excluded by strict `<`), one
    // 1ms inside (included). Stale `crashes: 9` is ignored — derived from
    // the filtered launches array, not trusted from disk.
    writeStateFile(statePath, {
      version: 1,
      crashes: 9,
      launches: [now - window, now - (window - 1)],
      cleanExit: false,
      lastReset: now - 5_000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
    expect(readStateFile(statePath).crashes).toBe(1);
  });

  it("markCleanExit writes a clean state independent of any prior timer (regression #8683)", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.markCleanExit();

    // Advance well past the prior stability-timer deadline — there should
    // be no timer to fire, no late write that could clobber the clean state.
    vi.advanceTimersByTime(30 * 60 * 1000);

    const parsed = readStateFile(statePath);
    expect(parsed).toMatchObject({
      version: 1,
      cleanExit: true,
    });
    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("replaces partially valid persisted state with a fully valid shape", () => {
    writeStateFile(statePath, {
      version: 1,
      crashes: 2,
      launches: [Date.now() - 1_000],
      cleanExit: false,
      lastReset: "yesterday",
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    const parsed = readStateFile(statePath);
    expect(typeof parsed.lastReset).toBe("number");
    expect(parsed.cleanExit).toBe(false);
    expect(Array.isArray(parsed.launches)).toBe(true);
  });

  it("quarantine survives a chmod failure (rename is authoritative)", () => {
    writeStateFile(statePath, { not: "valid", structure: true });
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: not permitted"), { code: "EPERM" });
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.getQuarantinedStatePath()).toMatch(/\.corrupted\.\d+$/);
    expect(fs.existsSync(guard.getQuarantinedStatePath()!)).toBe(true);
    chmodSpy.mockRestore();
  });

  it("rename failure in quarantine leaves quarantinedStatePath null without throwing", () => {
    writeStateFile(statePath, { not: "valid" });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });

    const guard = new CrashLoopGuardService();
    expect(() => guard.initialize()).not.toThrow();
    expect(guard.getQuarantinedStatePath()).toBeNull();
    renameSpy.mockRestore();
  });

  it("sweep failure (readdirSync throws) does not prevent boot", () => {
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });

    const guard = new CrashLoopGuardService();
    expect(() => guard.initialize()).not.toThrow();
    expect(guard.isSafeMode()).toBe(false);
    readdirSpy.mockRestore();
  });

  it("quarantines state with non-finite numeric fields (Infinity from JSON overflow)", () => {
    // JSON.parse turns numeric overflow into Infinity. Without an isFinite
    // guard the file would pass type validation, then JSON.stringify on the
    // write-back would emit `null` — corrupting the file on the next boot
    // instead of the current one. Quarantine immediately.
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        // eslint-disable-next-line no-loss-of-precision
        crashes: 1e309, // → Infinity after JSON.parse
        launches: [],
        cleanExit: false,
        lastReset: Date.now(),
      }),
      "utf8"
    );

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.getQuarantinedStatePath()).toMatch(/\.corrupted\.\d+$/);
  });

  it("quarantines state when lastReset is Infinity", () => {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 0,
        launches: [],
        cleanExit: false,
        // eslint-disable-next-line no-loss-of-precision
        lastReset: 1e309,
      }),
      "utf8"
    );

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.getQuarantinedStatePath()).toMatch(/\.corrupted\.\d+$/);
  });

  it("prune tolerates `.corrupted.*` siblings with malformed timestamps", () => {
    // A malformed entry that would parse to NaN if naively coerced.
    fs.writeFileSync(
      path.join(tmpDir, "crash-loop-state.json.corrupted.not-a-number"),
      "x",
      "utf8"
    );
    // The regex requires \d+, so this entry is ignored entirely.
    const guard = new CrashLoopGuardService();
    expect(() => guard.initialize()).not.toThrow();

    // Non-matching entry is preserved (we only act on regex matches).
    expect(fs.existsSync(path.join(tmpDir, "crash-loop-state.json.corrupted.not-a-number"))).toBe(
      true
    );
  });

  it("does not keep relaunch disabled after old launches roll out of the crash window", () => {
    const now = Date.now();
    // Four launches outside the 30-min window (decayed) plus two inside —
    // safe mode and relaunch should reflect only the recent two.
    writeStateFile(statePath, {
      version: 1,
      crashes: 5,
      launches: [
        now - 35 * 60_000,
        now - 34 * 60_000,
        now - 33 * 60_000,
        now - 31 * 60_000,
        now - 1_000,
        now - 500,
      ],
      cleanExit: false,
      lastReset: now - 2 * 60_000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
    expect((readStateFile(statePath).launches as unknown[]).length).toBe(5);
  });
});
