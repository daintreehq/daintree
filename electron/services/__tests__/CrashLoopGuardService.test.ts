import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => ""),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

import { CrashLoopGuardService } from "../CrashLoopGuardService.js";

describe("CrashLoopGuardService", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crash-guard-test-"));
    appMock.getPath.mockReturnValue(tmpDir);
    statePath = path.join(tmpDir, "crash-loop-state.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

    // Write state with old launches (outside 60s window)
    writeState({
      version: 1,
      crashes: 3,
      launches: [now - 120000, now - 90000, now - 70000],
      cleanExit: false,
      lastReset: now - 300000,
    });

    const guard = new CrashLoopGuardService();
    guard.initialize();

    // Old launches are outside the 60s window, so crashes should be 0
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
});
