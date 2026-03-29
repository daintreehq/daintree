// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useNavigationBlockedNotification } from "../useNavigationBlockedNotification";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.fn<(payload: NotifyPayload) => string>().mockReturnValue("toast-id");

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

type BlockedCallback = (payload: { panelId: string; url: string }) => void;

let capturedCallback: BlockedCallback | null = null;
const cleanupFn = vi.fn();

describe("useNavigationBlockedNotification", () => {
  beforeEach(() => {
    capturedCallback = null;
    cleanupFn.mockClear();
    notifyMock.mockClear();

    window.electron = {
      webview: {
        onNavigationBlocked: vi.fn((cb: BlockedCallback) => {
          capturedCallback = cb;
          return cleanupFn;
        }),
      },
      system: {
        openExternal: vi.fn(),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("subscribes on mount and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useNavigationBlockedNotification("panel-1"));

    expect(window.electron.webview.onNavigationBlocked).toHaveBeenCalledTimes(1);
    expect(capturedCallback).toBeInstanceOf(Function);

    unmount();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("shows a warning notification with Open in browser action", () => {
    renderHook(() => useNavigationBlockedNotification("panel-1"));

    act(() => {
      capturedCallback!({
        panelId: "panel-1",
        url: "https://auth.example.com/authorize",
      });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Navigation blocked",
        action: expect.objectContaining({ label: "Open in browser" }),
        duration: 8000,
      })
    );
  });

  it("action button calls openExternal with the blocked URL", () => {
    renderHook(() => useNavigationBlockedNotification("panel-1"));

    act(() => {
      capturedCallback!({
        panelId: "panel-1",
        url: "https://accounts.google.com/o/oauth2/auth",
      });
    });

    const call = notifyMock.mock.calls[0][0];
    call.action!.onClick!();
    expect(window.electron.system.openExternal).toHaveBeenCalledWith(
      "https://accounts.google.com/o/oauth2/auth"
    );
  });

  it("ignores events for other panels", () => {
    renderHook(() => useNavigationBlockedNotification("panel-1"));

    act(() => {
      capturedCallback!({
        panelId: "panel-other",
        url: "https://example.com",
      });
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("deduplicates rapid-fire notifications for the same URL", () => {
    renderHook(() => useNavigationBlockedNotification("panel-1"));

    act(() => {
      capturedCallback!({ panelId: "panel-1", url: "https://example.com" });
      capturedCallback!({ panelId: "panel-1", url: "https://example.com" });
      capturedCallback!({ panelId: "panel-1", url: "https://example.com" });
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("does not crash when window.electron is undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    expect(() => renderHook(() => useNavigationBlockedNotification("panel-1"))).not.toThrow();
  });
});
