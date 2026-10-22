import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { processStartTime } from "./hostSocketLock.js";

/**
 * `host-advert.json`, beside the host socket: the mDNS tool this launch
 * spawned and which launch that was. dns-sd and avahi-publish-service watch
 * neither their parent nor stdin, so a crashed or killed host leaves its
 * advert announcing; the next launch reads this file to end exactly that
 * process, and never one that merely looks like it.
 */

export const HOST_ADVERT_NAME = "host-advert.json";

const KILL_ESCALATION_MS = 2_000;

interface ProcessIdentity {
  pid: number;
  startTime: string | null;
}

export interface AdvertRecord {
  version: 1;
  owner: ProcessIdentity;
  child: ProcessIdentity & { argv: string[] };
}

export interface AdvertRecordDeps {
  platform: NodeJS.Platform;
  ownerPid: number;
  startTime(pid: number): string | null;
  /** The process's argv as the kernel holds it; null when it can't be read. */
  argv(pid: number): string[] | null;
  signal(pid: number, signal: NodeJS.Signals | 0): void;
  setTimer(fn: () => void, ms: number): void;
}

function readLinuxArgv(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.length > 0 ? raw.replace(/\0$/, "").split("\0") : null;
  } catch {
    return null;
  }
}

/** `ps` flattens argument boundaries, so the result is one joined string. */
function readMacArgv(pid: number): string[] | null {
  try {
    const command = execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return command.length > 0 ? [command] : null;
  } catch {
    return null;
  }
}

export function defaultAdvertRecordDeps(): AdvertRecordDeps {
  return {
    platform: process.platform,
    ownerPid: process.pid,
    startTime: processStartTime,
    argv: (pid) => (process.platform === "darwin" ? readMacArgv(pid) : readLinuxArgv(pid)),
    signal: (pid, signal) => process.kill(pid, signal),
    setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
  };
}

function supported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "linux";
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

function parseIdentity(raw: unknown): ProcessIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const { pid, startTime } = raw as Record<string, unknown>;
  if (!isPid(pid)) return null;
  return { pid, startTime: typeof startTime === "string" && startTime ? startTime : null };
}

function parseRecord(text: string): AdvertRecord | null {
  if (!text || text.length > 8 * 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { version, owner, child } = raw as Record<string, unknown>;
  if (version !== 1) return null;
  const ownerIdentity = parseIdentity(owner);
  const childIdentity = parseIdentity(child);
  const argv = (child as { argv?: unknown } | undefined)?.argv;
  if (!ownerIdentity || !childIdentity) return null;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) {
    return null;
  }
  return { version: 1, owner: ownerIdentity, child: { ...childIdentity, argv: argv as string[] } };
}

function readRecord(file: string): AdvertRecord | null {
  try {
    return parseRecord(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Nothing more to do about a file we can't remove.
  }
}

export function advertRecordPath(dir: string): string {
  return path.join(dir, HOST_ADVERT_NAME);
}

/** Record the tool this launch just spawned. Returns false when it could not be recorded. */
export function saveAdvertRecord(
  dir: string,
  child: { pid: number; file: string; args: readonly string[] },
  deps: AdvertRecordDeps = defaultAdvertRecordDeps()
): boolean {
  if (!supported(deps.platform) || !isPid(child.pid)) return false;
  const record: AdvertRecord = {
    version: 1,
    owner: { pid: deps.ownerPid, startTime: deps.startTime(deps.ownerPid) },
    child: {
      pid: child.pid,
      startTime: deps.startTime(child.pid),
      argv: [child.file, ...child.args],
    },
  };
  const file = advertRecordPath(dir);
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    removeFile(tmp);
    return false;
  }
}

/** Remove the record only if it still names `pid`; a newer advert may own it now. */
export function clearAdvertRecord(dir: string, pid: number): void {
  const file = advertRecordPath(dir);
  const current = readRecord(file);
  if (current && current.child.pid !== pid) return;
  removeFile(file);
}

type Match = "match" | "mismatch" | "unknown";

/** `unknown` is a read that failed or a record without a start time: never grounds to signal. */
function identityMatch(
  identity: ProcessIdentity,
  deps: AdvertRecordDeps,
  argv?: readonly string[]
): Match {
  if (!identity.startTime) return "unknown";
  const started = deps.startTime(identity.pid);
  if (started === null) return "unknown";
  if (started !== identity.startTime) return "mismatch";
  if (!argv) return "match";
  const actual = deps.argv(identity.pid);
  if (!actual) return "unknown";
  const expected = deps.platform === "darwin" ? [argv.join(" ")] : argv;
  const same = actual.length === expected.length && actual.every((part, i) => part === expected[i]);
  return same ? "match" : "mismatch";
}

function isAlive(pid: number, deps: AdvertRecordDeps): boolean {
  try {
    deps.signal(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * End the advert an earlier launch left behind. Runs whatever the settings
 * are now, since turning advertising or Host mode off is no reason for a
 * stranded advert to keep announcing. Signals only a process whose pid, start
 * time and argv all match the record; anything else costs only the record.
 */
export function reapOrphanedAdvert(
  dir: string,
  deps: AdvertRecordDeps = defaultAdvertRecordDeps()
): void {
  if (!supported(deps.platform)) return;
  const file = advertRecordPath(dir);
  const record = readRecord(file);
  if (!record) {
    removeFile(file);
    return;
  }
  const { owner, child } = record;
  // A live host that isn't this one keeps its advert, and its record. Only a
  // definite mismatch (the pid was reused) or a dead owner frees it.
  if (owner.pid === deps.ownerPid || isAlive(owner.pid, deps)) {
    if (identityMatch(owner, deps) !== "mismatch") return;
  }
  const match = isAlive(child.pid, deps) ? identityMatch(child, deps, child.argv) : "mismatch";
  if (match === "mismatch") {
    removeFile(file);
    return;
  }
  if (match === "unknown") return;
  try {
    deps.signal(child.pid, "SIGTERM");
  } catch {
    return;
  }
  // The record stays until the advert is seen gone, so a crash before then still leaves a handle.
  deps.setTimer(() => {
    if (isAlive(child.pid, deps) && identityMatch(child, deps, child.argv) === "match") {
      try {
        deps.signal(child.pid, "SIGKILL");
      } catch {
        // Gone between the check and the signal.
      }
    }
    clearAdvertRecord(dir, child.pid);
  }, KILL_ESCALATION_MS);
}
