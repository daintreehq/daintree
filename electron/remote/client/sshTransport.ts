import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { ATTACH_STDIO_FLAG } from "../host/attachStdio.js";
import { parseDiscoveryInfo, type HostDiscoveryInfo } from "../host/discoveryFile.js";
import {
  maxSocketPathBytes,
  remoteHostSocketLocation,
  type SocketPlatform,
} from "../host/hostSocketPath.js";
import type { CommandRunner } from "./commandRunner.js";
import { createCommandStreamTransport, type StreamCommandChild } from "./commandStreamTransport.js";
import { sshExecutable } from "./sshExecutable.js";
import { isValidSshTarget } from "../../../shared/utils/sshTarget.js";
import {
  HostModeOffError,
  SshAccessError,
  TransportError,
  connectUnixSocket,
  isSshAccessDenied,
  type LinkOpenOptions,
  type LinkTransport,
  type LinkTransportConnection,
} from "./transport.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("main:sshTransport");

/**
 * Reach a host through the system `ssh`, never an SSH library, so the user's
 * ~/.ssh/config, agents (ssh-agent, 1Password, Secure Enclave keys) and
 * Tailscale SSH all apply unchanged. Nothing here overrides identity, host-key
 * or agent settings. One ControlMaster connection per host is shared by the
 * probe, the discovery read and the socket forward.
 *
 *   1. `ssh <target> 'echo; uname -s; id -u; echo "$HOME"'` to derive where
 *      the host's discovery file lives on that machine.
 *   2. `ssh <target> sh -c '...cat...' sh <discovery file>` for the socket
 *      path and token, framed by markers.
 *   3. `ssh -O forward -L <local.sock>:<remote.sock> <target>` through that
 *      master (or, with no master, a dedicated `ssh -N -L`), then dial
 *      local.sock.
 *
 * A server with `AllowStreamLocalForwarding no` still accepts step 3 (`-L`
 * binds on this side) and refuses each connection through it, so before the
 * first forward `ssh -W <remote.sock>` opens one channel to the socket and
 * reads ssh's own words back. Refused, the link runs over
 * `ssh <target> -- <daintree> --attach-stdio` instead: the host's bridge
 * carries it over the session's stdio (see host/attachStdio.ts).
 */

export interface SshChild {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SshSpawner = (args: string[]) => SshChild;

/** ssh with stdin, stdout and stderr piped: its stdio carries a link. */
export type SshStreamSpawner = (args: string[]) => StreamCommandChild;

export interface SshTransportOptions {
  /** What the user typed: `user@host`, an ~/.ssh/config alias, a tailnet name. */
  target: string;
  /** A Daintree-owned directory for the control socket and local forward (created 0700). Keep it short. */
  clientDir: string;
  spawn?: SshSpawner;
  /** For the stdio fallback; the system ssh with piped stdio unless given. */
  spawnStream?: SshStreamSpawner;
  /**
   * The remote command line that starts the host's attach bridge; from the
   * host's discovery file (`<its command> --attach-stdio`) unless given.
   */
  attachCommand?: string;
  sshPath?: string;
  commandTimeoutMs?: number;
  forwardTimeoutMs?: number;
  controlPersist?: string;
  /** Remote userData directory name on macOS (the packaged app's by default). */
  macAppDirName?: string;
  /**
   * Called once when ssh reached the host but Daintree there didn't answer,
   * unless the dial says the host may not be started: start it if it can be
   * (installed, Host mode last on), resolving true when the link should be
   * tried again. Rejects with why it couldn't start.
   */
  ensureRunning?: (signal: AbortSignal) => Promise<boolean>;
  linuxDirName?: string;
}

export interface RemoteProbe {
  platform: SocketPlatform;
  uid: number;
  home: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
/** ssh appends ".XXXXXXXXXXXXXXXX" to the control path while creating it. */
const CONTROL_PATH_TEMP_SUFFIX = 17;
const PERCENT_C_LENGTH = 40;
const POLL_MS = 50;

/**
 * Absolute paths we are willing to hand to a remote shell (single-quoted) or
 * to `-L`. Backslashes are refused because fish treats them specially inside
 * single quotes; control characters because nothing legitimate has them.
 */
function isSafeRemotePath(value: string): boolean {
  if (!value.startsWith("/")) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || value[i] === "\\") return false;
  }
  return true;
}

/**
 * `-L local:remote` splits on the colon, so forwarded paths can't contain one.
 * ssh also expands `${VAR}` (and, in `-L`, `%u`/`%d`/`%l`) in these paths
 * against this machine's environment before sending them to the host, so a
 * host that chose its socket path could read our environment back out of it.
 * A bare `$` is left alone by ssh and is fine.
 */
