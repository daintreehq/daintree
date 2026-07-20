import { create } from "zustand";
import type { ReactNode } from "react";
import type { ActionId } from "@shared/types/actions";
import type { NotificationEventKind } from "@/lib/notify";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useUIStore } from "@/store/uiStore";

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
  /** Past-tense label shown during the success-flash confirmation. When absent, the action dismisses the toast immediately on click (current behavior). */
  successLabel?: string;
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
    eventKind?: NotificationEventKind;
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
 * Minimum time a grid-bar notification stays displayed before a
 * higher-severity newcomer can preempt it. Prevents read-mid-message
 * disruption when multiple producers contend for the single grid-bar slot.
 */
export const GRID_BAR_DWELL_FLOOR_MS = 5000;

/**
 * Severity weights for grid-bar selection. `watch` dominates `high` which
 * dominates `low`; the gap is wide enough that no type bonus
 * (GRID_BAR_TYPE_WEIGHTS max = 3) can lift a lower priority above a higher one.
 */
export const PRIORITY_WEIGHTS: Record<NotificationPriority, number> = {
  watch: 100,
  high: 10,
  low: 0,
};

/**
 * Type-severity bonus applied on top of `PRIORITY_WEIGHTS` when comparing
 * grid-bar candidates. Inlined here (rather than imported from
 * `notificationSeverity.ts`) to keep the boot-loaded notification store
 * off a new module edge. A consistency test in `notificationStore.test.ts`
 * asserts these values track `SEVERITY_WEIGHTS`.
 */
const GRID_BAR_TYPE_WEIGHTS: Record<NotificationType, number> = {
  error: 3,
  warning: 2,
  info: 1,
  success: 0,
};

/**
 * Single-slot grid-bar selection contract.
 *
 * Picks among undismissed `grid-bar` notifications by
 * `PRIORITY_WEIGHTS[priority] + SEVERITY_WEIGHTS[type]` (highest wins);
 * ties resolve to the oldest `firstShownAt` (chronological).
 *
 * A `lockedId` is the id of the notification currently visible to the
 * user. While that notification is still within `GRID_BAR_DWELL_FLOOR_MS`
 * of its `firstShownAt`, it is returned unchanged — a higher-severity
 * newcomer cannot preempt it mid-read. Once the dwell expires, the
 * regular score/age ordering applies.
 *
 * Pure: callers pass `nowMs` (typically `Date.now()` at render time) so
 * the selector itself stays time-independent and unit-testable.
 */
export function selectGridBarNotification(
  notifications: Notification[],
  nowMs: number,
  lockedId?: string
): Notification | undefined {
  const candidates = notifications.filter((n) => n.placement === "grid-bar" && !n.dismissed);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  if (lockedId !== undefined) {
    const locked = candidates.find((n) => n.id === lockedId);
    if (locked !== undefined) {
      const dwellExpires = (locked.firstShownAt ?? 0) + GRID_BAR_DWELL_FLOOR_MS;
      if (nowMs < dwellExpires) return locked;
    }
  }

  return [...candidates].sort((a, b) => {
    const scoreDiff =
      PRIORITY_WEIGHTS[b.priority] +
      GRID_BAR_TYPE_WEIGHTS[b.type] -
      (PRIORITY_WEIGHTS[a.priority] + GRID_BAR_TYPE_WEIGHTS[a.type]);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.firstShownAt ?? 0) - (b.firstShownAt ?? 0);
  })[0];
}

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
          // `actions` is tri-state, mirroring `action`'s explicit-clear escape
          // hatch: an explicit `actions: undefined` clears the slot (same stage
          // regression rationale as above), while an omitted key or an empty
          // array still preserves the existing array — callers that pass `[]`
          // mean "I have no actions to contribute", not "wipe the ones there".
          const actionsResolved =
            "actions" in notification && notification.actions === undefined
              ? undefined
              : incomingHasActions
                ? notification.actions
                : liveMatch.actions;
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
                    actions: actionsResolved,
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
            // Suppress the discoverability cue (overflow pill + bell blip)
            // when the notification center is already open — the user can
            // see the entry land in the inbox directly, so signaling its
            // arrival twice would create a UX contradiction.
            const silent = useUIStore.getState().notificationCenterOpen;
            useNotificationHistoryStore
              .getState()
              .markUnseenAsToast(evictCandidate.historyEntryId, { silent });
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
