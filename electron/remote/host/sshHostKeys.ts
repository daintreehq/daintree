import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../../utils/logger.js";
import {
  MAX_SSH_ANSWER_KEY_BYTES,
  MAX_SSH_HOST_KEYS_PER_LISTENER,
  MAX_SSH_LISTEN_ADDRESS_LENGTH,
  MAX_SSH_LISTEN_ADDRESSES,
  MAX_SSH_LISTENERS,
  MAX_SSH_PATH_LENGTH,
  SshHostKeysAnswerSchema,
  type SshHostKeyFile,
  type SshHostKeysAnswer,
  type SshListenerGap,
  type SshListenerReading,
} from "./linkMethods.js";
import { MAX_PUBLIC_KEY_LENGTH, parsePublicKeyFile } from "./sshPublicKey.js";

const logger = createLogger("main:sshHostKeys");

/** One `sshd -G` may take this long; a config on a slow mount shouldn't hold the answer. */
const CONFIG_DUMP_TIMEOUT_MS = 2_000;
/** No `sshd -G` starts after this much of the read has passed. */
const READ_DEADLINE_MS = 5_000;
/** Callers get an answer by now even when a read is stuck in the filesystem. */
const ANSWER_DEADLINE_MS = 6_000;
const MAX_CONFIG_DUMP_BYTES = 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
/** A `.pub` larger than any key line plus a long comment isn't one. */
const MAX_PUBLIC_FILE_BYTES = MAX_PUBLIC_KEY_LENGTH + 4096;
/** `/proc` entries read at once, so a busy machine doesn't run the Host out of descriptors. */
const DISCOVERY_CONCURRENCY = 32;
/** An sshd's options, as its getopt string has them: these take an argument. */
const OPTIONS_WITH_ARGUMENT = new Set(["C", "E", "b", "c", "f", "g", "h", "k", "o", "p", "u"]);
/** A per-connection re-exec, inetd mode, or a config test or dump: never a listener. */
const NOT_A_LISTENER = new Set(["R", "i", "t", "T", "G", "V"]);
/** `-Q` has been accepted and ignored since OpenSSH 7.4. */
const OTHER_FLAGS = new Set(["D", "d", "e", "q", "r", "Q"]);
/** OpenSSH 8.2+ retitles a listener; the command line is the args joined by spaces. */
const LISTENER_TITLE = /^sshd: (\S.*?) \[listener\] \d+ of [\d-]+ startups$/;
const GLOB = /[*?[]/;

export type ConfigDumpResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "unsupported" | "denied" | "failed" | "timed-out" };

interface FileIdentity {
  dev: number;
  ino: number;
}

export interface SshHostKeyReaderDeps {
  platform: NodeJS.Platform;
  procRoot: string;
  /** Where sshd looks without `-f`; a relative `Include` is relative to its directory. */
  defaultConfigFile: string;
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  readlink(file: string): Promise<string>;
  /** The only way a key file is opened: the reader asks only for `.pub` siblings. */
  open(file: string, flags: number): Promise<fs.FileHandle>;
  /** Identity of a configured private key, to keep it from being opened under another name. */
  stat(file: string): Promise<FileIdentity>;
  /** A `.pub`'s own entry, symlink unfollowed, checked before it is opened. */
  lstat(file: string): Promise<FileIdentity & { isFile(): boolean }>;
  /** Whether this user can read a file, or list a directory, `sshd -G` would include. */
  canRead(file: string, directory: boolean): Promise<boolean>;
  /**
   * The verified file `binary` resolves to, when it is an sshd this Host would
   * run: every directory on its path, and the file, owned by root or this user
   * and writable by no one else. Null otherwise.
   */
  trustBinary(binary: string): Promise<string | null>;
  runConfigDump(binary: string, args: string[], timeoutMs: number): Promise<ConfigDumpResult>;
  now(): number;
}

interface SshdOptions {
  configFile: string | null;
  hostKeys: string[];
  /** `-o` lines naming a `HostKey`. */
  overrideHostKeys: string[];
  /** The options `sshd -G` must see, in the daemon's order: a later one can override an earlier. */
  replay: string[];
  notAListener: boolean;
}

