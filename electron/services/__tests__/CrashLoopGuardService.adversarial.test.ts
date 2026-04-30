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

  it("counts only launches strictly inside the rapid-crash window boundary", () => {
    const now = Date.now();
    writeStateFile(statePath, {
      version: 1,
      crashes: 9,
      launches: [now - 300_000, now - 299_999],
      cleanExit: false,
      lastReset: now - 5_000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
    expect(readStateFile(statePath).crashes).toBe(1);
  });

  it("keeps clean-exit state fresh when markCleanExit wins before the stability timer fires", () => {
    const guard = new CrashLoopGuardService();
    guard.initialize();
    guard.startStabilityTimer();
    guard.markCleanExit();

    vi.advanceTimersByTime(5 * 60 * 1000);

    const parsed = readStateFile(statePath);
    expect(parsed).toMatchObject({
      version: 1,
      crashes: 0,
      cleanExit: true,
      launches: [],
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

  it("does not keep relaunch disabled after old launches roll out of the hard-stop window", () => {
    const now = Date.now();
    writeStateFile(statePath, {
      version: 1,
      crashes: 5,
      launches: [
        now - 320_000,
        now - 310_000,
        now - 305_000,
        now - 301_000,
        now - 1_000,
        now - 500,
      ],
      cleanExit: false,
      lastReset: now - 120_000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    expect(guard.isSafeMode()).toBe(false);
    expect(guard.shouldRelaunch()).toBe(true);
    expect((readStateFile(statePath).launches as unknown[]).length).toBe(5);
  });
});
