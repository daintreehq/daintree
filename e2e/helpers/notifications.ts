import type { Page } from "@playwright/test";

// Thin Playwright wrappers over the renderer-side notification backdoor exposed
// by `src/lib/e2eNotificationBackdoor.ts` (gated on DAINTREE_E2E_MODE). Injection
// goes straight at the store singletons so synthetic notifications are fully
// deterministic — no priority routing, focus gating, or rate-limit interference.

type NotificationType = "success" | "error" | "info" | "warning";
type NotificationPriority = "high" | "low" | "watch";
type NotificationPlacement = "toast" | "grid-bar";
type BackendStatus = "connected" | "disconnected" | "recovering";
type WatchdogStatus = "active" | "disabled";

export interface InjectToastOptions {
  type?: NotificationType;
  message?: string;
  title?: string;
  priority?: NotificationPriority;
  placement?: NotificationPlacement;
  duration?: number;
  correlationId?: string;
  historyEntryId?: string;
  actionLabel?: string;
  successLabel?: string;
  asyncAction?: boolean;
  asyncDelayMs?: number;
}

export interface InjectHistoryOptions {
  type?: NotificationType;
  message?: string;
  title?: string;
  correlationId?: string;
  seenAsToast?: boolean;
}

export async function injectToast(page: Page, opts: InjectToastOptions = {}): Promise<string> {
  return page.evaluate((o) => {
    const a = (
      window as unknown as {
        __daintreeNotificationsE2E?: { addToast: (input: unknown) => string };
      }
    ).__daintreeNotificationsE2E;
    if (!a) throw new Error("__daintreeNotificationsE2E backdoor not attached");
    return a.addToast({
      type: o.type ?? "info",
      message: o.message ?? "Test notification",
      title: o.title,
      priority: o.priority,
      placement: o.placement,
      duration: o.duration,
      correlationId: o.correlationId,
      historyEntryId: o.historyEntryId,
      actionLabel: o.actionLabel,
      successLabel: o.successLabel,
      asyncAction: o.asyncAction,
      asyncDelayMs: o.asyncDelayMs,
    });
  }, opts);
}

/** Injects a grid-bar notification (placement forced to "grid-bar"). */
export async function injectGridNotification(
  page: Page,
  opts: InjectToastOptions = {}
): Promise<string> {
  return injectToast(page, { ...opts, placement: "grid-bar" });
}

/** Backdates a notification's firstShownAt by `ms` so the grid-bar dwell floor is already expired. */
export async function backdateNotification(page: Page, id: string, ms: number): Promise<void> {
  await page.evaluate(
    ({ id, ms }) => {
      const a = (
        window as unknown as {
          __daintreeNotificationsE2E?: { backdateNotification: (id: string, ts: number) => void };
        }
      ).__daintreeNotificationsE2E;
      a?.backdateNotification(id, Date.now() - ms);
    },
    { id, ms }
  );
}

export async function injectHistoryEntry(
  page: Page,
  opts: InjectHistoryOptions = {}
): Promise<string> {
  return page.evaluate((o) => {
    const a = (
      window as unknown as {
        __daintreeNotificationsE2E?: { addHistoryEntry: (input: unknown) => string };
      }
    ).__daintreeNotificationsE2E;
    if (!a) throw new Error("__daintreeNotificationsE2E backdoor not attached");
    return a.addHistoryEntry({
      type: o.type ?? "info",
      message: o.message ?? "Test entry",
      title: o.title,
      correlationId: o.correlationId,
      seenAsToast: o.seenAsToast,
    });
  }, opts);
}

export async function archiveHistoryEntry(page: Page, id: string): Promise<void> {
  await page.evaluate((id) => {
    (
      window as unknown as {
        __daintreeNotificationsE2E?: { archiveHistoryEntry: (id: string) => void };
      }
    ).__daintreeNotificationsE2E?.archiveHistoryEntry(id);
  }, id);
}

export async function snoozeThread(
  page: Page,
  correlationId: string,
  durationMs: number
): Promise<void> {
  await page.evaluate(
    ({ correlationId, durationMs }) => {
      (
        window as unknown as {
          __daintreeNotificationsE2E?: {
            snoozeThread: (correlationId: string, until: number) => void;
          };
        }
      ).__daintreeNotificationsE2E?.snoozeThread(correlationId, Date.now() + durationMs);
    },
    { correlationId, durationMs }
  );
}

/** Full reset of all notification surfaces — call in beforeEach. */
export async function resetNotifications(page: Page): Promise<void> {
  await page.evaluate(() => {
    const a = (
      window as unknown as {
        __daintreeNotificationsE2E?: {
          resetToasts: () => void;
          clearHistory: () => void;
          resetNotifyInternals: () => void;
          resetBanners: () => void;
        };
      }
    ).__daintreeNotificationsE2E;
    // Throw on a missing backdoor so a misconfigured launch fails loudly in
    // beforeEach instead of surfacing as a delayed positive-assertion timeout.
    if (!a) throw new Error("__daintreeNotificationsE2E backdoor not attached");
    a.resetToasts();
    a.clearHistory();
    a.resetNotifyInternals();
    a.resetBanners();
  });
}

export async function setBackendStatus(page: Page, status: BackendStatus): Promise<void> {
  await page.evaluate((status) => {
    (
      window as unknown as {
        __daintreeNotificationsE2E?: { setBackendStatus: (s: string) => void };
      }
    ).__daintreeNotificationsE2E?.setBackendStatus(status);
  }, status);
}

export async function setWatchdogStatus(page: Page, status: WatchdogStatus): Promise<void> {
  await page.evaluate((status) => {
    (
      window as unknown as {
        __daintreeNotificationsE2E?: { setWatchdogStatus: (s: string) => void };
      }
    ).__daintreeNotificationsE2E?.setWatchdogStatus(status);
  }, status);
}

export async function setSafeMode(page: Page, safeMode: boolean, dismissed = false): Promise<void> {
  await page.evaluate(
    ({ safeMode, dismissed }) => {
      (
        window as unknown as {
          __daintreeNotificationsE2E?: { setSafeMode: (s: boolean, d?: boolean) => void };
        }
      ).__daintreeNotificationsE2E?.setSafeMode(safeMode, dismissed);
    },
    { safeMode, dismissed }
  );
}

export async function setRestoreConfirmation(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((visible) => {
    (
      window as unknown as {
        __daintreeNotificationsE2E?: { setRestoreConfirmation: (v: boolean) => void };
      }
    ).__daintreeNotificationsE2E?.setRestoreConfirmation(visible);
  }, visible);
}

/** Reads MAX_VISIBLE_TOASTS from the renderer so the test stays in sync with the store constant. */
export async function getMaxVisibleToasts(page: Page): Promise<number> {
  return page.evaluate(() => {
    const a = (
      window as unknown as {
        __daintreeNotificationsE2E?: { MAX_VISIBLE_TOASTS: number };
      }
    ).__daintreeNotificationsE2E;
    if (!a) throw new Error("__daintreeNotificationsE2E backdoor not attached");
    return a.MAX_VISIBLE_TOASTS;
  });
}

/** Reads GRID_BAR_DWELL_FLOOR_MS from the renderer so dwell-floor tests track the store constant. */
export async function getGridBarDwellFloorMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const a = (
      window as unknown as {
        __daintreeNotificationsE2E?: { GRID_BAR_DWELL_FLOOR_MS: number };
      }
    ).__daintreeNotificationsE2E;
    if (!a) throw new Error("__daintreeNotificationsE2E backdoor not attached");
    return a.GRID_BAR_DWELL_FLOOR_MS;
  });
}
