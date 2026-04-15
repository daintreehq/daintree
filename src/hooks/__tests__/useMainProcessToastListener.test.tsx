// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMainProcessToastListener } from "../useMainProcessToastListener";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.fn<(payload: NotifyPayload) => string>().mockReturnValue("toast-id");

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

type ToastCallback = (payload: {
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  action?: { label: string; ipcChannel: string };
}) => void;

let capturedCallback: ToastCallback | null = null;
const cleanupFn = vi.fn();

describe("useMainProcessToastListener", () => {
  beforeEach(() => {
    capturedCallback = null;
    cleanupFn.mockClear();
    notifyMock.mockClear();

    window.electron = {
      notification: {
        onShowToast: vi.fn((cb: ToastCallback) => {
          capturedCallback = cb;
          return cleanupFn;
        }),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("subscribes to onShowToast on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useMainProcessToastListener());

    expect(window.electron.notification.onShowToast).toHaveBeenCalledTimes(1);
    expect(capturedCallback).toBeInstanceOf(Function);

    unmount();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("calls notify with correct payload for a simple toast", () => {
    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "success",
        title: "CLI Installed",
        message: "The daintree command is now available",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith({
      type: "success",
      title: "CLI Installed",
      message: "The daintree command is now available",
      action: undefined,
    });
  });

  it("calls notify with an action that triggers checkForUpdates", () => {
    const checkForUpdatesMock = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.electron as any).update = {
      checkForUpdates: checkForUpdatesMock,
    };

    renderHook(() => useMainProcessToastListener());

    act(() => {
      capturedCallback!({
        type: "error",
        title: "Update Failed",
        message: "Network error",
        action: { label: "Retry", ipcChannel: "update:check-for-updates" },
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Update Failed",
        action: expect.objectContaining({ label: "Retry" }),
      })
    );

    // Click the action button
    const call = notifyMock.mock.calls[0][0];
    call.action!.onClick();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("does not crash when window.electron is undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    expect(() => renderHook(() => useMainProcessToastListener())).not.toThrow();
  });
});
