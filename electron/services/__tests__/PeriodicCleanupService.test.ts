import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPowerMonitor = vi.hoisted(() => ({
  getSystemIdleTime: vi.fn().mockReturnValue(120),
}));

const mockApp = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => `/fake/${name}`),
}));

const mockRunScratchCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRunAssistantScratchCleanup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPruneOldLogs = vi.hoisted(() => vi.fn());
const mockPruneHeapSnapshotsAsync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockPruneAuditByRetention = vi.hoisted(() => vi.fn());

// store.get is key-aware: the log-prune routine reads "privacy", the audit-prune
// routine reads "helpAssistant". A single flat return value would feed the wrong
// shape to whichever routine didn't expect it.
function storeGetByKey(key: string): unknown {
  if (key === "helpAssistant") return { auditRetention: 7 };
  return { logRetentionDays: 30 };
}
const mockStoreGet = vi.hoisted(() => vi.fn());

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
  pruneHeapSnapshotsAsync: mockPruneHeapSnapshotsAsync,
  MAX_HEAP_SNAPSHOTS: 10,
  logError: vi.fn(),
}));

vi.mock("../../store.js", () => ({
  store: { get: mockStoreGet },
}));

vi.mock("../McpServerService.js", () => ({
  mcpServerService: { pruneAuditByRetention: mockPruneAuditByRetention },
}));

import { PeriodicCleanupService } from "../PeriodicCleanupService.js";

describe("PeriodicCleanupService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.clearAllMocks();
    mockPowerMonitor.getSystemIdleTime.mockReturnValue(120);
    mockApp.getPath.mockImplementation((name: string) => `/fake/${name}`);
    mockRunScratchCleanup.mockResolvedValue(undefined);
    mockRunAssistantScratchCleanup.mockResolvedValue(undefined);
    mockPruneHeapSnapshotsAsync.mockResolvedValue(undefined);
    mockStoreGet.mockImplementation(storeGetByKey);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function expectNoRoutinesRan() {
    expect(mockRunScratchCleanup).not.toHaveBeenCalled();
    expect(mockRunAssistantScratchCleanup).not.toHaveBeenCalled();
    expect(mockPruneOldLogs).not.toHaveBeenCalled();
    expect(mockPruneHeapSnapshotsAsync).not.toHaveBeenCalled();
  }

  function expectAllRoutinesRan() {
    expect(mockRunScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockRunAssistantScratchCleanup).toHaveBeenCalledTimes(1);
    expect(mockPruneOldLogs).toHaveBeenCalledTimes(1);
    expect(mockPruneHeapSnapshotsAsync).toHaveBeenCalledTimes(1);
  }

  it("runs all routines when the system is idle", async () => {
    const service = new PeriodicCleanupService();
    await service.tick();

    expectAllRoutinesRan();
    expect(mockPruneOldLogs).toHaveBeenCalledWith("/fake/userData", 30);
    expect(mockPruneHeapSnapshotsAsync).toHaveBeenCalledWith("/fake/logs", 10);
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

  it("skips log pruning when retention is zero but still prunes heap snapshots", async () => {
    mockStoreGet.mockReturnValue({ logRetentionDays: 0 });
    const service = new PeriodicCleanupService();
    await service.tick();

    // Heap snapshot pruning is count-based, not gated on log retention.
    expect(mockPruneOldLogs).not.toHaveBeenCalled();
    expect(mockPruneHeapSnapshotsAsync).toHaveBeenCalledWith("/fake/logs", 10);
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

  it("prunes assistant audit logs using the configured retention (#10776)", async () => {
    mockStoreGet.mockImplementation((key: string) =>
      key === "helpAssistant" ? { auditRetention: 30 } : { logRetentionDays: 30 }
    );
    const service = new PeriodicCleanupService();
    await service.tick();

    expect(mockPruneAuditByRetention).toHaveBeenCalledWith(30);
    service.dispose();
  });

  it("defaults to a 7-day audit retention when the setting is absent (#10776)", async () => {
    mockStoreGet.mockImplementation((key: string) =>
      key === "helpAssistant" ? {} : { logRetentionDays: 30 }
    );
    const service = new PeriodicCleanupService();
    await service.tick();

    expect(mockPruneAuditByRetention).toHaveBeenCalledWith(7);
    service.dispose();
  });

  it("skips audit pruning when retention is Off (0) (#10776)", async () => {
    mockStoreGet.mockImplementation((key: string) =>
      key === "helpAssistant" ? { auditRetention: 0 } : { logRetentionDays: 30 }
    );
    const service = new PeriodicCleanupService();
    await service.tick();

    expect(mockPruneAuditByRetention).not.toHaveBeenCalled();
    service.dispose();
  });

  it("skips audit pruning when the stored retention is a corrupt non-number (#10776)", async () => {
    mockStoreGet.mockImplementation((key: string) =>
      key === "helpAssistant"
        ? ({ auditRetention: "7" } as unknown as { auditRetention: number })
        : { logRetentionDays: 30 }
    );
    const service = new PeriodicCleanupService();
    await service.tick();

    // A stringly-typed value coerces to `"7" > 0 === true`, so guard on the
    // type, not just the comparison — otherwise prune is a silent no-op.
    expect(mockPruneAuditByRetention).not.toHaveBeenCalled();
    service.dispose();
  });

  it("isolates an audit-prune failure so the other routines still run (#10776)", async () => {
    mockPruneAuditByRetention.mockImplementation(() => {
      throw new Error("prune boom");
    });
    const service = new PeriodicCleanupService();
    await service.tick();

    // The throwing audit prune does not prevent the earlier routines.
    expectAllRoutinesRan();
    service.dispose();
  });
});
