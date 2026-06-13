// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

interface DiskSpaceStatusPayload {
  status: "normal" | "warning" | "critical";
  availableMb: number;
}

const notifyMock = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
}));

const onDiskSpaceStatusMock = vi.fn();
const unsubscribeMock = vi.fn();
let captured: ((payload: DiskSpaceStatusPayload) => void) | null = null;

function load() {
  return import("../useDiskSpaceWarnings");
}

describe("useDiskSpaceWarnings", () => {
  beforeEach(() => {
    vi.resetModules();
    notifyMock.mockClear();
    onDiskSpaceStatusMock.mockReset();
    unsubscribeMock.mockReset();
    captured = null;
    onDiskSpaceStatusMock.mockImplementation((cb: (payload: DiskSpaceStatusPayload) => void) => {
      captured = cb;
      return unsubscribeMock;
    });

    window.electron = {
      window: {
        onDiskSpaceStatus: onDiskSpaceStatusMock,
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  // #10455: a remount must not register a second IPC listener.
  it("subscribes exactly once across mount → unmount → remount", async () => {
    const { useDiskSpaceWarnings } = await load();

    const first = renderHook(() => useDiskSpaceWarnings());
    expect(onDiskSpaceStatusMock).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useDiskSpaceWarnings());
    renderHook(() => useDiskSpaceWarnings());

    expect(onDiskSpaceStatusMock).toHaveBeenCalledTimes(1);
  });

  it("does not unsubscribe on unmount", async () => {
    const { useDiskSpaceWarnings } = await load();

    const { unmount } = renderHook(() => useDiskSpaceWarnings());
    unmount();

    expect(unsubscribeMock).not.toHaveBeenCalled();
  });

  it("routes critical, warning, and normal disk states to distinct notifications", async () => {
    const { useDiskSpaceWarnings } = await load();
    renderHook(() => useDiskSpaceWarnings());

    act(() => captured!({ status: "critical", availableMb: 120 }));
    expect(notifyMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "error" }));

    act(() => captured!({ status: "warning", availableMb: 450.6 }));
    expect(notifyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "warning",
        urgent: true,
        correlationId: "disk-space-warning",
        supersedeKey: "disk-space",
        duration: 8000,
        inboxMessage: "Low disk space: 451 MB remaining.",
      })
    );

    act(() => captured!({ status: "normal", availableMb: 5000 }));
    expect(notifyMock).toHaveBeenLastCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("does not subscribe when Electron is unavailable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    const { useDiskSpaceWarnings } = await load();

    expect(() => renderHook(() => useDiskSpaceWarnings())).not.toThrow();
    expect(onDiskSpaceStatusMock).not.toHaveBeenCalled();
  });
});
