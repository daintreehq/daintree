import { execFile } from "node:child_process";
import fs from "node:fs/promises";

// Only listen addresses that a localhost connection can reach count.
const MAX_PIDS_SCANNED = 4096;
const LSOF_TIMEOUT_MS = 5_000;
const TCP_LISTEN_STATE = "0A";

export interface RawListener {
  port: number;
  pid: number | null;
  processName: string | null;
}

function isReachableIpv4(address: string): boolean {
  return address === "*" || address === "0.0.0.0" || address.startsWith("127.");
}

function isReachableIpv6(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    bare === "::" ||
    bare === "::1" ||
    bare === "*" ||
    bare.startsWith("::ffff:127.") ||
    bare === "::ffff:0.0.0.0"
  );
}

/**
 * Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn`: `p<pid>`, `c<command>` and one
 * `n<address>:<port>` per listening socket (plus other field lines, ignored).
 */
export function parseLsofListeners(output: string): RawListener[] {
  const out: RawListener[] = [];
  let pid: number | null = null;
  let command: string | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length < 2) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      command = null;
    } else if (field === "c") {
      command = value.slice(0, 256);
    } else if (field === "n") {
      const separator = value.lastIndexOf(":");
      if (separator <= 0) continue;
      const address = value.slice(0, separator);
      const port = Number.parseInt(value.slice(separator + 1), 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const reachable = address.startsWith("[")
        ? isReachableIpv6(address)
        : isReachableIpv4(address);
      if (!reachable) continue;
      out.push({ port, pid, processName: command });
    }
  }
  return out;
}

export interface ProcNetListener {
  port: number;
  uid: number;
  inode: number;
}

function isReachableProcIpv4(hex: string): boolean {
  // Little-endian per 32-bit word: 0100007F is 127.0.0.1.
  if (hex === "00000000") return true;
  return hex.length === 8 && hex.slice(6, 8).toUpperCase() === "7F";
}

function isReachableProcIpv6(hex: string): boolean {
  const upper = hex.toUpperCase();
  if (upper.length !== 32) return false;
  if (upper === "0".repeat(32)) return true;
  if (upper === "00000000000000000000000001000000") return true;
  // IPv4-mapped: ::ffff:a.b.c.d is words 0,0,FFFF0000,<v4>.
  if (upper.startsWith("0000000000000000FFFF0000")) {
    return isReachableProcIpv4(upper.slice(24));
  }
  return false;
}

/** Parse `/proc/net/tcp` or `/proc/net/tcp6`, keeping listening sockets reachable via localhost. */
export function parseProcNetTcp(content: string, family: 4 | 6): ProcNetListener[] {
  const out: ProcNetListener[] = [];
  const lines = content.split("\n");
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) continue;
    const local = columns[1]!;
    const state = columns[3]!;
    if (state.toUpperCase() !== TCP_LISTEN_STATE) continue;
    const [addressHex, portHex] = local.split(":");
    if (!addressHex || !portHex) continue;
    const reachable =
      family === 4 ? isReachableProcIpv4(addressHex) : isReachableProcIpv6(addressHex);
    if (!reachable) continue;
    const port = Number.parseInt(portHex, 16);
    const uid = Number.parseInt(columns[7]!, 10);
    const inode = Number.parseInt(columns[9]!, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!Number.isInteger(uid) || !Number.isInteger(inode)) continue;
    out.push({ port, uid, inode });
  }
  return out;
}

export interface ProcFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

export const nodeProcFs: ProcFs = {
  readFile: (path) => fs.readFile(path, "utf8"),
  readdir: (path) => fs.readdir(path),
  readlink: (path) => fs.readlink(path),
};

/**
 * Both TCP tables, reachable listeners only. With `strict`, a table that
 * exists but can't be read makes the answer null rather than half a list; a
 * missing table is an address family the kernel doesn't have.
 */
export async function readProcNetTables(
  procFs: ProcFs,
  strict = false
): Promise<ProcNetListener[] | null> {
  let failed = false;
  const read = (file: string, family: 4 | 6) =>
    procFs
      .readFile(file)
      .then((text) => parseProcNetTcp(text, family))
      .catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "ENOENT") failed = true;
        return [];
      });
  const tables = await Promise.all([read("/proc/net/tcp", 4), read("/proc/net/tcp6", 6)]);
  return strict && failed ? null : tables.flat();
}

