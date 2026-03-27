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
  const bsize = 4096;
  const bavail = Math.floor((availableMb * 1024 * 1024) / bsize);
  return { bavail, bsize, bfree: bavail + 1000, blocks: bavail + 50000 };
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
    statfsMock.mockResolvedValue(makeStatfs(1000));
    const actions = createActions();
    const mod = await importAndStart(actions);

    // Normal status: no sendStatus call (status didn't change from initial "normal")
    expect(actions.calls.sendStatus).toHaveLength(0);
    expect(mod.getCurrentDiskSpaceStatus().status).toBe("normal");
    expect(mod.getCurrentDiskSpaceStatus().availableMb).toBeCloseTo(1000, 0);
  });

  it("transitions to warning when disk space drops below 500MB", async () => {
    statfsMock.mockResolvedValue(makeStatfs(400));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("warning");
    expect(actions.calls.sendStatus[0].writesSuppressed).toBe(false);
    expect(actions.calls.onCriticalChange).toHaveLength(0);
  });

  it("transitions to critical when disk space drops below 100MB", async () => {
    statfsMock.mockResolvedValue(makeStatfs(50));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("critical");
    expect(actions.calls.sendStatus[0].writesSuppressed).toBe(true);
    expect(actions.calls.onCriticalChange).toEqual([true]);
  });

  it("sends native notification when not focused", async () => {
    statfsMock.mockResolvedValue(makeStatfs(300));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(1);
    expect(actions.calls.notifications[0].title).toContain("Low disk space");
  });

  it("does not send native notification when focused", async () => {
    statfsMock.mockResolvedValue(makeStatfs(300));
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
    statfsMock.mockResolvedValue(makeStatfs(1000));
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
    statfsMock.mockResolvedValue(makeStatfs(300));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.sendStatus).toHaveLength(1);
    expect(actions.calls.sendStatus[0].status).toBe("warning");
  });

  it("respects notification cooldown", async () => {
    statfsMock.mockResolvedValue(makeStatfs(400));
    const actions = createActions();
    await importAndStart(actions);

    expect(actions.calls.notifications).toHaveLength(1);

    // Still warning after 5 minutes - same status, no new sendStatus call
    statfsMock.mockResolvedValue(makeStatfs(350));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    // No new notification (same status, cooldown not expired)
    expect(actions.calls.notifications).toHaveLength(1);
  });

  it("bypasses cooldown when escalating to critical", async () => {
    statfsMock.mockResolvedValue(makeStatfs(400));
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
    statfsMock.mockResolvedValue(makeStatfs(1000));
    const actions = createActions();
    await importAndStart(actions);

    cleanup?.();
    cleanup = null;

    statfsMock.mockResolvedValue(makeStatfs(50));
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(actions.calls.sendStatus).toHaveLength(0);
  });

  it("getCurrentDiskSpaceStatus returns cached value", async () => {
    statfsMock.mockResolvedValue(makeStatfs(300));
    const actions = createActions();
    const mod = await importAndStart(actions);

    const status = mod.getCurrentDiskSpaceStatus();
    expect(status.status).toBe("warning");
    expect(status.availableMb).toBeCloseTo(300, 0);
    expect(status.writesSuppressed).toBe(false);
  });
});
