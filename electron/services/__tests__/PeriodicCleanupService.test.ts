import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPowerMonitor = vi.hoisted(() => ({
  getSystemIdleTime: vi.fn().mockReturnValue(120),
}));

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn().mockReturnValue("/fake/userData"),
}));

const mockRunScratchCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunAssistantScratchCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPruneOldLogs = vi.hoisted(() => vi.fn());
const mockStoreGet = vi.hoisted(() => vi.fn().mockReturnValue({ logRetentionDays: 30 }));

vi.mock("electron", () => ({
  app: mockApp,
  powerMonitor: mockPowerMonitor,
}));

vi.mock("../ScratchCleanupService.js", () => ({
  runScratchCleanup: mockRunScratchCleanup,
}));

vi.mock("../AssistantScratchService.js", () => ({
  runAssistantScratchCleanup: mockRunAssistantScratchCleanup,
}));

vi.mock("../../utils/logger.js", () => ({
  pruneOldLogs: mockPruneOldLogs,
  logError: vi.fn(),
}));

vi.mock("../../store.js", () => ({
  store: { get: mockStoreGet },
}));

import { PeriodicCleanupService } from "../PeriodicCleanupService.js";

describe("PeriodicCleanupService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.clearAllMocks();
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
    mockApp.getPath.mockReturnValue("/fake/userData");
    mockRunScratchCleanup.mockResolvedValue(undefined);
    mockRunAssistantScratchCleanup.mockResolvedValue(undefined);
    mockStoreGet.mockReturnValue({ logRetentionDays: 30 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function expectNoRoutinesRan() {
    expect(mockRunScratchCleanup).not.toHaveBeenCalled();
    expect(mockRunAssistantScratchCleanup).not.toHaveBeenCalled();
    expect(mockPruneOldLogs).not.toHaveBeenCalled();
  }

  function expectAllRoutinesRan() {
    expect(mockRunScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockRunAssistantScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockPruneOldLogs).toHaveBeenCalledTimes(1);
  }

  it("runs all three routines when the system is idle", async () => {
    const service = new PeriodicCleanupService();
    await service.tick();

    expectAllRoutinesRan();
    expect(mockPruneOldLogs).toHaveBeenCalledWith("/fake/userData", 30);
    service.dispose();
  });

  it("skips the tick when the system is not idle", async () => {
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(10);
    const service = new PeriodicCleanupService();
    await service.tick();

    expectNoRoutinesRan();
    service.dispose();
  });

  it("skips the tick when powerMonitor throws", async () => {
    mockPowerMonitor.getSystemIdleTime.mockImplementation(() => {
      throw new Error("not ready");
    });
    const service = new PeriodicCleanupService();
    await expect(service.tick()).resolves.toBeUndefined();

    expectNoRoutinesRan();
    service.dispose();
  });

  it("does not invoke the routines before the cadence elapses", async () => {
    const service = new PeriodicCleanupService();
    service.start();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour < 4h cadence
    expectNoRoutinesRan();

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000); // crosses the 4h mark
    expectAllRoutinesRan();
    service.dispose();
  });

  it("prevents overlapping ticks via the inFlight guard", async () => {
    let resolveScratch: () => void = () => {};
    mockRunScratchCleanup.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveScratch = resolve;
      })
    );

    const service = new PeriodicCleanupService();
    const first = service.tick(); // enters inFlight, awaits the pending scratch cleanup
    await service.tick(); // should bail out immediately

    expect(mockRunScratchCleanup).toHaveBeenCalledTimes(1);

    resolveScratch();
    await first;
    service.dispose();
  });

  it("isolates per-routine failures so the others still run", async () => {
    mockRunScratchCleanup.mockRejectedValue(new Error("boom"));
    const service = new PeriodicCleanupService();
    await service.tick();

    expect(mockRunScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockRunAssistantScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockPruneOldLogs).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("skips log pruning when retention is zero", async () => {
    mockStoreGet.mockReturnValue({ logRetentionDays: 0 });
    const service = new PeriodicCleanupService();
    await service.tick();

    expect(mockPruneOldLogs).not.toHaveBeenCalled();
    service.dispose();
  });

  it("drains an in-flight pass before dispose resolves", async () => {
    let resolveScratch: () => void = () => {};
    mockRunScratchCleanup.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveScratch = resolve;
      })
    );

    const service = new PeriodicCleanupService();
    const tickPromise = service.tick();
    await Promise.resolve(); // let tick() enter inFlight

    let disposeResolved = false;
    const disposePromise = service.dispose().then(() => {
      disposeResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(disposeResolved).toBe(false); // still draining the pending sweep

    resolveScratch();
    await tickPromise;
    await disposePromise;
    expect(disposeResolved).toBe(true);
  });

  it("does not tick after dispose", async () => {
    const service = new PeriodicCleanupService();
    service.start();
    await service.dispose();

    await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
    expectNoRoutinesRan();

    // A direct tick after dispose is also a no-op.
    await service.tick();
    expectNoRoutinesRan();
  });
});
