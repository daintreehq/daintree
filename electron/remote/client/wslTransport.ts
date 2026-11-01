import { spawn as nodeSpawn } from "node:child_process";
import { ATTACH_STDIO_FLAG, HEADLESS_OZONE_SWITCH } from "../../boot/hostModeLaunch.js";
import { parseDiscoveryInfo } from "../host/discoveryFile.js";
import {
  HOST_DISCOVERY_NAME,
  HOST_SOCKET_NAME,
  LINUX_RUNTIME_DIR_NAME,
} from "../host/hostSocketPath.js";
import type { CommandRunner } from "./commandRunner.js";
import { createCommandStreamTransport, type StreamCommandChild } from "./commandStreamTransport.js";
import { failureDetail } from "./remoteShell.js";
import { safeLaunchCommand } from "./sshTransport.js";
import {
  HostModeOffError,
  TransportError,
  UnusableConnectionError,
  type LinkOpenOptions,
  type LinkTransport,
  type LinkTransportConnection,
} from "./transport.js";
import {
  WSL_ENV,
  isWslServiceFailure,
  withWslDiagnostics,
  wslExecArgs,
  wslExecutable,
} from "./wslCommand.js";

/**
 * A link to a Linux Host inside a WSL distro on this Windows machine (#12830).
 *
 * 1. `wsl.exe --exec /bin/sh -c <find>` prints the live Host's discovery file
 *    (only one whose socket exists and whose pid is running counts).
 * 2. `wsl.exe --exec <its command> --attach-stdio` starts the Host's own
 *    bridge, which reads its socket and token from that file and carries the
 *    link over its stdio (see commandStreamTransport.ts).
 *
 * The bridge runs headless with WSLg's display variables removed, so Chromium
 * never reaches for the distro's compositor. A distro with no Host listening
 * is started through `ensureRunning` (its user service), as an ssh host is.
 */

export interface WslTransportOptions {
  distro: string;
  run: CommandRunner;
  /** Holds the distro up across link attempts (see WslKeepalive). */
  keepalive?: (distro: string) => void;
  /** Start the host's Daintree when it isn't listening; resolves whether it now should be. */
  ensureRunning?: (signal: AbortSignal) => Promise<boolean>;
  /**
   * Runtime directory names to look for a Host in, in order. A packaged Host
   * uses `daintree`; a development Shell also finds a development Host.
   */
  runtimeDirNames?: readonly string[];
  spawn?: (wslPath: string, args: string[]) => StreamCommandChild;
  wslPath?: string;
  /** A stopped distro takes several seconds to boot before the bridge can answer. */
  preambleTimeoutMs?: number;
  discoveryTimeoutMs?: number;
}

/** Discovery and the Host's launch command are small; anything bigger is not them. */
const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 60_000;
const PREAMBLE_TIMEOUT_MS = 60_000;
/** The find script's exit code when no live Host is listening. */
const NO_HOST_EXIT = 3;
/** wsl.exe's error code for a distro name it doesn't know; its message around it is translated. */
const WSL_DISTRO_NOT_FOUND = /WSL_E_DISTRO_NOT_FOUND/;

const RUNTIME_DIR_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * One line of sh: print the first live Host's discovery file. The names are
 * fixed identifiers, never input, and are checked before they are spliced in.
 */
export function buildWslDiscoveryScript(dirNames: readonly string[]): string {
  if (dirNames.length === 0 || !dirNames.every((name) => RUNTIME_DIR_NAME.test(name))) {
    throw new Error("Not a usable runtime directory name");
  }
  return [
    `u=$(id -u)`,
    `for n in ${dirNames.join(" ")}; do d="/run/user/$u/$n"; f="$d/${HOST_DISCOVERY_NAME}"; if [ -f "$f" ] && [ -S "$d/${HOST_SOCKET_NAME}" ]; then p=$(sed -n 's/.*"pid":\\([0-9][0-9]*\\).*/\\1/p' "$f"); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then head -c ${MAX_DISCOVERY_BYTES} "$f"; exit 0; fi; fi; done`,
    `exit ${NO_HOST_EXIT}`,
  ].join("; ");
}

