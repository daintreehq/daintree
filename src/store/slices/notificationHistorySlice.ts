import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ActionId } from "@shared/types/actions";
import type { NotificationActionVariant } from "@/store/notificationStore";
import type { NotificationEventKind } from "@/lib/notify";
import { createDebouncedSafeJSONStorage } from "@/store/persistence/safeStorage";
import { registerPersistedStore } from "@/store/persistence/persistedStoreRegistry";

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
    eventKind?: NotificationEventKind;
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

// Age-based retention. Read entries (seenAsToast && !archivedAt) age out after a
// week; archived entries persist for a month so resolved-history lookups stay
// useful across sessions. Unread entries are kept regardless of age — losing a
// missed error to a clock is the failure mode we're trying to fix.
export const READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const ARCHIVED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const NOTIFICATION_HISTORY_STORAGE_KEY = "daintree-notification-history";
const NOTIFICATION_HISTORY_PERSIST_VERSION = 1;

function computeUnreadCount(entries: NotificationHistoryEntry[]): number {
  return entries.filter((e) => !e.seenAsToast && e.countable !== false && !e.archivedAt).length;
}

/**
 * Drop expired entries (read older than 7d, archived older than 30d), then
 * enforce the 200-entry safety ceiling. Age pruning runs before the cap so
 * unread entries survive a burst storm even when they're older than the
 * read-retention cutoff. Returns a new array; never mutates the input.
 */
export function pruneNotificationEntries(
  entries: NotificationHistoryEntry[],
  now: number
): NotificationHistoryEntry[] {
  const readCutoff = now - READ_RETENTION_MS;
  const archivedCutoff = now - ARCHIVED_RETENTION_MS;
  const filtered = entries.filter((e) => {
    if (e.archivedAt !== null) return e.archivedAt >= archivedCutoff;
    if (e.seenAsToast) return e.timestamp >= readCutoff;
    return true;
  });
  if (filtered.length <= MAX_ENTRIES) return filtered;
  return filtered.slice(0, MAX_ENTRIES);
}

const VALID_TYPES: ReadonlySet<NotificationHistoryEntry["type"]> = new Set([
  "success",
  "error",
  "info",
  "warning",
]);

// Clock-skew allowance for entries that look slightly in the future on
// hydration (different process boot times, NTP drift). Anything beyond a
// minute is treated as garbage rather than a valid future timestamp.
const FUTURE_TIMESTAMP_SLACK_MS = 60_000;

function sanitizeActions(raw: unknown): NotificationHistoryEntry["actions"] {
  if (!Array.isArray(raw)) return undefined;
  const validated: NotificationHistoryAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.label !== "string" || a.label.length === 0) continue;
    if (typeof a.actionId !== "string" || a.actionId.length === 0) continue;
    validated.push({
      label: a.label,
      actionId: a.actionId as ActionId,
      actionArgs:
        a.actionArgs && typeof a.actionArgs === "object"
          ? (a.actionArgs as Record<string, unknown>)
          : undefined,
      variant: typeof a.variant === "string" ? (a.variant as NotificationActionVariant) : undefined,
    });
  }
  return validated.length === 0 ? undefined : validated;
}

/**
 * Defensively coerce a value off the wire into a `NotificationHistoryEntry`,
 * or `null` if the shape is unrecoverable. `message` is forced to a string —
 * pre-persist code paths only ever wrote strings, but a corrupt blob or a
 * future ReactNode leak would crash React on render without this guard.
 * `summarized` is reset to false because in-session re-entry summaries don't
 * carry meaning across restarts.
 */
