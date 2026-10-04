import { spawnSync } from "child_process";
import type * as pty from "node-pty";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { KillCensus } from "../TerminalLineageLedger.js";

const SIGKILL_ESCALATION_DELAY_MS = 500;
/**
 * How long a census captured ahead of PTY release stays usable by the kill
 * that follows it. Teardown runs both synchronously, so anything older belongs
 * to a kill that never happened.
 */
const CAPTURED_CENSUS_MAX_AGE_MS = 1000;

/** Identities recorded at SIGTERM time, re-checked before anything is SIGKILLed. */
interface EscalationState {
  shellPid: number;
  shellStartTime: string | undefined;
  targets: Map<number, string>;
}

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
  getVerifiedOrphanPids(
    rootPid: number,
    alreadyCovered: readonly number[],
    census?: KillCensus | null
  ): number[];
  /**
   * A fresh process-table read for the kill path, or null when one cannot be
   * taken. Absent or null leaves the killer on the cached census.
   */
  takeKillCensus?(): KillCensus | null;
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
 *
 * The live walk itself comes from a census taken at kill time when the ledger
 * can supply one, not the periodic cache (#13165): the cache is seconds stale,
 * so a kill that trusted it missed everything spawned since its last sweep.
 */
export class ProcessTreeKiller {
  private killTreeTimer: NodeJS.Timeout | null = null;
  private registeredRootPid: number | null = null;
  private capturedCensus: { census: KillCensus; atMs: number } | null = null;
  private escalation: EscalationState | null = null;

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
   * Snapshot the process table before the PTY is released. Closing the master
   * hangs up the foreground job, and an intermediate parent dying there
   * reparents its detached children to PID 1 before {@link execute} could walk
   * to them — the ancestry has to be read while it still exists.
   */
  captureTree(): void {
    this.capturedCensus = null;
    if (process.platform === "win32" || !(this.ptyProcess.pid > 0)) return;
    const census = this.lineage?.takeKillCensus?.() ?? null;
    this.capturedCensus = census ? { census, atMs: Date.now() } : null;
  }

  private takeCensus(): KillCensus | null {
    const captured = this.capturedCensus;
    this.capturedCensus = null;
    if (captured && Date.now() - captured.atMs <= CAPTURED_CENSUS_MAX_AGE_MS) {
      return captured.census;
    }
    return this.lineage?.takeKillCensus?.() ?? null;
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
  private resolveOrphans(shellPid: number, live: number[], census?: KillCensus | null): number[] {
    if (!this.lineage) return [];

    const verified = census
      ? this.lineage.getVerifiedOrphanPids(shellPid, live, census)
      : this.lineage.getVerifiedOrphanPids(shellPid, live);
    if (verified.length === 0) return [];

    const ordered: number[] = [];
    const seen = new Set<number>([...live, shellPid]);
    if (census) {
      // A fresh census is a live read, so a verified member's children in it
      // are that member's children right now — including ones it forked after
      // detaching, which no sweep has identified yet.
      for (const pid of verified) {
        for (const child of [...walkDescendants(census, pid), pid]) {
          if (seen.has(child)) continue;
          seen.add(child);
          ordered.push(child);
        }
      }
      return ordered;
    }

    const verifiedSet = new Set(verified);
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
    const pending = this.escalation;
    this.abort();

    const shellPid = this.ptyProcess.pid;

    if (shellPid === undefined || shellPid <= 0) {
      this.capturedCensus = null;
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

    // A kill already mid-way through its grace window (kill() then dispose())
    // only needs its escalation completed. Restarting from a fresh walk would
    // miss everything the first SIGTERM already orphaned from the shell.
    if (immediate && pending && pending.shellPid === shellPid) {
      this.capturedCensus = null;
      this.escalate(pending, this.lineage?.takeKillCensus?.() ?? null);
      return;
    }

    // Unix: SIGTERM descendants bottom-up, then kill the shell.
    // SIGTERM is queued (not delivered) while a process is stopped via SIGSTOP
    // (Ctrl+Z). SIGCONT wakes the process; the kernel then delivers the queued
    // SIGTERM before any user-space code runs, so handlers like vite's port
    // release fire normally. SIGTERM-then-SIGCONT (per pid) is the correct
    // order — reversing it lets the resumed process fork() new children in the
    // window between SIGCONT delivery and SIGTERM delivery.
    //
    // A fresh census is the source of truth when one can be taken (#13165): the
    // cached one is seconds stale, so it has never heard of anything spawned
    // since its last sweep. Without one, fall back to the cached walk.
    const census = this.takeCensus();
    const shellStartTime = census?.startTimeOf(shellPid);
    let descendants: number[];
    if (census) {
      const live = shellStartTime !== undefined ? walkDescendants(census, shellPid) : [];
      // Orphans first: they are already detached, so nothing about signalling
      // them can reparent a process the live walk still owns.
      descendants = [...this.resolveOrphans(shellPid, live, census), ...live];
    } else {
      const live = this.processTreeCache?.getDescendantPids(shellPid) ?? [];
      descendants = [...this.resolveOrphans(shellPid, live), ...live];
    }

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
    // throws (already-dead shell → ESRCH here, silent). A fresh census that
    // lacks the shell means it is already gone and its PID is up for reuse.
    if (!census || shellStartTime !== undefined) {
      try {
        process.kill(shellPid, "SIGCONT");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          console.warn(`[ProcessTreeKiller] SIGCONT pid=${shellPid}: ${(err as Error).message}`);
        }
      }
    }

    // Everything signalled above, by identity. Once its parent dies a target
    // reparents to PID 1 where no walk from the shell reaches it, so the
    // escalation finds it again by this record — and only while its start time
    // still matches, so a PID recycled during the grace window is left alone.
    const state: EscalationState | null = census
      ? {
          shellPid,
          shellStartTime,
          targets: new Map(
            descendants.flatMap((pid) => {
              const startTime = census.startTimeOf(pid);
              return startTime === undefined ? [] : [[pid, startTime] as const];
            })
          ),
        }
      : null;

    if (immediate) {
      // Microseconds after the SIGTERM pass, in a context that cannot afford
      // another `ps`: the snapshot just taken is still the current one.
      if (state) this.escalate(state, census);
      else this.sigkillSweep(shellPid);
      return;
    }

    const delay = escalationDelayMs ?? SIGKILL_ESCALATION_DELAY_MS;

    // Re-read descendants inside the timer so children spawned in the
    // grace window between SIGTERM and SIGKILL are also reaped. Capturing
    // the snapshot in a closure here would orphan late-forked subprocesses.
    this.escalation = state;
    this.killTreeTimer = setTimeout(() => {
      this.killTreeTimer = null;
      const current = this.escalation;
      this.escalation = null;
      if (current) this.escalate(current, this.lineage?.takeKillCensus?.() ?? null);
      else this.sigkillSweep(shellPid);
    }, delay);
    this.killTreeTimer.unref?.();
  }

  /**
   * SIGKILL whatever of a SIGTERMed tree is still alive, judged against a fresh
   * census: every recorded target whose identity still matches, anything those
   * survivors forked during the grace window, verified ledger orphans and their
   * children, and the shell with its subtree only if it is still the same
   * process. Without a census, falls back to the cached sweep.
   */
  private escalate(state: EscalationState, census: KillCensus | null): void {
    if (!census) {
      this.sigkillSweep(state.shellPid);
      return;
    }

    const shellAlive =
      state.shellStartTime !== undefined &&
      census.startTimeOf(state.shellPid) === state.shellStartTime;
    const seen = new Set<number>([state.shellPid]);
    const ordered: number[] = [];
    const addSubtree = (root: number) => {
      for (const pid of walkDescendants(census, root)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        ordered.push(pid);
      }
    };
    const add = (pid: number) => {
      addSubtree(pid);
      if (seen.has(pid)) return;
      seen.add(pid);
      ordered.push(pid);
    };

    for (const [pid, startTime] of state.targets) {
      if (census.startTimeOf(pid) === startTime) add(pid);
    }
    for (const pid of this.resolveOrphans(state.shellPid, ordered, census)) add(pid);
    if (shellAlive) {
      addSubtree(state.shellPid);
      ordered.push(state.shellPid);
    }

    for (const pid of ordered) this.signal(pid, "SIGKILL");
  }

  /**
   * Reap descendants left behind by a shell that exited on its own.
   *
   * The natural-exit path previously only cancelled the escalation timer, so a
   * user typing `exit` while a detached grandchild was alive left it running
   * forever (#12203). The shell is already gone here, so the ledger is the
   * entire answer — and for the same reason this must never signal the shell
   * PID, which the OS is free to have recycled.
   *
   * @param immediate SIGKILL synchronously instead of after the grace window,
   *   for the `process.on("exit")` context where timers never fire.
   */
  reapAfterRootExit(immediate: boolean = false, escalationDelayMs?: number): void {
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

    if (immediate) {
      // `process.on("exit")` context — no timer will ever fire, so escalate now.
      this.sigkillSweep(shellPid, { includeShell: false, includeLiveWalk: false });
      return;
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
    this.escalation = null;
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

/**
 * PIDs no kill path may ever signal, whatever a census says: init, the kernel's
 * placeholders, this process, and its parent.
 */
function isForbiddenTarget(pid: number): boolean {
  return !Number.isInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid;
}

/**
 * Descendants of `root` in the census, post-order (leaves first), never
 * descending through a forbidden PID. The visited set makes a malformed table
 * with a ppid cycle terminate.
 */
function walkDescendants(census: KillCensus, root: number): number[] {
  const out: number[] = [];
  const visited = new Set<number>([root]);
  const visit = (pid: number) => {
    for (const child of census.childrenOf(pid)) {
      if (visited.has(child) || isForbiddenTarget(child)) continue;
      visited.add(child);
      visit(child);
      out.push(child);
    }
  };
  visit(root);
  return out;
}
