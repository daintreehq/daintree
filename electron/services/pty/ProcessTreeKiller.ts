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
  execute(immediate: boolean, escalationDelayMs?: number): void {
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

    // Unix: SIGTERM descendants bottom-up, then kill the shell.
    // SIGTERM is queued (not delivered) while a process is stopped via SIGSTOP
    // (Ctrl+Z). SIGCONT wakes the process; the kernel then delivers the queued
    // SIGTERM before any user-space code runs, so handlers like vite's port
    // release fire normally. SIGTERM-then-SIGCONT (per pid) is the correct
    // order — reversing it lets the resumed process fork() new children in the
    // window between SIGCONT delivery and SIGTERM delivery.
    const descendants = this.processTreeCache?.getDescendantPids(shellPid) ?? [];

    for (const pid of descendants) {
      let sigtermBlocked = false;
      try {
        process.kill(pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ESRCH: process already exited — silent. Anything else (e.g. EPERM
        // on an elevated subprocess) means the survivor stays alive and the
        // operator needs to know.
        if (code !== "ESRCH") {
          console.warn(`[ProcessTreeKiller] SIGTERM pid=${pid}: ${(err as Error).message}`);
          sigtermBlocked = true;
        }
      }
      // Skip SIGCONT when SIGTERM was rejected (EPERM, etc.) — there is no
      // queued kill to deliver, and waking a process we couldn't signal does
      // nothing useful. ESRCH falls through (the SIGCONT will also ESRCH and
      // be silent).
      if (sigtermBlocked) continue;
      try {
        process.kill(pid, "SIGCONT");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ESRCH is silent; EPERM warns because a failed SIGCONT leaves the
        // stopped process holding its queued SIGTERM forever — a permanent
        // orphan rather than a clean shutdown.
        if (code !== "ESRCH") {
          console.warn(`[ProcessTreeKiller] SIGCONT pid=${pid}: ${(err as Error).message}`);
        }
      }
    }

    try {
      this.ptyProcess.kill();
    } catch {
      // Process may already be dead
    }

    // node-pty's IPty.kill() sends SIGHUP to the shell, which also queues
    // while stopped. Wake the shell so the queued SIGHUP delivers. Kept
    // outside the ptyProcess.kill() try/catch so it still fires if that
    // throws (already-dead shell → ESRCH here, silent).
    try {
      process.kill(shellPid, "SIGCONT");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        console.warn(`[ProcessTreeKiller] SIGCONT pid=${shellPid}: ${(err as Error).message}`);
      }
    }

    if (immediate) {
      this.sigkillSweep(shellPid);
      return;
    }

    const delay = escalationDelayMs ?? SIGKILL_ESCALATION_DELAY_MS;

    // Re-read descendants inside the timer so children spawned in the
    // grace window between SIGTERM and SIGKILL are also reaped. Capturing
    // the snapshot in a closure here would orphan late-forked subprocesses.
    this.killTreeTimer = setTimeout(() => {
      this.killTreeTimer = null;
      this.sigkillSweep(shellPid);
    }, delay);
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
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          console.warn(`[ProcessTreeKiller] SIGKILL pid=${pid}: ${(err as Error).message}`);
        }
      }
    }
  }
}
