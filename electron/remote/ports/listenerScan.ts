import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { HostListeningPort } from "../../../shared/types/ipc/portForwards.js";

/**
 * The TCP ports listening on this machine's loopback that belong to the
 * user's own processes, offered to a Shell as ports it can forward. Read
 * without root: `lsof` on macOS, `/proc/net/tcp{,6}` plus the user's own
 * `/proc/<pid>/fd` links on Linux. Only listeners a `localhost` connection
 * can reach count (loopback or wildcard addresses).
 */

const MAX_LISTENERS = 256;
const MAX_PIDS_SCANNED = 4096;
const LSOF_TIMEOUT_MS = 5_000;
const TCP_LISTEN_STATE = "0A";

interface RawListener {
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

/** Keep one entry per port (the first that names a process), sorted, without our own process. */
export function finalizeListeners(
  listeners: RawListener[],
  excludePids: ReadonlySet<number>
): HostListeningPort[] {
  const byPort = new Map<number, RawListener>();
  for (const listener of listeners) {
    if (listener.pid !== null && excludePids.has(listener.pid)) continue;
    const known = byPort.get(listener.port);
    if (!known || (known.processName === null && listener.processName !== null)) {
      byPort.set(listener.port, listener);
    }
  }
  return [...byPort.values()]
    .sort((a, b) => a.port - b.port)
    .slice(0, MAX_LISTENERS)
    .map(({ port, pid, processName }) => ({ port, pid, processName }));
}

export interface ProcFs {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
}

const nodeProcFs: ProcFs = {
  readFile: (path) => fs.readFile(path, "utf8"),
  readdir: (path) => fs.readdir(path),
  readlink: (path) => fs.readlink(path),
};

/** Linux: the user's own listeners, with the owning process where its fds are readable. */
export async function scanLinuxListeners(
  uid: number,
  procFs: ProcFs = nodeProcFs
): Promise<RawListener[]> {
  const tables = await Promise.all([
    procFs
      .readFile("/proc/net/tcp")
      .then((text) => parseProcNetTcp(text, 4))
      .catch(() => []),
    procFs
      .readFile("/proc/net/tcp6")
      .then((text) => parseProcNetTcp(text, 6))
      .catch(() => []),
  ]);
  const listeners = tables.flat().filter((entry) => entry.uid === uid);
  const wanted = new Map<number, ProcNetListener[]>();
  for (const listener of listeners) {
    const list = wanted.get(listener.inode) ?? [];
    list.push(listener);
    wanted.set(listener.inode, list);
  }
  const owners = new Map<number, { pid: number; processName: string | null }>();
  const pids = (await procFs.readdir("/proc").catch(() => [] as string[]))
    .filter((name) => /^\d+$/.test(name))
    .slice(0, MAX_PIDS_SCANNED);
  for (const pidText of pids) {
    if (owners.size === wanted.size) break;
    const fds = await procFs.readdir(`/proc/${pidText}/fd`).catch(() => null);
    if (!fds) continue;
    let processName: string | null | undefined;
    for (const fd of fds) {
      const target = await procFs.readlink(`/proc/${pidText}/fd/${fd}`).catch(() => null);
      const match = target ? /^socket:\[(\d+)\]$/.exec(target) : null;
      if (!match) continue;
      const inode = Number.parseInt(match[1]!, 10);
      if (!wanted.has(inode) || owners.has(inode)) continue;
      if (processName === undefined) {
        processName = await procFs
          .readFile(`/proc/${pidText}/comm`)
          .then((text) => text.trim().slice(0, 256) || null)
          .catch(() => null);
      }
      owners.set(inode, { pid: Number.parseInt(pidText, 10), processName });
    }
  }
  return listeners.map((listener) => {
    const owner = owners.get(listener.inode);
    return {
      port: listener.port,
      pid: owner?.pid ?? null,
      processName: owner?.processName ?? null,
    };
  });
}

export type LsofRunner = () => Promise<string>;

const defaultLsof: LsofRunner = () =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // lsof exits 1 when nothing matched; that is an empty answer, not a failure.
        if (error && (error as { code?: unknown }).code !== 1) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });

export interface ListenerScanOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  lsof?: LsofRunner;
  procFs?: ProcFs;
  excludePids?: ReadonlySet<number>;
}

export async function scanHostListeners(
  options: ListenerScanOptions = {}
): Promise<HostListeningPort[]> {
  const platform = options.platform ?? process.platform;
  const exclude = options.excludePids ?? new Set([process.pid]);
  if (platform === "darwin") {
    const output = await (options.lsof ?? defaultLsof)();
    return finalizeListeners(parseLsofListeners(output), exclude);
  }
  if (platform === "linux") {
    const uid = options.uid ?? process.getuid?.() ?? -1;
    return finalizeListeners(await scanLinuxListeners(uid, options.procFs), exclude);
  }
  return [];
}