/** The argv after `--exec` that starts the Host's attach bridge. */
export function buildWslAttachArgv(command: readonly string[]): string[] {
  return [
    "/usr/bin/env",
    "-u",
    "DISPLAY",
    "-u",
    "WAYLAND_DISPLAY",
    ...command,
    ATTACH_STDIO_FLAG,
    HEADLESS_OZONE_SWITCH,
  ];
}

const defaultStreamSpawner = (wslPath: string, args: string[]): StreamCommandChild =>
  nodeSpawn(wslPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, ...WSL_ENV },
  });

export class WslTransport implements LinkTransport {
  private readonly wslPath: string;

  constructor(private readonly options: WslTransportOptions) {
    this.wslPath = options.wslPath ?? wslExecutable();
    // Validates the distro name before anything runs.
    wslExecArgs(options.distro, ["/bin/true"]);
  }

  async open(signal: AbortSignal, options?: LinkOpenOptions): Promise<LinkTransportConnection> {
    this.options.keepalive?.(this.options.distro);
    try {
      return await this.openOnce(signal);
    } catch (error) {
      const ensureRunning = this.options.ensureRunning;
      if (
        !(error instanceof HostModeOffError) ||
        !ensureRunning ||
        options?.mayStart === false ||
        signal.aborted
      ) {
        throw error;
      }
      if (!(await ensureRunning(signal))) throw error;
      return this.openOnce(signal);
    }
  }

  private async openOnce(signal: AbortSignal): Promise<LinkTransportConnection> {
    const command = await this.readLaunchCommand(signal);
    const args = wslExecArgs(this.options.distro, buildWslAttachArgv(command));
    const spawn = this.options.spawn ?? defaultStreamSpawner;
    const transport = createCommandStreamTransport(() => spawn(this.wslPath, args), {
      preambleTimeoutMs: this.options.preambleTimeoutMs ?? PREAMBLE_TIMEOUT_MS,
      // wsl.exe prints its own failures (no such distro) on stdout.
      stdoutInFailure: true,
    });
    return transport.open(signal);
  }

  private async readLaunchCommand(signal: AbortSignal): Promise<string[]> {
    const { distro } = this.options;
    const script = buildWslDiscoveryScript(
      this.options.runtimeDirNames ?? [LINUX_RUNTIME_DIR_NAME]
    );
    const result = withWslDiagnostics(
      await this.options.run(this.wslPath, wslExecArgs(distro, ["/bin/sh", "-c", script]), {
        timeoutMs: this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
        maxOutputBytes: MAX_DISCOVERY_BYTES,
        signal,
        env: WSL_ENV,
      })
    );
    if (signal.aborted) throw new TransportError("Connection cancelled", null);
    if (result.spawnError) {
      throw new UnusableConnectionError("WSL isn't available on this PC", result.spawnError);
    }
    if (result.timedOut) {
      throw new TransportError(`${distro} didn't answer in time`, failureDetail(result, "wsl.exe"));
    }
    if (result.code === NO_HOST_EXIT) {
      throw new HostModeOffError(`Daintree isn't running in Host mode in ${distro}.`);
    }
    if (result.code !== 0) {
      const detail = failureDetail(result, `wsl.exe exited with ${result.code}`);
      // wsl.exe's own code for a name it doesn't know: only installing or renaming one changes it.
      if (isWslServiceFailure(result.code) && WSL_DISTRO_NOT_FOUND.test(detail)) {
        throw new UnusableConnectionError(`${distro} isn't installed in WSL`, detail);
      }
      throw new TransportError(`Couldn't reach ${distro} through WSL`, detail);
    }
    const info = parseDiscoveryInfo(result.stdout);
    if (!info) throw new TransportError("Host discovery file is not valid", null);
    const command = safeLaunchCommand(info);
    if (!command) {
      throw new TransportError(
        "The Host in WSL didn't say how to start its attach bridge",
        info.command ? "Its launch command isn't one Daintree will run." : null
      );
    }
    return command;
  }
}
