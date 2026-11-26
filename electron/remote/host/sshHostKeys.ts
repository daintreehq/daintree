import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_SSH_HOST_KEYS_PER_LISTENER,
  MAX_SSH_LISTEN_ADDRESSES,
  MAX_SSH_LISTENERS,
  type SshHostKeyFile,
  type SshHostKeysAnswer,
  type SshListenerGap,
  type SshListenerReading,
} from "./linkMethods.js";
import { MAX_PUBLIC_KEY_LENGTH, parsePublicKeyFile } from "./sshPublicKey.js";

/** One `sshd -G` may take this long; a config on a slow mount shouldn't hold the answer. */
const CONFIG_DUMP_TIMEOUT_MS = 2_000;
/** The whole read, so the Shell's call always gets an answer in time. */
const READ_DEADLINE_MS = 5_000;
const MAX_CONFIG_DUMP_BYTES = 1024 * 1024;
/** A `.pub` larger than any key line plus a long comment isn't one. */
const MAX_PUBLIC_FILE_BYTES = MAX_PUBLIC_KEY_LENGTH + 4096;
/** An sshd's options, as its getopt string has them: these take an argument. */
const OPTIONS_WITH_ARGUMENT = new Set(["C", "E", "b", "c", "f", "g", "h", "k", "o", "p", "u"]);
/** A per-connection re-exec, inetd mode, or a config test or dump: never a listener. */
const NOT_A_LISTENER = new Set(["R", "i", "t", "T", "G", "V", "Q"]);
const OTHER_FLAGS = new Set(["D", "d", "e", "q", "r"]);
/** OpenSSH 8.2+ retitles a listener; the command line is the args joined by spaces. */
const LISTENER_TITLE = /^sshd: (\S.*?) \[listener\] \d+ of [\d-]+ startups$/;

export type ConfigDumpResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "unsupported" | "denied" | "failed" | "timed-out" };

export interface SshHostKeyReaderDeps {
  platform: NodeJS.Platform;
  procRoot: string;
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  readlink(file: string): Promise<string>;
  /** The only way a key file is opened: the reader asks only for `.pub` siblings. */
  open(file: string, flags: number): Promise<fs.FileHandle>;
  /** Identity of a configured private key, compared with its `.pub`; never opens it. */
  stat(file: string): Promise<{ dev: number; ino: number }>;
  /** Whether `binary` is one this Host would run: owned by root or this user, writable by no one else. */
  trustBinary(binary: string): Promise<boolean>;
  runConfigDump(binary: string, args: string[], timeoutMs: number): Promise<ConfigDumpResult>;
  now(): number;
}

interface SshdOptions {
  configFile: string | null;
  hostKeys: string[];
  /** Each `-o`, kept for `sshd -G` to apply as the daemon did. */
  overrides: string[];
  ports: string[];
  addressFamily: "-4" | "-6" | null;
  notAListener: boolean;
}

interface Candidate {
  pid: number;
  ppid: number;
  startTime: string;
  argv: string[] | null;
  /** The argv came from a retitled command line, joined by spaces. */
  retitled: boolean;
}

function errnoOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

/** ppid and start time from `/proc/<pid>/stat`, read past the command name, which may hold spaces. */
function parseStat(stat: string): { ppid: number; startTime: string } | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  return Number.isInteger(ppid) && startTime ? { ppid, startTime } : null;
}

/** sshd's options, by its getopt string, from argv after the program name. */
export function parseSshdArgs(args: readonly string[]): SshdOptions | null {
  const options: SshdOptions = {
    configFile: null,
    hostKeys: [],
    overrides: [],
    ports: [],
    addressFamily: null,
    notAListener: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // sshd takes no operands: anything else means this isn't a command line read right.
    if (!arg.startsWith("-") || arg === "-") return null;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j]!;
      if (!OPTIONS_WITH_ARGUMENT.has(flag)) {
        if (NOT_A_LISTENER.has(flag)) options.notAListener = true;
        else if (flag === "4" || flag === "6") options.addressFamily = `-${flag}`;
        else if (!OTHER_FLAGS.has(flag)) return null;
        continue;
      }
      const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
      if (value === undefined) return null;
      if (flag === "f") options.configFile = value;
      else if (flag === "h") options.hostKeys.push(value);
      else if (flag === "o") options.overrides.push(value);
      else if (flag === "p") options.ports.push(value);
      break;
    }
  }
  return options;
}

/** `HostKey` paths named by `-o`, as sshd reads `-o` lines: keyword, then `=` or whitespace. */
function overrideHostKeys(overrides: readonly string[]): string[] {
  const keys: string[] = [];
  for (const line of overrides) {
    const match = /^\s*hostkey\s*(?:=\s*|\s+)(.+?)\s*$/i.exec(line);
    if (match) keys.push(match[1]!.replace(/^"(.*)"$/, "$1"));
  }
  return keys;
}