interface Candidate {
  pid: number;
  ppid: number;
  startTime: string;
  /** Null when the command line couldn't be read or recovered. */
  argv: string[] | null;
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

/** `HostKey` named by one `-o` line, as sshd reads it: keyword, then `=` or whitespace. */
function overrideHostKey(line: string): string | null {
  const match = /^\s*hostkey\s*(?:=\s*|\s+)(.+?)\s*$/i.exec(line);
  return match ? match[1]!.replace(/^"(.*)"$/, "$1") : null;
}

/** sshd's options, by its getopt string, from argv after the program name. */
export function parseSshdArgs(args: readonly string[]): SshdOptions | null {
  const options: SshdOptions = {
    configFile: null,
    hostKeys: [],
    overrideHostKeys: [],
    replay: [],
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
        else if (flag === "4" || flag === "6") options.replay.push(`-${flag}`);
        else if (!OTHER_FLAGS.has(flag)) return null;
        continue;
      }
      const value = j + 1 < arg.length ? arg.slice(j + 1) : args[++i];
      if (value === undefined) return null;
      if (flag === "f") options.configFile = value;
      if (flag === "h") options.hostKeys.push(value);
      if (flag === "o") {
        const hostKey = overrideHostKey(value);
        if (hostKey !== null) options.overrideHostKeys.push(hostKey);
      }
      if ("fhop".includes(flag)) options.replay.push(`-${flag}`, value);
      break;
    }
  }
  return options;
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

/** A path sshd resolves against its own working directory or user, not this Host's. */
function contextDependent(file: string): boolean {
  return !path.posix.isAbsolute(file);
}

async function readOrNull(deps: SshHostKeyReaderDeps, file: string): Promise<string | null> {
  try {
    return await deps.readFile(file);
  } catch {
    return null;
  }
}

/**
 * What a process sees as `/`: the device and the path within it of its root
 * mount, from `mountinfo`, which anyone may read. Another container's or a
 * chroot's root differs; a sandboxed unit's private mount namespace doesn't.
 */
function rootMount(mountinfo: string | null): string | null {
  for (const line of mountinfo?.split("\n") ?? []) {
    const fields = line.split(" ");
    if (fields[4] === "/") return `${fields[2]} ${fields[3]}`;
  }
  return null;
}

async function rootView(
  deps: SshHostKeyReaderDeps,
  pid: number
): Promise<"same" | "different" | "unknown"> {
  const proc = (rest: string) => path.posix.join(deps.procRoot, rest);
  const [ownStatus, theirStatus, ownMounts, theirMounts] = await Promise.all([
    readOrNull(deps, proc("self/status")),
    readOrNull(deps, proc(`${pid}/status`)),
    readOrNull(deps, proc("self/mountinfo")),
    readOrNull(deps, proc(`${pid}/mountinfo`)),
  ]);
  const depth = (status: string | null) =>
    status
      ?.split("\n")
      .find((row) => row.startsWith("NSpid:"))
      ?.slice("NSpid:".length)
      .trim()
      .split(/\s+/).length ?? null;
  const ownDepth = depth(ownStatus);
  const theirDepth = depth(theirStatus);
  if (ownDepth !== null && theirDepth !== null && theirDepth > ownDepth) return "different";
  const own = rootMount(ownMounts);
  const theirs = rootMount(theirMounts);
  if (own === null || theirs === null) return "unknown";
  return own === theirs ? "same" : "different";
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
    if (title) return { pid, ...parsed, argv: title[1]!.split(" ") };
    // A connection's title starts with its user (`sshd: alice [priv]`, `[accepted]`); a
    // listener's with its program path, which a long title can lose its end past.
    return argv[0]!.startsWith("sshd: /") ? { pid, ...parsed, argv: null } : null;
  }
  return { pid, ...parsed, argv: argv.length > 0 ? argv : null };
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(run))));
  }
  return results;
}

