/**
 * The rollout file a Codex pane is writing, seen from outside the CLI (#16097).
 *
 * Codex holds its session's rollout open for writing for as long as the
 * session runs (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`),
 * so the file is an operating-system fact about the pane's own processes. That
 * answers for any `CODEX_HOME` and for a `codex` typed into a shell, which
 * Daintree never learned an id for. Nothing here reads Codex's config or asks
 * Codex; the file's first record is read only to confirm what it is.
 *
 * One `ps` and one `lsof`, each on demand, bounded in time and output. Any
 * listing that can't be complete answers unknown, because only a complete one
 * can show there is exactly one file.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  unknownSessionFile,
  type AgentSessionFileResult,
} from "../../../shared/types/agentSessionFile.js";

const PS_TIMEOUT_MS = 1_500;
const LSOF_TIMEOUT_MS = 2_000;
const LISTING_MAX_BYTES = 8 * 1024 * 1024;
/** A pane's tree past this is not one this can list whole. */
const MAX_TREE_PIDS = 256;
/** More open rollouts than this is no single session's. */
const MAX_CANDIDATES = 8;
/**
 * Bytes read to find the first record. Codex's opening `session_meta` carries
 * the model's base instructions, about 22 KiB in codex-cli 0.166.
 */
const SESSION_META_MAX_BYTES = 256 * 1024;

const ROLLOUT_NAME =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface ListingResult {
  stdout: string;
  exitCode: number;
}

/** Runs one listing command; rejects when it couldn't run, timed out or overflowed. */
export type ListingRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; maxBytes: number }
) => Promise<ListingResult>;

export interface CodexSessionFileProbeDeps {
  platform?: NodeJS.Platform;
  run?: ListingRunner;
}

export const runListing: ListingRunner = (file, args, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: maxBytes,
        windowsHide: true,
        env: {
          ...process.env,
          LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
        },
      },
      (error, stdout) => {
        if (!error) {
          resolve({ stdout, exitCode: 0 });
          return;
        }
        const code = (error as { code?: unknown }).code;
        // An exit status is an answer; a spawn failure, a kill or an overflow is not.
        if (typeof code === "number" && !error.killed && !error.signal) {
          resolve({ stdout, exitCode: code });
          return;
        }
        reject(error);
      }
    );
  });

/** The pane's root process and every descendant, or null when the tree is too big to list whole. */
export function collectTreePids(psOutput: string, rootPid: number): number[] | null {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      if (seen.size > MAX_TREE_PIDS) return null;
      queue.push(child);
    }
  }
  return [...seen];
}

export interface OpenFileRecord {
  pid: number;
  fd: string;
  access: string;
  type: string;
  inode: string;
  name: string;
}

/** Parses `lsof -F pfatin`: a `p` line opens a process, an `f` line opens one of its files. */
export function parseLsofFields(output: string): OpenFileRecord[] {
  const records: OpenFileRecord[] = [];
  let pid: number | null = null;
  let current: OpenFileRecord | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      current = null;
      pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0) pid = null;
      continue;
    }
    if (field === "f") {
      current = null;
      if (pid === null) continue;
      current = { pid, fd: value, access: "", type: "", inode: "", name: "" };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (field === "a") current.access = value;
    else if (field === "t") current.type = value;
    else if (field === "i") current.inode = value;
    else if (field === "n") current.name = value;
  }
  return records;
}

/** The session id a rollout's path names, when it sits where Codex writes rollouts. */
export function rolloutSessionId(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) return null;
  const match = ROLLOUT_NAME.exec(path.basename(filePath));
  if (!match) return null;
  const day = path.dirname(filePath);
  const month = path.dirname(day);
  const year = path.dirname(month);
  if (
    !/^\d{2}$/.test(path.basename(day)) ||
    !/^\d{2}$/.test(path.basename(month)) ||
    !/^\d{4}$/.test(path.basename(year)) ||
    path.basename(path.dirname(year)) !== "sessions"
  ) {
    return null;
  }
  return match[1].toLowerCase();
}

function isWriteAccess(access: string): boolean {
  return access === "w" || access === "u";
}

export type SessionMetaKind = "root" | "child" | "invalid";

/**
 * What a rollout's first record says it is. A subagent's thread shares its
 * root's `session_id` under an id of its own; older records with no
 * `session_id` mark a subagent by an object `source`.
 */
