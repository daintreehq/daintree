// eager-import-allow: reads/writes agent session history via sync fs
import { readFileSync, statSync } from "fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  resilientAtomicWriteFile,
  resilientRename,
  resilientRenameSync,
  tightenDirPermissions,
  OWNER_RW_FILE_MODE,
  OWNER_RWX_DIR_MODE,
} from "../../utils/fs.js";
import type {
  AgentSessionRecord,
  AgentSessionRetentionDays,
} from "../../../shared/types/ipc/agentSessionHistory.js";
import { rebaseAbsolutePath } from "../../../shared/utils/projectPathRelocation.js";

export type { AgentSessionRecord };

const MAX_RECORDS_PER_WORKTREE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const SESSION_HISTORY_TTL_MS = DEFAULT_RETENTION_DAYS * DAY_MS; // 30 days

export { MAX_RECORDS_PER_WORKTREE, SESSION_HISTORY_TTL_MS, DEFAULT_RETENTION_DAYS };

const HISTORY_FILENAME = "agent-session-history.json";

/**
 * Convert a retention window in days to the eviction TTL in ms. `0` (keep
 * forever) maps to `Infinity` so the age filter never drops a record — the
 * per-worktree cap is the only remaining bound. This module stays
 * electron-free: retention arrives as a plain number from the caller (read from
 * the store at the IPC/call-site layer), never read here.
 */
function retentionDaysToMs(retentionDays?: AgentSessionRetentionDays): number {
  if (retentionDays === undefined) return SESSION_HISTORY_TTL_MS;
  return retentionDays > 0 ? retentionDays * DAY_MS : Infinity;
}

function getUserDataDir(): string | null {
  return process.env.DAINTREE_USER_DATA || null;
}

export function getSessionHistoryPath(userData?: string): string | null {
  const dir = userData || getUserDataDir();
  if (!dir) return null;
  return path.join(dir, HISTORY_FILENAME);
}

// Serialize all read-modify-write cycles through a single promise chain. Every
// terminal close path can call persistAgentSession (trash expiry, IPC kill /
// gracefulKill, app quit), and during app quit several fire near-simultaneously.
// Without serialization the read-then-write would lost-update — two callers read
// the same array, each prepends its own record, and the last write drops the
// other. Chaining keeps every record. `.then(fn, fn)` runs the next write whether
// the previous resolved or rejected, so one failure can't wedge the queue.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.catch(() => {});
  return run as Promise<T>;
}

function evictRecords(
  records: AgentSessionRecord[],
  now: number,
  retentionMs: number = SESSION_HISTORY_TTL_MS
): AgentSessionRecord[] {
  // Filter expired records (retentionMs === Infinity ⇒ never age out)
  const fresh = records.filter((r) => now - r.savedAt < retentionMs);

  // Deduplicate on sessionId, keeping the newest. Multiple close paths can fire
  // for the same terminal (e.g. a user kill landing mid-shutdown), each writing
  // a record with the same resumable sessionId — without this the journal would
  // accumulate stale duplicates. Records arrive newest-first, so the first
  // occurrence of each sessionId wins.
  const seen = new Set<string>();
  const deduped: AgentSessionRecord[] = [];
  for (const r of fresh) {
    if (r.sessionId) {
      if (seen.has(r.sessionId)) continue;
      seen.add(r.sessionId);
    }
    deduped.push(r);
  }

  // Enforce per-worktree cap
  const buckets = new Map<string, AgentSessionRecord[]>();
  for (const r of deduped) {
    const key = r.worktreeId ?? "__global__";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(r);
  }

  const result: AgentSessionRecord[] = [];
  for (const bucket of buckets.values()) {
    // Records are ordered newest-first (prepended on write), so slice keeps the most recent
    result.push(...bucket.slice(0, MAX_RECORDS_PER_WORKTREE));
  }

  // Maintain newest-first global order
  result.sort((a, b) => b.savedAt - a.savedAt);
  return result;
}

