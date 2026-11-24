import { create } from "zustand";
import { persist, type StorageValue } from "zustand/middleware";
import type { ActionId } from "@shared/types/actions";
import type { NotificationActionVariant } from "@/store/notificationStore";
import type { NotificationEventKind } from "@/lib/notify";
import type { NotificationPluginSource } from "@shared/types/ipc/maps";
import {
  createDebouncedSafeJSONStorage,
  readLocalStorageItemSafely,
  safeJSONParse,
} from "@/store/persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  pickFieldByWriterDelta,
  type PersistWriteMergeContext,
} from "@/store/persistence/persistWriteMerge";
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
    /** The other machine this came from; its project ids mean nothing here. */
    hostName?: string;
    /** The plugin that raised it; a silence is keyed on its id. */
    plugin?: NotificationPluginSource;
  };
  actions?: NotificationHistoryAction[];
}

type AddEntryInput = Omit<
  NotificationHistoryEntry,
  "id" | "timestamp" | "seenAsToast" | "summarized" | "countable" | "archivedAt"
> & {
  /**
   * The entry's id, for an event every project view hears at once (a host
   * broadcast): each view files it under the same id, so their writes merge
   * into one row. An id this view already holds changes nothing. Defaults to a
   * fresh UUID.
   */
  id?: string;
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
const NOTIFICATION_HISTORY_PERSIST_VERSION = 2;

/**
 * Returns true when `correlationId` is currently snoozed by the user.
 * Treats expired snoozes as not-snoozed — callers don't need to manually
 * sweep before reading. A missing `correlationId` is always not-snoozed
 * because snooze is a thread-level affordance.
 */
function isSnoozedAt(
  snoozedThreads: Record<string, number>,
  correlationId: string | undefined,
  now: number
): boolean {
  if (!correlationId) return false;
  const until = snoozedThreads[correlationId];
  return typeof until === "number" && until > now;
}

/**
 * Returns a new snooze map with `correlationId` removed when no active
 * (non-archived) entries remain for that thread, leaving the input map
 * untouched in every other case. Called after dismiss/archive on a single
 * entry that carried a correlationId — without this sweep the snooze map
 * would keep keys with nothing behind them and the Snoozed tab would
 * surface an empty ghost row.
 */
function clearSnoozeIfThreadGone(
  snoozedThreads: Record<string, number>,
  remainingEntries: NotificationHistoryEntry[],
  correlationId: string | undefined
): Record<string, number> {
  if (!correlationId) return snoozedThreads;
  if (snoozedThreads[correlationId] === undefined) return snoozedThreads;
  const stillActive = remainingEntries.some(
    (e) => e.correlationId === correlationId && e.archivedAt === null
  );
  if (stillActive) return snoozedThreads;
  const next = { ...snoozedThreads };
  delete next[correlationId];
  return next;
}

/**
 * Drops the snooze of every thread a prune took an active row from and left
 * with none. The Snoozed tab is built from the snooze keys but lists only
 * surviving active rows, so a key outliving its thread is an empty tab. Only
 * threads the prune touched are swept: a removed archived row never stood
 * behind a snooze, and a snooze with nothing pruned behind it (one set before
 * the thread's first row) is left as it is.
 */
function clearSnoozesOfPrunedThreads(
  snoozedThreads: Record<string, number>,
  before: Iterable<NotificationHistoryEntry>,
  after: NotificationHistoryEntry[]
): Record<string, number> {
  if (Object.keys(snoozedThreads).length === 0) return snoozedThreads;
  const kept = new Set(after.map((e) => e.id));
  let pruned: Set<string> | undefined;
  for (const e of before) {
    const id = e.correlationId;
    if (!id || e.archivedAt !== null || snoozedThreads[id] === undefined || kept.has(e.id))
      continue;
    (pruned ??= new Set()).add(id);
  }
  if (pruned === undefined) return snoozedThreads;
  let next = snoozedThreads;
  for (const id of pruned) {
    if (after.some((e) => e.correlationId === id && e.archivedAt === null)) continue;
    if (next === snoozedThreads) next = { ...snoozedThreads };
    delete next[id];
  }
  return next;
}

function computeUnreadCount(
  entries: NotificationHistoryEntry[],
  snoozedThreads: Record<string, number>,
  now: number = Date.now()
): number {
  return entries.filter((e) => {
    if (e.seenAsToast) return false;
    if (e.countable === false) return false;
    if (e.archivedAt) return false;
    if (isSnoozedAt(snoozedThreads, e.correlationId, now)) return false;
    return true;
  }).length;
}

function isPastRetention(entry: NotificationHistoryEntry, now: number): boolean {
  if (entry.archivedAt !== null) return entry.archivedAt < now - ARCHIVED_RETENTION_MS;
  if (entry.seenAsToast) return entry.timestamp < now - READ_RETENTION_MS;
  return false;
}

/**
 * Drop expired entries (read older than 7d, archived older than 30d), then
 * enforce the 200-entry safety ceiling. Age pruning runs before the cap so
 * unread entries survive a burst storm even when they're older than the
 * read-retention cutoff. Ids in `keep` are spared the age pruning. Returns a
 * new array; never mutates the input.
 */
export function pruneNotificationEntries(
  entries: NotificationHistoryEntry[],
  now: number,
  keep?: ReadonlySet<string>
): NotificationHistoryEntry[] {
  const filtered = entries.filter((e) => keep?.has(e.id) === true || !isPastRetention(e, now));
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

// Quick-create's Undo used to persist `worktree.delete { force: true }`, which
// an inbox row replays with no dialog and no change check, days later, over
// whatever the worktree has gained since (#16264). Entries already on disk keep
// their record; only that action goes.
function isStoredForceDelete(action: Record<string, unknown>): boolean {
  if (action.actionId !== "worktree.delete") return false;
  const args = action.actionArgs;
  return typeof args === "object" && args !== null && "force" in args && args.force === true;
}

function sanitizeActions(raw: unknown): NotificationHistoryEntry["actions"] {
  if (!Array.isArray(raw)) return undefined;
  const validated: NotificationHistoryAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.label !== "string" || a.label.length === 0) continue;
    if (typeof a.actionId !== "string" || a.actionId.length === 0) continue;
    if (isStoredForceDelete(a)) continue;
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
export function sanitizePersistedEntry(
  raw: unknown,
  now: number = Date.now()
): NotificationHistoryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.timestamp !== "number" || !Number.isFinite(r.timestamp)) return null;
  // Reject implausible timestamps: <=0 or far in the future. Bounds protect
  // against corrupt localStorage holding values that would otherwise live in
  // the inbox until the year ~2286.
  if (r.timestamp <= 0 || r.timestamp > now + FUTURE_TIMESTAMP_SLACK_MS) return null;
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
    r.archivedAt <= now + FUTURE_TIMESTAMP_SLACK_MS
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

/**
 * Defensively coerce the persisted `snoozedThreads` blob into a clean map.
 * Strips non-object input, blank keys, non-finite values, and entries whose
 * snooze has already expired (no point hydrating a snooze that fires
 * immediately and then forces a re-render to clear itself).
 */
export function sanitizeSnoozedThreads(
  raw: unknown,
  now: number = Date.now()
): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value <= now) continue;
    out[key] = value;
  }
  return out;
}