/** The process holding each socket inode, from the user's own readable `/proc/<pid>/fd` links. */
export async function socketOwners(
  inodes: ReadonlySet<number>,
  procFs: ProcFs
): Promise<Map<number, { pid: number; processName: string | null }>> {
  const owners = new Map<number, { pid: number; processName: string | null }>();
  if (inodes.size === 0) return owners;
  const pids = (await procFs.readdir("/proc").catch(() => [] as string[]))
    .filter((name) => /^\d+$/.test(name))
    .slice(0, MAX_PIDS_SCANNED);
  for (const pidText of pids) {
    if (owners.size === inodes.size) break;
    const fds = await procFs.readdir(`/proc/${pidText}/fd`).catch(() => null);
    if (!fds) continue;
    let processName: string | null | undefined;
    for (const fd of fds) {
      const target = await procFs.readlink(`/proc/${pidText}/fd/${fd}`).catch(() => null);
      const match = target ? /^socket:\[(\d+)\]$/.exec(target) : null;
      if (!match) continue;
      const inode = Number.parseInt(match[1]!, 10);
      if (!inodes.has(inode) || owners.has(inode)) continue;
      if (processName === undefined) {
        processName = await procFs
          .readFile(`/proc/${pidText}/comm`)
          .then((text) => text.trim().slice(0, 256) || null)
          .catch(() => null);
      }
      owners.set(inode, { pid: Number.parseInt(pidText, 10), processName });
    }
  }
  return owners;
}

/** `lsof` asked about one listening TCP port; exits 1 when nothing matched. */
export function portLsofArgs(port: number): string[] {
  return ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pcn"];
}

/** `lsof` asked for the working directory of each pid. */
export function cwdLsofArgs(pids: readonly number[]): string[] {
  return ["-a", "-d", "cwd", "-p", pids.join(","), "-F", "pn"];
}

export type LsofArgsRunner = (args: string[]) => Promise<string>;

export const runLsof: LsofArgsRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/lsof",
      args,
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // lsof exits 1 when nothing matched.
        if (error && (error as { code?: unknown }).code !== 1) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });

/** Parse `lsof -d cwd -F pn`: `p<pid>` then `n<path>` for each process. */
export function parseLsofCwds(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("p")) {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null && line.length > 1) {
      cwds.set(pid, line.slice(1));
      pid = null;
    }
  }
  return cwds;
}

export interface PortListener {
  pid: number;
  /** Where the process runs from; null when it can't be read. */
  cwd: string | null;
}

export interface PortListenerOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  lsof?: LsofArgsRunner;
  procFs?: ProcFs;
  excludePids?: ReadonlySet<number>;
}

/**
 * Every process listening on `port` where a `localhost` connection reaches,
 * and the directory each runs from: a server and something else can hold the
 * IPv4 and IPv6 sides of one port, and either may be what answered. Null when
 * this machine can't account for every such socket: an unsupported platform,
 * a failed scan, a socket whose owner isn't readable or belongs to another
 * user, or one held by this app itself. An empty list means nothing listens.
 */
export async function findPortListeners(
  port: number,
  options: PortListenerOptions = {}
): Promise<PortListener[] | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const platform = options.platform ?? process.platform;
  const exclude = options.excludePids ?? new Set([process.pid]);
  try {
    let pids: number[];
    if (platform === "darwin") {
      const lsof = options.lsof ?? runLsof;
      const listeners = parseLsofListeners(await lsof(portLsofArgs(port))).filter(
        (listener) => listener.port === port
      );
      if (listeners.some((listener) => listener.pid === null)) return null;
      pids = [...new Set(listeners.map((listener) => listener.pid as number))];
      if (pids.some((pid) => exclude.has(pid))) return null;
      if (pids.length === 0) return [];
      const cwds = parseLsofCwds(await lsof(cwdLsofArgs(pids)));
      return pids.sort((a, b) => a - b).map((pid) => ({ pid, cwd: cwds.get(pid) ?? null }));
    }
    if (platform === "linux") {
      const procFs = options.procFs ?? nodeProcFs;
      const uid = options.uid ?? process.getuid?.() ?? -1;
      // Filtered to the one port before any fd is read: a miss costs two
      // table reads, never a walk of every process.
      const tables = await readProcNetTables(procFs, true);
      if (tables === null) return null;
      const sockets = tables.filter((entry) => entry.port === port);
      if (sockets.length === 0) return [];
      if (sockets.some((socket) => socket.uid !== uid)) return null;
      const owners = await socketOwners(new Set(sockets.map((socket) => socket.inode)), procFs);
      if (sockets.some((socket) => !owners.has(socket.inode))) return null;
      pids = [...new Set(sockets.map((socket) => owners.get(socket.inode)!.pid))];
      if (pids.some((pid) => exclude.has(pid))) return null;
      const listeners: PortListener[] = [];
      for (const pid of pids.sort((a, b) => a - b)) {
        const cwd = await procFs.readlink(`/proc/${pid}/cwd`).catch(() => null);
        listeners.push({ pid, cwd });
      }
      return listeners;
    }
    return null;
  } catch {
    return null;
  }
}
