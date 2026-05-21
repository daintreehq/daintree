import { create } from "zustand";
import type { ActionId } from "@shared/types/actions";
import type { NotificationActionVariant } from "@/store/notificationStore";

export interface NotificationHistoryAction {
  label: string;
  actionId: ActionId;
  actionArgs?: Record<string, unknown>;
  variant?: NotificationActionVariant;
}

export interface NotificationHistoryEntry {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title?: string;
  message: string;
  timestamp: number;
  correlationId?: string;
  /** True when the user has seen this notification (shown as toast or explicitly marked as read). False when missed (app blurred or low priority). */
  seenAsToast: boolean;
  /** True after being included in a re-entry summary shown on window refocus. */
  summarized: boolean;
  /** When false, the entry exists in history but does not increment the unread badge. Defaults to true. */
  countable: boolean;
  /**
   * Timestamp at which the entry was archived (moved to the Done state).
   * Archived entries are hidden from All/Unread views and only appear in the
   * Archived tab. Null until archived.
   */
  archivedAt: number | null;
  /**
   * Logical pairing key. When a later `notify()` is called with the same
   * `supersedeKey`, the prior non-archived entry sharing this key is archived
   * automatically — used for resolving-event pairs like
   * "disconnected" → "reconnected".
   */
  supersedeKey?: string;
  context?: {
    projectId?: string;
    worktreeId?: string;
    panelId?: string;
    eventKind?: "completed" | "waiting" | "workingPulse" | "uiFeedback";
  };
  actions?: NotificationHistoryAction[];
}

type AddEntryInput = Omit<
  NotificationHistoryEntry,
  "id" | "timestamp" | "seenAsToast" | "summarized" | "countable" | "archivedAt"
> & {
  seenAsToast?: boolean;
  countable?: boolean;
  /**
   * Exact id of a prior entry to archive when this entry is added. Consumed
   * at write-time and not stored on the new entry. No-op if the target is
   * missing or already archived. Takes precedence over `supersedeKey`.
   */
  supersedes?: string;
};

const MAX_ENTRIES = 200;

function computeUnreadCount(entries: NotificationHistoryEntry[]): number {
  return entries.filter((e) => !e.seenAsToast && e.countable !== false && !e.archivedAt).length;
}

