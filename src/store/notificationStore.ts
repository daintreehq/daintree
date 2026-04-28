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
  /** Wall-clock time the toast first became visible. Preserved across coalesces and updates. */
  firstShownAt?: number;
  /**
   * Bumped only when the displayed message text actually changes (not on
   * every count bump or metadata-only update). The Toast auto-dismiss timer
   * resets on this key, so chatty same-message coalesces no longer keep the
   * toast alive forever (issue #5863).
   */
  contentKey?: number;
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

/**
 * Compare two notification messages for the purpose of contentKey bumping.
 * Plain strings compare by value; any ReactNode message is treated as
 * "changed" because referential equality on JSX is unreliable and false
 * positives are safer than false negatives (a missed timer reset would let a
 * truly-updated toast dismiss too early).
 */
function messagesEqual(a: Notification["message"], b: Notification["message"]): boolean {
  return typeof a === "string" && typeof b === "string" && a === b;
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  notifications: [],
  addNotification: (notification) => {
    if (
      import.meta.env.DEV &&
      typeof notification.message !== "string" &&
      !notification.inboxMessage
    ) {
      // Mirrors the guard in notify(); without it, direct callers silently drop
      // their persistent inbox history (WCAG 2.2.1).
      console.error(
        "[notificationStore.addNotification] ReactNode message without inboxMessage — persistent inbox history will be dropped. Use notify() or provide inboxMessage."
      );
    }
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
          const messageChanged = !messagesEqual(notification.message, liveMatch.message);
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
                    contentKey: messageChanged ? (n.contentKey ?? 1) + 1 : (n.contentKey ?? 1),
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
          // Prefer evicting the oldest non-error toast so an error stays
          // visible when fast successes/infos arrive after it (#5861). Falls
          // back to oldest-of-any-type when the visible set is all errors.
          // Relies on `notifications` being append-only — `active` is therefore
          // insertion-ordered oldest-first, so `find` returns the oldest
          // non-error without sorting.
          const evictCandidate = active.find((n) => n.type !== "error") ?? active[0]!;
          notifications = notifications.map((n) =>
            n.id === evictCandidate.id ? { ...n, dismissed: true } : n
          );
          if (evictCandidate.historyEntryId) {
            useNotificationHistoryStore.getState().markUnseenAsToast(evictCandidate.historyEntryId);
          }
        }
      }
      const now = Date.now();
      return {
        notifications: [
          ...notifications,
          { ...notification, id, updatedAt: now, firstShownAt: now, contentKey: 1 },
        ],
      };
    });
    return collapsedOntoId ?? id;
  },
  updateNotification: (id, patch) =>
    set((state) => ({
      notifications: state.notifications.map((n) => {
        if (n.id !== id) return n;
        const now = Date.now();
        const messageInPatch = "message" in patch;
        const messageChanged = messageInPatch && !messagesEqual(patch.message, n.message);
        // A transition from "persistent" (duration: 0) to "auto-dismissing"
        // (duration > 0) is the start of a new visibility window — typically
        // an async operation completing. Reset firstShownAt so the cap is
        // measured from this point, not from when the spinner first appeared.
        const becomingAutoDismiss =
          n.duration === 0 && typeof patch.duration === "number" && patch.duration > 0;
        return {
          ...n,
          ...patch,
          updatedAt: now,
          firstShownAt: becomingAutoDismiss ? now : n.firstShownAt,
          contentKey: messageChanged ? (n.contentKey ?? 1) + 1 : (n.contentKey ?? 1),
        };
      }),
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
