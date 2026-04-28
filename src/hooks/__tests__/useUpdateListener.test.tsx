// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useUpdateListener } from "../useUpdateListener";
import type { NotifyPayload } from "@/lib/notify";

interface MockNotification {
  id: string;
  dismissed?: boolean;
  onDismiss?: () => void;
  correlationId?: string;
}

const notifyMock = vi.fn<(payload: NotifyPayload) => string>();

vi.mock("@/lib/notify", () => ({
  notify: (...args: [NotifyPayload]) => notifyMock(...args),
}));

const updateNotificationMock = vi.fn();
const addNotificationMock = vi.fn();

const storeState: { notifications: MockNotification[] } = { notifications: [] };

function addMockNotification(payload: {
  id: string;
  onDismiss?: () => void;
  correlationId?: string;
}): void {
  storeState.notifications = [
    ...storeState.notifications,
    {
      id: payload.id,
      dismissed: false,
      onDismiss: payload.onDismiss,
      correlationId: payload.correlationId,
    },
  ];
}

function patchMockNotification(id: string, patch: Partial<MockNotification>): void {
  storeState.notifications = storeState.notifications.map((n) =>
    n.id === id ? { ...n, ...patch } : n
  );
}

/** Simulate the user clicking the Toast's close button. */
function userDismiss(id: string): void {
  const n = storeState.notifications.find((x) => x.id === id);
  n?.onDismiss?.();
  patchMockNotification(id, { dismissed: true });
}