/** Whether every `Include` of `configFile` is one this user can read, so `-G` saw it all. */
async function includesReadable(
  deps: SshHostKeyReaderDeps,
  configFile: string,
  privateKeys: ReadonlySet<string>
): Promise<boolean> {
  if (privateKeys.has(configFile)) return false;
  const text = await readOrNull(deps, configFile);
  if (text === null || text.length > MAX_CONFIG_FILE_BYTES) return false;
  for (const line of text.split("\n")) {
    const match = /^\s*include\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    for (const raw of match[1]!.split(/\s+/)) {
      const sshdDir = path.posix.dirname(deps.defaultConfigFile);
      const pattern = path.posix.resolve(sshdDir, raw.replace(/^"(.*)"$/, "$1"));
      const dir = path.posix.dirname(pattern);
      // A glob above the last component can't be checked one directory at a time.
      if (GLOB.test(dir)) return false;
      const listed = GLOB.test(path.posix.basename(pattern));
      if (!(await deps.canRead(listed ? dir : pattern, listed))) return false;
    }
  }
  return true;
}

/**
 * Reads the public sibling of `hostKeyPath`. Its entry is checked before it is
 * opened: a symlink, anything not a regular file, or the very inode of a
 * configured private key is refused unopened. The open then refuses a
 * symlink swapped in meanwhile, and a different file is refused unread.
 */
async function readPublicSibling(
  deps: SshHostKeyReaderDeps,
  hostKeyPath: string,
  configured: ReadonlySet<string>,
  privateInodes: ReadonlySet<string>
): Promise<SshHostKeyFile> {
  const publicKeyPath = `${hostKeyPath}.pub`;
  const gap = (outcome: Exclude<SshHostKeyFile["outcome"], "read">): SshHostKeyFile => ({
    outcome,
    hostKeyPath,
    publicKeyPath,
  });
  if (contextDependent(hostKeyPath)) return gap("relative-path");
  if (configured.has(publicKeyPath)) return gap("not-a-public-file");
  const fileGap = (error: unknown) => {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return gap("missing");
    if (code === "EACCES" || code === "EPERM") return gap("permission-denied");
    if (code === "ELOOP") return gap("not-a-public-file");
    return gap("unreadable");
  };
  let entry: FileIdentity & { isFile(): boolean };
  try {
    entry = await deps.lstat(publicKeyPath);
  } catch (error) {
    return fileGap(error);
  }
  if (!entry.isFile() || privateInodes.has(`${entry.dev}:${entry.ino}`)) {
    return gap("not-a-public-file");
  }
  let handle: fs.FileHandle;
  try {
    handle = await deps.open(
      publicKeyPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
    );
  } catch (error) {
    return fileGap(error);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) {
      return gap("not-a-public-file");
    }
    if (info.size > MAX_PUBLIC_FILE_BYTES) return gap("invalid");
    const buffer = Buffer.alloc(MAX_PUBLIC_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PUBLIC_FILE_BYTES) return gap("invalid");
    const parsed = parsePublicKeyFile(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!parsed) return gap("invalid");
    return { outcome: "read", hostKeyPath, publicKeyPath, ...parsed };
  } catch (error) {
    return fileGap(error);
  } finally {
    await handle.close().catch(() => {});
  }
}

function listenerIdOf(configFile: string | null, listenAddresses: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([configFile ?? "", [...listenAddresses].sort()]))
    .digest("hex");
  return `sshd:${digest.slice(0, 32)}`;
}

/** How many bytes of key text and paths an answer has room for still, shared by every listener. */
interface Budget {
  bytes: number;
}

