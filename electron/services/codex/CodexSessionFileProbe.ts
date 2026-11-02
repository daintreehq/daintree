/**
 * The rollout file a Codex pane is writing, seen from outside the CLI (#16097).
 *
 * Codex holds its session's rollout open for writing for as long as the
 * session runs (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`),
 * so the file is an operating-system fact about the pane's own Codex process.
 * That answers for any `CODEX_HOME` and for a `codex` typed into a shell, which
 * Daintree never learned an id for. Nothing here reads Codex's config or asks
 * Codex; the file's first record is read only to confirm what it is.
 *
 * The pane's Codex is the outermost `codex` process under the pane, and only
 * the files it holds count: a `codex` one of its tools started is a different
 * conversation. One `ps`, one `lsof` and one more `ps` to confirm the process
 * is still the one listed, each on demand and bounded in time and output. Any
 * listing that can't be complete answers unknown, because only a complete one
 * can show there is exactly one file.
 */

import { spawn, type ChildProcess } from "node:child_process";
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

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * `rollout-<time>-<thread id>.jsonl`, or `…-<thread id>_<rollout id>.jsonl`
 * for a thread Codex reverted, which keeps its thread id.
 */
const ROLLOUT_NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})(?:_${UUID})?\\.jsonl$`,
  "i"
);
/** `ps -o pid=,ppid=,lstart=,comm=`: `lstart` is five fields, `comm` the rest of the line. */
const CENSUS_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.+?)\s*$/;
const CENSUS_COLUMNS = "pid=,ppid=,lstart=,comm=";

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

/**
 * Runs a listing in a process group of its own, so a timeout or an overflow
 * takes everything it started with it: `lsof` can leave a helper blocked on an
 * unreachable mount. The group is signalled once, and only while the listing
 * is still running: once it has exited and been reaped, its id can name
 * someone else's group.
 */
export const runListing: ListingRunner = (file, args, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: {
          ...process.env,
          LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
        },
      });
    } catch (error) {
      reject(error);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    // Set once the group is signalled or the listing has exited: no signal after either.
    let released = false;
    const killGroup = () => {
      if (released || !child.pid) return;
      released = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      killGroup();
      settle(() => reject(new Error(`${file} timed out`)));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        killGroup();
        settle(() => reject(new Error(`${file} output passed its cap`)));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      killGroup();
      settle(() => reject(error));
    });
    child.on("exit", () => {
      released = true;
    });
    child.on("close", (code, signal) => {
      settle(() => {
        if (code === null) reject(new Error(`${file} ended on ${signal ?? "a signal"}`));
        else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code });
      });
    });
  });

export interface CensusEntry {
  pid: number;
  ppid: number;
  /** Start time as `ps` prints it: with the pid, what tells a process from a later one reusing its id. */
  started: string;
  comm: string;
}

export function parseCensus(psOutput: string): Map<number, CensusEntry> {
  const census = new Map<number, CensusEntry>();
  for (const line of psOutput.split("\n")) {
    const match = CENSUS_LINE.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const [, , ppid, started, comm] = match;
    if (ppid === undefined || started === undefined || comm === undefined) continue;
    census.set(pid, { pid, ppid: Number(ppid), started, comm });
  }
  return census;
}

/** The names older npm packages gave the native binary, one per target. */
const LEGACY_CODEX_BINARIES = [
  "codex-aarch64-apple-darwin",
  "codex-x86_64-apple-darwin",
  "codex-aarch64-unknown-linux-musl",
  "codex-x86_64-unknown-linux-musl",
  "codex-aarch64-unknown-linux-gnu",
  "codex-x86_64-unknown-linux-gnu",
];
/** Linux keeps the first 15 bytes of a process name. */
const LINUX_COMM_LENGTH = 15;

/**
 * The native Codex binary: `codex`, or a legacy package's per-target name. The
 * npm launcher runs as `node`, and any other `codex-*` (a user's wrapper) is
 * not taken for Codex, so it can't hide the real one beneath it.
 */
export function isCodexExecutable(comm: string): boolean {
  let name = path.basename(comm.replace(/\\/g, "/")).toLowerCase();
  if (name.startsWith("-")) name = name.slice(1);
  if (name === "codex") return true;
  return LEGACY_CODEX_BINARIES.some(
    (binary) => binary === name || (name.length === LINUX_COMM_LENGTH && binary.startsWith(name))
  );
}

export type PaneCodexProcess =
  { status: "found"; process: CensusEntry } | { status: "none" | "ambiguous" | "too-big" };

/**
 * The outermost Codex process under `rootPid`, the root included. A `codex`
 * below another is something the outer one ran; two at the same depth leave
 * no one process the pane's.
 */
export function findPaneCodexProcess(
  census: Map<number, CensusEntry>,
  rootPid: number
): PaneCodexProcess {
  const children = new Map<number, number[]>();
  for (const entry of census.values()) {
    const siblings = children.get(entry.ppid);
    if (siblings) siblings.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const seen = new Set<number>([rootPid]);
  let level = [rootPid];
  while (level.length > 0) {
    const found = level
      .map((pid) => census.get(pid))
      .filter((entry): entry is CensusEntry => !!entry && isCodexExecutable(entry.comm));
    const [only, another] = found;
    if (another) return { status: "ambiguous" };
    if (only) return { status: "found", process: only };
    const next: number[] = [];
    for (const pid of level) {
      for (const child of children.get(pid) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        if (seen.size > MAX_TREE_PIDS) return { status: "too-big" };
        next.push(child);
      }
    }
    level = next;
  }
  return { status: "none" };
}

export interface OpenFileRecord {
  pid: number;
  fd: string;
  access: string;
  type: string;
  device: string;
  inode: string;
  name: string;
}

/** Parses `lsof -F pfatDin`: a `p` line opens a process, an `f` line opens one of its files. */
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
      current = { pid, fd: value, access: "", type: "", device: "", inode: "", name: "" };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (field === "a") current.access = value;
    else if (field === "t") current.type = value;
    else if (field === "D") current.device = value;
    else if (field === "i") current.inode = value;
    else if (field === "n") current.name = value;
  }
  return records;
}

/** The thread id a rollout's path names, when it sits where Codex writes rollouts. */
export function rolloutThreadId(filePath: string): string | null {
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
  return match[1]?.toLowerCase() ?? null;
}

function isWriteAccess(access: string): boolean {
  return access === "w" || access === "u";
}

export type SessionMetaKind = "root" | "child" | "invalid";

/**
 * What a rollout's first record says it is. A subagent's thread names its
 * parent, and shares its root's `session_id` under an id of its own; older
 * records with neither mark a subagent by an object `source`.
 */
export function classifySessionMeta(firstLine: string, fileThreadId: string): SessionMetaKind {
  let record: unknown;
  try {
    record = JSON.parse(firstLine);
  } catch {
    return "invalid";
  }
  if (!record || typeof record !== "object") return "invalid";
  const { type, payload } = record as { type?: unknown; payload?: unknown };
  if (type !== "session_meta" || !payload || typeof payload !== "object") return "invalid";
  const {
    id,
    session_id: sessionId,
    parent_thread_id: parentThreadId,
    source,
  } = payload as {
    id?: unknown;
    session_id?: unknown;
    parent_thread_id?: unknown;
    source?: unknown;
  };
  if (typeof id !== "string" || id.toLowerCase() !== fileThreadId) return "invalid";
  if (parentThreadId !== undefined && parentThreadId !== null) return "child";
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== "string") return "invalid";
    if (sessionId.toLowerCase() !== fileThreadId) return "child";
  }
  if (source !== null && typeof source === "object") return "child";
  return "root";
}

/** `lsof` prints a device as hex, the way `stat` holds it. */
function sameDevice(listed: string, dev: number): boolean {
  if (!/^0x[0-9a-f]+$/i.test(listed)) return false;
  return Number.parseInt(listed.slice(2), 16) === dev;
}

/**
 * The first record of the file `lsof` saw, read through a descriptor checked
 * to be that same file: the device and inode it listed, a regular file, no
 * symlink at the end of the path. Null when it isn't, or the record doesn't
 * end inside the read.
 */
async function readFirstRecord(candidate: OpenFileRecord): Promise<string | null> {
  const checked = await lstat(candidate.name);
  if (
    !checked.isFile() ||
    String(checked.ino) !== candidate.inode ||
    !sameDevice(candidate.device, checked.dev)
  ) {
    return null;
  }
  const handle = await open(
    candidate.name,
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

async function classifyCandidate(
  candidate: OpenFileRecord,
  threadId: string
): Promise<SessionMetaKind> {
  try {
    const line = await readFirstRecord(candidate);
    return line === null ? "invalid" : classifySessionMeta(line, threadId);
  } catch {
    return "invalid";
  }
}

async function listCensus(run: ListingRunner, args: string[]) {
  const ps = await run("ps", args, { timeoutMs: PS_TIMEOUT_MS, maxBytes: LISTING_MAX_BYTES });
  return ps.exitCode === 0 ? parseCensus(ps.stdout) : null;
}

/**
 * The rollout the pane's Codex under `rootPid` is writing: observed when that
 * process holds exactly one root session's rollout open for writing, unknown
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

  let codex: CensusEntry;
  try {
    const census = await listCensus(run, ["-A", "-o", CENSUS_COLUMNS]);
    if (!census) return unknownSessionFile("probe-failed");
    const found = findPaneCodexProcess(census, rootPid);
    if (found.status !== "found") {
      if (found.status === "none") return unknownSessionFile("not-observed");
      return unknownSessionFile(found.status === "ambiguous" ? "ambiguous" : "probe-failed");
    }
    codex = found.process;
  } catch {
    return unknownSessionFile("probe-failed");
  }

  let lsof: ListingResult;
  try {
    lsof = await run("lsof", ["-n", "-P", "-w", "-p", String(codex.pid), "-F", "pfatDin"], {
      timeoutMs: LSOF_TIMEOUT_MS,
      maxBytes: LISTING_MAX_BYTES,
    });
  } catch {
    return unknownSessionFile("probe-failed");
  }
  // Anything but a clean exit may have left files out.
  if (lsof.exitCode !== 0) return unknownSessionFile("probe-failed");

  // The listing is only the pane's if the process is still the one the census
  // found: same parent, same start, same program.
  try {
    const after = (await listCensus(run, ["-o", CENSUS_COLUMNS, "-p", String(codex.pid)]))?.get(
      codex.pid
    );
    if (
      !after ||
      after.ppid !== codex.ppid ||
      after.started !== codex.started ||
      after.comm !== codex.comm
    ) {
      return unknownSessionFile("pane-changed");
    }
  } catch {
    return unknownSessionFile("probe-failed");
  }

  const candidates = new Map<string, { record: OpenFileRecord; threadId: string }>();
  for (const record of parseLsofFields(lsof.stdout)) {
    if (
      record.pid !== codex.pid ||
      record.type !== "REG" ||
      !isWriteAccess(record.access) ||
      !/^\d+$/.test(record.fd)
    ) {
      continue;
    }
    const threadId = rolloutThreadId(record.name);
    if (!threadId) continue;
    // One file held by several descriptors is still one file.
    candidates.set(`${record.device}\0${record.inode}\0${record.name}`, { record, threadId });
  }
  if (candidates.size === 0) return unknownSessionFile("not-observed");
  if (candidates.size > MAX_CANDIDATES) return unknownSessionFile("ambiguous");

  const classified = await Promise.all(
    [...candidates.values()].map(async ({ record, threadId }) => ({
      record,
      threadId,
      kind: await classifyCandidate(record, threadId),
    }))
  );
  const roots = classified.filter((entry) => entry.kind === "root");
  if (roots.length > 1) return unknownSessionFile("ambiguous");
  const [root] = roots;
  if (!root || classified.some((entry) => entry.kind === "invalid")) {
    return unknownSessionFile("unverified");
  }
  return {
    status: "observed",
    agentId: "codex",
    sessionId: root.threadId,
    path: root.record.name,
    observedBy: "open-for-writing",
  };
}