interface PersistedNotificationHistoryShape {
  entries: NotificationHistoryEntry[];
  /**
   * Map of `correlationId` → expiry epoch-ms timestamp. Snoozed threads are
   * hidden from the All/Unread/Archived tabs, surface only in the Snoozed
   * tab, and are excluded from the unread badge count.
   */
  snoozedThreads?: Record<string, number>;
}

interface NormalizedNotificationHistory {
  entries: Map<string, NotificationHistoryEntry>;
  snoozedThreads: Record<string, number>;
}

/**
 * Sanitizes a persisted value the way hydration does, at a fixed `now`, keyed by
 * entry id. Every merge input goes through this so the writer-delta diff
 * compares like-for-like: the baseline is the raw hydration read while incoming
 * is post-hydration memory, and without it the session-local `summarized`
 * reset or an expired snooze would read as a writer edit. Entries are not
 * age-pruned here: an entry that expired after hydration would vanish from the
 * baseline too and a dismissal of it would look like a sibling's addition.
 */
function normalizeNotificationHistory(
  value: StorageValue<unknown> | null,
  now: number
): NormalizedNotificationHistory {
  const state =
    value?.state && typeof value.state === "object"
      ? (value.state as Partial<PersistedNotificationHistoryShape>)
      : undefined;
  const rawEntries = Array.isArray(state?.entries) ? state.entries : [];
  const entries = new Map<string, NotificationHistoryEntry>();
  for (const raw of rawEntries) {
    const entry = sanitizePersistedEntry(raw, now);
    if (entry && !entries.has(entry.id)) entries.set(entry.id, entry);
  }
  return { entries, snoozedThreads: sanitizeSnoozedThreads(state?.snoozedThreads, now) };
}

