import { spawnSync } from "child_process";
import type * as pty from "node-pty";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";

const SIGKILL_ESCALATION_DELAY_MS = 500;

/**
 * Owns the cross-platform teardown of a PTY's process tree and its deferred
 * SIGKILL escalation timer. Extracted from TerminalProcess so the kill
 * lifecycle is testable in isolation and the escalation closure can re-read
 * the descendant list at SIGKILL time — children spawned during the 500ms
 * grace window would otherwise be orphaned.
 */
export class ProcessTreeKiller {
  private killTreeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ptyProcess: pty.IPty,
    private readonly processTreeCache: ProcessTreeCache | null
  ) {}

  /**
   * Kill the entire process tree rooted at the PTY shell.
   * Sends SIGTERM to all descendants bottom-up (leaves first), then kills the shell.
   * @param immediate If true, SIGKILL is sent synchronously (for process.on("exit") context
   *   where timers don't fire). If false, SIGKILL escalation fires after 500ms and re-reads
   *   the descendant list to catch processes spawned during the grace window.
   */
  execute(immediate: boolean): void {
    this.abort();

    const shellPid = this.ptyProcess.pid;

    if (shellPid === undefined || shellPid <= 0) {
      try {
        this.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
      return;
    }

    // Windows: use taskkill /T /F which handles the entire tree atomically
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(shellPid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
      } catch {
        // taskkill may fail if process already exited
      }
      try {
        this.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
      return;
    }

    // Unix: SIGTERM descendants bottom-up, then kill the shell
    const descendants = this.processTreeCache?.getDescendantPids(shellPid) ?? [];

    for (const pid of descendants) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ESRCH: process already exited
      }
    }

    try {
      this.ptyProcess.kill();
    } catch {
      // Process may already be dead
    }

    if (immediate) {
      this.sigkillSweep(shellPid);
      return;
    }

    // Re-read descendants inside the timer so children spawned in the
    // grace window between SIGTERM and SIGKILL are also reaped. Capturing
    // the snapshot in a closure here would orphan late-forked subprocesses.
    this.killTreeTimer = setTimeout(() => {
      this.killTreeTimer = null;
      this.sigkillSweep(shellPid);
    }, SIGKILL_ESCALATION_DELAY_MS);
    this.killTreeTimer.unref?.();
  }

  /**
   * Cancel any pending SIGKILL escalation. Idempotent.
   */
  abort(): void {
    if (this.killTreeTimer) {
      clearTimeout(this.killTreeTimer);
      this.killTreeTimer = null;
    }
  }

  private sigkillSweep(shellPid: number): void {
    const descendants = this.processTreeCache?.getDescendantPids(shellPid) ?? [];
    const allPids = [...descendants, shellPid];
    for (const pid of allPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ESRCH: process already exited
      }
    }
  }
}
