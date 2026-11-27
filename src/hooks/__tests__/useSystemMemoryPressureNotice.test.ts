// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SystemMemoryPressureDelivery } from "@shared/types/ipc/system";

const notifyMock = vi.fn();
let attended = true;
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
  isWindowAttended: () => attended,
}));

let mac = true;
vi.mock("@/lib/platform", () => ({
  isMac: () => mac,
}));

const dispatchMock = vi.fn();
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: (...args: unknown[]) => dispatchMock(...args) },
}));

const eventsOnMock = vi.fn();
// Main's once-per-episode claims (#18274): the first claim of a surface wins.
const granted = new Set<string>();
async function claimOnce({ episodeId, surface }: { episodeId: string; surface: string }) {
  const key = `${episodeId}:${surface}`;
  if (granted.has(key)) return false;
  granted.add(key);
  return true;
}
const claimMock = vi.fn(claimOnce);
const releaseMock = vi.fn(
  async ({ episodeId, surface }: { episodeId: string; surface: string }) => {
    granted.delete(`${episodeId}:${surface}`);
  }
);
let captured: ((payload: SystemMemoryPressureDelivery) => Promise<void>) | null = null;

const DEGRADED: SystemMemoryPressureDelivery = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: 36 * 1024,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
  episodeId: "episode-1",
  fileInbox: true,
};
const NORMAL: SystemMemoryPressureDelivery = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
  episodeId: "episode-1",
  fileInbox: false,
};
const CRITICAL: SystemMemoryPressureDelivery = {
  ...DEGRADED,
  kernelPressureLevel: "critical",
  escalated: true,
};

function load() {
  return import("../useSystemMemoryPressureNotice");
}

async function mountAndCapture() {
  const mod = await load();
  renderHook(() => mod.useSystemMemoryPressureNotice());
  return mod;
}

async function historyStore() {
  return (await import("@/store/slices/notificationHistorySlice")).useNotificationHistoryStore;
}

/** Hands the view a delivery and waits out its claims to Main. */
async function deliver(payload: SystemMemoryPressureDelivery): Promise<void> {
  await act(async () => {
    await captured!(payload);
  });
}

/** The same singleton the freshly imported hook writes, after `vi.resetModules`. */
async function noticeStore() {
  return (await import("@/store/systemMemoryNoticeStore")).useSystemMemoryNoticeStore;
}

describe("formatSystemMemoryPressureMessage", () => {
  it("states each measurement over threshold and the restart note, nothing else", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(formatSystemMemoryPressureMessage(DEGRADED, true)).toBe(
      "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this."
    );
    expect(formatSystemMemoryPressureMessage({ ...DEGRADED, swapUsedPercent: null }, true)).toBe(
      "The fseventsd process is using 36 GB of memory. Restarting your Mac clears this."
    );
    expect(
      formatSystemMemoryPressureMessage({ ...DEGRADED, fseventsdRssMb: 8.4 * 1024 }, true)
    ).toContain("using 8.4 GB of memory");
  });

  it("labels a Windows figure as commit and names a generic computer off macOS", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(
      formatSystemMemoryPressureMessage(
        { ...DEGRADED, swapKind: "commit", fseventsdRssMb: null },
        false
      )
    ).toBe("Committed memory is at 91% of its limit. Restarting your computer clears this.");
  });

  it("states the kernel's reported level first, without the restart note when alone (#12799)", async () => {
    const { formatSystemMemoryPressureMessage } = await load();

    expect(
      formatSystemMemoryPressureMessage(
        { ...NORMAL, status: "degraded", kernelPressureLevel: "critical" },
        true
      )
    ).toBe("macOS reports memory pressure at its critical level.");
    expect(
      formatSystemMemoryPressureMessage(
        { ...DEGRADED, fseventsdRssMb: null, kernelPressureLevel: "warn" },
        true
      )
    ).toBe(
      "macOS reports memory pressure at its warning level and swap is 91% full. Restarting your Mac clears this."
    );
  });

  it("returns null when no figure was over threshold", async () => {
    const { formatSystemMemoryPressureMessage } = await load();
    expect(formatSystemMemoryPressureMessage(NORMAL, true)).toBeNull();
  });
});

