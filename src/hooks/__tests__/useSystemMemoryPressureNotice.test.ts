// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { SystemMemoryPressurePayload } from "@shared/types/ipc/system";

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const removeNotificationMock = vi.fn();
vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({ removeNotification: removeNotificationMock }),
  },
}));

let mac = true;
vi.mock("@/lib/platform", () => ({
  isMac: () => mac,
}));

const eventsOnMock = vi.fn();
let captured: ((payload: SystemMemoryPressurePayload) => void) | null = null;

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 91,
  swapKind: "swap",
  fseventsdRssMb: 36 * 1024,
};
const NORMAL: SystemMemoryPressurePayload = {
  status: "normal",
  swapUsedPercent: null,
  swapKind: "swap",
  fseventsdRssMb: null,
};

function load() {
  return import("../useSystemMemoryPressureNotice");
}

async function mountAndCapture() {
  const mod = await load();
  renderHook(() => mod.useSystemMemoryPressureNotice());
  return mod;
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
    ).toBe("Committed memory is at 91% of the system limit. Restarting your computer clears this.");
  });

  it("returns null when no figure was over threshold", async () => {
    const { formatSystemMemoryPressureMessage } = await load();
    expect(formatSystemMemoryPressureMessage(NORMAL, true)).toBeNull();
  });
});

describe("useSystemMemoryPressureNotice", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockReset();
    notifyMock.mockReturnValue("notice-1");
    removeNotificationMock.mockReset();
    eventsOnMock.mockReset();
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

  it("raises one quiet, dismissible grid-bar warning with no accent-bearing action", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0];
    expect(payload).toMatchObject({
      type: "warning",
      priority: "low",
      urgent: false,
      placement: "grid-bar",
      duration: 0,
      context: { eventKind: "host" },
    });
    expect(payload.supersedeKey).toEqual(expect.any(String));
    expect(payload.message).toContain("Swap is 91% full");
    expect(payload.action).toBeUndefined();
    expect(payload.actions).toBeUndefined();
  });

  it("ignores a repeated degraded edge for the same episode", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(DEGRADED));

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("clears its own notice on recovery and leaves a low-priority resolution row", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

    expect(removeNotificationMock).toHaveBeenCalledWith("notice-1");
    expect(notifyMock).toHaveBeenCalledTimes(2);
    const [[warning], [resolution]] = notifyMock.mock.calls;
    expect(resolution).toMatchObject({
      type: "success",
      priority: "low",
      context: { eventKind: "host" },
    });
    // Same key, so the resolution row archives the warning's inbox row.
    expect(resolution.supersedeKey).toBe(warning.supersedeKey);
  });

  it("does nothing on recovery in a view that never raised the notice", async () => {
    await mountAndCapture();

    act(() => captured!(NORMAL));

    expect(notifyMock).not.toHaveBeenCalled();
    expect(removeNotificationMock).not.toHaveBeenCalled();
  });

  it("still resolves the inbox row when quiet hours kept the bar from showing", async () => {
    notifyMock.mockReturnValueOnce("");
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));

    expect(removeNotificationMock).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("raises the notice again for a new episode after recovery", async () => {
    await mountAndCapture();

    act(() => captured!(DEGRADED));
    act(() => captured!(NORMAL));
    act(() => captured!(DEGRADED));

    expect(notifyMock.mock.calls.map(([p]) => p.type)).toEqual(["warning", "success", "warning"]);
  });
});
