import { spawn as nodeSpawn } from "node:child_process";
import type { Writable } from "node:stream";
import { WSL_ENV, wslExecArgs, wslExecutable } from "./wslCommand.js";

/**
 * Keeps a WSL distro running while this Shell wants its Host.
 *
 * WSL stops a distro about 15 s after its last wsl.exe client exits, and
 * everything in it goes: the Host, its terminals, its agents. A systemd
 * service or linger doesn't keep it up. While a link is open its attach
 * bridge is such a client, but a reconnect gap, an idle link release or the
 * moments between setup's commands are not, so each wanted distro gets one
 * more: `cat` reading a stdin this process never writes. Ending stdin lets it
 * go, and so does this process dying, since the pipe closes with it; nothing
 * is left holding a distro up after Daintree is gone.
 *
 * A distro is wanted from its first link attempt or setup command until the
 * host is forgotten or re-pointed, or the app stops. A Disconnect or an idle
 * link release leaves it running, as a remote machine stays up when a Shell
 * lets go of it. A keeper that exits on its own (`wsl --shutdown`) is
 * started again by the next attempt.
 */

export interface KeeperChild {
  stdin: Writable | null;
  once(event: "exit", listener: () => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type KeeperSpawner = (wslPath: string, args: string[]) => KeeperChild;

/** After stdin closes, how long the keeper gets before it is killed. */
const RELEASE_GRACE_MS = 2_000;

const defaultSpawner: KeeperSpawner = (wslPath, args) =>
  nodeSpawn(wslPath, args, {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env, ...WSL_ENV },
  });

function keyOf(distro: string): string {
  // WSL looks distro names up without regard to case.
  return distro.toLowerCase();
}

export class WslKeepalive {
  private readonly keepers = new Map<string, KeeperChild>();
  private disposed = false;

  constructor(
    private readonly options: {
      spawn?: KeeperSpawner;
      wslPath?: string;
      releaseGraceMs?: number;
    } = {}
  ) {}

  /** Keep `distro` running; starts its keeper unless one is already running. */
  hold(distro: string): void {
    if (this.disposed) return;
    const key = keyOf(distro);
    if (this.keepers.has(key)) return;
    let child: KeeperChild;
    try {
      child = (this.options.spawn ?? defaultSpawner)(
        this.options.wslPath ?? wslExecutable(),
        wslExecArgs(distro, ["/bin/cat"])
      );
    } catch (error) {
      console.warn(`[RemoteHosts] Couldn't keep WSL distribution ${distro} running:`, error);
      return;
    }
    const forget = () => {
      if (this.keepers.get(key) === child) this.keepers.delete(key);
    };
    // Attached first: a missing wsl.exe fails asynchronously.
    child.once("error", (error) => {
      forget();
      console.warn(`[RemoteHosts] Couldn't keep WSL distribution ${distro} running:`, error);
    });
    child.once("exit", forget);
    child.stdin?.on("error", () => {});
    this.keepers.set(key, child);
  }

  /** Let `distro` stop once nothing else holds it. */
  release(distro: string): void {
    const key = keyOf(distro);
    const child = this.keepers.get(key);
    if (!child) return;
    this.keepers.delete(key);
    this.stop(child);
  }

  isHeld(distro: string): boolean {
    return this.keepers.has(keyOf(distro));
  }

  /** Release every distro; holding after this is a no-op. */
  dispose(): void {
    this.disposed = true;
    const children = [...this.keepers.values()];
    this.keepers.clear();
    for (const child of children) this.stop(child);
  }

  private stop(child: KeeperChild): void {
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.stdin?.end();
    const timer = setTimeout(() => {
      if (!exited) child.kill("SIGTERM");
    }, this.options.releaseGraceMs ?? RELEASE_GRACE_MS);
    timer.unref?.();
  }
}