/**
 * Settles an entry both this writer and the disk still hold, field by field, so
 * a stale `markAllRead` or message update can't undo a sibling's archive. An
 * archived entry is always read, matching `archiveEntry`.
 */
function mergeEntryFields(
  baseline: NotificationHistoryEntry,
  incoming: NotificationHistoryEntry,
  onDisk: NotificationHistoryEntry
): NotificationHistoryEntry {
  const archivedAt = pickFieldByWriterDelta(
    baseline.archivedAt,
    incoming.archivedAt,
    onDisk.archivedAt
  );
  return {
    ...onDisk,
    message: pickFieldByWriterDelta(baseline.message, incoming.message, onDisk.message),
    seenAsToast:
      archivedAt !== null ||
      pickFieldByWriterDelta(baseline.seenAsToast, incoming.seenAsToast, onDisk.seenAsToast),
    archivedAt,
  };
}

/**
 * Baseline-aware three-way merge for notification-history writes across project
 * views (#15534). Every view persists one shared inbox, so a cached view's stale
 * snapshot used to replace entries a sibling added, and revert rows it read,
 * archived or dismissed. Per entry id:
 *
 *   - added by this writer (absent from its baseline) → its entry is written,
 *     unless the disk already holds that id: an entry imported under its
 *     source's id (#15983) or a host broadcast every view hears (#17191) can be
 *     filed by several views, and the disk's copy keeps any read or archive a
 *     sibling gave it. A copy this writer showed as a toast is read either way:
 *     a hidden view's unread copy landing first doesn't undo what the user saw.
 *   - held by the writer and the disk → merged field by field.
 *   - known to the writer but gone from disk → stays gone, even if the writer
 *     edited it since: a sibling dismissed, cleared or pruned it, and a stale
 *     read or archive must not bring it back.
 *   - in the writer's baseline but not its memory → the writer removed it.
 *   - on disk and never known to the writer → a sibling's addition, kept.
 *
 * Snoozes merge per thread through `mergeRecordByWriterDelta`, and a snooze
 * whose thread is left with no active row is dropped. The result is
 * sorted newest first and held to the 200-entry cap. Age retention stays with
 * hydration and the store's own prunes, and never removes a row this writer
 * still holds: an old unread row marked read is expired in memory, and its Undo
 * needs it on disk. Only when both views' additions overflow the cap do rows
 * past retention go first, so unread rows outlast them as in
 * `pruneNotificationEntries`. `clearAll` clears what this view knew; entries a
 * sibling added since are kept.
 */
function mergeNotificationHistoryPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<unknown>): StorageValue<unknown> {
  // No shared value on disk yet → nothing to reconcile against.
  if (!onDisk) return incoming;
  const now = Date.now();
  const base = normalizeNotificationHistory(baseline, now);
  const inc = normalizeNotificationHistory(incoming, now);
  const disk = normalizeNotificationHistory(onDisk, now);

  const merged: NotificationHistoryEntry[] = [];
  for (const [id, entry] of inc.entries) {
    const before = base.entries.get(id);
    const current = disk.entries.get(id);
    if (before === undefined) {
      if (current === undefined) {
        merged.push(entry);
        continue;
      }
      const settled = mergeEntryFields(entry, entry, current);
      merged.push(
        entry.seenAsToast && !settled.seenAsToast ? { ...settled, seenAsToast: true } : settled
      );
      continue;
    }
    if (current !== undefined) merged.push(mergeEntryFields(before, entry, current));
  }
  for (const [id, entry] of disk.entries) {
    if (!inc.entries.has(id) && !base.entries.has(id)) merged.push(entry);
  }
  merged.sort((a, b) => b.timestamp - a.timestamp);

  const capped =
    merged.length > MAX_ENTRIES
      ? merged
          .filter((e) => inc.entries.has(e.id) || !isPastRetention(e, now))
          .slice(0, MAX_ENTRIES)
      : merged;
  // A writer that no longer holds an active row of a thread dropped its snooze
  // by pruning or dismissing, not by unsnoozing: a row a sibling added there
  // since still needs the snooze the sibling's disk copy carries.
  const writerThreads = new Set<string>();
  for (const e of inc.entries.values()) {
    if (e.correlationId && e.archivedAt === null) writerThreads.add(e.correlationId);
  }
  let snoozedThreads = mergeRecordByWriterDelta(
    base.snoozedThreads,
    inc.snoozedThreads,
    disk.snoozedThreads
  );
  for (const [id, until] of Object.entries(disk.snoozedThreads)) {
    if (snoozedThreads[id] !== undefined || writerThreads.has(id)) continue;
    if (!capped.some((e) => e.correlationId === id && e.archivedAt === null)) continue;
    snoozedThreads = { ...snoozedThreads, [id]: until };
  }
  const state: PersistedNotificationHistoryShape = {
    entries: capped,
    // Swept against the rows this write takes off disk: a thread that ends up
    // with none keeps no snooze, and a stale baseline row that disk already
    // lost says nothing about it.
    snoozedThreads: clearSnoozesOfPrunedThreads(snoozedThreads, disk.entries.values(), capped),
  };
  return { version: incoming.version, state };
}

/**
 * Hydration's entries, keeping each one this view holds unchanged as the very
 * object it holds, and the list itself when nothing moved, so a rehydrate that
 * brings nothing new re-renders nothing. The session-only `summarized` flag,
 * which storage never carries back, stays with the rows this view holds, or
 * the next re-entry summary would repeat them.
 */
function keepHeldEntries(
  hydrated: NotificationHistoryEntry[],
  held: NotificationHistoryEntry[]
): NotificationHistoryEntry[] {
  if (held.length === 0) return hydrated;
  const byId = new Map(held.map((e) => [e.id, e]));
  let unchanged = hydrated.length === held.length;
  const entries = hydrated.map((entry, index) => {
    const mine = byId.get(entry.id);
    let kept = entry;
    if (mine !== undefined) {
      if (JSON.stringify(storedForm(mine)) === JSON.stringify(entry)) kept = mine;
      else if (mine.summarized) kept = { ...entry, summarized: true };
    }
    if (kept !== held[index]) unchanged = false;
    return kept;
  });
  return unchanged ? held : entries;
}

/**
 * A held entry as hydration would build it, field for field and in the same
 * order, without the coercions hydration applies: a held value hydration would
 * have dropped or reset then reads as different from what storage gave back.
 */