export function classifySessionMeta(firstLine: string, fileSessionId: string): SessionMetaKind {
  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return "invalid";
  }
  if (!record || typeof record !== "object") return "invalid";
  const { type, payload } = record as { type?: unknown; payload?: unknown };
  if (type !== "session_meta" || !payload || typeof payload !== "object") return "invalid";
  const { id, session_id: sessionId, source } = payload as {
    id?: unknown;
    session_id?: unknown;
    source?: unknown;
  };
  if (typeof id !== "string" || id.toLowerCase() !== fileSessionId) return "invalid";
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== "string") return "invalid";
    if (sessionId.toLowerCase() !== fileSessionId) return "child";
  }
  if (source !== null && typeof source === "object") return "child";
  return "root";
}

/**
 * The first record of the file `lsof` saw, read through a descriptor that is
 * checked to be that same file. Null when it isn't, or the record doesn't end
 * inside the read.
 */
async function readFirstRecord(filePath: string, inode: string): Promise<string | null> {
  const checked = await lstat(filePath);
  if (!checked.isFile() || String(checked.ino) !== inode) return null;
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.ino !== checked.ino || stats.dev !== checked.dev) return null;
    const buffer = Buffer.alloc(Math.min(SESSION_META_MAX_BYTES, Math.max(stats.size, 0)));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const newline = buffer.subarray(0, filled).indexOf(0x0a);
    if (newline < 0) return null;
    return buffer.subarray(0, newline).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function classifyCandidate(candidate: OpenFileRecord, sessionId: string) {
  try {
    const line = await readFirstRecord(candidate.name, candidate.inode);
    return line === null ? "invalid" : classifySessionMeta(line, sessionId);
  } catch {
    return "invalid";
  }
}

/**
 * The rollout the process tree under `rootPid` is writing: observed when
 * exactly one root session's rollout is open for writing there, unknown
 * otherwise.
 */
export async function probeCodexSessionFile(
  rootPid: number,
  deps: CodexSessionFileProbeDeps = {}
): Promise<AgentSessionFileResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runListing;
  if (platform === "win32") return unknownSessionFile("unsupported-platform");
  if (!Number.isInteger(rootPid) || rootPid <= 1) return unknownSessionFile("no-live-agent");

  let pids: number[] | null;
  try {
    const ps = await run("ps", ["-A", "-o", "pid=,ppid="], {
      timeoutMs: PS_TIMEOUT_MS,
      maxBytes: LISTING_MAX_BYTES,
    });
    if (ps.exitCode !== 0) return unknownSessionFile("probe-failed");
    pids = collectTreePids(ps.stdout, rootPid);
  } catch {
    return unknownSessionFile("probe-failed");
  }
  if (!pids) return unknownSessionFile("probe-failed");

  let lsof: ListingResult;
  try {
    lsof = await run(
      "lsof",
      ["-n", "-P", "-w", "-a", "-p", pids.join(","), "-d", "0-65535", "-F", "pfatin"],
      { timeoutMs: LSOF_TIMEOUT_MS, maxBytes: LISTING_MAX_BYTES }
    );
  } catch {
    return unknownSessionFile("probe-failed");
  }
  // `lsof` exits 1 when some listed process had nothing to show or has gone,
  // which still leaves the others' files listed.
  if (lsof.exitCode !== 0 && lsof.exitCode !== 1) return unknownSessionFile("probe-failed");

  const candidates = new Map<string, { record: OpenFileRecord; sessionId: string }>();
  for (const record of parseLsofFields(lsof.stdout)) {
    if (record.type !== "REG" || !isWriteAccess(record.access) || !/^\d+$/.test(record.fd)) {
      continue;
    }
    const sessionId = rolloutSessionId(record.name);
    if (!sessionId) continue;
    // One file held by several descriptors or processes is still one file.
    candidates.set(`${record.inode}\0${record.name}`, { record, sessionId });
  }
  if (candidates.size === 0) return unknownSessionFile("not-observed");
  if (candidates.size > MAX_CANDIDATES) return unknownSessionFile("ambiguous");

  const classified = await Promise.all(
    [...candidates.values()].map(async ({ record, sessionId }) => ({
      record,
      sessionId,
      kind: await classifyCandidate(record, sessionId),
    }))
  );
  const roots = classified.filter((entry) => entry.kind === "root");
  if (roots.length > 1) return unknownSessionFile("ambiguous");
  if (roots.length === 0 || classified.some((entry) => entry.kind === "invalid")) {
    return unknownSessionFile("unverified");
  }
  const [root] = roots;
  return {
    status: "observed",
    agentId: "codex",
    sessionId: root.sessionId,
    path: root.record.name,
    observedBy: "open-for-writing",
  };
}
