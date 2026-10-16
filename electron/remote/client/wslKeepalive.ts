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
 * moments between setup's commands are not, so a distro in use gets one
 * more: `cat` reading a stdin this process never writes. Ending stdin lets it
 * go, and so does this process dying, since the pipe closes with it; nothing
 * is left holding a distro up after Daintree is gone.
 *
 * Two kinds of hold keep the keeper running:
 * - **wanted**, from a host's first link attempt until the host is forgotten
 *   or re-pointed, or the app stops. A Disconnect or an idle link release
 *   leaves it, as a remote machine stays up when a Shell lets go of it.
 * - **touched**, by each setup command, for a while after it: enough to carry
 *   a probe, an install and Host mode's start into the link that follows,
 *   and to let a distro that was only checked, never added, stop on its own.
 *
 * A keeper that exits on its own (`wsl --shutdown`) is started again by the
 * next hold.
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
/** How long a setup command keeps its distro up after it. */
const TOUCH_TTL_MS = 60_000;

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
  private readonly wanted = new Set<string>();
  private readonly touched = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(
    private readonly options: {
      spawn?: KeeperSpawner;
      wslPath?: string;
      releaseGraceMs?: number;
      touchTtlMs?: number;
    } = {}
  ) {}

  /** Keep `distro` running until {@link release}: a host this Shell uses lives there. */
  want(distro: string): void {
    if (this.disposed) return;
    this.wanted.add(keyOf(distro));
    this.ensureKeeper(distro);
  }

  /** Keep `distro` running for a while: a setup command just reached it. */
  touch(distro: string): void {
    if (this.disposed) return;
    const key = keyOf(distro);
    const previous = this.touched.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (this.touched.get(key) !== timer) return;
      this.touched.delete(key);
      this.stopIfUnheld(key);
    }, this.options.touchTtlMs ?? TOUCH_TTL_MS);
    timer.unref?.();
    this.touched.set(key, timer);
    this.ensureKeeper(distro);
  }

  /** Let `distro` stop once nothing else holds it: its host was forgotten or re-pointed. */
  release(distro: string): void {
    const key = keyOf(distro);
    this.wanted.delete(key);
    const timer = this.touched.get(key);
    if (timer) clearTimeout(timer);
    this.touched.delete(key);
    this.stopIfUnheld(key);
  }

  isHeld(distro: string): boolean {
    return this.keepers.has(keyOf(distro));
  }

  /** Release every distro; holding after this is a no-op. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.touched.values()) clearTimeout(timer);
    this.touched.clear();
    this.wanted.clear();
    const children = [...this.keepers.values()];
    this.keepers.clear();
    for (const child of children) this.stop(child);
  }

  private ensureKeeper(distro: string): void {
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

  private stopIfUnheld(key: string): void {
    if (this.wanted.has(key) || this.touched.has(key)) return;
    const child = this.keepers.get(key);
    if (!child) return;
    this.keepers.delete(key);
    this.stop(child);
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
