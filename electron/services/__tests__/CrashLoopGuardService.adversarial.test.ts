import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

import { CrashLoopGuardService } from "../CrashLoopGuardService.js";

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

  it("slow flap of four 6-minute-spaced crashes accumulates safe mode (regression #8683)", () => {
    const start = new Date("2026-04-13T12:00:00.000Z").getTime();

    // Three prior unclean boots, then a fourth that reads the prior three
    // as crashes-from-disk and trips safe mode. Under the prior 5-min
    // rapid window those earlier entries had decayed and the fourth boot
    // would have stayed normal.
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(start + i * 6 * 60_000);
      new CrashLoopGuardService().initialize();
    }

    vi.setSystemTime(start + 3 * 6 * 60_000);
    const guard = new CrashLoopGuardService();
    guard.initialize();
    expect(guard.isSafeMode()).toBe(true);
    expect(guard.getCrashCount()).toBe(3);
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