describe("describeSystemMemoryWorkloads", () => {
  it("names each project's terminals, then Daintree's own processes (#13529)", async () => {
    const { describeSystemMemoryWorkloads } = await load();

    expect(
      describeSystemMemoryWorkloads({
        appMemoryMb: 1843,
        projects: [
          { projectId: "a", projectName: "App", terminalCount: 4, memoryMb: 12.5 * 1024 },
          { projectId: "b", projectName: null, terminalCount: 1, memoryMb: 640 },
          { projectId: null, projectName: null, terminalCount: 2, memoryMb: 2048 },
        ],
        agentsRunning: 5,
        memoryTotalMb: 36864,
      })
    ).toBe(
      "App's terminals (4 terminals) use 13 GB. A project's terminals (1 terminal) use 640 MB. Terminals outside any project (2 terminals) use 2.0 GB. Daintree itself uses 1.8 GB."
    );
  });

  it("returns null when nothing was measured", async () => {
    const { describeSystemMemoryWorkloads } = await load();
    expect(describeSystemMemoryWorkloads(null)).toBeNull();
    expect(
      describeSystemMemoryWorkloads({
        appMemoryMb: null,
        projects: [],
        agentsRunning: null,
        memoryTotalMb: null,
      })
    ).toBeNull();
  });
});