/**
 * Thrown by {@link normalizeRecords} when a readable, well-formed JSON document
 * has a root that is not an array (e.g. `{}` or `null`). This is proven content
 * corruption — bytes that can never yield records — so it routes through the
 * same quarantine path as a `JSON.parse` `SyntaxError`, and is deliberately
 * distinct from a transient filesystem error (EACCES/EIO/EMFILE), which must
 * never trigger quarantine or an overwrite. Mirrors `GlobalFileStore.getRecipes`
 * throwing on a non-array root rather than silently degrading to `[]`.
 */
class InvalidSessionHistoryShapeError extends Error {
  constructor() {
    super("session history root is not an array");
    this.name = "InvalidSessionHistoryShapeError";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Proven corruption: a readable file whose bytes can never be valid journal
 * content — malformed JSON (`SyntaxError`) or a well-formed non-array root. Only
 * these are quarantined and treated as a fresh-but-empty journal. Every other
 * read failure (EACCES/EIO/EMFILE/EBUSY/…) is transient/unknown: the file may be
 * intact but temporarily unreadable, so it must NOT be quarantined or overwritten.
 */
function isCorruptionError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof InvalidSessionHistoryShapeError;
}

/**
 * Normalize parsed journal JSON into records, dropping the legacy `snapshot`
 * key. The exit-snapshot feature (#10850/#10855) was removed; journals written
 * while it was enabled still carry a `snapshot` tail on disk. Stripping it on
 * read means no consumer can resurface removed data — notably the MCP
 * `agentSessionHistory.list` action, whose raw result is serialized without
 * `resultSchema` parsing — and the next `persistAgentSession`/`pruneAgentSessions`
 * rewrite purges it from disk, so the file self-heals without a versioned migration.
 *
 * Throws {@link InvalidSessionHistoryShapeError} on a non-array root so the
 * caller can quarantine the corrupt file instead of silently overwriting it.
 */
function normalizeRecords(parsed: unknown): AgentSessionRecord[] {
  if (!Array.isArray(parsed)) {
    throw new InvalidSessionHistoryShapeError();
  }
  return parsed.map((raw) => {
    if (raw && typeof raw === "object" && "snapshot" in raw) {
      const { snapshot: _snapshot, ...rest } = raw as Record<string, unknown>;
      return rest as unknown as AgentSessionRecord;
    }
    return raw as AgentSessionRecord;
  });
}

// In-memory cache of the parsed journal, keyed by resolved file path. The resume
// palette calls listAgentSessions() -> readSessionHistorySync() on every open,
// which otherwise re-reads and re-parses the whole journal (up to 50 records per
// worktree) each time. The cache is gated on the file's stat (size + mtimeMs) so
// a direct on-disk change (or a write from any other path) is still picked up on
// the next read; every writer refreshes it with the array it just persisted.
// Memory-only — rebuilt from disk on first read after boot, no cross-process
// coordination needed (all journal I/O runs on the single main-process loop).
interface HistoryCacheEntry {
  records: AgentSessionRecord[];
  size: number;
  mtimeMs: number;
}
const historyCache = new Map<string, HistoryCacheEntry>();

function readCache(
  filePath: string,
  size: number,
  mtimeMs: number
): AgentSessionRecord[] | undefined {
  const entry = historyCache.get(filePath);
  if (entry && entry.size === size && entry.mtimeMs === mtimeMs) {
    return entry.records;
  }
  return undefined;
}

function writeCache(
  filePath: string,
  records: AgentSessionRecord[],
  size: number,
  mtimeMs: number
): void {
  historyCache.set(filePath, { records, size, mtimeMs });
}

// Refresh the cache after a write with the exact array just persisted, keyed to
// the freshly-written file's stat so the next read is a cache hit. If the stat
// fails, drop the entry so the next read falls back to a disk re-read.
function refreshCacheAfterWrite(filePath: string, records: AgentSessionRecord[]): void {
  try {
    const s = statSync(filePath);
    writeCache(filePath, records, s.size, s.mtimeMs);
  } catch {
    historyCache.delete(filePath);
  }
}

/**
 * Tri-state read outcome (per #11348 / lesson #11130 — an ambiguous read must
 * never be treated as "safe to overwrite"):
 * - `ok` with `records` — the journal was read (or is genuinely absent, or was
 *   corrupt-and-successfully-quarantined). Safe to treat as ground truth.
 * - `unreadable` — the file exists but could not be read (transient fs error,
 *   or an unrecoverable failed quarantine). A read-modify-write MUST abort on
 *   this rather than overwrite the still-present on-disk records with `[]`.
 */
type SessionHistoryReadResult =
  { status: "ok"; records: AgentSessionRecord[] } | { status: "unreadable"; error: unknown };

/**
 * Best-effort archive of a corrupt journal to a timestamped sidecar, matching
 * the sibling stores (`GlobalFileStore`/`ProjectFileStore`). Returns whether the
 * rename succeeded: a FAILED quarantine must be surfaced as `unreadable` (never
 * "empty and safe to overwrite"), so the caller preserves the corrupt bytes for
 * a later retry instead of clobbering the file we failed to move aside.
 */
async function quarantineCorruptJournal(filePath: string, error: unknown): Promise<boolean> {
  console.error("[agentSessionHistory] Corrupt session journal:", error);
  try {
    const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
    await resilientRename(filePath, quarantinePath);
    console.warn(`[agentSessionHistory] Corrupted session journal moved to ${quarantinePath}`);
    return true;
  } catch (renameError) {
    console.error(
      "[agentSessionHistory] Failed to quarantine corrupt session journal:",
      renameError
    );
    return false;
  }
}

function quarantineCorruptJournalSync(filePath: string, error: unknown): boolean {
  console.error("[agentSessionHistory] Corrupt session journal:", error);
  try {
    const quarantinePath = `${filePath}.corrupted.${Date.now()}`;
    resilientRenameSync(filePath, quarantinePath);
    console.warn(`[agentSessionHistory] Corrupted session journal moved to ${quarantinePath}`);
    return true;
  } catch (renameError) {
    console.error(
      "[agentSessionHistory] Failed to quarantine corrupt session journal:",
      renameError
    );
    return false;
  }
}

/**
 * The error a read-modify-write raises when it refuses to overwrite a journal it
 * could not read. Rejecting (rather than silently resolving) is load-bearing:
 * `journalAgentSession` treats a resolved `persistAgentSession` as a completed
 * write — it emits `agent-session:recorded` and consumes the lifecycle ledger's
 * exactly-once reservation. A silent abort would fire that event and burn the
 * reservation despite writing nothing, blocking any retry. Rejection instead
 * rescinds the reservation and suppresses the event, so a later capture retries.
 */
function unreadableJournalError(error: unknown): Error {
  return new Error(
    "Refusing to overwrite the agent session journal: it exists but could not be read " +
      "(transient filesystem error or unrecoverable quarantine); preserving on-disk records",
    { cause: error }
  );
}

// NOTE: on a cache hit these readers return the cached array BY REFERENCE (that
// shared-instance reuse is the whole point — a copy on every read would defeat
// the cache). Callers MUST treat the result as read-only; never sort/push/splice
// it in place. The production caller, listAgentSessions(), is safe: evictRecords()
// only reads the input and returns freshly-built arrays.
function readSessionHistoryResultSync(userData?: string): SessionHistoryReadResult {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return { status: "ok", records: [] };
  try {
    const s = statSync(filePath);
    const cached = readCache(filePath, s.size, s.mtimeMs);
    if (cached) return { status: "ok", records: cached };
    const content = readFileSync(filePath, "utf8");
    const records = normalizeRecords(JSON.parse(content));
    writeCache(filePath, records, s.size, s.mtimeMs);
    return { status: "ok", records };
  } catch (error) {
    // Never let a failed read leave a `[]` cached as if it were the journal.
    historyCache.delete(filePath);
    if (isMissingPathError(error)) return { status: "ok", records: [] };
    if (isCorruptionError(error)) {
      return quarantineCorruptJournalSync(filePath, error)
        ? { status: "ok", records: [] }
        : { status: "unreadable", error };
    }
    console.warn("[agentSessionHistory] Failed to read session journal:", error);
    return { status: "unreadable", error };
  }
}

async function readSessionHistoryResult(userData?: string): Promise<SessionHistoryReadResult> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return { status: "ok", records: [] };
  try {
    const s = await stat(filePath);
    const cached = readCache(filePath, s.size, s.mtimeMs);
    if (cached) return { status: "ok", records: cached };
    const content = await readFile(filePath, "utf8");
    const records = normalizeRecords(JSON.parse(content));
    writeCache(filePath, records, s.size, s.mtimeMs);
    return { status: "ok", records };
  } catch (error) {
    historyCache.delete(filePath);
    if (isMissingPathError(error)) return { status: "ok", records: [] };
    if (isCorruptionError(error)) {
      return (await quarantineCorruptJournal(filePath, error))
        ? { status: "ok", records: [] }
        : { status: "unreadable", error };
    }
    console.warn("[agentSessionHistory] Failed to read session journal:", error);
    return { status: "unreadable", error };
  }
}

