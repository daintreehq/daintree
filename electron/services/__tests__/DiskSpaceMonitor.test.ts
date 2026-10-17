import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/fake/userData"),
}));

vi.mock("electron", () => ({
  app: appMock,
}));

const statfsMock = vi.fn();

vi.mock("node:fs", () => ({
  promises: {
    statfs: statfsMock,
  },
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import type { DiskSpaceMonitorActions } from "../DiskSpaceMonitor.js";

function makeStatfs(availableMb: number) {
  const bsize = 4096n;
  const bavail = BigInt(Math.floor((availableMb * 1024 * 1024) / 4096));
  return { bavail, bsize, bfree: bavail + 1000n, blocks: bavail + 50000n };
}

function createActions(): DiskSpaceMonitorActions & {
  calls: {
    sendStatus: Array<{ status: string; availableMb: number; writesSuppressed: boolean }>;
    onCriticalChange: boolean[];
    notifications: Array<{ title: string; body: string }>;
  };
} {
  const calls = {
    sendStatus: [] as Array<{ status: string; availableMb: number; writesSuppressed: boolean }>,
    onCriticalChange: [] as boolean[],
    notifications: [] as Array<{ title: string; body: string }>,
  };
  return {
    sendStatus: (payload) => calls.sendStatus.push(payload),
    onCriticalChange: (isCritical) => calls.onCriticalChange.push(isCritical),
    showNativeNotification: (title, body) => calls.notifications.push({ title, body }),
    isWindowFocused: () => false,
    calls,
  };
}

describe("DiskSpaceMonitor", () => {
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_830_001);
    statfsMock.mockReset();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    vi.useRealTimers();
    vi.resetModules();
  });

  async function importAndStart(actions: DiskSpaceMonitorActions) {
    const mod = await import("../DiskSpaceMonitor.js");
    cleanup = mod.startDiskSpaceMonitor(actions);
    // Wait for the immediate async poll to complete
    await vi.advanceTimersByTimeAsync(0);
    return mod;
  }

  it("runs startup poll immediately and reports normal status", async () => {
    statfsMock.mockResolvedValue(makeStatfs(3000));
    const actions = createActions();
    const mod = await importAndStart(actions);

    // Normal status: no sendStatus call (status didn't change from initial "normal")
    expect(actions.calls.sendStatus).toHaveLength(0);
    expect(mod.getCurrentDiskSpaceStatus().status).toBe("normal");
    expect(mod.getCurrentDiskSpaceStatus().availableMb).toBeCloseTo(3000, 0);
  });

  it("transitions to warning when disk space drops below 2000MB", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("warning");
    expect(actions.calls.sendStatus[0].writesSuppressed).toBe(false);
    expect(actions.calls.onCriticalChange).toHaveLength(0);
  });

  it("transitions to critical when disk space drops below 500MB", async () => {
    statfsMock.mockResolvedValue(makeStatfs(50));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("critical");
    expect(actions.calls.sendStatus[0].writesSuppressed).toBe(true);
    expect(actions.calls.onCriticalChange).toEqual([true]);
  });

  it("sends native notification when not focused", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(1);
    expect(actions.calls.notifications[0].title).toContain("Low disk space");
  });

  it("does not send native notification when focused", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    actions.isWindowFocused = () => true;
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(0);
  });

  it("recovers from critical to normal and calls onCriticalChange(false)", async () => {
    statfsMock.mockResolvedValue(makeStatfs(50));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.onCriticalChange).toEqual([true]);

    // Recover
    statfsMock.mockResolvedValue(makeStatfs(3000));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.onCriticalChange).toEqual([true, false]);
    expect(actions.calls.sendStatus).toHaveLength(2);
    expect(actions.calls.sendStatus[1].status).toBe("normal");
  });

  it("handles statfs errors gracefully and continues polling", async () => {
    statfsMock.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const actions = createActions();
    await importAndStart(actions);

    // No crash, no status sent
    expect(actions.calls.sendStatus).toHaveLength(0);

    // Next poll works
    statfsMock.mockResolvedValue(makeStatfs(1500));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("warning");
  });

  it("respects notification cooldown", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(1);

    // Still warning after 5 minutes - same status, no new sendStatus call
    statfsMock.mockResolvedValue(makeStatfs(1400));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // No new notification (same status, cooldown not expired)
    expect(actions.calls.notifications).toHaveLength(1);
  });

  it("bypasses cooldown when escalating to critical", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(1);

    // Escalate to critical immediately
    statfsMock.mockResolvedValue(makeStatfs(50));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.notifications).toHaveLength(2);
    expect(actions.calls.notifications[1].title).toContain("Critical");
  });

  it("does not call callbacks after disposal", async () => {
    statfsMock.mockResolvedValue(makeStatfs(3000));
    const actions = createActions();
    await importAndStart(actions);

    cleanup?.();
    cleanup = null;

    statfsMock.mockResolvedValue(makeStatfs(50));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.sendStatus).toHaveLength(0);
  });

  it("getCurrentDiskSpaceStatus returns cached value", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    const mod = await importAndStart(actions);

    const status = mod.getCurrentDiskSpaceStatus();
    expect(status.status).toBe("warning");
    expect(status.availableMb).toBeCloseTo(1500, 0);
    expect(status.writesSuppressed).toBe(false);
  });

  it("publishes writesSuppressed=false to the shim once disk recovers", async () => {
    statfsMock.mockResolvedValue(makeStatfs(50));
    const actions = createActions();
    await importAndStart(actions);

    const { getWritesSuppressed } = await import("../diskPressureState.js");
    expect(getWritesSuppressed()).toBe(true);

    statfsMock.mockResolvedValue(makeStatfs(3000));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(getWritesSuppressed()).toBe(false);
  });

  it("does not suppress writes at warning level", async () => {
    statfsMock.mockResolvedValue(makeStatfs(1500));
    const actions = createActions();
    await importAndStart(actions);

    const { getWritesSuppressed } = await import("../diskPressureState.js");
    expect(getWritesSuppressed()).toBe(false);
  });

  describe("hysteresis", () => {
    it("initial escalation to warning is not blocked by hysteresis", async () => {
      statfsMock.mockResolvedValue(makeStatfs(1999));
      const actions = createActions();
      await importAndStart(actions);

      expect(actions.calls.sendStatus).toHaveLength(1);
      expect(actions.calls.sendStatus[0].status).toBe("warning");
    });

    it("warning latched: stays warning at 2001-2049 MB range", async () => {
      statfsMock.mockResolvedValue(makeStatfs(1999));
      const actions = createActions();
      await importAndStart(actions);

      expect(actions.calls.sendStatus[0].status).toBe("warning");

      // Oscillate just above warning enter threshold but below exit
      statfsMock.mockResolvedValue(makeStatfs(2001));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(actions.calls.sendStatus).toHaveLength(1); // no new transition

      statfsMock.mockResolvedValue(makeStatfs(2049));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(actions.calls.sendStatus).toHaveLength(1); // still latched
    });

    it("warning exit: recovers to normal at 2051 MB", async () => {
      statfsMock.mockResolvedValue(makeStatfs(1999));
      const actions = createActions();
      await importAndStart(actions);

      expect(actions.calls.sendStatus[0].status).toBe("warning");

      statfsMock.mockResolvedValue(makeStatfs(2051));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(actions.calls.sendStatus).toHaveLength(2);
      expect(actions.calls.sendStatus[1].status).toBe("normal");
    });

    it("writesSuppressed stays true during critical hysteresis band (530 MB)", async () => {
      statfsMock.mockResolvedValue(makeStatfs(400));
      const actions = createActions();
      const mod = await importAndStart(actions);

      expect(actions.calls.sendStatus[0].status).toBe("critical");
      expect(actions.calls.sendStatus[0].writesSuppressed).toBe(true);

      // Still within critical exit band
      statfsMock.mockResolvedValue(makeStatfs(530));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      // Status unchanged, writesSuppressed still true
      expect(actions.calls.sendStatus).toHaveLength(1);
      const { getWritesSuppressed } = await import("../diskPressureState.js");
      expect(getWritesSuppressed()).toBe(true);
      expect(mod.getCurrentDiskSpaceStatus().status).toBe("critical");
      expect(mod.getCurrentDiskSpaceStatus().writesSuppressed).toBe(true);
    });
  });
});

