// eager-import-allow: reads custom titles via store.get with revisioned updates so title replies and plugin snapshots see the latest saved titles
import { store } from "../store.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../shared/utils/workspaceIds.js";
import {
  WORKTREE_CUSTOM_TITLE_MAX_LENGTH,
  isWorktreeCustomTitleTooLong,
  normalizeWorktreeCustomTitle,
} from "../../shared/utils/worktreeCustomTitle.js";

/**
 * Each workspace's custom worktree titles (#14022), in Daintree's own store and
 * never in the repository. Main holds them so the worktree snapshots plugins
 * read carry the title the user sees; each view keeps a copy it adopts from
 * here.
 *
 * A cleared title is kept as `null` rather than dropped. Views hand over the
 * titles they kept in localStorage before main held them, and a hand-over only
 * fills worktrees main has no record of — so a title cleared here never comes
 * back from a stale copy, while a worktree nobody has touched since still
 * takes its old title, whichever view or window wrote first.
 *
 * No in-memory copy: reads happen when a plugin reads worktrees, and writes on
 * a rename.
 */
const STORE_KEY = "worktreeCustomTitles";

/** Worktree ids are absolute paths; nothing longer is one. */
const MAX_WORKTREE_ID_LENGTH = 4096;

export interface StoredWorktreeCustomTitles {
  /** Worktree id → title, normalised. Cleared titles are left out. */
  titles: Record<string, string>;
  /**
   * Bumped on every write and kept on disk, so it only ever grows. A view drops
   * any snapshot older than one it already holds: pushes and invoke replies
   * reach a remote view on separate lanes.
   */
  revision: number;
}

/** Worktree id → title, or `null` once the user cleared it. */
type RecordedTitles = Record<string, string | null>;

interface RecordedEntry {
  recorded: RecordedTitles;
  revision: number;
}

type ChangeListener = (workspaceId: string) => void;

const listeners = new Set<ChangeListener>();

function isWorkspaceId(id: string): boolean {
  return isProjectWorkspaceId(id) || isScratchWorkspaceId(id);
}

function assertWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !isWorkspaceId(workspaceId)) {
    throw new Error("worktree titles: projectId must be a workspace id");
  }
}

function isWorktreeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_WORKTREE_ID_LENGTH;
}

function parseRevision(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function parseTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = normalizeWorktreeCustomTitle(raw);
  return title && !isWorktreeCustomTitleTooLong(title) ? title : null;
}

/**
 * Only titles that still normalise to something within the limit, plus the
 * `null` of a cleared one: the file is user-editable.
 */
function parseRecorded(value: unknown): RecordedTitles {
  // Null prototype: the keys are worktree ids read from a user-editable file.
  const recorded = Object.create(null) as RecordedTitles;
  if (!value || typeof value !== "object" || Array.isArray(value)) return recorded;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorktreeId(id)) continue;
    if (raw === null) {
      recorded[id] = null;
      continue;
    }
    const title = parseTitle(raw);
    if (title !== null) recorded[id] = title;
  }
  return recorded;
}

function visibleTitles(recorded: RecordedTitles): Record<string, string> {
  const titles = Object.create(null) as Record<string, string>;
  for (const [id, title] of Object.entries(recorded)) {
    if (title !== null) titles[id] = title;
  }
  return titles;
}

/**
 * Throws when the store cannot be read. Unreadable is not "no titles": writing
 * from a map we could not read would delete every other workspace's titles.
 */
function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

function readEntry(all: Record<string, unknown>, workspaceId: string): RecordedEntry {
  const entry = Object.hasOwn(all, workspaceId) ? all[workspaceId] : undefined;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { recorded: parseRecorded(undefined), revision: 0 };
  }
  const raw = entry as Record<string, unknown>;
  return { recorded: parseRecorded(raw.titles), revision: parseRevision(raw.revision) };
}

function toStored(entry: RecordedEntry): StoredWorktreeCustomTitles {
  return { titles: visibleTitles(entry.recorded), revision: entry.revision };
}