async function readListener(
  deps: SshHostKeyReaderDeps,
  candidate: Candidate,
  options: SshdOptions | null,
  deadline: number,
  budget: Budget
): Promise<SshListenerReading> {
  const gaps = new Set<SshListenerGap>();
  const configFile =
    options?.configFile && options.configFile.length <= MAX_SSH_PATH_LENGTH
      ? options.configFile
      : null;
  const reading = (
    keys: SshHostKeyFile[],
    listenAddresses: string[] = [],
    identified = false
  ): SshListenerReading => ({
    listenerId: identified ? listenerIdOf(configFile, listenAddresses) : null,
    pid: candidate.pid,
    complete: gaps.size === 0 && keys.length > 0 && keys.every((key) => key.outcome === "read"),
    gaps: [...gaps],
    configFile,
    listenAddresses,
    keys,
  });
  if (!options || (options.configFile !== null && configFile === null)) {
    gaps.add("command-line-unreadable");
    return reading([]);
  }
  const view = await rootView(deps, candidate.pid);
  if (view !== "same") {
    gaps.add(view === "different" ? "other-namespace" : "namespace-unknown");
    return reading([]);
  }
  const named = [...options.hostKeys, ...options.overrideHostKeys];
  if (
    (configFile !== null && configFile !== "none" && contextDependent(configFile)) ||
    named.some(contextDependent)
  ) {
    gaps.add("relative-path");
    return reading([]);
  }

  // The kernel's link to the running binary, else the absolute program name it was started as,
  // which is also where an upgrade that replaced the running binary put the new one.
  const exe = await deps
    .readlink(path.posix.join(deps.procRoot, String(candidate.pid), "exe"))
    .catch(() => null);
  const named0 = exe && !exe.endsWith(" (deleted)") ? exe : candidate.argv![0]!;
  const binary = path.posix.isAbsolute(named0) ? await deps.trustBinary(named0) : null;

  let hostKeys = named;
  let listenAddresses: string[] = [];
  let identified = false;
  const remaining = deadline - deps.now();
  if (binary === null) {
    gaps.add("untrusted-binary");
  } else if (remaining <= 0) {
    gaps.add("timed-out");
  } else {
    const dump = await deps.runConfigDump(
      binary,
      ["-G", ...options.replay],
      Math.min(CONFIG_DUMP_TIMEOUT_MS, remaining)
    );
    if (dump.ok) {
      const parsed = parseConfigDump(dump.stdout);
      hostKeys = parsed.hostKeys;
      const fitting = parsed.listenAddresses.filter(
        (address) => address.length <= MAX_SSH_LISTEN_ADDRESS_LENGTH
      );
      if (
        fitting.length > MAX_SSH_LISTEN_ADDRESSES ||
        fitting.length < parsed.listenAddresses.length
      ) {
        gaps.add("truncated");
      }
      listenAddresses = fitting.slice(0, MAX_SSH_LISTEN_ADDRESSES);
      identified = true;
      if (
        configFile !== "none" &&
        !(await includesReadable(deps, configFile ?? deps.defaultConfigFile, new Set(hostKeys)))
      ) {
        gaps.add("config-unreadable");
      }
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
    }
  }

  const unique = [...new Set(hostKeys)];
  const fitting = unique.filter((key) => key.length + ".pub".length <= MAX_SSH_PATH_LENGTH);
  if (fitting.length < unique.length || fitting.length > MAX_SSH_HOST_KEYS_PER_LISTENER) {
    gaps.add("truncated");
  }
  const configured = new Set(unique);
  const privateInodes = new Set<string>();
  for (const key of unique) {
    if (contextDependent(key)) continue;
    const info = await deps.stat(key).catch(() => null);
    if (info) privateInodes.add(`${info.dev}:${info.ino}`);
  }
  const keys: SshHostKeyFile[] = [];
  for (const hostKey of fitting.slice(0, MAX_SSH_HOST_KEYS_PER_LISTENER)) {
    const key = await readPublicSibling(deps, hostKey, configured, privateInodes);
    const size =
      key.hostKeyPath.length +
      key.publicKeyPath.length +
      (key.outcome === "read" ? key.publicKey.length : 0);
    if (size > budget.bytes) {
      gaps.add("truncated");
      break;
    }
    budget.bytes -= size;
    keys.push(key);
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
  const candidates = (
    await mapLimited(pids, DISCOVERY_CONCURRENCY, (pid) => candidateOf(deps, pid))
  ).filter((candidate): candidate is Candidate => candidate !== null);
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
  const budget: Budget = { bytes: MAX_SSH_ANSWER_KEY_BYTES };
  const readings: SshListenerReading[] = [];
  for (const { candidate, options } of listeners.slice(0, MAX_SSH_LISTENERS)) {
    readings.push(await readListener(deps, candidate, options, deadline, budget));
  }

  // Two listeners with one identity can't be told apart, so neither is a baseline; and
  // past the cap, a listener left out could share any identity read.
  const seen = new Map<string, number>();
  for (const reading of readings) {
    if (reading.listenerId) seen.set(reading.listenerId, (seen.get(reading.listenerId) ?? 0) + 1);
  }
  for (const reading of readings) {
    if (truncated || (reading.listenerId && seen.get(reading.listenerId)! > 1)) {
      reading.listenerId = null;
    }
  }
  return {
    status: "reading",
    complete: !truncated && readings.every((reading) => reading.complete),
    truncated,
    listeners: readings,
  };
}

async function trustBinary(binary: string): Promise<string | null> {
  const uid = process.getuid?.() ?? -1;
  const safe = (info: { uid: number; mode: number }) =>
    (info.uid === 0 || info.uid === uid) && (info.mode & 0o022) === 0;
  try {
    const real = await fs.realpath(binary);
    if (path.posix.basename(real) !== "sshd") return null;
    const file = await fs.stat(real);
    if (!file.isFile() || !safe(file)) return null;
    // Nobody else may swap the file between this check and the run, through any directory.
    for (let dir = path.posix.dirname(real); ; dir = path.posix.dirname(dir)) {
      if (!safe(await fs.stat(dir))) return null;
      if (dir === "/") break;
    }
    return real;
  } catch {
    return null;
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
        // sshd resolves a relative `HostKey` against its working directory, `/` under init.
        cwd: "/",
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
        if (/permission denied|no such file/i.test(stderr)) {
          return resolve({ ok: false, reason: "denied" });
        }
        resolve({ ok: false, reason: "failed" });
      }
    );
  });
}