/** Simulate MAX_VISIBLE_TOASTS auto-eviction (marks dismissed WITHOUT calling onDismiss). */
function evictMockNotification(id: string): void {
  patchMockNotification(id, { dismissed: true });
}

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: Object.assign(() => ({}), {
    getState: () => ({
      updateNotification: updateNotificationMock,
      addNotification: addNotificationMock,
      notifications: storeState.notifications,
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
const notifyDismissMock = vi.fn().mockResolvedValue(undefined);

let toastCounter = 0;

describe("useUpdateListener", () => {
  beforeEach(() => {
    capturedAvailable = null;
    capturedProgress = null;
    capturedDownloaded = null;
    toastCounter = 0;
    storeState.notifications = [];
    cleanupAvailable.mockClear();
    cleanupProgress.mockClear();
    cleanupDownloaded.mockClear();
    notifyMock.mockClear().mockImplementation((payload) => {
      const id = `toast-${++toastCounter}`;
      addMockNotification({
        id,
        onDismiss: payload.onDismiss,
        correlationId: payload.correlationId,
      });
      return id;
    });
    updateNotificationMock.mockClear().mockImplementation((id, patch) => {
      patchMockNotification(id, patch as Partial<MockNotification>);
    });
    addNotificationMock.mockClear().mockImplementation((payload) => {
      const id = `fresh-toast-${++toastCounter}`;
      const typed = payload as {
        onDismiss?: () => void;
        correlationId?: string;
      };
      addMockNotification({
        id,
        onDismiss: typed.onDismiss,
        correlationId: typed.correlationId,
      });
      return id;
    });
    notifyDismissMock.mockClear();

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
        notifyDismiss: notifyDismissMock,
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

  it("includes the manual-check hint in the inbox message", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    const payload = notifyMock.mock.calls[0]![0];
    expect(payload.inboxMessage).toContain("Check for Updates");
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
      expect.any(String),
      expect.objectContaining({
        title: "Downloading Update",
        inboxMessage: "Downloading update: 43%",
      })
    );
    const patch = updateNotificationMock.mock.calls[0]![1];
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
      expect.any(String),
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        message: "Version 2.5.0 is ready to install.",
        duration: 0,
        dismissed: false,
        action: expect.objectContaining({ label: "Restart to Update" }),
      })
    );

    const patch = updateNotificationMock.mock.calls[0]![1];
    patch.action!.onClick();
    expect(window.electron.update.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("skips progress when toast was not created (quiet period)", () => {
    // Simulate quiet hours — non-urgent notify() calls are suppressed.
    notifyMock.mockImplementation((payload) => {
      if (payload.urgent) {
        const id = `toast-${++toastCounter}`;
        addMockNotification({
          id,
          onDismiss: payload.onDismiss,
          correlationId: payload.correlationId,
        });
        return id;
      }
      return "";
    });
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
    // Simulate quiet hours — non-urgent notify() calls are suppressed.
    notifyMock.mockImplementation((payload) => {
      if (payload.urgent) {
        const id = `toast-${++toastCounter}`;
        addMockNotification({
          id,
          onDismiss: payload.onDismiss,
          correlationId: payload.correlationId,
        });
        return id;
      }
      return "";
    });
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });

    // The "no live toast" fallback path uses notify({ urgent: true }) so the
    // Update Ready stage surfaces even while non-urgent toasts stay suppressed.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        message: "Version 2.5.0 is ready to install.",
        priority: "high",
        urgent: true,
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

    act(() => {
      capturedDownloaded!({ version: "3.0.0" });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        priority: "high",
        urgent: true,
      })
    );
  });

  it("emits notify with the shared app-update correlationId so repeats collapse in the store", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    // The hook no longer performs client-side version dedup — it emits
    // notify() every time and relies on the store's correlationId collapse
    // path to merge repeats into the same live toast. Verified indirectly
    // here by asserting the stable correlationId is set on every call.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "app-update" })
    );

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls.every((c) => c[0].correlationId === "app-update")).toBe(true);
  });

  it("emits notify for a newer version with the same app-update correlationId", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    expect(notifyMock).toHaveBeenCalledTimes(1);

    act(() => {
      capturedAvailable!({ version: "2.5.1" });
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]![0].correlationId).toBe("app-update");
  });

  it("allows a new toast if the prior same-version toast was already dismissed", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    const firstId = notifyMock.mock.results[0]!.value as string;

    act(() => {
      userDismiss(firstId);
    });

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("calls notifyDismiss on main when the user closes the tracked Available toast", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    const toastId = notifyMock.mock.results[0]!.value as string;

    act(() => {
      userDismiss(toastId);
    });

    expect(notifyDismissMock).toHaveBeenCalledTimes(1);
    expect(notifyDismissMock).toHaveBeenCalledWith("2.5.0");
  });

  it("does not call notifyDismiss when MAX_VISIBLE_TOASTS evicts the toast", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    const toastId = notifyMock.mock.results[0]!.value as string;

    // Eviction marks dismissed: true WITHOUT running the Toast's handleDismiss,
    // so onDismiss must not fire — the user didn't actually dismiss this.
    act(() => {
      evictMockNotification(toastId);
    });

    expect(notifyDismissMock).not.toHaveBeenCalled();
  });

  it("does not call notifyDismiss when the user dismisses the Update Ready (Downloaded) toast", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    const toastId = notifyMock.mock.results[0]!.value as string;

    // Stage transition: Available → Downloaded (in-place). The hook must
    // clear onDismiss so dismissing the Update Ready toast does not start the
    // 24h cooldown (user still wants to be reminded about the pending install).
    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });

    // Confirm the hook explicitly cleared the onDismiss in the update patch.
    const downloadedPatch = updateNotificationMock.mock.calls.find(
      (call) => call[1]?.title === "Update Ready"
    )?.[1];
    expect(downloadedPatch).toMatchObject({ onDismiss: undefined });

    act(() => {
      userDismiss(toastId);
    });

    expect(notifyDismissMock).not.toHaveBeenCalled();
  });

  it("clears the restart action when update-available fires after update-ready (stage regression)", () => {
    renderHook(() => useUpdateListener());

    // Notify calls pass `action: undefined` explicitly so the store's
    // collapse path wipes any "Restart to Update" button left over from a
    // prior Update Ready toast — the user must not be offered a restart
    // into a stale build while a newer one is still downloading.
    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    expect(notifyMock.mock.calls[0]![0]).toHaveProperty("action", undefined);
  });

  it("pending ref upgrades to downloaded but never downgrades back to available", () => {
    const { rerender } = renderHook(({ suppress }) => useUpdateListener(suppress), {
      initialProps: { suppress: true },
    });

    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });
    // Simulated quiet-period re-check: an "available" event arrives AFTER
    // the download already completed. The pending slot must keep the
    // "downloaded" state so the user is still shown "Update Ready" when
    // toasts unmute, not a stale "Update Available: downloading..." view.
    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });

    rerender({ suppress: false });

    // The suppress-lifted path emits notify({ urgent: true }) for the stored
    // "downloaded" pending update so quiet hours don't keep it hidden.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        urgent: true,
      })
    );
    expect(addNotificationMock).not.toHaveBeenCalled();
  });

  it("still creates the Update Ready toast after the Available toast was dismissed", () => {
    renderHook(() => useUpdateListener());

    act(() => {
      capturedAvailable!({ version: "2.5.0" });
    });
    const firstId = notifyMock.mock.results[0]!.value as string;

    act(() => {
      userDismiss(firstId);
    });
    expect(notifyDismissMock).toHaveBeenCalledTimes(1);

    act(() => {
      capturedDownloaded!({ version: "2.5.0" });
    });

    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Update Ready",
        urgent: true,
      })
    );
  });
});