interface NotificationHistoryState {
  entries: NotificationHistoryEntry[];
  unreadCount: number;
  /**
   * Number of toasts that have been evicted into the inbox since the user
   * last opened the notification center. Drives the toaster overflow pill
   * and the toolbar bell arrival animation. Reset by `resetEvictedCount`.
   */
  evictedToInboxCount: number;
  addEntry: (entry: AddEntryInput) => string;
  /**
   * Replaces the `message` text on an existing entry without bumping
   * `timestamp` or any read/archived state. Used by the rate-limit overflow
   * path to refresh an in-place summary row ("{N} more events") as more
   * overflowed events arrive. Returns `true` when the entry was updated,
   * `false` when the entry was missing or archived — callers that depend on
   * the row staying live (e.g. the rate-limit overflow summary) must treat
   * `false` as a signal to recreate the row rather than silently drop the
   * subsequent event.
   */
  updateEntryMessage: (id: string, message: string) => boolean;
  /**
   * Flips an entry's `seenAsToast` back to false (it's no longer visible as a
   * toast). Pass `silent: true` to skip the discoverability-cue increment
   * (`evictedToInboxCount`) — used when the notification center is already
   * open and the user can see the entry land in the inbox directly.
   */
  markUnseenAsToast: (id: string, options?: { silent?: boolean }) => void;
  dismissEntry: (id: string) => void;
  dismissByCorrelationId: (correlationId: string) => void;
  /**
   * Non-destructive archive (Done state). Sets `archivedAt` + `seenAsToast`
   * atomically so the badge clears immediately and the entry leaves All/Unread
   * for the Archived tab. No-op if the entry is missing or already archived.
   */
  archiveEntry: (id: string) => void;
  /**
   * Archives every non-archived entry in the thread. No-op when nothing matches.
   */
  archiveByCorrelationId: (correlationId: string) => void;
  clearAll: () => void;
  markAllRead: () => void;
  /**
   * Flips `seenAsToast` to true on the targeted entries in a single atomic
   * update. Skips entries that are already read or missing. Used by the
   * bulk-mark-read flows that need to capture an exact ID set up-front for an
   * undo affordance.
   */
  markIdsRead: (ids: string[]) => void;
  markSummarized: (ids: string[]) => void;
  resetEvictedCount: () => void;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>((set, get) => ({
  entries: [],
  unreadCount: 0,
  evictedToInboxCount: 0,
  addEntry: (entry) => {
    const { supersedes, ...rest } = entry;
    const seenAsToast = rest.seenAsToast ?? false;
    const countable = rest.countable ?? true;
    const newEntry: NotificationHistoryEntry = {
      ...rest,
      seenAsToast,
      summarized: false,
      countable,
      archivedAt: null,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    set((state) => {
      // Resolve supersede target inside the same set() so the insert + archive
      // land atomically — observers never see an unread count that omits one
      // change but includes the other.
      let archiveId: string | undefined;
      if (supersedes) {
        const target = state.entries.find((e) => e.id === supersedes);
        if (target && !target.archivedAt) archiveId = target.id;
      } else if (rest.supersedeKey) {
        const target = state.entries.find(
          (e) => e.supersedeKey === rest.supersedeKey && !e.archivedAt
        );
        if (target) archiveId = target.id;
      }

      const now = Date.now();
      const sourceEntries = archiveId
        ? state.entries.map((e) =>
            e.id === archiveId ? { ...e, archivedAt: now, seenAsToast: true } : e
          )
        : state.entries;

      const updated = [newEntry, ...sourceEntries];
      if (updated.length > MAX_ENTRIES) {
        updated.length = MAX_ENTRIES;
      }
      return { entries: updated, unreadCount: computeUnreadCount(updated) };
    });
    return newEntry.id;
  },
  updateEntryMessage: (id, message) => {
    const state = get();
    const entry = state.entries.find((e) => e.id === id);
    if (!entry || entry.archivedAt) return false;
    set({
      entries: state.entries.map((e) => (e.id === id ? { ...e, message } : e)),
    });
    return true;
  },
  markUnseenAsToast: (id, options) =>
    set((state) => {
      const entry = state.entries.find((e) => e.id === id);
      // Archived entries are done — never re-evict them into the unread/
      // overflow path. Without this guard a late toast expiry would flip
      // seenAsToast back to false on an archived entry and inflate
      // evictedToInboxCount even though unreadCount stays correct.
      if (!entry || !entry.seenAsToast || entry.archivedAt) return state;
      const entries = state.entries.map((e) => (e.id === id ? { ...e, seenAsToast: false } : e));
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
        evictedToInboxCount: options?.silent
          ? state.evictedToInboxCount
          : state.evictedToInboxCount + 1,
      };
    }),
  dismissEntry: (id) =>
    set((state) => {
      const entries = state.entries.filter((e) => e.id !== id);
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
      };
    }),
  dismissByCorrelationId: (correlationId) =>
    set((state) => {
      const entries = state.entries.filter((e) => e.correlationId !== correlationId);
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
      };
    }),
  archiveEntry: (id) =>
    set((state) => {
      const entry = state.entries.find((e) => e.id === id);
      if (!entry || entry.archivedAt) return state;
      const now = Date.now();
      const entries = state.entries.map((e) =>
        e.id === id ? { ...e, archivedAt: now, seenAsToast: true } : e
      );
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
      };
    }),
  archiveByCorrelationId: (correlationId) =>
    set((state) => {
      let mutated = false;
      const now = Date.now();
      const entries = state.entries.map((e) => {
        if (e.correlationId === correlationId && !e.archivedAt) {
          mutated = true;
          return { ...e, archivedAt: now, seenAsToast: true };
        }
        return e;
      });
      if (!mutated) return state;
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
      };
    }),
  clearAll: () => set({ entries: [], unreadCount: 0, evictedToInboxCount: 0 }),
  markAllRead: () =>
    set((state) => ({
      unreadCount: 0,
      entries: state.entries.map((e) => (e.seenAsToast ? e : { ...e, seenAsToast: true })),
    })),
  markIdsRead: (ids) =>
    set((state) => {
      if (ids.length === 0) return state;
      const idSet = new Set(ids);
      let mutated = false;
      const entries = state.entries.map((e) => {
        if (idSet.has(e.id) && !e.seenAsToast) {
          mutated = true;
          return { ...e, seenAsToast: true };
        }
        return e;
      });
      if (!mutated) return state;
      return {
        entries,
        unreadCount: computeUnreadCount(entries),
      };
    }),
  markSummarized: (ids) =>
    set((state) => {
      const idSet = new Set(ids);
      return {
        entries: state.entries.map((e) =>
          idSet.has(e.id) && !e.summarized ? { ...e, summarized: true } : e
        ),
      };
    }),
  resetEvictedCount: () =>
    set((state) => (state.evictedToInboxCount === 0 ? state : { evictedToInboxCount: 0 })),
}));

/** Returns all history entries that share the given correlationId */
export function getEntriesByCorrelationId(correlationId: string): NotificationHistoryEntry[] {
  return useNotificationHistoryStore
    .getState()
    .entries.filter((e) => e.correlationId === correlationId);
}