export function sanitizePersistedEntry(raw: unknown): NotificationHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.timestamp !== "number" || !Number.isFinite(r.timestamp)) return null;
  // Reject implausible timestamps: <=0 or far in the future. Bounds protect
  // against corrupt localStorage holding values that would otherwise live in
  // the inbox until the year ~2286.
  if (r.timestamp <= 0 || r.timestamp > Date.now() + FUTURE_TIMESTAMP_SLACK_MS) return null;
  if (typeof r.type !== "string" || !VALID_TYPES.has(r.type as NotificationHistoryEntry["type"])) {
    return null;
  }
  const message = typeof r.message === "string" ? r.message : "";
  // archivedAt: 0 / negative / future is coerced to null so the existing
  // falsy "is archived" checks in the slice (`!entry.archivedAt`) stay
  // consistent with the type-level `number | null` model.
  const archivedAt =
    typeof r.archivedAt === "number" &&
    Number.isFinite(r.archivedAt) &&
    r.archivedAt > 0 &&
    r.archivedAt <= Date.now() + FUTURE_TIMESTAMP_SLACK_MS
      ? r.archivedAt
      : null;
  return {
    id: r.id,
    type: r.type as NotificationHistoryEntry["type"],
    title: typeof r.title === "string" ? r.title : undefined,
    message,
    timestamp: r.timestamp,
    correlationId: typeof r.correlationId === "string" ? r.correlationId : undefined,
    seenAsToast: r.seenAsToast === true,
    summarized: false,
    countable: r.countable !== false,
    archivedAt,
    supersedeKey: typeof r.supersedeKey === "string" ? r.supersedeKey : undefined,
    context:
      r.context && typeof r.context === "object"
        ? (r.context as NotificationHistoryEntry["context"])
        : undefined,
    actions: sanitizeActions(r.actions),
  };
}

interface PersistedNotificationHistoryShape {
  entries: NotificationHistoryEntry[];
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
  /**
   * Drop entries that have exceeded their retention window. Read entries are
   * kept for 7d, archived for 30d, unread entries indefinitely (subject to the
   * 200-entry safety cap). No-op when nothing has expired so the persist write
   * doesn't fire on every tick.
   */
  pruneExpiredEntries: (now?: number) => void;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>()(
  persist(
    (set, get) => ({
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

          const candidate = [newEntry, ...sourceEntries];
          const updated = pruneNotificationEntries(candidate, now);
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
          const entries = state.entries.map((e) =>
            e.id === id ? { ...e, seenAsToast: false } : e
          );
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
      pruneExpiredEntries: (now = Date.now()) =>
        set((state) => {
          const filtered = pruneNotificationEntries(state.entries, now);
          if (filtered.length === state.entries.length) return state;
          return { entries: filtered, unreadCount: computeUnreadCount(filtered) };
        }),
    }),
    {
      name: NOTIFICATION_HISTORY_STORAGE_KEY,
      version: NOTIFICATION_HISTORY_PERSIST_VERSION,
      storage: createDebouncedSafeJSONStorage<PersistedNotificationHistoryShape>(300),
      // Only persist entries — unreadCount is recomputed on hydration, and
      // evictedToInboxCount is a session-only discoverability counter that
      // resets to 0 on every fresh load.
      partialize: (state): PersistedNotificationHistoryShape => ({ entries: state.entries }),
      merge: (persisted, current) => {
        const p = persisted as Partial<PersistedNotificationHistoryShape> | undefined;
        const rawEntries = Array.isArray(p?.entries) ? p.entries : [];
        const sanitized = rawEntries
          .map(sanitizePersistedEntry)
          .filter((e): e is NotificationHistoryEntry => e !== null);
        const pruned = pruneNotificationEntries(sanitized, Date.now());
        return { ...current, entries: pruned, unreadCount: computeUnreadCount(pruned) };
      },
    }
  )
);

registerPersistedStore({
  storeId: "notificationHistoryStore",
  store: useNotificationHistoryStore,
  persistedStateType: "PersistedNotificationHistoryShape",
});

/** Returns all history entries that share the given correlationId */
export function getEntriesByCorrelationId(correlationId: string): NotificationHistoryEntry[] {
  return useNotificationHistoryStore
    .getState()
    .entries.filter((e) => e.correlationId === correlationId);
}