export const systemSshHostKeyReaderDeps: SshHostKeyReaderDeps = {
  platform: process.platform,
  procRoot: "/proc",
  defaultConfigFile: "/etc/ssh/sshd_config",
  readFile: (file) => fs.readFile(file, "utf8"),
  readdir: (dir) => fs.readdir(dir),
  readlink: (file) => fs.readlink(file),
  open: (file, flags) => fs.open(file, flags),
  stat: (file) => fs.stat(file),
  lstat: (file) => fs.lstat(file),
  canRead: (file, directory) =>
    fs.access(file, directory ? fsConstants.R_OK | fsConstants.X_OK : fsConstants.R_OK).then(
      () => true,
      () => false
    ),
  trustBinary,
  runConfigDump,
  now: () => Date.now(),
};

/**
 * This Host's reader, one read at a time: Shells asking together share it,
 * so no number of callers runs more than one set of `sshd -G` at once. A read
 * stuck in the filesystem keeps later callers sharing it rather than stacking
 * more, and each gets `timed-out` on time.
 */
export function createSshHostKeysReader(
  deps: SshHostKeyReaderDeps = systemSshHostKeyReaderDeps,
  answerDeadlineMs = ANSWER_DEADLINE_MS
): () => Promise<SshHostKeysAnswer> {
  let inFlight: Promise<SshHostKeysAnswer> | null = null;
  return () => {
    inFlight ??= readSshHostKeys(deps)
      .then((answer) => {
        if (SshHostKeysAnswerSchema.safeParse(answer).success) return answer;
        logger.warn("An SSH host key reading didn't fit its answer; reporting discovery failed");
        return { status: "discovery-failed" } as const;
      })
      .catch((error: unknown) => {
        logger.warn("Couldn't read this machine's SSH host keys", { error });
        return { status: "discovery-failed" } as const;
      })
      .finally(() => {
        inFlight = null;
      });
    const work = inFlight;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<SshHostKeysAnswer>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timed-out" }), answerDeadlineMs);
      timer.unref?.();
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  };
}