type StatfsResult = { bavail: bigint; bsize: bigint };

function statfsFor(availableMb: number): StatfsResult {
  return { bavail: BigInt(availableMb), bsize: 1048576n };
}

function makeActions() {
  return {
    sendStatus: vi.fn(),
    onCriticalChange: vi.fn(),
    showNativeNotification: vi.fn(),
    isWindowFocused: vi.fn().mockReturnValue(false),
  };
}

const INTERVAL_MS = 5 * 60 * 1000;

describe("DiskSpaceMonitor adversarial", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_830_001);
    vi.clearAllMocks();
    appMock.getPath.mockReturnValue("/userdata");
    statfsMock.mockResolvedValue(statfsFor(10_000));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function loadModule() {
    return await import("../DiskSpaceMonitor.js");
  }

  it("dispose while statfs is in flight suppresses all late side effects", async () => {
    let resolveStatfs: (v: StatfsResult) => void = () => {};
    statfsMock.mockReturnValueOnce(
      new Promise<StatfsResult>((resolve) => {
        resolveStatfs = resolve;
      })
    );

    const { startDiskSpaceMonitor } = await loadModule();
    const actions = makeActions();
    const cleanup = startDiskSpaceMonitor(actions);

    cleanup();
    resolveStatfs(statfsFor(50));
    await vi.advanceTimersByTimeAsync(0);

    expect(actions.sendStatus).not.toHaveBeenCalled();
    expect(actions.onCriticalChange).not.toHaveBeenCalled();
    expect(actions.showNativeNotification).not.toHaveBeenCalled();
  });

  it("app.getPath throwing is treated as a poll failure and does not crash the loop", async () => {
    appMock.getPath.mockImplementationOnce(() => {
      throw new Error("no such path key");
    });

    const { startDiskSpaceMonitor } = await loadModule();
    const cleanup = startDiskSpaceMonitor(makeActions());

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(statfsMock).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("cleanup stops further interval scheduling after a failed poll", async () => {
    statfsMock.mockRejectedValue(new Error("boom"));

    const { startDiskSpaceMonitor } = await loadModule();
    const cleanup = startDiskSpaceMonitor(makeActions());

    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    statfsMock.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(statfsMock).not.toHaveBeenCalled();
  });

  it("getCurrentDiskSpaceStatus stays unchanged across a failed poll", async () => {
    const { startDiskSpaceMonitor, getCurrentDiskSpaceStatus } = await loadModule();
    const before = getCurrentDiskSpaceStatus();

    statfsMock.mockRejectedValueOnce(new Error("fail"));
    const cleanup = startDiskSpaceMonitor(makeActions());
    await vi.advanceTimersByTimeAsync(0);

    expect(getCurrentDiskSpaceStatus()).toEqual(before);

    cleanup();
  });

  describe("hysteresis boundary flapping", () => {
    it("critical oscillation: 499->501->549 does not refire callbacks", async () => {
      statfsMock.mockResolvedValueOnce(statfsFor(499));
      const { startDiskSpaceMonitor } = await loadModule();
      const actions = makeActions();
      const cleanup = startDiskSpaceMonitor(actions);

      await vi.advanceTimersByTimeAsync(0);
      expect(actions.sendStatus).toHaveBeenCalledTimes(1);
      expect(actions.sendStatus.mock.calls[0][0].status).toBe("critical");

      // 501 MB — still within critical exit band, should stay critical
      statfsMock.mockResolvedValueOnce(statfsFor(501));
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(actions.sendStatus).toHaveBeenCalledTimes(1); // no new transition

      // 549 MB — still latched critical
      statfsMock.mockResolvedValueOnce(statfsFor(549));
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(actions.sendStatus).toHaveBeenCalledTimes(1); // still latched

      cleanup();
    });

    it("critical exits only above 550: 551 enters warning, fires callbacks once", async () => {
      statfsMock.mockResolvedValueOnce(statfsFor(400));
      const { startDiskSpaceMonitor } = await loadModule();
      const actions = makeActions();
      const cleanup = startDiskSpaceMonitor(actions);

      await vi.advanceTimersByTimeAsync(0);
      expect(actions.sendStatus.mock.calls[0][0].status).toBe("critical");
      expect(actions.onCriticalChange).toHaveBeenCalledWith(true);

      // 551 MB exceeds critical exit threshold but is below warning enter — becomes warning
      statfsMock.mockResolvedValueOnce(statfsFor(551));
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(actions.sendStatus).toHaveBeenCalledTimes(2);
      expect(actions.sendStatus.mock.calls[1][0].status).toBe("warning");
      expect(actions.onCriticalChange).toHaveBeenCalledWith(false);

      cleanup();
    });

    it("warning->critical escalation not latched: 1900->400 goes critical immediately", async () => {
      statfsMock.mockResolvedValueOnce(statfsFor(1900));
      const { startDiskSpaceMonitor } = await loadModule();
      const actions = makeActions();
      const cleanup = startDiskSpaceMonitor(actions);

      await vi.advanceTimersByTimeAsync(0);
      expect(actions.sendStatus.mock.calls[0][0].status).toBe("warning");

      // Escalation always uses enter thresholds — hysteresis only gates recovery
      statfsMock.mockResolvedValueOnce(statfsFor(400));
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(actions.sendStatus).toHaveBeenCalledTimes(2);
      expect(actions.sendStatus.mock.calls[1][0].status).toBe("critical");
      expect(actions.onCriticalChange).toHaveBeenCalledWith(true);

      cleanup();
    });
  });
});
