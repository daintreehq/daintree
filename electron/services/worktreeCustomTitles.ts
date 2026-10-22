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
 * No in-memory copy: reads happen when a plugin reads worktrees, and writes on
 * a rename.
 */
const STORE_KEY = "worktreeCustomTitles";

/** Worktree ids are absolute paths; nothing longer is one. */
const MAX_WORKTREE_ID_LENGTH = 4096;

export interface StoredWorktreeCustomTitles {
  /** Worktree id → title, normalised. */
  titles: Record<string, string>;
  /**
   * Bumped on every write and kept on disk, so it only ever grows. A view drops
   * any snapshot older than one it already holds: pushes and invoke replies
   * reach a remote view on separate lanes.
   */
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

/** Only titles that still normalise to something within the limit: the file is user-editable. */
function parseTitles(value: unknown): Record<string, string> {
  // Null prototype: the keys are worktree ids read from a user-editable file.
  const titles = Object.create(null) as Record<string, string>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return titles;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isWorktreeId(id) || typeof raw !== "string") continue;
    const title = normalizeWorktreeCustomTitle(raw);
    if (title && !isWorktreeCustomTitleTooLong(title)) titles[id] = title;
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

/** `undefined` when the workspace has no entry yet, which is what lets a legacy hand-over land. */
function rawEntry(all: Record<string, unknown>, workspaceId: string): unknown {
  return Object.hasOwn(all, workspaceId) ? all[workspaceId] : undefined;
}

function parseEntry(entry: unknown): StoredWorktreeCustomTitles {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { titles: parseTitles(undefined), revision: 0 };
  }
  const raw = entry as Record<string, unknown>;
  return { titles: parseTitles(raw.titles), revision: parseRevision(raw.revision) };
}

/**
 * Write one workspace's entry back, one revision on. Whole-key rewrite:
 * electron-store dot-notation would nest on a key containing dots.
 */
function writeEntry(
  all: Record<string, unknown>,
  workspaceId: string,
  titles: Record<string, string>
): StoredWorktreeCustomTitles {
  const revision = parseEntry(rawEntry(all, workspaceId)).revision + 1;
  store.set(STORE_KEY, { ...all, [workspaceId]: { titles: { ...titles }, revision } });
  return { titles, revision };
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

/** One workspace's stored titles; empty with revision 0 before anything was stored. */
export function getWorktreeCustomTitles(workspaceId: string): StoredWorktreeCustomTitles {
  return parseEntry(rawEntry(readAll(), workspaceId));
}

/**
 * Hand over the titles a view kept in localStorage before main held them. Only
 * the first hand-over for a workspace lands: every view of it shares one
 * localStorage copy, so once the entry exists a later one is either the same
 * titles or older than what main has been told since — a title cleared here
 * must not come back from it. Check and write share one synchronous turn, so
 * two views handing over at once can't both land.
 */
export function importLegacyWorktreeCustomTitles(
  workspaceId: string,
  legacy: unknown
): StoredWorktreeCustomTitles {
  assertWorkspaceId(workspaceId);
  const all = readAll();
  const existing = rawEntry(all, workspaceId);
  if (existing !== undefined) return parseEntry(existing);
  const titles = parseTitles(legacy);
  const stored = writeEntry(all, workspaceId, titles);
  if (Object.keys(titles).length > 0) notify(workspaceId);
  return stored;
}

/**
 * Set one worktree's title, or with `null` or a blank title clear it. An
 * unchanged title writes nothing, so it neither bumps the revision nor wakes
 * a plugin.
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
  const current = parseEntry(rawEntry(all, workspaceId));
  const held = Object.hasOwn(current.titles, worktreeId) ? current.titles[worktreeId] : undefined;
  if (next ? held === next : held === undefined) return current;
  const titles = Object.assign(Object.create(null) as Record<string, string>, current.titles);
  if (next) {
    titles[worktreeId] = next;
  } else {
    delete titles[worktreeId];
  }
  const stored = writeEntry(all, workspaceId, titles);
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