export const isForwardablePath = (p: string) =>
  isSafeRemotePath(p) && !p.includes(":") && !p.includes("${") && !p.includes("%");

function requireForwardable(remoteSocket: string): string {
  if (!isForwardablePath(remoteSocket)) {
    throw new TransportError(`Refusing to forward an unusual remote path: ${remoteSocket}`, null);
  }
  return remoteSocket;
}

/**
 * The host's discovery file named a socket this client won't hand to ssh.
 * Starting the host again can't change that, so no restart is attempted.
 */
export class DiscoveryRejectedError extends TransportError {
  constructor(detail: string) {
    super("Host discovery file is not valid", detail);
    this.name = "DiscoveryRejectedError";
  }
}

/** Single-quote for a POSIX, fish or csh remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * ssh splits `-o` values on whitespace, and the control directory sits under
 * userData (`~/Library/Application Support/...` on macOS), so the path is
 * double-quoted with ssh's own escapes.
 */
export function controlPathOption(controlPath: string): string {
  return `ControlPath="${controlPath.replace(/[\\"]/g, "\\$&")}"`;
}

export { isValidSshTarget };

export function defaultSshSpawner(sshPath = sshExecutable()): SshSpawner {
  return (args) =>
    spawn(sshPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as SshChild;
}

export function defaultSshStreamSpawner(sshPath = sshExecutable()): SshStreamSpawner {
  return (args) =>
    spawn(sshPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as StreamCommandChild;
}

function targetHash(target: string): string {
  return crypto.createHash("sha256").update(target).digest("hex").slice(0, 16);
}

/**
 * Changes whenever the options a master starts with change, so a master an
 * older build left running (one that may still forward the agent, say) is
 * never picked up as this build's. 1: no agent, X11 or config forwards.
 * 2: keepalives, so a master whose connection died is noticed. 3: faster
 * keepalives, now that they are what tells a link its host is gone.
 */
const CONTROL_PATH_PREFIX = "cm3-";

/**
 * `cm3-%C` when it fits the platform's socket path limit; otherwise a short
 * per-target hash (%C alone is 40 characters, and ssh adds a temporary
 * suffix while binding).
 */
export function controlPathFor(clientDir: string, target: string, platform = process.platform) {
  const limit = maxSocketPathBytes(platform);
  const withC = path.join(clientDir, `${CONTROL_PATH_PREFIX}%C`);
  const expanded = Buffer.byteLength(withC) - 2 + PERCENT_C_LENGTH + CONTROL_PATH_TEMP_SUFFIX;
  if (expanded <= limit) return withC;
  const hashed = path.join(clientDir, `${CONTROL_PATH_PREFIX}${targetHash(target)}`);
  if (Buffer.byteLength(hashed) + CONTROL_PATH_TEMP_SUFFIX > limit) {
    throw new TransportError(`SSH control directory path is too long: ${clientDir}`, null);
  }
  return hashed;
}

/** Unique per attempt so a previous attempt's cleanup can never remove this one's forward. */
export function localForwardPathFor(clientDir: string, target: string): string {
  const nonce = crypto.randomBytes(4).toString("hex");
  return path.join(clientDir, `l-${targetHash(target).slice(0, 8)}-${nonce}.sock`);
}

/**
 * Daintree opens sessions on its own (probes, reconnects, the attach bridge),
 * so nothing the user's config forwards for their interactive logins rides
 * along: no agent or X11 for each session, and none of the config's port
 * forwards on a master this call creates. `-W` is not a port forward and
 * survives ClearAllForwardings; `-O forward` requests go through the master
 * later and are unaffected.
 */
const NO_FORWARDING = [
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "ClearAllForwardings=yes",
];

/**
 * A master outlives sleeps and network changes; without keepalives a dead
 * one is reused (ControlMaster=auto) and every command through it hangs until
 * the kernel gives up on the TCP connection. They only act on the process
 * that owns the connection, which is whichever of these calls becomes the
 * master, so every call carries them. They are also how a link learns its
 * host is gone: the link itself waits out a host whose main loop is stalled,
 * and sshd answers these while it is, so a dead connection still ends the
 * link in about 20 s.
 */
const KEEPALIVE = ["-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=4"];

/**
 * Every call here names its own command, so a `RemoteCommand` in the user's
 * config for the host would make ssh refuse it ("Cannot execute command-line
 * and remote command"), and a `RequestTTY force` would put a pty under stdin
 * fed scripts and the binary attach link. `IgnoreUnknown` comes first so an
 * ssh older than 7.6, which has no `RemoteCommand`, skips it instead of
 * failing. The first `IgnoreUnknown` wins rather than adding to the user's,
 * so it is `*`: a narrower list would make options their config already
 * tolerates fatal.
 */
export const OWN_COMMAND_ARGS = [
  "-o",
  "IgnoreUnknown=*",
  "-o",
  "RemoteCommand=none",
  "-o",
  "RequestTTY=no",
];

/**
 * Left to the kernel, a host that's off or behind a route that drops packets
 * takes 75 s to refuse on macOS, past the command deadline, which then cuts
 * ssh off before it says why. It applies per address, so two that both drop
 * packets still end inside {@link SSH_COMMAND_TIMEOUT_MS}; a reused master
 * doesn't connect, so it never applies there.
 */
const CONNECT_TIMEOUT = ["-o", "ConnectTimeout=10"];

/** How long one ssh command may run before it is stopped. */
export const SSH_COMMAND_TIMEOUT_MS = 30_000;

export function sshCommonArgs(controlPath: string, controlPersist = "10m"): string[] {
  return [
    ...OWN_COMMAND_ARGS,
    "-o",
    "BatchMode=yes",
    ...CONNECT_TIMEOUT,
    ...KEEPALIVE,
    ...NO_FORWARDING,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPersist=${controlPersist}`,
    "-o",
    controlPathOption(controlPath),
  ];
}

/** The leading newline keeps a startup file's unterminated output off `uname`'s line. */
export const PROBE_COMMAND = 'echo; uname -s; id -u; echo "$HOME"';

export function buildProbeArgs(target: string, controlPath: string, persist?: string): string[] {
  return [...sshCommonArgs(controlPath, persist), "--", target, PROBE_COMMAND];
}

const DISCOVERY_START = "@@dt:discovery";
const DISCOVERY_END = "@@dt:discovery-end";
/** The read's status for a missing file: cat's message for it is in the host's locale. */
const NO_DISCOVERY_FILE_EXIT = 3;

/**
 * Prints the file between marker lines, so whatever the user's shell startup
 * files print around it is left out. The path arrives as `$1`, never spliced
 * into the script, so it is quoted once for the login shell, whichever it is.
 */
const DISCOVERY_READ_SCRIPT = `if [ -e "$1" ]; then echo; echo ${DISCOVERY_START}; cat -- "$1" || exit 1; echo; echo ${DISCOVERY_END}; else exit ${NO_DISCOVERY_FILE_EXIT}; fi`;

export function buildCatArgs(
  target: string,
  controlPath: string,
  filePath: string,
  persist?: string
): string[] {
  if (!isSafeRemotePath(filePath)) {
    throw new TransportError(`Refusing to read an unusual remote path: ${filePath}`, null);
  }
  return [
    ...sshCommonArgs(controlPath, persist),
    "--",
    target,
    `sh -c ${shellQuote(DISCOVERY_READ_SCRIPT)} sh ${shellQuote(filePath)}`,
  ];
}

/** The discovery file from the read's output; null unless it arrived whole between its markers. */
export function parseDiscoveryRead(stdout: string): HostDiscoveryInfo | null {
  const startMarker = `\n${DISCOVERY_START}\n`;
  const start = stdout.lastIndexOf(startMarker);
  if (start === -1) return null;
  const from = start + startMarker.length;
  const end = stdout.indexOf(`\n${DISCOVERY_END}\n`, from);
  if (end === -1) return null;
  return parseDiscoveryInfo(stdout.slice(from, end));
}

/** `ssh -G` prints the control path with its `%` tokens expanded. */
export function buildResolveControlPathArgs(target: string, controlPath: string): string[] {
  return ["-G", "-o", controlPathOption(controlPath), "--", target];
}

/** The expanded control path from `ssh -G`, or null when it can't be passed on as is. */
export function parseResolvedControlPath(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("controlpath ")) continue;
    const value = line.slice("controlpath ".length).replace(/\r$/, "");
    // A `%` left in it would be expanded a second time.
    return path.isAbsolute(value) && !value.includes("%") ? value : null;
  }
  return null;
}

/**
 * How a mux control command names the master. A `-O forward` or `-O cancel`
 * also sends every forward the user's config declares for the host along
 * with ours (ClearAllForwardings would drop ours too), so when the master's
 * expanded path is known the command reads no config at all.
 */
export function muxControlArgs(controlPath: string, resolvedControlPath: string | null): string[] {
  return resolvedControlPath === null
    ? ["-o", controlPathOption(controlPath)]
    : ["-F", "/dev/null", "-o", controlPathOption(resolvedControlPath)];
}

/**
 * Add the forward to the ControlMaster the probe left running. A mux client
 * given `-N -L` would also ask the master for a session, so the forward is
 * requested with `-O forward` instead.
 */
export function buildMuxForwardArgs(
  target: string,
  controlPath: string,
  localSocket: string,
  remoteSocket: string,
  resolvedControlPath: string | null = null
): string[] {
  return [
    ...muxControlArgs(controlPath, resolvedControlPath),
    "-O",
    "forward",
    "-L",
    `${localSocket}:${requireForwardable(remoteSocket)}`,
    "--",
    target,
  ];
}

/**
 * Fallback when no master is available: a dedicated connection that holds
 * the forward for as long as the child lives. Multiplexing is off for it so
 * it can never attach to a master as a session-requesting client.
 */
export function buildForwardArgs(
  target: string,
  localSocket: string,
  remoteSocket: string
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ForwardX11=no",
    ...CONNECT_TIMEOUT,
    ...KEEPALIVE,
    "-o",
    "ControlPath=none",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `${localSocket}:${requireForwardable(remoteSocket)}`,
    "--",
    target,
  ];
}

export function buildCancelArgs(
  target: string,
  controlPath: string,
  localSocket: string,
  remoteSocket: string,
  resolvedControlPath: string | null = null
): string[] {
  return [
    ...muxControlArgs(controlPath, resolvedControlPath),
    "-O",
    "cancel",
    "-L",
    `${localSocket}:${requireForwardable(remoteSocket)}`,
    "--",
    target,
  ];
}

/**
 * One channel to the host socket through the master, with nothing sent: how
 * the server answers a socket forward, in ssh's own words. stdin is closed, so
 * an accepted channel ends as soon as it opens.
 */
export function buildStreamLocalCheckArgs(
  target: string,
  controlPath: string,
  remoteSocket: string,
  persist?: string
): string[] {
  return [
    ...sshCommonArgs(controlPath, persist),
    "-W",
    requireForwardable(remoteSocket),
    "--",
    target,
  ];
}

/**
 * What ssh prints when the server refuses a channel to a socket: through a
 * master ("Stdio forwarding request failed: Session open refused by peer"),
 * or on its own connection ("channel 0: open failed: …", "stdio forwarding
 * failed"). OpenSSH says the same for a socket nobody listens on; the bridge
 * then reports that in its own words.
 */
const STREAM_LOCAL_REFUSED =
  /open failed|refused by peer|stdio forwarding (request )?failed|administratively prohibited/i;

export function isStreamLocalRefusal(stderr: string): boolean {
  return STREAM_LOCAL_REFUSED.test(stderr);
}

/** Mirrors the host's `USER_DATA_DIR_FLAG` (electron/remote/host/hostLocation.ts). */
const USER_DATA_DIR_FLAG = "--user-data-dir=";

/**
 * A part of a host's published launch command we will run: an absolute path,
 * or the profile its Host mode keeps its socket in, as `--user-data-dir=<path>`.
 */
function isSafeLaunchPart(part: string, index: number): boolean {
  if (index > 0 && part.startsWith(USER_DATA_DIR_FLAG)) {
    return isSafeRemotePath(part.slice(USER_DATA_DIR_FLAG.length));
  }
  return isSafeRemotePath(part);
}

/**
 * The launch command a host published in its discovery file, when every part
 * is one we will run (see {@link isSafeLaunchPart}); null otherwise.
 */
export function safeLaunchCommand(info: HostDiscoveryInfo): string[] | null {
  const command = info.command;
  if (!command || command.length === 0) return null;
  if (!command.every((part, index) => isSafeLaunchPart(part, index))) return null;
  return [...command];
}

/** The remote command line that starts a host's attach bridge, from its discovery file. */
export function attachCommandFor(info: HostDiscoveryInfo): string | null {
  const command = safeLaunchCommand(info);
  if (!command) return null;
  return [...command.map(shellQuote), ATTACH_STDIO_FLAG].join(" ");
}

export function buildAttachArgs(
  target: string,
  controlPath: string,
  remoteCommand: string,
  persist?: string
): string[] {
  return [...sshCommonArgs(controlPath, persist), "--", target, remoteCommand];
}

export function buildExitArgs(target: string, controlPath: string): string[] {
  return ["-o", controlPathOption(controlPath), "-O", "exit", "--", target];
}

/**
 * ControlMasters this process has used, by target and control path: the
 * shared `cm-%C` template is one string for every host, while ssh expands it
 * into a socket per host. ControlPersist keeps a master across reconnects
 * while the app runs; on quit each one is told to exit so no ssh outlives the
 * app.
 */
const usedMasters = new Map<string, (timeoutMs: number) => Promise<void>>();

function masterKey(target: string, controlPath: string): string {
  return `${target}\0${controlPath}`;
}

export function noteSshMaster(
  target: string,
  controlPath: string,
  close: (timeoutMs: number) => Promise<void>
): void {
  const key = masterKey(target, controlPath);
  if (!usedMasters.has(key)) usedMasters.set(key, close);
}

/** `ssh -O exit` for every master this process used, in parallel, each bounded by `timeoutMs`. */
export async function closeSshMasters(timeoutMs = 1_500): Promise<void> {
  const closers = [...usedMasters.values()];
  usedMasters.clear();
  await Promise.all(closers.map((close) => close(timeoutMs).catch(() => {})));
}

/** Close one host's master (forgetting it): `ssh -O exit`, then its control socket. */
export async function closeSshMaster(
  run: CommandRunner,
  clientDir: string,
  target: string,
  timeoutMs: number
): Promise<void> {
  if (!isValidSshTarget(target)) return;
  let controlPath: string;
  try {
    controlPath = controlPathFor(clientDir, target);
  } catch {
    return;
  }
  usedMasters.delete(masterKey(target, controlPath));
  await run(sshExecutable(), buildExitArgs(target, controlPath), { timeoutMs }).catch(() => {});
  if (!controlPath.includes("%")) await fs.rm(controlPath, { force: true }).catch(() => {});
}

/** Every name a build gives a master's control socket: `cm1-…`, `cm2-…`, and the temporary one ssh binds first. */
const CONTROL_SOCKET_NAME = /^cm\d*-/;

/**
 * Masters a previous launch left running because it crashed or was killed,
 * so its quit never told them to exit. This launch would reuse one (the
 * control path is the same every launch) with that launch's port forwards
 * still bound on it, unlisted and unstoppable here; an older build's keeps its
 * forwards bound until it times out. Each is told to exit and its socket
 * removed, as a normal quit would have, before anything here dials a host.
 */
export async function exitStaleSshMasters(
  run: CommandRunner,
  clientDir: string,
  timeoutMs: number
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(clientDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => CONTROL_SOCKET_NAME.test(name))
      .map(async (name) => {
        const socketPath = path.join(clientDir, name);
        try {
          if (!(await fs.lstat(socketPath)).isSocket()) return;
        } catch {
          return;
        }
        // The socket names the master; the destination is only there because ssh requires one.
        const args = ["-F", "/dev/null", "-o", controlPathOption(socketPath), "-O", "exit", "--"];
        const result = await run(sshExecutable(), [...args, "localhost"], { timeoutMs }).catch(
          () => null
        );
        // A master that wouldn't go keeps its socket: without it, nothing could reach it again.
        if (result?.code === 0 || (await isDeadSocket(socketPath, timeoutMs))) {
          await fs.rm(socketPath, { force: true }).catch(() => {});
        } else {
          logger.warn("A master left by an earlier launch didn't exit");
        }
      })
  );
}

/** Whether nothing answers on a unix socket any more: its process is gone. */
function isDeadSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const finish = (dead: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(dead);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED" || error.code === "ENOENT")
    );
  });
}

/**
 * Parse the probe's output. Takes the last three lines so a noisy remote
 * shell startup file printing to stdout doesn't break it.
 */
export function parseProbeOutput(stdout: string): RemoteProbe | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.length > 0);
  if (lines.length < 3) return null;
  const [os, uidText, home] = lines.slice(-3) as [string, string, string];
  const platform = os === "Darwin" ? "darwin" : os === "Linux" ? "linux" : null;
  if (!platform) return null;
  if (!/^\d{1,10}$/.test(uidText)) return null;
  if (!isSafeRemotePath(home)) return null;
  return { platform, uid: Number(uidText), home };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function collect(stream: Readable | null, cap: number, keepTail: boolean): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream?.on("data", (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buf);
    size += buf.byteLength;
    while (keepTail && size > cap && chunks.length > 1) size -= chunks.shift()!.byteLength;
    if (!keepTail && size > cap) stream.destroy();
  });
  return () => {
    const all = Buffer.concat(chunks);
    return (
      keepTail ? all.subarray(Math.max(0, all.byteLength - cap)) : all.subarray(0, cap)
    ).toString("utf8");
  };
}

/** ssh exited non-zero: `code` is the remote command's status, or 255 when ssh itself failed. */
class SshExitError extends TransportError {
  constructor(
    readonly code: number | null,
    detail: string
  ) {
    super("ssh failed", detail);
  }
}

function stderrDetail(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

type StreamLocalState = "unverified" | "works" | "refused";

const SSH_TIMED_OUT = "ssh did not finish in time";

export class SshTransport implements LinkTransport {
  private readonly spawnSsh: SshSpawner;
  private readonly spawnStream: SshStreamSpawner;
  /**
   * Whether the server lets a channel reach the host socket. Checked once,
   * again after a forwarded connection closed having carried nothing, and
   * again after a connection the bridge carried closes.
   */
  private streamLocal: StreamLocalState = "unverified";
  private lastRoute: "forward" | "attach-stdio" | null = null;

  constructor(private readonly options: SshTransportOptions) {
    if (!isValidSshTarget(options.target)) {
      throw new TransportError(`Not a usable SSH target: ${options.target}`, null);
    }
    this.spawnSsh = options.spawn ?? defaultSshSpawner(options.sshPath);
    this.spawnStream = options.spawnStream ?? defaultSshStreamSpawner(options.sshPath);
  }

  /** How the last successful open reached the host (for tests and diagnostics). */
  get route(): "forward" | "attach-stdio" | null {
    return this.lastRoute;
  }

  async open(signal: AbortSignal, options?: LinkOpenOptions): Promise<LinkTransportConnection> {
    let reached = false;
    try {
      return await this.openOnce(signal, () => (reached = true));
    } catch (error) {
      // ssh itself failing (unreachable, refused key) is not Daintree being down.
      const ensureRunning = this.options.ensureRunning;
      if (!reached || !ensureRunning || options?.mayStart === false || signal.aborted) throw error;
      if (error instanceof DiscoveryRejectedError) throw error;
      if (!(await ensureRunning(signal))) throw error;
      return this.openOnce(signal, () => {});
    }
  }

  private async openOnce(
    signal: AbortSignal,
    onReached: () => void
  ): Promise<LinkTransportConnection> {
    const { target, clientDir } = this.options;
    await fs.mkdir(clientDir, { recursive: true, mode: 0o700 });
    await fs.chmod(clientDir, 0o700);
    const controlPath = controlPathFor(clientDir, target);
    const persist = this.options.controlPersist;

    // Recorded before the probe: ssh may leave a master behind even when the
    // probe itself fails or is cancelled.
    noteSshMaster(target, controlPath, (timeoutMs) => this.exitMaster(controlPath, timeoutMs));
    const probe = await this.run(buildProbeArgs(target, controlPath, persist), signal).catch(
      async (error: unknown) => {
        // A probe that hangs is most often a master whose connection died
        // under it: retire it so the next attempt dials afresh.
        if (error instanceof TransportError && error.message === SSH_TIMED_OUT) {
          await this.exitMaster(controlPath, 1_500);
        }
        if (
          error instanceof TransportError &&
          !(error instanceof SshAccessError) &&
          isSshAccessDenied(error.detail ?? "")
        ) {
          throw new SshAccessError(error.detail ?? "");
        }
        throw error;
      }
    );
    const remote = parseProbeOutput(probe.stdout);
    if (!remote) {
      throw new TransportError("Unrecognised reply from the host", probe.stdout.trim() || null);
    }
    onReached();
    const location = remoteHostSocketLocation({
      ...remote,
      macAppDirName: this.options.macAppDirName,
      linuxDirName: this.options.linuxDirName,
    });
    const cat = await this.run(
      buildCatArgs(target, controlPath, location.discoveryPath, persist),
      signal
    ).catch((error: unknown) => {
      // The host answered, and Daintree writes this file while it listens: none there is no Host mode.
      if (error instanceof SshExitError && error.code === NO_DISCOVERY_FILE_EXIT) {
        throw new HostModeOffError(
          `Daintree isn't running in Host mode there (no ${path.posix.basename(location.discoveryPath)}).`
        );
      }
      throw error;
    });
    const info = parseDiscoveryRead(cat.stdout);
    if (!info) throw new TransportError("Host discovery file is not valid", null);
    // The host writes its socket beside the discovery file, so anything else
    // is a path the host chose for us to hand to ssh: refuse it.
    if (info.socketPath !== location.socketPath) {
      throw new DiscoveryRejectedError(
        `The host's discovery file names a socket at ${info.socketPath}, not beside it at ${location.socketPath}`
      );
    }
    const remoteSocket = info.socketPath;
    // A home folder with ":", "${" or "%" in its name puts them in the socket
    // path, which ssh would read as forwarding syntax. The attach bridge
    // reaches the same socket without naming it to ssh at all.
    if (!isForwardablePath(remoteSocket)) {
      if (!(this.options.attachCommand ?? attachCommandFor(info))) {
        throw new DiscoveryRejectedError(
          `The host's socket path has characters ssh can't forward as written (":", "\${" or "%"), and the host didn't say how to start its attach bridge: ${remoteSocket}`
        );
      }
      const connection = await this.openOverStdio(controlPath, info, signal);
      this.lastRoute = "attach-stdio";
      return connection;
    }

    if (this.streamLocal === "unverified") {
      this.streamLocal = await this.checkStreamLocal(controlPath, remoteSocket, signal);
    }
    if (this.streamLocal === "refused") {
      const connection = await this.openOverStdio(controlPath, info, signal);
      this.lastRoute = "attach-stdio";
      // ssh words a socket nobody listens on (a host that just crashed or is
      // restarting, its old socket file still there) exactly as a server that
      // refuses socket forwarding, so the verdict lasts only this connection:
      // the next one checks again, rather than every reconnect for the rest
      // of the app's life riding the bridge.
      connection.socket.once("close", () => {
        if (this.streamLocal === "refused") this.streamLocal = "unverified";
      });
      return connection;
    }
    const connection = await this.openForward(controlPath, remoteSocket, info.token, signal);
    this.lastRoute = "forward";
    return connection;
  }

  /**
   * Open one channel to the host socket and read how the server answered.
   * Only a refusal in ssh's words counts as refused; anything else (an old
   * ssh without `-W <socket>`, a timeout) leaves the forward to try.
   */
  private async checkStreamLocal(
    controlPath: string,
    remoteSocket: string,
    signal: AbortSignal
  ): Promise<StreamLocalState> {
    const { target, controlPersist } = this.options;
    try {
      await this.run(
        buildStreamLocalCheckArgs(target, controlPath, remoteSocket, controlPersist),
        signal
      );
      return "works";
    } catch (err) {
      if (signal.aborted) throw err;
      const detail = err instanceof TransportError ? (err.detail ?? "") : "";
      return isStreamLocalRefusal(detail) ? "refused" : "unverified";
    }
  }

  /** The link over `ssh <target> -- <daintree> --attach-stdio`, through the master. */
  private async openOverStdio(
    controlPath: string,
    info: HostDiscoveryInfo,
    signal: AbortSignal
  ): Promise<LinkTransportConnection> {
    const { target, controlPersist } = this.options;
    const command = this.options.attachCommand ?? attachCommandFor(info);
    if (!command) {
      throw new TransportError(
        "The host's ssh server refuses socket forwarding, and the host didn't say how to start its attach bridge",
        null
      );
    }
    const transport = createCommandStreamTransport(
      () => this.spawnStream(buildAttachArgs(target, controlPath, command, controlPersist)),
      { preambleTimeoutMs: this.options.commandTimeoutMs ?? SSH_COMMAND_TIMEOUT_MS }
    );
    return transport.open(signal);
  }

  /** The master's expanded control path, or null to name it the usual way. */
  private async resolveControlPath(controlPath: string, signal: AbortSignal) {
    try {
      const out = await this.run(
        buildResolveControlPathArgs(this.options.target, controlPath),
        signal
      );
      return parseResolvedControlPath(out.stdout);
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
  }

  private async openForward(
    controlPath: string,
    remoteSocket: string,
    token: string,
    signal: AbortSignal
  ): Promise<LinkTransportConnection> {
    const { target, clientDir } = this.options;
    const localSocket = localForwardPathFor(clientDir, target);
    if (Buffer.byteLength(localSocket) > maxSocketPathBytes() || localSocket.includes(":")) {
      throw new TransportError(`Local forward path is not usable: ${localSocket}`, null);
    }
    await fs.rm(localSocket, { force: true });

    let dispose: () => Promise<void>;
    const resolved = await this.resolveControlPath(controlPath, signal);
    const cancelViaMaster = async () => {
      await this.run(
        buildCancelArgs(target, controlPath, localSocket, remoteSocket, resolved),
        new AbortController().signal
      ).catch(() => {});
      await fs.rm(localSocket, { force: true }).catch(() => {});
    };
    const viaMaster = await this.run(
      buildMuxForwardArgs(target, controlPath, localSocket, remoteSocket, resolved),
      signal
    ).then(
      () => true,
      () => false
    );
    if (viaMaster) {
      dispose = cancelViaMaster;
      try {
        await waitForSocket(localSocket, this.options.forwardTimeoutMs ?? 15_000, signal);
      } catch (err) {
        await dispose();
        throw err;
      }
    } else {
      if (signal.aborted) {
        // Cancelled mid-request (a Retry, a stop): the master may hold the forward all the same.
        await cancelViaMaster();
        throw new TransportError("Connection cancelled", null);
      }
      const forward = await this.startForward(
        buildForwardArgs(target, localSocket, remoteSocket),
        localSocket,
        signal
      );
      dispose = async () => {
        forward.kill("SIGTERM");
        await fs.rm(localSocket, { force: true }).catch(() => {});
      };
    }
    let socket: net.Socket;
    try {
      socket = await connectUnixSocket(localSocket, signal);
    } catch (err) {
      await dispose();
      throw err;
    }
    // A forward that closes having carried nothing may have been refused by
    // the server since it was checked: check again next time.
    socket.once("close", () => {
      if (socket.bytesRead === 0 && this.streamLocal === "works") this.streamLocal = "unverified";
    });
    return { socket, token, dispose };
  }

  private exitMaster(controlPath: string, timeoutMs: number): Promise<void> {
    return this.run(
      buildExitArgs(this.options.target, controlPath),
      new AbortController().signal,
      timeoutMs
    ).then(
      () => undefined,
      () => undefined
    );
  }

  private run(args: string[], signal: AbortSignal, timeoutOverrideMs?: number): Promise<RunResult> {
    const timeoutMs = timeoutOverrideMs ?? this.options.commandTimeoutMs ?? SSH_COMMAND_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new TransportError("Connection cancelled", null));
        return;
      }
      let child: SshChild;
      try {
        child = this.spawnSsh(args);
      } catch (err) {
        reject(new TransportError("Could not run ssh", (err as Error).message));
        return;
      }
      const stdout = collect(child.stdout, MAX_OUTPUT_BYTES, false);
      const stderr = collect(child.stderr, MAX_STDERR_BYTES, true);
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new TransportError("Connection cancelled", null)));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            new TransportError(
              SSH_TIMED_OUT,
              stderrDetail(stderr(), `ssh did not finish within ${timeoutMs} ms`)
            )
          )
        );
      }, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) =>
        finish(() => reject(new TransportError("Could not run ssh", err.message)))
      );
      child.on("exit", (code) => {
        // Let buffered output land before reading it.
        setImmediate(() =>
          finish(() => {
            if (code === 0) resolve({ code, stdout: stdout(), stderr: stderr() });
            else {
              reject(
                new SshExitError(
                  code,
                  stderrDetail(stderr(), `ssh exited with code ${String(code)}`)
                )
              );
            }
          })
        );
      });
    });
  }

  /**
   * Start a dedicated forward and wait until its local socket exists. Any
   * exit before then is a failure, reported with ssh's stderr.
   */
  private startForward(
    args: string[],
    localSocket: string,
    signal: AbortSignal
  ): Promise<SshChild> {
    // It dials afresh, so it gets the deadline any other dialling command has.
    const timeoutMs = this.options.forwardTimeoutMs ?? SSH_COMMAND_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let child: SshChild;
      try {
        child = this.spawnSsh(args);
      } catch (err) {
        reject(new TransportError("Could not run ssh", (err as Error).message));
        return;
      }
      child.stdout?.resume();
      const stderr = collect(child.stderr, MAX_STDERR_BYTES, true);
      let settled = false;
      const deadline = Date.now() + timeoutMs;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(poller);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const fail = (error: TransportError) => {
        child.kill("SIGTERM");
        finish(() => reject(error));
      };
      const onAbort = () => fail(new TransportError("Connection cancelled", null));
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => fail(new TransportError("Could not run ssh", err.message)));
      child.on("exit", (code) => {
        setImmediate(() =>
          fail(
            new TransportError(
              "ssh forward failed",
              stderrDetail(stderr(), `ssh exited with code ${String(code)}`)
            )
          )
        );
      });
      let poller: ReturnType<typeof setTimeout>;
      const poll = async () => {
        if (settled) return;
        if (await socketExists(localSocket)) {
          finish(() => resolve(child));
          return;
        }
        if (Date.now() > deadline) {
          fail(
            new TransportError(
              "ssh forward did not come up",
              stderrDetail(stderr(), `no forward after ${timeoutMs} ms`)
            )
          );
          return;
        }
        poller = setTimeout(() => void poll(), POLL_MS);
      };
      poller = setTimeout(() => void poll(), 0);
    });
  }
}

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    return (await fs.lstat(socketPath)).isSocket();
  } catch {
    return false;
  }
}

async function waitForSocket(
  socketPath: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await socketExists(socketPath))) {
    if (signal.aborted) throw new TransportError("Connection cancelled", null);
    if (Date.now() > deadline) {
      throw new TransportError("ssh forward did not come up", `no forward after ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
