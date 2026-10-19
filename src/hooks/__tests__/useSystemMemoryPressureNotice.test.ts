// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
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
let captured: ((payload: SystemMemoryPressurePayload) => void) | null = null;

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: 36 * 1024,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
};
const NORMAL: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: null,
  escalated: false,
  workloads: null,
};
const CRITICAL: SystemMemoryPressurePayload = {
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
      })
    ).toBe(
      "App's terminals (4 terminals) use 13 GB. A project's terminals (1 terminal) use 640 MB. Terminals outside any project (2 terminals) use 2.0 GB. Daintree itself uses 1.8 GB."
    );
  });

  it("returns null when nothing was measured", async () => {
    const { describeSystemMemoryWorkloads } = await load();
    expect(describeSystemMemoryWorkloads(null)).toBeNull();
    expect(describeSystemMemoryWorkloads({ appMemoryMb: null, projects: [] })).toBeNull();
  });
});

describe("useSystemMemoryPressureNotice", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notice-1");
    eventsOnMock.mockReset();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue({ ok: true });
    mac = true;
    captured = null;
    eventsOnMock.mockImplementation(
      (name: string, cb: (payload: SystemMemoryPressurePayload) => void) => {
        if (name === "system:memory-pressure") captured = cb;
        return vi.fn();
      }
    );
    Object.defineProperty(window, "electron", {
      configurable: true,
      writable: true,
      value: { events: { on: eventsOnMock } },
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

    act(() => captured!(DEGRADED));

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

    act(() =>
      captured!({
        ...DEGRADED,
        workloads: {
          appMemoryMb: 1024,
          projects: [{ projectId: "a", projectName: "App", terminalCount: 3, memoryMb: 9216 }],
        },
      })
    );

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
    act(() => captured!(DEGRADED));

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

    act(() => captured!({ ...NORMAL, status: "degraded" }));

    expect(store.getState().notice).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("replaces the row and the inbox record when the episode worsens (#13529)", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));
    act(() => captured!(CRITICAL));

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

    act(() => captured!(DEGRADED));
    act(() => captured!(CRITICAL));
    act(() => captured!({ ...CRITICAL, fseventsdRssMb: null }));

    expect(notifyMock.mock.calls.map(([p]) => p.priority)).toEqual(["low", "high", "low"]);
  });

  it("toasts an episode that opens at the critical level", async () => {
    await mountAndCapture();

    act(() => captured!({ ...CRITICAL, escalated: false }));

    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      priority: "high",
      title: "Critical system memory pressure",
    });
  });

  it("clears its own row on recovery and leaves a quiet resolution row", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

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

    act(() => captured!(NORMAL));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(store.getState().notice).toBeNull();
  });

  it("raises the notice again for a new episode after recovery, critical toast included", async () => {
    await mountAndCapture();
    const store = await noticeStore();

    act(() => captured!(CRITICAL));
    act(() => captured!(NORMAL));
    act(() => captured!(CRITICAL));

    expect(notifyMock.mock.calls.map(([p]) => [p.type, p.priority])).toEqual([
      ["warning", "high"],
      ["success", "low"],
      ["warning", "high"],
    ]);
    expect(store.getState().notice).not.toBeNull();
  });
});