// Read-only consumers (listAgentSessions and the MCP list action) collapse an
// unreadable journal to `[]` — a transient failure degrades the displayed list
// for one read without touching disk. The `unreadable` outcome is never cached,
// so the next read re-attempts the file. The read-modify-write paths use
// readSessionHistoryResult directly and ABORT on `unreadable`.
export function readSessionHistorySync(userData?: string): AgentSessionRecord[] {
  const result = readSessionHistoryResultSync(userData);
  return result.status === "ok" ? result.records : [];
}

export async function readSessionHistory(userData?: string): Promise<AgentSessionRecord[]> {
  const result = await readSessionHistoryResult(userData);
  return result.status === "ok" ? result.records : [];
}

export async function persistAgentSession(
  record: Omit<AgentSessionRecord, "savedAt">,
  userData?: string,
  retentionDays?: AgentSessionRetentionDays
): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return;

  await enqueueWrite(async () => {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true, mode: OWNER_RWX_DIR_MODE });
    await tightenDirPermissions(dir);

    const now = Date.now();
    const fullRecord: AgentSessionRecord = { ...record, savedAt: now };

    const existing = await readSessionHistoryResult(userData);
    if (existing.status === "unreadable") {
      // The journal exists but couldn't be read — overwriting now would destroy
      // the on-disk records. Abort so a later capture retries once it's readable.
      throw unreadableJournalError(existing.error);
    }
    const updated = evictRecords(
      [fullRecord, ...existing.records],
      now,
      retentionDaysToMs(retentionDays)
    );

    await resilientAtomicWriteFile(filePath, JSON.stringify(updated, null, 2), "utf-8", {
      mode: OWNER_RW_FILE_MODE,
    });
    refreshCacheAfterWrite(filePath, updated);
  });
}

