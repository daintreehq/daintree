// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type {
  ProcessInventoryClosedProcess,
  ProcessInventorySnapshot,
} from "@shared/types/processes";

const notifyMock = vi.hoisted(() => vi.fn((_payload: unknown) => "notice-1"));
const removeNotificationMock = vi.hoisted(() => vi.fn());
const getSnapshotMock = vi.hoisted(() => vi.fn());
const view = vi.hoisted(() => ({
  observable: true,
  listener: null as ((observable: boolean) => void) | null,
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: { getState: () => ({ removeNotification: removeNotificationMock }) },
}));
vi.mock("@/clients/processesClient", () => ({
  processesClient: { getSnapshot: getSnapshotMock },
}));
vi.mock("@/lib/viewCacheState", () => ({
  isProjectViewObservable: () => view.observable,
  subscribeProjectViewObservability: (listener: (observable: boolean) => void) => {
    view.listener = listener;
    return () => {
      view.listener = null;
    };
  },
}));

import {
  CLOSED_PROCESS_POLL_MS,
  useClosedTerminalProcessNotice,
} from "../useClosedTerminalProcessNotice";

interface NoticePayload {
  title: string;
  placement: string;
  supersedeKey: string;
  actions: Array<{ label: string; onClick: () => void }>;
}

function closed(pid: number, memoryKb = 1024 * 1024): ProcessInventoryClosedProcess {
  return {
    pid,
    startTime: `start-${pid}`,
    comm: "node",
    memoryKb,
    cpuPercent: 0,
    origin: { kind: "terminal", id: "t", projectId: "p" },
    closedAt: 1,
    projectName: "Cedar",
  };
}

function snapshotWith(processes: ProcessInventoryClosedProcess[]): ProcessInventorySnapshot {
  return {
    terminals: [],
    closedTerminalProcesses: processes,
    cleanup: null,
    plugins: [],
    complete: true,
    samplesAvailable: true,
    sampledAt: 1,
  };
}

async function poll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLOSED_PROCESS_POLL_MS);
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useClosedTerminalProcessNotice (#13174)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    view.observable = true;
    view.listener = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes the first read as a baseline and announces only what appears after it", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();
    expect(notifyMock).not.toHaveBeenCalled();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201), closed(202)]));
    await poll();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]?.[0] as NoticePayload;
    expect(payload.placement).toBe("grid-bar");
    expect(payload.title).toBe("2 processes from closed terminals · ~2.0 GB");
    expect(payload.supersedeKey).toBe("closed-terminal-processes");

    // The same set again is not news.
    await poll();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("opens the processes view from the notice and clears it", async () => {
    const onView = vi.fn();
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    renderHook(() => useClosedTerminalProcessNotice(onView));
    await settle();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    await poll();

    const payload = notifyMock.mock.calls[0]?.[0] as NoticePayload;
    act(() => payload.actions[0]?.onClick());
    expect(onView).toHaveBeenCalledTimes(1);
    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
  });

  it("withdraws the notice once nothing from a closed terminal is running", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    await poll();
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    await poll();

    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
  });

  it("treats a failed read as no information rather than an empty list", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    await poll();
    getSnapshotMock.mockRejectedValue(new Error("host gone"));
    await poll();

    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("never baselines, announces or withdraws on an incomplete or stale reading", async () => {
    // A partial first reading must not become the baseline...
    getSnapshotMock.mockResolvedValue({ ...snapshotWith([]), complete: false });
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();
    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    await poll();
    expect(notifyMock).not.toHaveBeenCalled();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201), closed(202)]));
    await poll();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // ...and a failed census hides processes rather than proving them gone.
    getSnapshotMock.mockResolvedValue({ ...snapshotWith([]), samplesAvailable: false });
    await poll();
    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("refreshes a standing notice when some of its processes end", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();

    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201), closed(202)]));
    await poll();
    getSnapshotMock.mockResolvedValue(snapshotWith([closed(202)]));
    await poll();

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect((notifyMock.mock.calls[1]?.[0] as NoticePayload).title).toBe(
      "1 process from closed terminals · ~1.0 GB"
    );
  });

  it("withdraws its notice on unmount, since the action targets this badge", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    const { unmount } = renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();
    getSnapshotMock.mockResolvedValue(snapshotWith([closed(201)]));
    await poll();

    unmount();
    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
  });

  it("reads nothing while the view can't be seen, and resumes when it can", async () => {
    view.observable = false;
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await poll();
    expect(getSnapshotMock).not.toHaveBeenCalled();

    view.observable = true;
    await act(async () => {
      view.listener?.(true);
    });
    await settle();
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("stops polling on unmount", async () => {
    getSnapshotMock.mockResolvedValue(snapshotWith([]));
    const { unmount } = renderHook(() => useClosedTerminalProcessNotice(() => {}));
    await settle();
    unmount();
    getSnapshotMock.mockClear();

    await poll();
    expect(getSnapshotMock).not.toHaveBeenCalled();
  });
});