describe("useSystemMemoryPressureNotice", () => {
  beforeEach(() => {
    vi.resetModules();
    // The inbox persists to it, and a fresh module graph hydrates from it.
    localStorage.clear();
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notice-1");
    eventsOnMock.mockReset();
    granted.clear();
    claimMock.mockReset();
    claimMock.mockImplementation(claimOnce);
    releaseMock.mockClear();
    attended = true;
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    mac = true;
    captured = null;
    eventsOnMock.mockImplementation(
      (name: string, cb: (payload: SystemMemoryPressureDelivery) => Promise<void>) => {
        if (name === "system:memory-pressure") captured = cb;
        return vi.fn();
      }
    );
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: {
        events: { on: eventsOnMock },
        system: { claimMemoryNotice: claimMock, releaseMemoryNotice: releaseMock },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electron");
  });

  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useSystemMemoryPressureNotice } = await load();

    const first = renderHook(() => useSystemMemoryPressureNotice());
    first.unmount();
    renderHook(() => useSystemMemoryPressureNotice());

    expect(eventsOnMock).toHaveBeenCalledTimes(1);
    expect(eventsOnMock).toHaveBeenCalledWith("system:memory-pressure", expect.any(Function));
  });

  it("shows the reading as a sidebar row and a quiet inbox record (#13101)", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver(DEGRADED);

    expect(store.getState().notice).toMatchObject({
      reading: "Swap is 91% full and the fseventsd process is using 36 GB of memory.",
      detail:
        "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this.",
      critical: false,
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    // Inbox only, uncounted: low priority with no placement never toasts or bars.
    expect(payload).toMatchObject({
      type: "warning",
      priority: "low",
      urgent: false,
      countable: false,
      title: "High system memory use",
      context: { eventKind: "host" },
    });
    expect(payload.placement).toBeUndefined();
    expect(payload.supersedeKey).toEqual(expect.any(String));
  });

  it("adds the workloads Daintree hosts to the detail and the inbox record", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver({
      ...DEGRADED,
      workloads: {
        appMemoryMb: 1024,
        projects: [{ projectId: "a", projectName: "App", terminalCount: 3, memoryMb: 9216 }],
        agentsRunning: 2,
        memoryTotalMb: 36864,
      },
    });

    expect(store.getState().notice?.detail).toBe(
      "Swap is 91% full and the fseventsd process is using 36 GB of memory. Restarting your Mac clears this. App's terminals (3 terminals) use 9.0 GB. Daintree itself uses 1.0 GB."
    );
    expect(notifyMock.mock.calls[0]![0].message).toBe(store.getState().notice?.detail);
    // The one-line reading stays the measurement alone.
    expect(store.getState().notice?.reading).not.toContain("terminals");
  });

  it("offers the memory breakdown, never an agent launch, and keeps the row after it opens", async () => {
    await mountAndCapture();
    const store = await noticeStore();
    await deliver(DEGRADED);

    const action = store.getState().notice!.action!;
    expect(action).toMatchObject({ label: "Show memory use", actionId: "diagnostics.openWhySlow" });
    expect(notifyMock.mock.calls[0]![0].actions).toEqual([action]);
    expect(dispatchMock).not.toHaveBeenCalled();

    await act(async () => {
      await action.onClick();
    });

    expect(dispatchMock).toHaveBeenCalledWith("diagnostics.openWhySlow", undefined, {
      source: "user",
    });
    expect(dispatchMock.mock.calls.some(([id]) => id === "agent.launch")).toBe(false);
    expect(store.getState().notice).not.toBeNull();
  });

  it("raises nothing when no reading was over threshold", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver({ ...NORMAL, status: "degraded" });

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("replaces the row and the inbox record when the episode worsens (#13529)", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver(DEGRADED);
    await deliver(CRITICAL);

    expect(store.getState().notice).toMatchObject({
      reading:
        "macOS reports memory pressure at its critical level and swap is 91% full and the fseventsd process is using 36 GB of memory.",
      critical: true,
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const [first, second] = notifyMock.mock.calls.map(([p]) => p);
    expect(second.supersedeKey).toBe(first.supersedeKey);
    expect(second.title).toBe("Critical system memory pressure");
  });

  it("toasts the first critical reading of an episode, and only that one", async () => {
    await mountAndCapture();

    await deliver(DEGRADED);
    await deliver(CRITICAL);
    await deliver({ ...CRITICAL, fseventsdRssMb: null });

    // The third publish stays at the critical level, so it only refreshes the row.
    expect(notifyMock.mock.calls.map(([p]) => p.priority)).toEqual(["low", "high"]);
  });

  it("refreshes the row in place when the episode escalates again, leaving the toast up (#13639)", async () => {
    await mountAndCapture();
    const history = await historyStore();
    notifyMock.mockImplementation((payload: { historyId?: string; message: string }) => {
      history
        .getState()
        .addEntry({ id: payload.historyId, type: "warning", message: payload.message });
      return "notice-1";
    });

    await deliver(DEGRADED);
    await deliver(CRITICAL);
    await deliver({ ...CRITICAL, swapUsedPercent: 97 });

    // Any later notify() carrying the replaceKey would dismiss the sticky toast.
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const toast = notifyMock.mock.calls[1]![0];
    expect(history.getState().entries.find((e) => e.id === toast.historyId)?.message).toContain(
      "swap is 97% full"
    );
  });

  it("dismisses the critical toast on recovery after an escalation", async () => {
    await mountAndCapture();

    await deliver(CRITICAL);
    await deliver({ ...CRITICAL, swapUsedPercent: 97 });
    await deliver(NORMAL);

    const [toast, resolution] = notifyMock.mock.calls.map(([p]) => p);
    expect(resolution.replaceKey).toBe(toast.replaceKey);
  });

  it("toasts an episode that opens at the critical level", async () => {
    await mountAndCapture();

    await deliver({ ...CRITICAL, escalated: false });

    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      priority: "high",
      title: "Critical system memory pressure",
    });
  });

  it("clears its own row on recovery and leaves a quiet resolution row", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver(DEGRADED);
    await deliver(NORMAL);

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const warning = notifyMock.mock.calls[0]![0];
    const resolution = notifyMock.mock.calls[1]![0];
    expect(resolution).toMatchObject({
      type: "success",
      priority: "low",
      urgent: false,
      countable: false,
      context: { eventKind: "host" },
    });
    expect(resolution.placement).toBeUndefined();
    // Same key, so the resolution row archives the warning's inbox row.
    expect(resolution.supersedeKey).toBe(warning.supersedeKey);
    // And dismisses a critical toast still on screen.
    expect(resolution.replaceKey).toBe(warning.replaceKey);
    expect(warning.replaceKey).toEqual(expect.any(String));
  });

  it("does nothing on recovery in a view that never raised the notice", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver(NORMAL);

    expect(notifyMock).not.toHaveBeenCalled();
    expect(store.getState().notice).toBeNull();
  });

  it("raises the notice again for a new episode after recovery, critical toast included", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    await deliver(CRITICAL);
    await deliver(NORMAL);
    await deliver({ ...CRITICAL, episodeId: "episode-2" });

    expect(notifyMock.mock.calls.map(([p]) => [p.type, p.priority])).toEqual([
      ["warning", "high"],
      ["success", "low"],
      ["warning", "high"],
    ]);
    expect(store.getState().notice).not.toBeNull();
  });

  describe("one notice across project views (#18274)", () => {
    const fileRow = async () => {
      const history = await historyStore();
      notifyMock.mockImplementation(
        (payload: { historyId?: string; message: string; transient?: boolean }) => {
          if (!payload.transient) {
            history.getState().addEntry({
              id: payload.historyId,
              type: "warning",
              message: payload.message,
              supersedeKey: "system-memory-pressure",
            });
          }
          return "notice-1";
        }
      );
      return history;
    };

    it("claims the row and the toast before showing them, under ids the episode and level name", async () => {
      await mountAndCapture();

      await deliver(DEGRADED);
      await deliver(CRITICAL);

      const [warning, critical] = notifyMock.mock.calls.map(([p]) => p);
      expect(warning.historyId).toContain("episode-1");
      expect(critical.historyId).toContain("episode-1");
      expect(critical.historyId).not.toBe(warning.historyId);
      expect(claimMock.mock.calls.map(([c]) => c.surface)).toEqual([
        "inbox-warning",
        "inbox-critical",
        "critical-toast",
      ]);
    });

    it("shows the sidebar row but files nothing when another view already filed the row", async () => {
      await mountAndCapture();
      const store = await noticeStore();

      await deliver({ ...DEGRADED, fileInbox: false });

      expect(store.getState().notice?.reading).toContain("Swap is 91% full");
      expect(notifyMock).not.toHaveBeenCalled();
      expect(claimMock).not.toHaveBeenCalled();
    });

    it("refreshes a row a sibling filed, in place", async () => {
      await mountAndCapture();
      const history = await historyStore();
      history.getState().addEntry({
        id: "system-memory-pressure:episode-1:warning",
        type: "warning",
        message: "Swap is 91% full.",
        supersedeKey: "system-memory-pressure",
      });

      await deliver({ ...DEGRADED, fileInbox: false, swapUsedPercent: 95 });

      expect(notifyMock).not.toHaveBeenCalled();
      expect(
        history.getState().entries.find((e) => e.id === "system-memory-pressure:episode-1:warning")
          ?.message
      ).toContain("Swap is 95% full");
    });

    it("never brings back a row the user dismissed, even from a delivery replayed late", async () => {
      await mountAndCapture();
      const history = await fileRow();

      await deliver(DEGRADED);
      const filed = String(notifyMock.mock.calls[0]![0].historyId);
      expect(history.getState().entries.some((e) => e.id === filed)).toBe(true);
      act(() => history.getState().dismissEntry(filed));
      // Still asking to file: Main sent it before any view had claimed the row.
      await deliver({ ...DEGRADED, swapUsedPercent: 96 });
      await deliver({ ...DEGRADED, fileInbox: false, swapUsedPercent: 97 });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(history.getState().entries.some((e) => e.id === filed)).toBe(false);
    });

    it("toasts critical in the view the user is looking at, keeping it out of the inbox, when another view filed the row", async () => {
      await mountAndCapture();

      await deliver({ ...CRITICAL, fileInbox: false });

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]![0]).toMatchObject({
        priority: "high",
        transient: true,
        title: "Critical system memory pressure",
      });
      expect(notifyMock.mock.calls[0]![0].historyId).toBeUndefined();
    });

    it("files the critical row quietly from a window behind, leaving the toast to the attended view", async () => {
      await mountAndCapture();
      attended = false;

      await deliver(CRITICAL);

      expect(notifyMock.mock.calls[0]![0].priority).toBe("low");
      expect(claimMock.mock.calls.map(([c]) => c.surface)).toEqual(["inbox-critical"]);
    });

    it("hands the toast back when notify held it back", async () => {
      await mountAndCapture();
      notifyMock.mockReturnValue("");

      await deliver(CRITICAL);

      expect(releaseMock).toHaveBeenCalledWith({
        episodeId: "episode-1",
        surface: "critical-toast",
      });
    });

    it("handles a delivery only after the one before it has filed what Main gave it", async () => {
      await mountAndCapture();
      const history = await fileRow();
      const answers: Array<() => void> = [];
      claimMock.mockImplementation(
        ({ episodeId, surface }) =>
          new Promise<boolean>((resolve) => {
            answers.push(() => {
              const key = `${episodeId}:${surface}`;
              resolve(!granted.has(key));
              granted.add(key);
            });
          })
      );

      // A worsening at the same level, then the recovery, arrive while Main is
      // still answering the first delivery's claim.
      let settled!: Promise<void>;
      act(() => {
        void captured!(DEGRADED);
        void captured!({ ...DEGRADED, swapUsedPercent: 97, escalated: true });
        settled = captured!(NORMAL);
      });
      let done = false;
      void settled.then(() => (done = true));
      await act(async () => {
        while (!done) {
          answers.shift()?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });

      expect(notifyMock.mock.calls.map(([p]) => p.type)).toEqual(["warning", "success"]);
      const row = history
        .getState()
        .entries.find((e) => e.id === notifyMock.mock.calls[0]![0].historyId);
      // The worsening refreshed the filed row; recovery then retired it.
      expect(row?.message).toContain("Swap is 97% full");
      expect(row?.archivedAt).toEqual(expect.any(Number));
    });

    it("keeps handling deliveries after one throws", async () => {
      await mountAndCapture();
      const store = await noticeStore();
      notifyMock.mockImplementationOnce(() => {
        throw new Error("notify failed");
      });

      await deliver(DEGRADED);
      await deliver({ ...DEGRADED, episodeId: "episode-2", swapUsedPercent: 95 });

      expect(store.getState().notice?.reading).toContain("Swap is 95% full");
      expect(notifyMock).toHaveBeenCalledTimes(2);
    });

    it("retires every row of the episode on recovery, the launch bar's included", async () => {
      await mountAndCapture();
      const history = await historyStore();
      const ids = ["system-memory-pressure:episode-1:warning", "launch-row"];
      history.getState().addEntry({
        id: ids[0],
        type: "warning",
        message: "Swap is 91% full.",
        supersedeKey: "system-memory-pressure",
      });
      history.getState().addEntry({
        id: ids[1],
        type: "warning",
        message: "Swap is 91% full.",
        supersedeKey: "system-memory-launch",
      });

      // A view that holds the rows but never heard the episode still answers.
      await deliver(NORMAL);

      expect(notifyMock).toHaveBeenCalledTimes(1);
      expect(notifyMock.mock.calls[0]![0]).toMatchObject({
        type: "success",
        historyId: expect.stringContaining("episode-1"),
      });
      const entries = history.getState().entries;
      for (const id of ids) {
        expect(entries.find((e) => e.id === id)?.archivedAt).toEqual(expect.any(Number));
      }
    });
  });
});