function storedForm(entry: NotificationHistoryEntry): NotificationHistoryEntry {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    message: entry.message,
    timestamp: entry.timestamp,
    correlationId: entry.correlationId,
    seenAsToast: entry.seenAsToast,
    summarized: false,
    countable: entry.countable,
    archivedAt: entry.archivedAt,
    supersedeKey: entry.supersedeKey,
    context: entry.context,
    actions: entry.actions,
  };
}

function sameRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
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
  /**
   * Per-thread snooze map: `correlationId` → expiry epoch-ms. While a thread
   * is snoozed, its entries are hidden from All/Unread/Archived, do not count
   * toward `unreadCount`, and only surface in the Snoozed tab. The snooze
   * clears automatically (a) when the timestamp passes (via
   * `clearExpiredSnoozes`) or (b) when a `notify()` call with a matching
   * `correlationId` triggers `shouldReToast` (the thread escalated).
   */
  snoozedThreads: Record<string, number>;
  addEntry: (entry: AddEntryInput) => string;
  /**
   * Adds entries that arrive whole, each under the id its source gave it, so
   * the same record arriving twice is one entry: an id already held, read or
   * archived, is skipped, and sibling views merge by id when they persist.
   * They keep their own timestamps and take their place by them, under the
   * same retention and cap as any entry.
   */
  importEntries: (entries: readonly NotificationHistoryEntry[]) => void;
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
  /**
   * Archive's inverse: back to the active inbox, still read. Without it an
   * archive was undoable only by the toast-less `e` never having happened.
   */
  unarchiveEntry: (id: string) => void;
  /** Restores every archived entry in the thread. No-op when nothing matches. */
  unarchiveByCorrelationId: (correlationId: string) => void;
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
  /**
   * Snooze a thread until `snoozedUntil` (epoch ms). Overwrites any prior
   * snooze for the same `correlationId`. Recomputes `unreadCount` so the
   * badge updates atomically with the visibility change.
   */
  snoozeThread: (correlationId: string, snoozedUntil: number) => void;
  /**
   * Remove `correlationId` from the snooze map. No-op when the thread is not
   * snoozed.
   */
  clearSnooze: (correlationId: string) => void;
  /**
   * Drop every snooze whose expiry has passed. Called by the view-lifetime
   * `useNotificationSnoozeExpiry` at each expiry and on wake, and when the
   * inbox opens. Writes nothing when nothing has expired.
   */
  clearExpiredSnoozes: (now?: number) => void;
}

const notificationHistoryStorage = createDebouncedSafeJSONStorage<unknown>(300, {
  mergeOnWrite: mergeNotificationHistoryPersistedWrite,
});

/**
 * Writes the inbox's pending persist now rather than after its debounce, for a
 * caller that must know it reached storage before telling its source so.
 */
export function flushNotificationHistory(): void {
  notificationHistoryStorage.flush(NOTIFICATION_HISTORY_STORAGE_KEY);
}

/**
 * The entry ids the inbox's storage holds, read back from it: what survives a
 * reload, which a write that hit the quota, fell back to memory or was cut by
 * the entry cap doesn't reach.
 */