function configDumpArgs(options: SshdOptions): string[] {
  const args = ["-G"];
  if (options.configFile !== null) args.push("-f", options.configFile);
  for (const key of options.hostKeys) args.push("-h", key);
  for (const line of options.overrides) args.push("-o", line);
  for (const port of options.ports) args.push("-p", port);
  if (options.addressFamily) args.push(options.addressFamily);
  return args;
}

function parseConfigDump(stdout: string): { hostKeys: string[]; listenAddresses: string[] } {
  const hostKeys: string[] = [];
  const listenAddresses: string[] = [];
  for (const line of stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const keyword = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    if (!value) continue;
    if (keyword === "hostkey") hostKeys.push(value);
    else if (keyword === "listenaddress") listenAddresses.push(value);
  }
  return { hostKeys, listenAddresses };
}

/**
 * Reads the public sibling of `hostKeyPath`. The private key itself is only
 * ever `stat`ed, to refuse a `.pub` that is the same file under another name.
 */
async function readPublicSibling(
  deps: SshHostKeyReaderDeps,
  hostKeyPath: string,
  configured: ReadonlySet<string>
): Promise<SshHostKeyFile> {
  const publicKeyPath = `${hostKeyPath}.pub`;
  const gap = (outcome: Exclude<SshHostKeyFile["outcome"], "read">): SshHostKeyFile => ({
    outcome,
    hostKeyPath,
    publicKeyPath,
  });
  if (!path.posix.isAbsolute(hostKeyPath)) return gap("relative-path");
  if (configured.has(publicKeyPath)) return gap("not-a-public-file");
  let handle: fs.FileHandle;
  try {
    handle = await deps.open(
      publicKeyPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return gap("missing");
    if (code === "EACCES" || code === "EPERM") return gap("permission-denied");
    if (code === "ELOOP") return gap("not-a-public-file");
    return gap("unreadable");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return gap("not-a-public-file");
    try {
      const privateKey = await deps.stat(hostKeyPath);
      if (privateKey.dev === info.dev && privateKey.ino === info.ino) {
        return gap("not-a-public-file");
      }
    } catch {
      // A private key this user can't stat can't be the file it just opened.
    }
    if (info.size > MAX_PUBLIC_FILE_BYTES) return gap("invalid");
    const buffer = Buffer.alloc(MAX_PUBLIC_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PUBLIC_FILE_BYTES) return gap("invalid");
    const parsed = parsePublicKeyFile(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!parsed) return gap("invalid");
    return { outcome: "read", hostKeyPath, publicKeyPath, ...parsed };
  } catch (error) {
    const code = errnoOf(error);
    return gap(code === "EACCES" || code === "EPERM" ? "permission-denied" : "unreadable");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readOrNull(deps: SshHostKeyReaderDeps, file: string): Promise<string | null> {
  try {
    return await deps.readFile(file);
  } catch {
    return null;
  }
}

/** How many PID namespaces deep a process is, from the `NSpid` line of its status. */
function pidNamespaceDepth(status: string | null): number | null {
  const line = status?.split("\n").find((row) => row.startsWith("NSpid:"));
  return line ? line.slice("NSpid:".length).trim().split(/\s+/).length : null;
}

async function inOtherNamespace(deps: SshHostKeyReaderDeps, pid: number): Promise<boolean> {
  const proc = (rest: string) => path.posix.join(deps.procRoot, rest);
  const [own, theirs] = await Promise.all([
    readOrNull(deps, proc("self/status")),
    readOrNull(deps, proc(`${pid}/status`)),
  ]);
  const ownDepth = pidNamespaceDepth(own);
  const theirDepth = pidNamespaceDepth(theirs);
  if (ownDepth !== null && theirDepth !== null && theirDepth > ownDepth) return true;
  // Another user's daemon hides its namespaces; the PID depth above still shows a container.
  const [ownMount, theirMount] = await Promise.all([
    deps.readlink(proc("self/ns/mnt")).catch(() => null),
    deps.readlink(proc(`${pid}/ns/mnt`)).catch(() => null),
  ]);
  return ownMount !== null && theirMount !== null && ownMount !== theirMount;
}

async function candidateOf(deps: SshHostKeyReaderDeps, pid: number): Promise<Candidate | null> {
  const dir = path.posix.join(deps.procRoot, String(pid));
  const comm = await readOrNull(deps, `${dir}/comm`);
  // OpenSSH 9.8+ runs each connection as `sshd-session` (and 10.0 `sshd-auth`).
  if (comm?.trim() !== "sshd") return null;
  const stat = await readOrNull(deps, `${dir}/stat`);
  const parsed = stat ? parseStat(stat) : null;
  if (!parsed) return null;
  const cmdline = await readOrNull(deps, `${dir}/cmdline`);
  const argv = cmdline
    ? cmdline.split("\0").filter((arg, i, all) => i < all.length - 1 || arg)
    : [];
  if (argv.length === 1 && argv[0]!.startsWith("sshd: ")) {
    const title = LISTENER_TITLE.exec(argv[0]!);
    // Any other title is a connection's: `sshd: user [priv]`, `sshd: user@pts/0`, `[accepted]`.
    if (!title) return null;
    return { pid, ...parsed, argv: title[1]!.split(" "), retitled: true };
  }
  return { pid, ...parsed, argv: argv.length > 0 ? argv : null, retitled: false };
}

function listenerIdOf(configFile: string | null, listenAddresses: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([configFile ?? "", [...listenAddresses].sort()]))
    .digest("hex");
  return `sshd:${digest.slice(0, 32)}`;
}

async function readListener(
  deps: SshHostKeyReaderDeps,
  candidate: Candidate,
  options: SshdOptions | null,
  deadline: number
): Promise<SshListenerReading> {
  const gaps = new Set<SshListenerGap>();
  const reading = (
    keys: SshHostKeyFile[],
    listenAddresses: string[] = [],
    identified = false
  ): SshListenerReading => ({
    listenerId: identified ? listenerIdOf(options?.configFile ?? null, listenAddresses) : null,
    pid: candidate.pid,
    complete: gaps.size === 0 && keys.every((key) => key.outcome === "read"),
    gaps: [...gaps],
    configFile: options?.configFile ?? null,
    listenAddresses: listenAddresses.slice(0, MAX_SSH_LISTEN_ADDRESSES),
    keys,
  });
  if (!options) {
    gaps.add("command-line-unreadable");
    return reading([]);
  }
  if (await inOtherNamespace(deps, candidate.pid)) {
    gaps.add("other-namespace");
    return reading([]);
  }
  const relative = [options.configFile ?? "/", ...options.hostKeys].some(
    (file) => !path.posix.isAbsolute(file)
  );
  if (relative) {
    gaps.add("relative-path");
    return reading([]);
  }

  // The kernel's link to the running binary, else the absolute program name it was started as,
  // which is also where an upgrade that replaced the running binary put the new one.
  const exe = await deps
    .readlink(path.posix.join(deps.procRoot, String(candidate.pid), "exe"))
    .catch(() => null);
  const binary = exe && !exe.endsWith(" (deleted)") ? exe : candidate.argv![0]!;
  const trusted = path.posix.isAbsolute(binary) && (await deps.trustBinary(binary));

  let hostKeys: string[];
  let listenAddresses: string[] = [];
  let identified = false;
  const explicitKeys = [...options.hostKeys, ...overrideHostKeys(options.overrides)];
  const remaining = deadline - deps.now();
  if (!trusted) {
    gaps.add("untrusted-binary");
    hostKeys = explicitKeys;
  } else if (remaining <= 0) {
    gaps.add("timed-out");
    hostKeys = explicitKeys;
  } else {
    const dump = await deps.runConfigDump(
      binary,
      configDumpArgs(options),
      Math.min(CONFIG_DUMP_TIMEOUT_MS, remaining)
    );
    if (dump.ok) {
      ({ hostKeys, listenAddresses } = parseConfigDump(dump.stdout));
      identified = true;
    } else {
      gaps.add(
        dump.reason === "unsupported"
          ? "config-dump-unavailable"
          : dump.reason === "denied"
            ? "config-unreadable"
            : dump.reason === "timed-out"
              ? "timed-out"
              : "config-dump-failed"
      );
      hostKeys = explicitKeys;
    }
  }

  const unique = [...new Set(hostKeys)];
  if (unique.length > MAX_SSH_HOST_KEYS_PER_LISTENER) gaps.add("truncated");
  const configured = new Set(unique);
  const keys: SshHostKeyFile[] = [];
  for (const hostKey of unique.slice(0, MAX_SSH_HOST_KEYS_PER_LISTENER)) {
    keys.push(await readPublicSibling(deps, hostKey, configured));
  }

  // A pid reused mid-read would join two processes' evidence.
  const after = await readOrNull(deps, path.posix.join(deps.procRoot, `${candidate.pid}/stat`));
  if (after === null || parseStat(after)?.startTime !== candidate.startTime) {
    gaps.add("exited");
    return reading([]);
  }
  return reading(keys, listenAddresses, identified);
}

/**
 * The SSH host public keys of every sshd listener this Host's user can see,
 * grouped by listener (#18257). Linux only: listeners are found in `/proc`,
 * their `HostKey`s resolved with `sshd -G`, which parses configuration and
 * never loads keys (not `-T`, which does), and each key read from its `.pub`
 * sibling. A private key is never opened.
 */
export async function readSshHostKeys(deps: SshHostKeyReaderDeps): Promise<SshHostKeysAnswer> {
  if (deps.platform !== "linux") {
    return { status: "unsupported-platform", platform: deps.platform };
  }
  const deadline = deps.now() + READ_DEADLINE_MS;
  let entries: string[];
  try {
    entries = await deps.readdir(deps.procRoot);
  } catch {
    return { status: "discovery-failed" };
  }
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  const candidates = (await Promise.all(pids.map((pid) => candidateOf(deps, pid)))).filter(
    (candidate): candidate is Candidate => candidate !== null
  );
  const sshdPids = new Set(candidates.map((candidate) => candidate.pid));

  const listeners: Array<{ candidate: Candidate; options: SshdOptions | null }> = [];
  for (const candidate of candidates) {
    // Before OpenSSH 8.2 a connection's process keeps the listener's argv for a moment.
    if (sshdPids.has(candidate.ppid)) continue;
    const options = candidate.argv ? parseSshdArgs(candidate.argv.slice(1)) : null;
    if (options?.notAListener) continue;
    if (candidate.argv && path.posix.basename(candidate.argv[0]!) !== "sshd") continue;
    listeners.push({ candidate, options });
  }
  if (listeners.length === 0) return { status: "no-sshd-visible" };

  listeners.sort((a, b) => a.candidate.pid - b.candidate.pid);
  const truncated = listeners.length > MAX_SSH_LISTENERS;
  const readings: SshListenerReading[] = [];
  for (const { candidate, options } of listeners.slice(0, MAX_SSH_LISTENERS)) {
    readings.push(await readListener(deps, candidate, options, deadline));
  }

  // Two listeners with one identity can't be told apart, so neither is a baseline.
  const seen = new Map<string, number>();
  for (const reading of readings) {
    if (reading.listenerId) seen.set(reading.listenerId, (seen.get(reading.listenerId) ?? 0) + 1);
  }
  for (const reading of readings) {
    if (reading.listenerId && seen.get(reading.listenerId)! > 1) reading.listenerId = null;
  }
  return {
    status: "reading",
    complete: !truncated && readings.every((reading) => reading.complete),
    truncated,
    listeners: readings,
  };
}

async function trustBinary(binary: string): Promise<boolean> {
  const uid = process.getuid?.() ?? -1;
  const safe = (info: { uid: number; mode: number }) =>
    (info.uid === 0 || info.uid === uid) && (info.mode & 0o022) === 0;
  try {
    const real = await fs.realpath(binary);
    const [file, dir] = await Promise.all([fs.stat(real), fs.stat(path.dirname(real))]);
    return file.isFile() && safe(file) && safe(dir);
  } catch {
    return false;
  }
}

function runConfigDump(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<ConfigDumpResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_CONFIG_DUMP_BYTES,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout });
        if (errnoOf(error) === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return resolve({ ok: false, reason: "failed" });
        }
        if ((error as { killed?: boolean }).killed)
          return resolve({ ok: false, reason: "timed-out" });
        if (/(illegal|invalid|unknown) option/i.test(stderr)) {
          return resolve({ ok: false, reason: "unsupported" });
        }
        if (/permission denied/i.test(stderr)) return resolve({ ok: false, reason: "denied" });
        resolve({ ok: false, reason: "failed" });
      }
    );
  });
}

export const systemSshHostKeyReaderDeps: SshHostKeyReaderDeps = {
  platform: process.platform,
  procRoot: "/proc",
  readFile: (file) => fs.readFile(file, "utf8"),
  readdir: (dir) => fs.readdir(dir),
  readlink: (file) => fs.readlink(file),
  open: (file, flags) => fs.open(file, flags),
  stat: (file) => fs.stat(file),
  trustBinary,
  runConfigDump,
  now: () => Date.now(),
};

/**
 * This Host's reader, one read at a time: Shells asking together share it,
 * so no number of callers runs more than one set of `sshd -G` at once.
 */
export function createSshHostKeysReader(
  deps: SshHostKeyReaderDeps = systemSshHostKeyReaderDeps
): () => Promise<SshHostKeysAnswer> {
  let inFlight: Promise<SshHostKeysAnswer> | null = null;
  return () => {
    inFlight ??= readSshHostKeys(deps).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
