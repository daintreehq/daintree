// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMainProcessToastListener } from "../useMainProcessToastListener";

const notifyMock = vi.fn(() => "toast-id");

vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => notifyMock(...args),
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
    delete (window as Record<string, unknown>).electron;
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
        message: "The canopy command is now available",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith({
      type: "success",
      title: "CLI Installed",
      message: "The canopy command is now available",
      action: undefined,
    });
  });

  it("calls notify with an action that triggers checkForUpdates", () => {
    const checkForUpdatesMock = vi.fn();
    (window.electron as Record<string, unknown>).update = {
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
    const call = notifyMock.mock.calls[0][0] as { action: { onClick: () => void } };
    call.action.onClick();
    expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
  });

  it("does not crash when window.electron is undefined", () => {
    delete (window as Record<string, unknown>).electron;
    expect(() => renderHook(() => useMainProcessToastListener())).not.toThrow();
  });
});
