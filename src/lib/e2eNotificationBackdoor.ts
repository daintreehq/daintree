// E2E-only backdoor for driving the notification surfaces (toasts, grid-bar,
// global recovery banners, notification center) from Playwright. Gated on the
// preload-injected `__DAINTREE_E2E_MODE__` flag — mirrors the ActionService
// dispatch backdoor at `src/services/ActionService.ts:710` — so the globals are
// never attached in production sessions. Injection goes straight at the store
// singletons rather than through `notify()`, keeping the synthetic events fully
// deterministic (no priority routing, focus gating, or rate-limit interference).
import {
  MAX_VISIBLE_TOASTS,
  GRID_BAR_DWELL_FLOOR_MS,
  useNotificationStore,
  type NotificationType,
  type NotificationPriority,
  type NotificationPlacement,
} from "@/store/notificationStore";
import {
  useNotificationHistoryStore,
  type NotificationHistoryEntry,
} from "@/store/slices/notificationHistorySlice";
import {
  _setQuietUntil,
  _resetRateLimitBuckets,
  _resetCoalesceMap,
  _resetPendingSuppressedForTest,
  _resetEscalationTrackers,
  _resetOverflowAnnouncements,
} from "@/lib/notify";
import { usePanelStore, type BackendStatus, type WatchdogStatus } from "@/store/panelStore";
import { useSafeModeStore } from "@/store/safeModeStore";
import { useRestoreConfirmationStore } from "@/store/restoreConfirmationStore";

export interface E2EToastInput {
  type: NotificationType;
  message: string;
  title?: string;
  priority?: NotificationPriority;
  placement?: NotificationPlacement;
  /** ms; omit/0 for a sticky toast that never auto-dismisses. */
  duration?: number;
  correlationId?: string;
  /** Links the toast to a history entry so eviction increments the overflow pill. */
  historyEntryId?: string;
  /** When set, renders an action button with this label. */
  actionLabel?: string;
  /** Past-tense confirmation label; enables the success-flash flow. */
  successLabel?: string;
  /** When true, the action's onClick resolves after `asyncDelayMs` (spinner path). */
  asyncAction?: boolean;
  asyncDelayMs?: number;
}

export interface E2EHistoryInput {
  type: NotificationType;
  message: string;
  title?: string;
  correlationId?: string;
  /** Defaults to false (unread). Set true to seed a read entry. */
  seenAsToast?: boolean;
}

export interface E2ESeedHistoryInput {
  entries: NotificationHistoryEntry[];
  /** `correlationId` → expiry epoch-ms. Defaults to no snoozed threads. */
  snoozedThreads?: Record<string, number>;
}

export interface NotificationsE2EApi {
  readonly MAX_VISIBLE_TOASTS: number;
  readonly GRID_BAR_DWELL_FLOOR_MS: number;
  addToast: (input: E2EToastInput) => string;
  /** Directly overwrites `firstShownAt` on a grid-bar notification to drive dwell-floor expiry without a real wait. */
  backdateNotification: (id: string, firstShownAt: number) => void;
  resetToasts: () => void;
  addHistoryEntry: (input: E2EHistoryInput) => string;
  /**
   * Replaces the whole history store contents in one write. Unlike
   * `addHistoryEntry` this accepts the full persisted entry shape —
   * timestamps, actions, context, archived/snoozed state — so a capture or
   * regression fixture can pin states that `addEntry` derives from the clock
   * (relative-time labels) or never sets at all (row actions, panel context).
   */
  seedHistory: (input: E2ESeedHistoryInput) => void;
  archiveHistoryEntry: (id: string) => void;
  snoozeThread: (correlationId: string, snoozedUntil: number) => void;
  clearHistory: () => void;
  resetNotifyInternals: () => void;
  setBackendStatus: (status: BackendStatus) => void;
  setWatchdogStatus: (status: WatchdogStatus) => void;
  setSafeMode: (safeMode: boolean, dismissed?: boolean) => void;
  setRestoreConfirmation: (visible: boolean) => void;
  resetBanners: () => void;
}

function buildApi(): NotificationsE2EApi {
  return {
    MAX_VISIBLE_TOASTS,
    GRID_BAR_DWELL_FLOOR_MS,
    addToast: (input) => {
      const action = input.actionLabel
        ? {
            label: input.actionLabel,
            successLabel: input.successLabel,
            onClick: input.asyncAction
              ? () => new Promise<void>((resolve) => setTimeout(resolve, input.asyncDelayMs ?? 300))
              : () => {},
          }
        : undefined;
      return useNotificationStore.getState().addNotification({
        type: input.type,
        message: input.message,
        title: input.title,
        priority: input.priority ?? "high",
        placement: input.placement ?? "toast",
        duration: input.duration,
        correlationId: input.correlationId,
        historyEntryId: input.historyEntryId,
        action,
      });
    },
    backdateNotification: (id, firstShownAt) => {
      useNotificationStore.setState((state) => ({
        notifications: state.notifications.map((n) => (n.id === id ? { ...n, firstShownAt } : n)),
      }));
    },
    resetToasts: () => useNotificationStore.getState().reset(),
    addHistoryEntry: (input) =>
      useNotificationHistoryStore.getState().addEntry({
        type: input.type,
        message: input.message,
        title: input.title,
        correlationId: input.correlationId,
        seenAsToast: input.seenAsToast ?? false,
      }),
    seedHistory: ({ entries, snoozedThreads = {} }) => {
      const unreadCount = entries.filter(
        (e) =>
          !e.seenAsToast &&
          e.countable !== false &&
          !e.archivedAt &&
          !(e.correlationId && (snoozedThreads[e.correlationId] ?? 0) > Date.now())
      ).length;
      useNotificationHistoryStore.setState({ entries, snoozedThreads, unreadCount });
    },
    archiveHistoryEntry: (id) => useNotificationHistoryStore.getState().archiveEntry(id),
    snoozeThread: (correlationId, snoozedUntil) =>
      useNotificationHistoryStore.getState().snoozeThread(correlationId, snoozedUntil),
    clearHistory: () => useNotificationHistoryStore.getState().clearAll(),
    resetNotifyInternals: () => {
      _resetRateLimitBuckets();
      _resetCoalesceMap();
      _resetPendingSuppressedForTest();
      _resetEscalationTrackers();
      _resetOverflowAnnouncements();
      _setQuietUntil(0);
    },
    setBackendStatus: (status) => usePanelStore.setState({ backendStatus: status }),
    setWatchdogStatus: (status) => usePanelStore.setState({ watchdogStatus: status }),
    setSafeMode: (safeMode, dismissed = false) =>
      useSafeModeStore.setState({ safeMode, dismissed }),
    setRestoreConfirmation: (visible) => useRestoreConfirmationStore.setState({ visible }),
    resetBanners: () => {
      usePanelStore.setState({ backendStatus: "connected", watchdogStatus: "active" });
      // Clear the full safe-mode shape (not just safeMode/dismissed) so a prior
      // test's crash metadata can't leak into a later SafeModeBanner render.
      useSafeModeStore.setState({
        safeMode: false,
        dismissed: false,
        crashCount: undefined,
        skippedPanelCount: undefined,
        lastCrashAt: undefined,
        quarantinedPanels: undefined,
      });
      useRestoreConfirmationStore.setState({ visible: false });
    },
  };
}

export function installE2ENotificationBackdoor(): void {
  if (typeof window === "undefined" || window.__DAINTREE_E2E_MODE__ !== true) return;

  window.__daintreeNotificationsE2E = buildApi();
}