export function listAgentSessions(
  worktreeId?: string,
  userData?: string,
  retentionDays?: AgentSessionRetentionDays
): AgentSessionRecord[] {
  const records = readSessionHistorySync(userData);
  const now = Date.now();
  const fresh = evictRecords(records, now, retentionDaysToMs(retentionDays));

  if (!worktreeId) return fresh;
  return fresh.filter((r) => r.worktreeId === worktreeId);
}

/**
 * Prune the journal to the given retention window immediately, rewriting the
 * file through the shared write queue so it can't interleave with an in-flight
 * persist. Used when the user shortens the retention setting — mirrors
 * `helpAssistant`'s `pruneAuditByRetention` so a tighter privacy window takes
 * effect at once rather than lazily on the next persist/list.
 */
export async function pruneAgentSessions(
  retentionDays: AgentSessionRetentionDays,
  userData?: string
): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return;

  await enqueueWrite(async () => {
    const existing = await readSessionHistoryResult(userData);
    if (existing.status === "unreadable") {
      // Don't prune to `[]` over a journal we couldn't read; abort and retry later.
      throw unreadableJournalError(existing.error);
    }
    const pruned = evictRecords(existing.records, Date.now(), retentionDaysToMs(retentionDays));
    await resilientAtomicWriteFile(filePath, JSON.stringify(pruned, null, 2), "utf-8", {
      mode: OWNER_RW_FILE_MODE,
    });
    refreshCacheAfterWrite(filePath, pruned);
  });
}

