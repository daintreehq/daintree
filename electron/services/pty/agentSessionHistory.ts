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

function evictRecords(records: AgentSessionRecord[], now: number): AgentSessionRecord[] {
  // Filter expired records
  const fresh = records.filter((r) => now - r.savedAt < SESSION_HISTORY_TTL_MS);

  // Enforce per-worktree cap
  const buckets = new Map<string, AgentSessionRecord[]>();
  for (const r of fresh) {
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

  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const now = Date.now();
  const fullRecord: AgentSessionRecord = { ...record, savedAt: now };

  const existing = await readSessionHistory(userData);
  const updated = evictRecords([fullRecord, ...existing], now);

  await resilientAtomicWriteFile(filePath, JSON.stringify(updated, null, 2));
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

  if (!worktreeId) {
    // Clear all
    await resilientAtomicWriteFile(filePath, "[]");
    return;
  }

  const existing = await readSessionHistory(userData);
  const filtered = existing.filter((r) => r.worktreeId !== worktreeId);
  await resilientAtomicWriteFile(filePath, JSON.stringify(filtered, null, 2));
}
