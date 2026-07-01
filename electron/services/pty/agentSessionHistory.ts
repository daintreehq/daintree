// eager-import-allow: reads/writes agent session history via sync fs
import { readFileSync } from "fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resilientAtomicWriteFile } from "../../utils/fs.js";
import type { AgentSessionRecord } from "../../../shared/types/ipc/agentSessionHistory.js";

export type { AgentSessionRecord };

const MAX_RECORDS_PER_WORKTREE = 50;
const SESSION_HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HISTORY_FILENAME = "agent-session-history.json";

export { MAX_RECORDS_PER_WORKTREE, SESSION_HISTORY_TTL_MS };

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

function evictRecords(records: AgentSessionRecord[], now: number): AgentSessionRecord[] {
  // Filter expired records
  const fresh = records.filter((r) => now - r.savedAt < SESSION_HISTORY_TTL_MS);

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

export function readSessionHistorySync(userData?: string): AgentSessionRecord[] {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as AgentSessionRecord[];
  } catch {
    return [];
  }
}

export async function readSessionHistory(userData?: string): Promise<AgentSessionRecord[]> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return [];
  try {
    const content = await readFile(filePath, "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as AgentSessionRecord[];
  } catch {
    return [];
  }
}

export async function persistAgentSession(
  record: Omit<AgentSessionRecord, "savedAt">,
  userData?: string
): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return;

  await enqueueWrite(async () => {
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });

    const now = Date.now();
    const fullRecord: AgentSessionRecord = { ...record, savedAt: now };

    const existing = await readSessionHistory(userData);
    const updated = evictRecords([fullRecord, ...existing], now);

    await resilientAtomicWriteFile(filePath, JSON.stringify(updated, null, 2));
  });
}

export function listAgentSessions(worktreeId?: string, userData?: string): AgentSessionRecord[] {
  const records = readSessionHistorySync(userData);
  const now = Date.now();
  const fresh = evictRecords(records, now);

  if (!worktreeId) return fresh;
  return fresh.filter((r) => r.worktreeId === worktreeId);
}

export async function clearAgentSessions(worktreeId?: string, userData?: string): Promise<void> {
  const filePath = getSessionHistoryPath(userData);
  if (!filePath) return;

  // Share the write queue with persistAgentSession so a clear can't interleave
  // with an in-flight persist's read-modify-write and resurrect a cleared record.
  await enqueueWrite(async () => {
    if (!worktreeId) {
      // Clear all
      await resilientAtomicWriteFile(filePath, "[]");
      return;
    }

    const existing = await readSessionHistory(userData);
    const filtered = existing.filter((r) => r.worktreeId !== worktreeId);
    await resilientAtomicWriteFile(filePath, JSON.stringify(filtered, null, 2));
  });
}
