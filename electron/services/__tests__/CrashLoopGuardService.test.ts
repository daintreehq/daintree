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

  it("returns true with 3 recent unclean launches", () => {
    const now = Date.now();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 3,
        launches: [now - 10000, now - 20000, now - 30000],
        cleanExit: false,
        lastReset: now - 60000,
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(true);
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

  it("returns false when launches are outside the rapid crash window", () => {
    const now = Date.now();
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        crashes: 3,
        launches: [now - 400000, now - 370000, now - 340000],
        cleanExit: false,
        lastReset: now - 300000,
      }),
      "utf8"
    );

    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns false on corrupted state file", () => {
    fs.writeFileSync(statePath, "not valid json!!!", "utf8");
    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("returns false on invalid state structure", () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 2, foo: "bar" }), "utf8");
    expect(isSafeModeActive(tmpDir)).toBe(false);
  });

  it("defaults to app.getPath('userData') when called without args", () => {
    appMock.getPath.mockReturnValue(tmpDir);
    expect(isSafeModeActive()).toBe(false);
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

  it("resets counter after stability timer fires", () => {
    // Simulate 2 crashes
    for (let i = 0; i < 2; i++) {
      const guard = new CrashLoopGuardService();
      guard.initialize();
    }

    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.startStabilityTimer();

    vi.advanceTimersByTime(5 * 60 * 1000);

    const state = readState();
    expect(state.crashes).toBe(0);
    expect(state.cleanExit).toBe(true);

    guard.dispose();
  });

  it("handles corrupted state file gracefully", () => {
    fs.writeFileSync(statePath, "not valid json!!!", "utf8");

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("handles invalid state structure gracefully", () => {
    writeState({ version: 2, foo: "bar" });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
  });

  it("only counts crashes within the rapid crash window", () => {
    const now = Date.now();

    // Write state with old launches (outside 300s window)
    writeState({
      version: 1,
      crashes: 3,
      launches: [now - 400000, now - 370000, now - 340000],
      cleanExit: false,
      lastReset: now - 300000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    // Old launches are outside the 300s window, so crashes should be 0
    expect(guard.isSafeMode()).toBe(false);
  });

  it("dispose clears stability timer", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.startStabilityTimer();
    guard.dispose();

    // Timer should not fire
    const stateBefore = readState();
    vi.advanceTimersByTime(5 * 60 * 1000);
    const stateAfter = readState();

    expect(stateAfter.crashes).toBe(stateBefore.crashes);
  });

  it("stability timer resets in-memory flags after hard stop", () => {
    // Reach hard-stop state (5 crashes)
    for (let i = 0; i < 5; i++) {
      const guard = new CrashLoopGuardService();
      guard.initialize();
    }

    const guard = new CrashLoopGuardService();
    guard.initialize();
    expect(guard.isSafeMode()).toBe(true);
    expect(guard.shouldRelaunch()).toBe(false);

    guard.startStabilityTimer();
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);

    guard.dispose();
  });

  it("initialize is idempotent — second call is a no-op", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.initialize();

    const state = readState();
    expect(state.launches).toHaveLength(1);
  });

  it("startStabilityTimer is idempotent", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.startStabilityTimer();
    guard.startStabilityTimer();

    vi.advanceTimersByTime(5 * 60 * 1000);

    const state = readState();
    expect(state.crashes).toBe(0);

    guard.dispose();
  });

  describe("crash metadata", () => {
    it("getCrashCount reports zero on a fresh boot", () => {
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.getCrashCount()).toBe(0);
    });

    it("getLastCrashTimestamp is undefined on a fresh boot", () => {
      const guard = new CrashLoopGuardService();
      guard.initialize();
      expect(guard.getLastCrashTimestamp()).toBeUndefined();
    });

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

    it("cancels the stability timer so it can't clobber the fresh state", () => {
      for (let i = 0; i < 3; i++) {
        const guard = new CrashLoopGuardService();
        guard.initialize();
      }
      const guard = new CrashLoopGuardService();
      guard.initialize();
      guard.startStabilityTimer();

      guard.resetForNormalBoot();

      // Advancing past the 5-minute timeout must not re-fire the timer
      // (which would also write fresh state, but more importantly must
      // not throw on a torn-down service).
      vi.advanceTimersByTime(6 * 60 * 1000);

      const state = readState();
      expect(state.crashes).toBe(0);
      expect(state.cleanExit).toBe(true);

      guard.dispose();
    });
  });
});
