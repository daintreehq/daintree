import { create } from "zustand";
import type { ReactNode } from "react";
import type { ActionId } from "@shared/types/actions";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

const uuidv4 = () => crypto.randomUUID();

export type NotificationType = "success" | "error" | "info" | "warning";
export type NotificationPlacement = "toast" | "grid-bar";
export type NotificationActionVariant = "primary" | "secondary";
export type NotificationPriority = "high" | "low" | "watch";

export interface NotificationAction {
  label: string;
  onClick: () => void | Promise<void>;
  variant?: NotificationActionVariant;
  actionId?: ActionId;
  actionArgs?: Record<string, unknown>;
}

export interface Notification {
  id: string;
  type: NotificationType;
  priority: NotificationPriority;
  placement?: NotificationPlacement;
  title?: string;
  message: string | ReactNode;
  /** Plain-text fallback for history when message is a ReactNode */
  inboxMessage?: string;
  duration?: number;
  action?: NotificationAction;
  actions?: NotificationAction[];
  correlationId?: string;
  /** Set to true synchronously on dismiss to avoid flicker */
  dismissed?: boolean;
  /** Bumped on each coalesced update so useEffect deps can detect changes */
  updatedAt?: number;
  /** Links this toast to its notification history entry for overflow tracking */
  historyEntryId?: string;
  /**
   * Origin context for this notification. Populated by callers that want to
   * enable contextual affordances (e.g. "Mute this project") on the toast and
   * in the notification center. Shape mirrors NotificationHistoryEntry.context.
   */
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
  };
  /**
   * Number of events collapsed into this toast. `undefined` means a single
   * event (rendered without a badge); values >= 2 indicate same-entity
   * collapses and surface as a count badge in the toast UI.
   */
  count?: number;
  /**
   * Fires exactly once when the user closes the toast via the close button
   * (or an action button). Does NOT fire on MAX_VISIBLE_TOASTS eviction or on
   * programmatic dismissNotification from elsewhere — only on the user-driven
   * Toast handleDismiss path.
   */
  onDismiss?: () => void;
}

export type NotificationPatch = Partial<Omit<Notification, "id">>;

interface NotificationStore {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id">) => string;
  updateNotification: (id: string, patch: NotificationPatch) => void;
  dismissNotification: (id: string) => void;
  removeNotification: (id: string) => void;
  clearNotifications: () => void;
  reset: () => void;
}

export const MAX_VISIBLE_TOASTS = 3;

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (notification) => {
    const id = uuidv4();
    let collapsedOntoId: string | null = null;
    set((state) => {
      // Entity collapse: when the incoming notification carries a
      // correlationId that matches a live (non-dismissed, non-grid-bar) toast,
      // merge into it in place rather than adding a new toast + evicting.
      // This keeps unrelated unread errors visible instead of FIFO-discarding
      // them under rapid same-entity bursts (see issue #5385).
      if (
        notification.placement !== "grid-bar" &&
        typeof notification.correlationId === "string" &&
        notification.correlationId.length > 0
      ) {
        const liveMatch = state.notifications.find(
          (n) =>
            !n.dismissed &&
            n.placement !== "grid-bar" &&
            n.correlationId === notification.correlationId
        );
        if (liveMatch) {
          collapsedOntoId = liveMatch.id;
          const incomingHasActions = (notification.actions?.length ?? 0) > 0;
          // `action` uses key-presence (not ??) so a caller can explicitly
          // clear the slot by passing `action: undefined`. This matters for
          // stage regressions (e.g. Update Ready → Update Available) where
          // the prior toast's "Restart to Update" button must NOT carry over
          // onto a downloading-again state. Unset keys still preserve the
          // existing action (the default "missing = preserve" semantic).
          const actionResolved = "action" in notification ? notification.action : liveMatch.action;
          return {
            notifications: state.notifications.map((n) =>
              n.id === liveMatch.id
                ? {
                    ...n,
                    type: notification.type,
                    priority: notification.priority,
                    message: notification.message,
                    title: notification.title ?? n.title,
                    inboxMessage: notification.inboxMessage ?? n.inboxMessage,
                    duration: notification.duration ?? n.duration,
                    action: actionResolved,
                    actions: incomingHasActions ? notification.actions : n.actions,
                    onDismiss: notification.onDismiss ?? n.onDismiss,
                    historyEntryId: notification.historyEntryId ?? n.historyEntryId,
                    count: (n.count ?? 1) + 1,
                    updatedAt: Date.now(),
                  }
                : n
            ),
          };
        }
      }

      let notifications = state.notifications;
      if (notification.placement !== "grid-bar") {
        const active = notifications.filter((n) => !n.dismissed && n.placement !== "grid-bar");
        if (active.length >= MAX_VISIBLE_TOASTS) {
          const oldest = active[0]!;
          notifications = notifications.map((n) =>
            n.id === oldest.id ? { ...n, dismissed: true } : n
          );
          if (oldest.historyEntryId) {
            useNotificationHistoryStore.getState().markUnseenAsToast(oldest.historyEntryId);
          }
        }
      }
      return {
        notifications: [...notifications, { ...notification, id, updatedAt: Date.now() }],
      };
    });
    return collapsedOntoId ?? id;
  },
  updateNotification: (id, patch) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n
      ),
    })),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, dismissed: true } : n)),
    })),
  removeNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    })),
  clearNotifications: () => set({ notifications: [] }),
  reset: () => set({ notifications: [] }),
}));