/**
 * Rebase the absolute `worktreeId` and `cwd` of one project's records after a
 * folder move/rename (#11282, phase 2), so a relocated project's captured agent
 * sessions stay grouped under the moved worktrees and resume in the right place.
 * Only records whose non-null `projectId` matches are touched — legacy
 * `projectId: null` records are left alone rather than guessing their owner.
 * Shares the write queue so it can't interleave with an in-flight persist, and
 * skips the disk write entirely when nothing changed.
 */
export async function rewriteAgentSessionPathsForProject(
  projectId: string,
  oldRoot: string,
  newRoot: string,
  userData?: string
): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath || !projectId || !oldRoot || !newRoot || oldRoot === newRoot) return;

  await enqueueWrite(async () => {
    const existing = await readSessionHistoryResult(userData);
    if (existing.status === "unreadable") {
      // Rebasing an unreadable journal would rewrite it from `[]`; abort instead.
      throw unreadableJournalError(existing.error);
    }
    let changed = false;
    const rewritten = existing.records.map((r) => {
      if (r.projectId !== projectId) return r;
      const nextWorktreeId =
        r.worktreeId !== null ? rebaseAbsolutePath(r.worktreeId, oldRoot, newRoot) : r.worktreeId;
      const nextCwd = r.cwd !== undefined ? rebaseAbsolutePath(r.cwd, oldRoot, newRoot) : r.cwd;
      if (nextWorktreeId === r.worktreeId && nextCwd === r.cwd) return r;
      changed = true;
      return { ...r, worktreeId: nextWorktreeId, cwd: nextCwd };
    });
    if (!changed) return;
    await resilientAtomicWriteFile(filePath, JSON.stringify(rewritten, null, 2), "utf-8", {
      mode: OWNER_RW_FILE_MODE,
    });
    refreshCacheAfterWrite(filePath, rewritten);
  });
}

export async function clearAgentSessions(worktreeId?: string, userData?: string): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return;

  // Share the write queue with persistAgentSession so a clear can't interleave
  // with an in-flight persist's read-modify-write and resurrect a cleared record.
  await enqueueWrite(async () => {
    if (!worktreeId) {
      // Clear all
      await resilientAtomicWriteFile(filePath, "[]", "utf-8", { mode: OWNER_RW_FILE_MODE });
      refreshCacheAfterWrite(filePath, []);
      return;
    }

    const existing = await readSessionHistoryResult(userData);
    if (existing.status === "unreadable") {
      // Clearing one worktree must not wipe every other worktree's records when
      // the read fails; abort so the untouched journal survives.
      throw unreadableJournalError(existing.error);
    }
    const filtered = existing.records.filter((r) => r.worktreeId !== worktreeId);
    await resilientAtomicWriteFile(filePath, JSON.stringify(filtered, null, 2), "utf-8", {
      mode: OWNER_RW_FILE_MODE,
    });
    refreshCacheAfterWrite(filePath, filtered);
  });
}
