import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { parseDiscoveryInfo } from "../host/discoveryFile.js";
import {
  maxSocketPathBytes,
  remoteHostSocketLocation,
  type SocketPlatform,
} from "../host/hostSocketPath.js";
import {
  TransportError,
  connectUnixSocket,
  type LinkTransport,
  type LinkTransportConnection,
} from "./transport.js";

/**
 * Reach a host through the system `ssh`, never an SSH library, so the user's
 * ~/.ssh/config, agents (ssh-agent, 1Password, Secure Enclave keys) and
 * Tailscale SSH all apply unchanged. Nothing here overrides identity, host-key
 * or agent settings. One ControlMaster connection per host is shared by the
 * probe, the discovery read and the socket forward.
 *
 *   1. `ssh <target> 'uname -s; id -u; echo "$HOME"'` to derive where the
 *      host's discovery file lives on that machine.
 *   2. `ssh <target> cat <discovery file>` for the socket path and token.
 *   3. `ssh -O forward -L <local.sock>:<remote.sock> <target>` through that
 *      master (or, with no master, a dedicated `ssh -N -L`), then dial
 *      local.sock.
 */

export interface SshChild {
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SshSpawner = (args: string[]) => SshChild;

export interface SshTransportOptions {
  /** What the user typed: `user@host`, an ~/.ssh/config alias, a tailnet name. */
  target: string;
  /** A Daintree-owned directory for the control socket and local forward (created 0700). Keep it short. */
  clientDir: string;
  spawn?: SshSpawner;
  sshPath?: string;
  commandTimeoutMs?: number;
  forwardTimeoutMs?: number;
  controlPersist?: string;
  /** Remote userData directory name on macOS (the packaged app's by default). */
  macAppDirName?: string;
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

/** `-L local:remote` splits on the colon, so forwarded paths can't contain one. */
const isForwardablePath = (p: string) => isSafeRemotePath(p) && !p.includes(":");

/** Single-quote for a POSIX, fish or csh remote shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function isValidSshTarget(target: string): boolean {
  return /^[A-Za-z0-9_.@%+[\]-]{1,255}$/.test(target) && !target.startsWith("-");
}

export function defaultSshSpawner(sshPath = "ssh"): SshSpawner {
  return (args) =>
    spawn(sshPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }) as SshChild;
}

function targetHash(target: string): string {
  return crypto.createHash("sha256").update(target).digest("hex").slice(0, 16);
}

/**
 * `cm-%C` when it fits the platform's socket path limit; otherwise a short
 * per-target hash (%C alone is 40 characters, and ssh adds a temporary
 * suffix while binding).
 */
export function controlPathFor(clientDir: string, target: string, platform = process.platform) {
  const limit = maxSocketPathBytes(platform);
  const withC = path.join(clientDir, "cm-%C");
  const expanded = Buffer.byteLength(withC) - 2 + PERCENT_C_LENGTH + CONTROL_PATH_TEMP_SUFFIX;
  if (expanded <= limit) return withC;
  const hashed = path.join(clientDir, `cm-${targetHash(target)}`);
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

export function sshCommonArgs(controlPath: string, controlPersist = "10m"): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPersist=${controlPersist}`,
    "-o",
    `ControlPath=${controlPath}`,
  ];
}

export const PROBE_COMMAND = 'uname -s; id -u; echo "$HOME"';

export function buildProbeArgs(target: string, controlPath: string, persist?: string): string[] {
  return [...sshCommonArgs(controlPath, persist), "--", target, PROBE_COMMAND];
}

export function buildCatArgs(
  target: string,
  controlPath: string,
  filePath: string,
  persist?: string
): string[] {
  if (!isSafeRemotePath(filePath)) {
    throw new TransportError(`Refusing to read an unusual remote path: ${filePath}`, null);
  }
  return [...sshCommonArgs(controlPath, persist), "--", target, `cat -- ${shellQuote(filePath)}`];
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
  remoteSocket: string
): string[] {
  return [
    "-o",
    `ControlPath=${controlPath}`,
    "-O",
    "forward",
    "-L",
    `${localSocket}:${remoteSocket}`,
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
    "ControlPath=none",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `${localSocket}:${remoteSocket}`,
    "--",
    target,
  ];
}

export function buildCancelArgs(
  target: string,
  controlPath: string,
  localSocket: string,
  remoteSocket: string
): string[] {
  return [
    "-o",
    `ControlPath=${controlPath}`,
    "-O",
    "cancel",
    "-L",
    `${localSocket}:${remoteSocket}`,
    "--",
    target,
  ];
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

function stderrDetail(stderr: string, fallback: string): string {
  const trimmed = stderr.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export class SshTransport implements LinkTransport {
  private readonly spawnSsh: SshSpawner;

  constructor(private readonly options: SshTransportOptions) {
    if (!isValidSshTarget(options.target)) {
      throw new TransportError(`Not a usable SSH target: ${options.target}`, null);
    }
    this.spawnSsh = options.spawn ?? defaultSshSpawner(options.sshPath);
  }

  async open(signal: AbortSignal): Promise<LinkTransportConnection> {
    const { target, clientDir } = this.options;
    await fs.mkdir(clientDir, { recursive: true, mode: 0o700 });
    await fs.chmod(clientDir, 0o700);
    const controlPath = controlPathFor(clientDir, target);
    const persist = this.options.controlPersist;

    const probe = await this.run(buildProbeArgs(target, controlPath, persist), signal);
    const remote = parseProbeOutput(probe.stdout);
    if (!remote) {
      throw new TransportError("Unrecognised reply from the host", probe.stdout.trim() || null);
    }
    const location = remoteHostSocketLocation({
      ...remote,
      macAppDirName: this.options.macAppDirName,
      linuxDirName: this.options.linuxDirName,
    });
    const cat = await this.run(
      buildCatArgs(target, controlPath, location.discoveryPath, persist),
      signal
    );
    const info = parseDiscoveryInfo(cat.stdout);
    if (!info || !isForwardablePath(info.socketPath)) {
      throw new TransportError("Host discovery file is not valid", null);
    }
    const remoteSocket = info.socketPath;

    const localSocket = localForwardPathFor(clientDir, target);
    if (Buffer.byteLength(localSocket) > maxSocketPathBytes() || localSocket.includes(":")) {
      throw new TransportError(`Local forward path is not usable: ${localSocket}`, null);
    }
    await fs.rm(localSocket, { force: true });

    let dispose: () => Promise<void>;
    const viaMaster = await this.run(
      buildMuxForwardArgs(target, controlPath, localSocket, remoteSocket),
      signal
    ).then(
      () => true,
      () => false
    );
    if (viaMaster) {
      dispose = async () => {
        await this.run(
          buildCancelArgs(target, controlPath, localSocket, remoteSocket),
          new AbortController().signal
        ).catch(() => {});
        await fs.rm(localSocket, { force: true }).catch(() => {});
      };
      try {
        await waitForSocket(localSocket, this.options.forwardTimeoutMs ?? 15_000, signal);
      } catch (err) {
        await dispose();
        throw err;
      }
    } else {
      if (signal.aborted) throw new TransportError("Connection cancelled", null);
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
    try {
      const socket = await connectUnixSocket(localSocket, signal);
      return { socket, token: info.token, dispose };
    } catch (err) {
      await dispose();
      throw err;
    }
  }

  private run(args: string[], signal: AbortSignal): Promise<RunResult> {
    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
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
              "ssh did not finish in time",
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
                new TransportError(
                  "ssh failed",
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
    const timeoutMs = this.options.forwardTimeoutMs ?? 15_000;
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