/**
 * Write one workspace's entry back, one revision on. Whole-key rewrite:
 * electron-store dot-notation would nest on a key containing dots.
 */
function writeEntry(
  all: Record<string, unknown>,
  workspaceId: string,
  entry: RecordedEntry
): StoredWorktreeCustomTitles {
  const next: RecordedEntry = { recorded: entry.recorded, revision: entry.revision + 1 };
  store.set(STORE_KEY, {
    ...all,
    [workspaceId]: { titles: { ...next.recorded }, revision: next.revision },
  });
  return toStored(next);
}

function notify(workspaceId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(workspaceId);
    } catch (error) {
      console.error("[worktreeCustomTitles] Change listener failed:", error);
    }
  }
}

/** One workspace's titles; empty with revision 0 before anything was stored. */
export function getWorktreeCustomTitles(workspaceId: string): StoredWorktreeCustomTitles {
  return toStored(readEntry(readAll(), workspaceId));
}

/**
 * Hand over the titles a view kept in localStorage before main held them. Each
 * lands only for a worktree main has no record of, set or cleared, so a newer
 * title or a clear made here wins over the copy. Check and write share one
 * synchronous turn, so two views handing over at once can't both land one.
 */
export function importLegacyWorktreeCustomTitles(
  workspaceId: string,
  legacy: unknown
): StoredWorktreeCustomTitles {
  assertWorkspaceId(workspaceId);
  const all = readAll();
  const entry = readEntry(all, workspaceId);
  let landed = false;
  for (const [id, title] of Object.entries(visibleTitles(parseRecorded(legacy)))) {
    if (Object.hasOwn(entry.recorded, id)) continue;
    entry.recorded[id] = title;
    landed = true;
  }
  if (!landed) return toStored(entry);
  const stored = writeEntry(all, workspaceId, entry);
  notify(workspaceId);
  return stored;
}

/**
 * Set one worktree's title, or with `null` or a blank title clear it. An
 * unchanged title, or a clear of none, writes nothing, so it neither bumps the
 * revision nor wakes a plugin.
 */
export function setWorktreeCustomTitle(
  workspaceId: string,
  worktreeId: string,
  title: string | null
): StoredWorktreeCustomTitles {
  assertWorkspaceId(workspaceId);
  if (!isWorktreeId(worktreeId)) {
    throw new Error("worktree titles: worktreeId must be a worktree id");
  }
  if (title !== null && typeof title !== "string") {
    throw new Error("worktree titles: title must be a string or null");
  }
  const next = title === null ? "" : normalizeWorktreeCustomTitle(title);
  if (isWorktreeCustomTitleTooLong(next)) {
    throw new Error(
      `worktree titles: title is longer than ${WORKTREE_CUSTOM_TITLE_MAX_LENGTH} characters`
    );
  }
  const all = readAll();
  const entry = readEntry(all, workspaceId);
  const held = Object.hasOwn(entry.recorded, worktreeId) ? entry.recorded[worktreeId] : undefined;
  if (next ? held === next : typeof held !== "string") return toStored(entry);
  entry.recorded[worktreeId] = next || null;
  const stored = writeEntry(all, workspaceId, entry);
  notify(workspaceId);
  return stored;
}

/** Clear several worktrees' titles in one write, as a prune of removed worktrees does. */
export function clearWorktreeCustomTitles(
  workspaceId: string,
  worktreeIds: readonly string[]
): StoredWorktreeCustomTitles {
  assertWorkspaceId(workspaceId);
  const all = readAll();
  const entry = readEntry(all, workspaceId);
  let cleared = false;
  for (const id of worktreeIds) {
    if (!isWorktreeId(id) || !Object.hasOwn(entry.recorded, id)) continue;
    if (typeof entry.recorded[id] !== "string") continue;
    entry.recorded[id] = null;
    cleared = true;
  }
  if (!cleared) return toStored(entry);
  const stored = writeEntry(all, workspaceId, entry);
  notify(workspaceId);
  return stored;
}

/** Called with the workspace id after every write that changed a title. */
export function onWorktreeCustomTitlesChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
