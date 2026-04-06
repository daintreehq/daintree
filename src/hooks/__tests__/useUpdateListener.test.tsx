// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUpdateListener } from "../useUpdateListener";
import type { NotifyPayload } from "@/lib/notify";

const notifyMock = vi.fn<(payload: NotifyPayload) => string>().mockReturnValue("toast-1");

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

const updateNotificationMock = vi.fn();
const addNotificationMock = vi.fn().mockReturnValue("fresh-toast");

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: Object.assign(() => ({}), {
    getState: () => ({
      updateNotification: updateNotificationMock,
      addNotification: addNotificationMock,
      notifications: [],
    }),
  }),
}));

type AvailableCallback = (info: { version: string }) => void;
type ProgressCallback = (info: { percent: number }) => void;
type DownloadedCallback = (info: { version: string }) => void;

let capturedAvailable: AvailableCallback | null = null;
let capturedProgress: ProgressCallback | null = null;
let capturedDownloaded: DownloadedCallback | null = null;

const cleanupAvailable = vi.fn();
const cleanupProgress = vi.fn();
const cleanupDownloaded = vi.fn();

describe("useUpdateListener", () => {
  beforeEach(() => {
    capturedAvailable = null;
    capturedProgress = null;
    capturedDownloaded = null;
    cleanupAvailable.mockClear();
    cleanupProgress.mockClear();
    cleanupDownloaded.mockClear();
    notifyMock.mockClear().mockReturnValue("toast-1");
    updateNotificationMock.mockClear();
    addNotificationMock.mockClear().mockReturnValue("fresh-toast");

    window.electron = {
      update: {
        onUpdateAvailable: vi.fn((cb: AvailableCallback) => {
          capturedAvailable = cb;
          return cleanupAvailable;
        }),
        onDownloadProgress: vi.fn((cb: ProgressCallback) => {
          capturedProgress = cb;
          return cleanupProgress;
        }),
        onUpdateDownloaded: vi.fn((cb: DownloadedCallback) => {
          capturedDownloaded = cb;
          return cleanupDownloaded;
        }),
        quitAndInstall: vi.fn(),
        checkForUpdates: vi.fn(),
      },
    } as unknown as typeof window.electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  it("subscribes to all three update events and cleans up on unmount", () => {
    const { unmount } = renderHook(() => useUpdateListener());

    expect(window.electron.update.onUpdateAvailable).toHaveBeenCalledTimes(1);
    expect(window.electron.update.onDownloadProgress).toHaveBeenCalledTimes(1);
    expect(window.electron.update.onUpdateDownloaded).toHaveBeenCalledTimes(1);

    unmount();
    expect(cleanupAvailable).toHaveBeenCalledTimes(1);
    expect(cleanupProgress).toHaveBeenCalledTimes(1);
    expect(cleanupDownloaded).toHaveBeenCalledTimes(1);
  });

  it("calls notify with persistent toast on update-available", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Update Available",
        message: "Version 2.5.0 is downloading...",
        duration: 0,
        priority: "high",
      })
    );
  });

  it("updates toast in-place with progress bar on download-progress", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    act(() => {
      capturedProgress!({ percent: 42.7 });
    });

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({
        title: "Downloading Update",
        inboxMessage: "Downloading update: 43%",
      })
    );
    // message should be a ReactNode (the DownloadProgress component)
    const patch = updateNotificationMock.mock.calls[0][1];
    expect(typeof patch.message).not.toBe("string");
  });

  it("updates toast to downloaded state with restart action", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        message: "Version 2.5.0 is ready to install.",
        duration: 0,
        dismissed: false,
        action: expect.objectContaining({ label: "Restart to Update" }),
      })
    );

    // Clicking the action should call quitAndInstall
    const patch = updateNotificationMock.mock.calls[0][1];
    patch.action!.onClick();
    expect(window.electron.update.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("skips progress when toast was not created (quiet period)", () => {
    notifyMock.mockReturnValue("");
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    act(() => {
      capturedProgress!({ percent: 50 });
    });

    expect(updateNotificationMock).not.toHaveBeenCalled();
  });

  it("creates fresh notification on downloaded when quiet period was active", () => {
    notifyMock.mockReturnValue("");
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        message: "Version 2.5.0 is ready to install.",
        priority: "high",
        duration: 0,
        action: expect.objectContaining({ label: "Restart to Update" }),
      })
    );
  });

  it("does not crash when window.electron is undefined", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
    expect(() => renderHook(() => useUpdateListener())).not.toThrow();
  });

  it("handles downloaded before available (no prior toast)", () => {
    renderHook(() => useUpdateListener());

    // Skip calling available, go straight to downloaded
    act(() => {
      capturedDownloaded!({ version: "3.0.0" });
    });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        priority: "high",
      })
    );
  });
});