export function notificationHistoryIdsInStorage(): Set<string> {
  const value = safeJSONParse<unknown>(
    readLocalStorageItemSafely(NOTIFICATION_HISTORY_STORAGE_KEY),
    { store: "notificationHistoryStore", key: NOTIFICATION_HISTORY_STORAGE_KEY },
    null
  );
  const entries: unknown = fieldOf(fieldOf(value, "state"), "entries");
  const ids = new Set<string>();
  if (!Array.isArray(entries)) return ids;
  for (const entry of entries) {
    const id: unknown = fieldOf(entry, "id");
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export const useNotificationHistoryStore = create<NotificationHistoryState>()(
  persist(
    (set, get) => ({
      entries: [],
      unreadCount: 0,
      evictedToInboxCount: 0,
      snoozedThreads: {},
      addEntry: (entry) => {
        const { supersedes, id: requestedId, ...rest } = entry;
        const held =
          requestedId === undefined ? undefined : get().entries.find((e) => e.id === requestedId);
        if (requestedId !== undefined && held !== undefined) {
          // Filed already, here or by a sibling whose write this view took up.
          // A copy shown here as a toast is read, as the write merge settles it.
          if (rest.seenAsToast === true && !held.seenAsToast) get().markIdsRead([requestedId]);
          return requestedId;
        }
        const seenAsToast = rest.seenAsToast ?? false;
        const countable = rest.countable ?? true;
        const newEntry: NotificationHistoryEntry = {
          ...rest,
          seenAsToast,
          summarized: false,
          countable,
          archivedAt: null,
          id: requestedId ?? crypto.randomUUID(),
          timestamp: Date.now(),
        };
        set((state) => {
          // Resolve supersede target inside the same set() so the insert + archive
          // land atomically — observers never see an unread count that omits one
          // change but includes the other.
          let archived: NotificationHistoryEntry | undefined;
          if (supersedes) {
            const target = state.entries.find((e) => e.id === supersedes);
            if (target && !target.archivedAt) archived = target;
          } else if (rest.supersedeKey) {
            archived = state.entries.find(
              (e) => e.supersedeKey === rest.supersedeKey && !e.archivedAt
            );
          }

          const now = Date.now();
          const archiveId = archived?.id;
          const sourceEntries = archiveId
            ? state.entries.map((e) =>
                e.id === archiveId ? { ...e, archivedAt: now, seenAsToast: true } : e
              )
            : state.entries;

          const candidate = [newEntry, ...sourceEntries];
          const updated = pruneNotificationEntries(candidate, now);
          // A superseded entry is archived like any other: a thread it leaves
          // empty mustn't keep its snooze, nor one the 200-entry cap emptied.
          const snoozedThreads = clearSnoozesOfPrunedThreads(
            clearSnoozeIfThreadGone(state.snoozedThreads, updated, archived?.correlationId),
            candidate,
            updated
          );
          return {
            entries: updated,
            snoozedThreads,
            unreadCount: computeUnreadCount(updated, snoozedThreads, now),
          };
        });
        // Every view files a broadcast row, frozen ones too (their IPC runs,
        // their timers wait for the thaw). A copy written on thaw would bring
        // back a row the user dismissed meanwhile, so it's written now.
        if (requestedId !== undefined) flushNotificationHistory();
        return newEntry.id;
      },
      importEntries: (incoming) => {
        const state = get();
        const held = new Set(state.entries.map((e) => e.id));
        const added = incoming.filter((e) => {
          if (held.has(e.id)) return false;
          held.add(e.id);
          return true;
        });
        if (added.length === 0) {
          // Written again all the same: a record handed over twice is most
          // likely one whose entry never reached storage (a full storage drops
          // the pending write), and only a write puts it there.
          set({ entries: state.entries });
          return;
        }
        const now = Date.now();
        const candidate = [...added, ...state.entries].sort((a, b) => b.timestamp - a.timestamp);
        const updated = pruneNotificationEntries(candidate, now);
        const snoozedThreads = clearSnoozesOfPrunedThreads(
          state.snoozedThreads,
          candidate,
          updated
        );
        set({
          entries: updated,
          snoozedThreads,
          unreadCount: computeUnreadCount(updated, snoozedThreads, now),
        });
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
            unreadCount: computeUnreadCount(entries, state.snoozedThreads),
            evictedToInboxCount: options?.silent
              ? state.evictedToInboxCount
              : state.evictedToInboxCount + 1,
          };
        }),
      dismissEntry: (id) =>
        set((state) => {
          const removed = state.entries.find((e) => e.id === id);
          const entries = state.entries.filter((e) => e.id !== id);
          // If dismissing this entry leaves no other entries with the same
          // correlationId, drop the snooze too — otherwise the snoozed-thread
          // map keeps a key with nothing behind it ("ghost snooze") and the
          // Snoozed tab stays visible as an empty chip.
          const snoozedThreads = clearSnoozeIfThreadGone(
            state.snoozedThreads,
            entries,
            removed?.correlationId
          );
          return {
            entries,
            snoozedThreads,
            unreadCount: computeUnreadCount(entries, snoozedThreads),
          };
        }),
      dismissByCorrelationId: (correlationId) =>
        set((state) => {
          const entries = state.entries.filter((e) => e.correlationId !== correlationId);
          // Clearing the thread also clears its snooze — a dismissed thread
          // shouldn't reappear in the Snoozed tab as a ghost row with no
          // entries.
          const snoozedThreads = { ...state.snoozedThreads };
          delete snoozedThreads[correlationId];
          return {
            entries,
            snoozedThreads,
            unreadCount: computeUnreadCount(entries, snoozedThreads),
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
          // If archiving this entry leaves no remaining active entries for
          // its correlationId, clear the snooze so the Snoozed tab doesn't
          // keep an empty ghost row.
          const snoozedThreads = clearSnoozeIfThreadGone(
            state.snoozedThreads,
            entries,
            entry.correlationId
          );
          return {
            entries,
            snoozedThreads,
            unreadCount: computeUnreadCount(entries, snoozedThreads, now),
          };
        }),
      unarchiveEntry: (id) =>
        set((state) => {
          const entry = state.entries.find((e) => e.id === id);
          if (!entry || !entry.archivedAt) return state;
          const entries = state.entries.map((e) => (e.id === id ? { ...e, archivedAt: null } : e));
          return { entries, unreadCount: computeUnreadCount(entries, state.snoozedThreads) };
        }),
      unarchiveByCorrelationId: (correlationId) =>
        set((state) => {
          let mutated = false;
          const entries = state.entries.map((e) => {
            if (e.correlationId === correlationId && e.archivedAt) {
              mutated = true;
              return { ...e, archivedAt: null };
            }
            return e;
          });
          if (!mutated) return state;
          return { entries, unreadCount: computeUnreadCount(entries, state.snoozedThreads) };
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
          // Archiving the whole thread also clears its snooze — the user has
          // resolved it, so it shouldn't surface again at the snooze expiry.
          const snoozedThreads = state.snoozedThreads[correlationId]
            ? (() => {
                const next = { ...state.snoozedThreads };
                delete next[correlationId];
                return next;
              })()
            : state.snoozedThreads;
          return {
            entries,
            snoozedThreads,
            unreadCount: computeUnreadCount(entries, snoozedThreads, now),
          };
        }),
      clearAll: () =>
        set({ entries: [], unreadCount: 0, evictedToInboxCount: 0, snoozedThreads: {} }),
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
            unreadCount: computeUnreadCount(entries, state.snoozedThreads),
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
          const snoozedThreads = clearSnoozesOfPrunedThreads(
            state.snoozedThreads,
            state.entries,
            filtered
          );
          return {
            entries: filtered,
            snoozedThreads,
            unreadCount: computeUnreadCount(filtered, snoozedThreads, now),
          };
        }),
      snoozeThread: (correlationId, snoozedUntil) => {
        if (!correlationId || !Number.isFinite(snoozedUntil)) return;
        set((state) => {
          if (state.snoozedThreads[correlationId] === snoozedUntil) return state;
          const snoozedThreads = { ...state.snoozedThreads, [correlationId]: snoozedUntil };
          return {
            snoozedThreads,
            unreadCount: computeUnreadCount(state.entries, snoozedThreads),
          };
        });
      },
      clearSnooze: (correlationId) => {
        if (!correlationId) return;
        set((state) => {
          if (state.snoozedThreads[correlationId] === undefined) return state;
          const snoozedThreads = { ...state.snoozedThreads };
          delete snoozedThreads[correlationId];
          return {
            snoozedThreads,
            unreadCount: computeUnreadCount(state.entries, snoozedThreads),
          };
        });
      },
      clearExpiredSnoozes: (now = Date.now()) => {
        // Persist queues a storage write on every `set`, even one that returns
        // the same state, and this runs on each window focus.
        if (!Object.values(get().snoozedThreads).some((until) => until <= now)) return;
        set((state) => {
          let mutated = false;
          const next: Record<string, number> = {};
          for (const [key, value] of Object.entries(state.snoozedThreads)) {
            if (value > now) {
              next[key] = value;
            } else {
              mutated = true;
            }
          }
          if (!mutated) return state;
          return {
            snoozedThreads: next,
            unreadCount: computeUnreadCount(state.entries, next, now),
          };
        });
      },
    }),
    {
      name: NOTIFICATION_HISTORY_STORAGE_KEY,
      version: NOTIFICATION_HISTORY_PERSIST_VERSION,
      // Storage is `unknown` instead of `PersistedNotificationHistoryShape`
      // because `migrate` can return a pre-v2 blob shape; the persist
      // middleware then funnels that through `merge`, which does its own
      // defensive coercion.
      storage: notificationHistoryStorage,
      // Only persist entries + snoozedThreads — unreadCount is recomputed on
      // hydration, and evictedToInboxCount is a session-only discoverability
      // counter that resets to 0 on every fresh load.
      partialize: (state): PersistedNotificationHistoryShape => ({
        entries: state.entries,
        snoozedThreads: state.snoozedThreads,
      }),
      // v1 → v2 adds `snoozedThreads` (per-thread snooze map, #9200). The
      // entries shape is unchanged, so v1 blobs are otherwise valid; default
      // the new field to an empty map and let `merge` finish the work.
      migrate: (persistedState, version) => {
        if (version < 2) {
          const prev =
            persistedState && typeof persistedState === "object"
              ? (persistedState as Record<string, unknown>)
              : {};
          return { ...prev, snoozedThreads: {} };
        }
        return persistedState;
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<PersistedNotificationHistoryShape> | undefined;
        const rawEntries = Array.isArray(p?.entries) ? p.entries : [];
        const now = Date.now();
        const sanitized = rawEntries
          .map((raw) => sanitizePersistedEntry(raw, now))
          .filter((e): e is NotificationHistoryEntry => e !== null);
        // A rehydrate mid-session spares the rows this view holds from age
        // retention, as its writes do: an old row just marked read still has
        // an Undo to answer, and the store's own prune retires it later.
        const pruned = pruneNotificationEntries(
          sanitized,
          now,
          new Set(current.entries.map((e) => e.id))
        );
        const snoozedThreads = clearSnoozesOfPrunedThreads(
          sanitizeSnoozedThreads(p?.snoozedThreads, now),
          sanitized,
          pruned
        );
        const entries = keepHeldEntries(pruned, current.entries);
        return {
          ...current,
          entries,
          snoozedThreads: sameRecord(current.snoozedThreads, snoozedThreads)
            ? current.snoozedThreads
            : snoozedThreads,
          unreadCount: computeUnreadCount(entries, snoozedThreads, now),
        };
      },
    }
  )
);

/**
 * Takes up what sibling project views wrote to the shared inbox: their reads,
 * archives, dismissals, snoozes and new rows. A write of this view's own still
 * in its debounce lands first, through the same merge.
 */
export function syncNotificationHistoryFromStorage(): void {
  void useNotificationHistoryStore.persist.rehydrate();
}

// A persist store hydrates once per view, so a cached view kept the badge and
// rows it loaded until it reloaded. Views share the storage partition, so a
// sibling's write arrives as a `storage` event; a view frozen while it landed
// catches up when it's activated again, before its reveal and on it.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event) => {
    if (event.key !== NOTIFICATION_HISTORY_STORAGE_KEY) return;
    syncNotificationHistoryFromStorage();
  });
  window.electron?.app?.onViewWarmActivated?.(() => syncNotificationHistoryFromStorage());
  window.electron?.app?.onViewRevealed?.(() => syncNotificationHistoryFromStorage());
}

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
