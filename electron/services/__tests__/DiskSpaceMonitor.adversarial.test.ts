import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({ getPath: vi.fn<(key: string) => string>() }));
const fsMock = vi.hoisted(() => ({
  statfs: vi.fn<(p: string) => Promise<{ bavail: number; bsize: number }>>(),
}));

vi.mock("electron", () => ({ app: appMock }));
vi.mock("node:fs", () => ({ promises: fsMock }));

type StatfsResult = { bavail: number; bsize: number };

function statfsFor(availableMb: number): StatfsResult {
  return { bavail: availableMb, bsize: 1024 * 1024 };
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
    vi.clearAllMocks();
    appMock.getPath.mockReturnValue("/userdata");
    fsMock.statfs.mockResolvedValue(statfsFor(10_000));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadModule() {
    return await import("../DiskSpaceMonitor.js");
  }

  it("dispose while statfs is in flight suppresses all late side effects", async () => {
    let resolveStatfs: (v: StatfsResult) => void = () => {};
    fsMock.statfs.mockReturnValueOnce(
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

    expect(fsMock.statfs).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("statfs failure on initial poll does not block recovery on next interval", async () => {
    fsMock.statfs
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
      .mockResolvedValueOnce(statfsFor(50));

    const { startDiskSpaceMonitor } = await loadModule();
    const actions = makeActions();
    const cleanup = startDiskSpaceMonitor(actions);

    await vi.advanceTimersByTimeAsync(0);
    expect(actions.sendStatus).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(actions.sendStatus).toHaveBeenCalledTimes(1);
    expect(actions.onCriticalChange).toHaveBeenCalledWith(true);

    cleanup();
  });

  it("cleanup stops further interval scheduling after a failed poll", async () => {
    fsMock.statfs.mockRejectedValue(new Error("boom"));

    const { startDiskSpaceMonitor } = await loadModule();
    const cleanup = startDiskSpaceMonitor(makeActions());

    await vi.advanceTimersByTimeAsync(0);
    cleanup();
    fsMock.statfs.mockClear();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(fsMock.statfs).not.toHaveBeenCalled();
  });

  it("getCurrentDiskSpaceStatus stays unchanged across a failed poll", async () => {
    const { startDiskSpaceMonitor, getCurrentDiskSpaceStatus } = await loadModule();
    const before = getCurrentDiskSpaceStatus();

    fsMock.statfs.mockRejectedValueOnce(new Error("fail"));
    const cleanup = startDiskSpaceMonitor(makeActions());
    await vi.advanceTimersByTimeAsync(0);

    expect(getCurrentDiskSpaceStatus()).toEqual(before);

    cleanup();
  });

  it("critical->normal transition fires onCriticalChange(false) exactly once", async () => {
    fsMock.statfs.mockResolvedValueOnce(statfsFor(50)).mockResolvedValueOnce(statfsFor(10_000));

    const { startDiskSpaceMonitor } = await loadModule();
    const actions = makeActions();
    const cleanup = startDiskSpaceMonitor(actions);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(0);

    const criticalCalls = actions.onCriticalChange.mock.calls.map((c) => c[0]);
    expect(criticalCalls).toEqual([true, false]);

    cleanup();
  });

  it("notification is skipped when the window is focused during a warning transition", async () => {
    fsMock.statfs.mockResolvedValueOnce(statfsFor(300));

    const { startDiskSpaceMonitor } = await loadModule();
    const actions = makeActions();
    actions.isWindowFocused.mockReturnValue(true);
    const cleanup = startDiskSpaceMonitor(actions);

    await vi.advanceTimersByTimeAsync(0);

    expect(actions.showNativeNotification).not.toHaveBeenCalled();
    expect(actions.sendStatus).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("critical availableMb computes writesSuppressed:true in the emitted payload", async () => {
    fsMock.statfs.mockResolvedValueOnce(statfsFor(50));

    const { startDiskSpaceMonitor } = await loadModule();
    const actions = makeActions();
    const cleanup = startDiskSpaceMonitor(actions);

    await vi.advanceTimersByTimeAsync(0);

    const [payload] = actions.sendStatus.mock.calls[0];
    expect(payload.status).toBe("critical");
    expect(payload.writesSuppressed).toBe(true);

    cleanup();
  });
});
