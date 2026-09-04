import { spawnSync } from "child_process";
import type * as pty from "node-pty";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";

const SIGKILL_ESCALATION_DELAY_MS = 500;

/**
 * The lineage ledger's kill-side surface. Declared structurally so the killer
 * stays unit-testable without the ledger's fs/subprocess machinery.
 */
export interface LineageKillSource {
  registerRoot(rootPid: number): void;
  markRootClosing(rootPid: number): void;
  /**
   * Tracked descendants of this root that the live walk can no longer reach,
   * with every start time re-verified against the OS first. Identity lives in
   * the ledger so the killer needs no subprocess or filesystem access of its
   * own — the only PIDs it ever sees here are ones proven to still be ours.
   */
  getVerifiedOrphanPids(rootPid: number, alreadyCovered: readonly number[]): number[];
}

/**
 * Owns the cross-platform teardown of a PTY's process tree and its deferred
 * SIGKILL escalation timer. Extracted from TerminalProcess so the kill
 * lifecycle is testable in isolation and the escalation closure can re-read
 * the descendant list at SIGKILL time — children spawned during the 500ms
 * grace window would otherwise be orphaned.
 *
 * The live tree walk cannot see a descendant that already reparented to PID 1
 * — `setsid`-detached background work does that within milliseconds of its
 * wrapper exiting (#12203). Every signalling pass therefore targets the union
 * of the live walk and the lineage ledger, which recorded those descendants
 * back when they were still reachable.
 */
export class ProcessTreeKiller {
  private killTreeTimer: NodeJS.Timeout | null = null;
  private registeredRootPid: number | null = null;

  constructor(
    private readonly ptyProcess: pty.IPty,
    private readonly processTreeCache: ProcessTreeCache | null,
    private readonly lineage: LineageKillSource | null = null
  ) {
    this.registerRoot(this.ptyProcess.pid);
  }

  /**
   * Register the shell PID as a lineage root. Called from the constructor, and
   * again once a real PID lands for a Windows ConPTY terminal that spawned
   * reporting PID 0 — without the second call those terminals would silently
   * run with no lineage tracking at all.
   *
   * Idempotent for a PID already registered by this killer: re-registering
   * resets the lineage, which would discard descendants we have already seen.
   */
  registerRoot(shellPid: number | undefined): void {
    if (!this.lineage) return;
    if (!Number.isInteger(shellPid) || (shellPid as number) <= 0) return;
    if (this.registeredRootPid === shellPid) return;
    this.registeredRootPid = shellPid as number;
    this.lineage.registerRoot(shellPid as number);
  }

  /**
   * The kill set the live walk cannot reach: ledger members whose identity the
   * ledger has just re-verified against the OS, ordered leaves-first.
   *
   * Membership is exactly the verified set — never a PID read out of the
   * cached census. The census is seconds stale, so an unverified PID from it
   * has no ownership proof at all, and expanding a verified parent's cached
   * subtree would even re-admit a child that verification had explicitly
   * rejected as recycled. Children a detached member spawned after leaving our
   * tree are covered because the ledger's own sweep admits and identifies them;
   * the census is used here only to order what is already proven.
   */
  private resolveOrphans(shellPid: number, live: number[]): number[] {
    if (!this.lineage) return [];

    const verified = this.lineage.getVerifiedOrphanPids(shellPid, live);
    if (verified.length === 0) return [];

    const verifiedSet = new Set(verified);
    const ordered: number[] = [];
    const seen = new Set<number>([...live, shellPid]);
    for (const pid of verified) {
      // getDescendantPids is post-order, so emitting a verified member's
      // verified descendants first keeps the leaves-first contract across the
      // union.
      for (const child of this.processTreeCache?.getDescendantPids(pid) ?? []) {
        if (!verifiedSet.has(child) || seen.has(child)) continue;
        seen.add(child);
        ordered.push(child);
      }
      if (seen.has(pid)) continue;
      seen.add(pid);
      ordered.push(pid);
    }
    return ordered;
  }

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

    this.lineage?.markRootClosing(shellPid);

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
      // taskkill /T walks the live tree, so it has the same blind spot as the
      // Unix walk below — reparented descendants need their own pass. Exclude
      // what the walk already covered so the taskkill above isn't repeated
      // once per live descendant.
      this.taskkillOrphans(
        this.resolveOrphans(shellPid, this.processTreeCache?.getDescendantPids(shellPid) ?? [])
      );
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
    const live = this.processTreeCache?.getDescendantPids(shellPid) ?? [];
    // Orphans first: they are already detached, so nothing about signalling
    // them can reparent a process the live walk still owns.
    const descendants = [...this.resolveOrphans(shellPid, live), ...live];

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
   * Reap descendants left behind by a shell that exited on its own.
   *
   * The natural-exit path previously only cancelled the escalation timer, so a
   * user typing `exit` while a detached grandchild was alive left it running
   * forever (#12203). The shell is already gone here, so the ledger is the
   * entire answer — and for the same reason this must never signal the shell
   * PID, which the OS is free to have recycled.
   */
  reapAfterRootExit(escalationDelayMs?: number): void {
    this.abort();

    const shellPid = this.ptyProcess.pid;
    if (shellPid === undefined || shellPid <= 0) return;

    this.lineage?.markRootClosing(shellPid);

    // Deliberately no live-walk subtraction here. The census is up to one sweep
    // old and still lists the exited shell's children beneath it, so a live walk
    // is stale by construction — and since the shell is gone, every one of those
    // children has already been reparented. Asking the ledger for its whole set
    // also means each PID is start-time verified before it is signalled, which a
    // stale live-walk entry would not be.
    const orphans = this.resolveOrphans(shellPid, []);
    if (orphans.length === 0) return;

    if (process.platform === "win32") {
      this.taskkillOrphans(orphans);
      return;
    }

    for (const pid of orphans) {
      this.signal(pid, "SIGTERM");
      this.signal(pid, "SIGCONT");
    }

    this.killTreeTimer = setTimeout(() => {
      this.killTreeTimer = null;
      this.sigkillSweep(shellPid, { includeShell: false, includeLiveWalk: false });
    }, escalationDelayMs ?? SIGKILL_ESCALATION_DELAY_MS);
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

  private taskkillOrphans(orphans: number[]): void {
    for (const pid of orphans) {
      try {
        spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
          windowsHide: true,
          stdio: "ignore",
          timeout: 3000,
        });
      } catch {
        // taskkill may fail if the process already exited
      }
    }
  }

  private signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(pid, sig);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        console.warn(`[ProcessTreeKiller] ${sig} pid=${pid}: ${(err as Error).message}`);
      }
    }
  }

  private sigkillSweep(
    shellPid: number,
    options?: { includeShell?: boolean; includeLiveWalk?: boolean }
  ): void {
    // After a natural exit the shell is gone, so a walk rooted at its PID
    // returns stale entries the ledger already covers — and covers with a
    // verified identity, which the raw walk does not have.
    const live =
      options?.includeLiveWalk === false
        ? []
        : (this.processTreeCache?.getDescendantPids(shellPid) ?? []);
    // Re-resolve rather than reusing the SIGTERM pass's set: start times are
    // verified again here, so a PID freed by the SIGTERM and handed to an
    // unrelated process in the grace window is dropped instead of SIGKILLed.
    const orphans = this.resolveOrphans(shellPid, live);
    const allPids = [...orphans, ...live];
    if (options?.includeShell !== false) {
      allPids.push(shellPid);
    }
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
