import { isKillableWindowsPid } from "../../utils/windowsProcessTree.js";
import {
  describeWindowsTreeKillProblem,
  isWindowsTreeKillHelperRunning,
  killWindowsProcessTrees,
  killWindowsProcessTreesSync,
  type WindowsTreeKillResult,
  type WindowsTreeKillTarget,
} from "../../utils/windowsTreeKill.js";
import type { ProcessTreeCache } from "../ProcessTreeCache.js";
import type { KillCensus, LineageOrigin } from "../TerminalLineageLedger.js";

const SIGKILL_ESCALATION_DELAY_MS = 500;
/**
 * One Windows tree kill on the host's persistent helper: census, terminations
 * and the exit wait, plus a PowerShell start when the helper is cold. Nothing
 * waits on it but the pseudoconsole.
 */
const WINDOWS_TREE_KILL_TIMEOUT_MS = 5000;
/** Never leave the pseudoconsole open past this, whatever the helper is doing. */
const WINDOWS_PTY_RELEASE_BACKSTOP_MS = 5500;
/**
 * The host's exit teardown: one helper run for every terminal, inside the 3 s
 * Main allows before it force-kills the host (`DISPOSE_EXIT_TIMEOUT_MS`).
 */
const WINDOWS_EXIT_BATCH_TIMEOUT_MS = 2500;
const WINDOWS_EXIT_BATCH_WAIT_MS = 500;
/**
 * How long a census captured ahead of PTY release stays usable by the kill
 * that follows it. Teardown runs both synchronously, so anything older belongs
 * to a kill that never happened.
 */
const CAPTURED_CENSUS_MAX_AGE_MS = 1000;
const SHELL_GONE = Symbol("shell-gone");

/** A Windows tree kill in flight, and when it has settled. */
interface WindowsJob {
  coversShell: boolean;
  /** Handed to a helper process, which finishes it even if this host exits. */
  started: boolean;
  done: Promise<void>;
}

/** Identities recorded at SIGTERM time, re-checked before anything is SIGKILLed. */
interface EscalationState {
  shellPid: number;
  shellStartTime: string | undefined;
  targets: Map<number, string>;
}

/**
 * The root process a killer owns: a terminal's `IPty`, or a plugin PTY's
 * adapter around one (#13173). `kill()` is the root's own signal — for node-pty
 * on Unix that is SIGHUP.
 */
export interface ProcessTreeKillTarget {
  readonly pid: number;
  kill(signal?: string): void;
}

/**
 * The lineage ledger's kill-side surface. Declared structurally so the killer
 * stays unit-testable without the ledger's fs/subprocess machinery.
 */
export interface LineageKillSource {
  registerRoot(rootPid: number, origin?: LineageOrigin | null): void;
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
  /**
   * Every identified descendant recorded for this root, with the start time it
   * was first seen under — unverified. Windows hands these to the tree-kill
   * helper as expected identities, which it checks against its own census and
   * then against each process handle, so no probe runs on the host's thread.
   */
  getTrackedPids?(rootPid: number): Array<{ pid: number; startTime: string }>;
}

/**
 * Windows tree kills collected during the pty-host's exit teardown, run as one
 * helper request when it is flushed. Null outside a teardown.
 */
let windowsExitBatch: {
  targets: WindowsTreeKillTarget[];
  /**
   * Shells the batch could only name by bare PID while their first kill is
   * still pending: see {@link ProcessTreeKiller}'s `killWindows`.
   */
  joined: Array<{ shellPid: number; job: WindowsJob }>;
  after: Array<() => void>;
} | null = null;

/**
 * Open the exit batch. From here until it is flushed, every Windows tree kill
 * is queued instead of started: one kill per terminal would not fit Main's
 * force-kill deadline. No-op off Windows.
 */
export function beginWindowsExitBatch(): void {
  if (process.platform !== "win32") return;
  windowsExitBatch ??= { targets: [], joined: [], after: [] };
}

/**
 * Kill every queued tree with one blocking helper run, then release each
 * terminal's pseudoconsole — after the kill, as the asynchronous path does,
 * because closing it first ends the shell the walk starts from.
 *
 * For `process.on("exit")`, where nothing asynchronous completes. A pending
 * first kill already handed to a helper process is not repeated: that process
 * finishes it after this host has gone, and only it knows whether the shell's
 * PID is still the shell's. One still waiting in this process's queue would
 * never run, and nothing has touched its shell, so the batch kills it here. A
 * teardown that can wait uses {@link flushWindowsExitBatchAsync}.
 */
export function flushWindowsExitBatch(): void {
  const batch = windowsExitBatch;
  windowsExitBatch = null;
  if (!batch) return;
  const targets = [
    ...batch.joined.filter(({ job }) => !job.started).map(({ shellPid }) => ({ pid: shellPid })),
    ...batch.targets,
  ];
  if (targets.length > 0) killExitBatchSync(targets);
  releaseExitBatch(batch.after);
}

/**
 * {@link flushWindowsExitBatch} for a teardown that can wait. When the host's
 * persistent helper is running — it is held warm while any terminal is open —
 * the batch is one request to it, awaited together with any first kill still
 * pending, for at most the exit budget: a cold PowerShell start alone is about
 * two seconds, which is why the blocking run missed Main's deadline at quit.
 * Without a running helper the batch is the blocking one-shot, as before.
 * Pseudoconsoles are released once the kills settle or the budget runs out,
 * whichever is first.
 */
export async function flushWindowsExitBatchAsync(): Promise<void> {
  const batch = windowsExitBatch;
  windowsExitBatch = null;
  if (!batch) return;
  const deadlineAt = Date.now() + WINDOWS_EXIT_BATCH_TIMEOUT_MS;
  const work: Array<Promise<unknown>> = batch.joined.map(({ job }) => job.done);
  if (batch.targets.length > 0) {
    if (isWindowsTreeKillHelperRunning()) {
      work.push(killExitBatchOnHelper(batch.targets));
    } else {
      killExitBatchSync(batch.targets);
    }
  }
  if (work.length > 0 && !(await settlesBy(Promise.all(work), deadlineAt))) {
    console.warn(
      `[ProcessTreeKiller] exit tree kills did not finish within ${WINDOWS_EXIT_BATCH_TIMEOUT_MS}ms; releasing ${batch.after.length} pseudoconsole(s) anyway`
    );
  }
  releaseExitBatch(batch.after);
}

const EXIT_BATCH_OPTIONS = {
  timeoutMs: WINDOWS_EXIT_BATCH_TIMEOUT_MS,
  waitMs: WINDOWS_EXIT_BATCH_WAIT_MS,
};

function killExitBatchSync(targets: readonly WindowsTreeKillTarget[]): void {
  try {
    logWindowsKillProblems(targets, killWindowsProcessTreesSync(targets, EXIT_BATCH_OPTIONS));
  } catch (error) {
    console.warn(`[ProcessTreeKiller] exit tree kill failed: ${(error as Error).message}`);
  }
}

function killExitBatchOnHelper(targets: readonly WindowsTreeKillTarget[]): Promise<void> {
  return killWindowsProcessTrees(targets, EXIT_BATCH_OPTIONS).then(
    (results) => logWindowsKillProblems(targets, results),
    (error: unknown) => {
      console.warn(`[ProcessTreeKiller] exit tree kill failed: ${(error as Error)?.message}`);
    }
  );
}

/** Whether `work` settled before `deadlineAt`; never waits past it. */
async function settlesBy(work: Promise<unknown>, deadlineAt: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()));
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function releaseExitBatch(after: ReadonlyArray<() => void>): void {
  for (const release of after) {
    try {
      release();
    } catch {
      // Already released
    }
  }
}

function logWindowsKillProblems(
  targets: readonly WindowsTreeKillTarget[],
  results: readonly WindowsTreeKillResult[]
): void {
  results.forEach((result, index) => {
    const problem = describeWindowsTreeKillProblem(result);
    if (problem) console.warn(`[ProcessTreeKiller] pid=${targets[index]?.pid}: ${problem}`);
  });
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
  /** `census: null` records a capture that failed, so the kill does not retry it. */
  private capturedCensus: { census: KillCensus | null; atMs: number } | null = null;
  /**
   * The shell's identity from the first census that saw it. A later kill on
   * this killer (dispose after a completed kill) must not mistake whatever now
   * holds the PID for our shell and walk an unrelated tree. `SHELL_GONE` once a
   * census has shown the shell missing: nothing that later takes the PID is ours.
   */
  private shellIdentity: string | typeof SHELL_GONE | null = null;
  private escalation: EscalationState | null = null;
  /**
   * Every process a kill on this killer has signalled, by start time, kept past
   * escalation so a later survivor check can tell a lingering target from a
   * stranger that inherited its PID.
   */
  private readonly killIdentities = new Map<number, string>();
  /**
   * Windows tree kills still running. A later kill joins one that covers the
   * shell rather than starting a second walk of the same tree.
   */
  private readonly windowsJobs = new Set<WindowsJob>();
  /** Set when a kill joined a pending job and so owes the pseudoconsole a release when it settles. */
  private releasePtyWhenSettled = false;
  /** A kill queued in the exit batch owes the pseudoconsole a release after the flush. */
  private releaseQueuedInBatch = false;
  private ptyReleased = false;
  /**
   * Windows: the shell's creation time (UTC µs) from the first tree kill whose
   * census listed it, passed back to every later kill so a recycled PID is
   * never walked as ours. `SHELL_GONE` once a census showed it gone.
   */
  private windowsShellIdentity: number | typeof SHELL_GONE | null = null;

  constructor(
    private readonly ptyProcess: ProcessTreeKillTarget,
    private readonly processTreeCache: ProcessTreeCache | null,
    private readonly lineage: LineageKillSource | null = null,
    /** What started this root, kept with its lineage for reporting survivors. */
    private readonly origin: LineageOrigin | null = null
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
    this.lineage.registerRoot(shellPid as number, this.origin);
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
    const atMs = Date.now();
    this.capturedCensus = { census: this.lineage?.takeKillCensus?.() ?? null, atMs };
  }

  private takeCensus(): KillCensus | null {
    const captured = this.capturedCensus;
    this.capturedCensus = null;
    // A capture that failed moments ago would fail again, and the shared
    // teardown budget cannot afford a second timeout.
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

  getKillIdentities(): ReadonlyMap<number, string> {
    return this.killIdentities;
  }

  private recordIdentities(census: KillCensus, pids: Iterable<number>): void {
    for (const pid of pids) {
      const startTime = census.startTimeOf(pid);
      if (startTime !== undefined) this.killIdentities.set(pid, startTime);
    }
  }

  /**
   * Kill the entire process tree rooted at the PTY shell.
   * Sends SIGTERM to all descendants bottom-up (leaves first), then kills the shell.
   * @param immediate If true, SIGKILL is sent synchronously (for process.on("exit") context
   *   where timers don't fire). If false, SIGKILL escalation fires after 500ms and re-reads
   *   the descendant list to catch processes spawned during the grace window. Windows has
   *   no grace window and always kills asynchronously, unless the host's exit batch is
   *   open ({@link beginWindowsExitBatch}).
   * @returns The PIDs this pass targeted, shell included.
   */
  execute(immediate: boolean, escalationDelayMs?: number): number[] {
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
      return [];
    }

    this.lineage?.markRootClosing(shellPid);

    // Windows: one helper run walks, verifies and ends the shell's tree and
    // every ledger orphan by handle (see killWindows). `immediate` changes
    // nothing here — there is no grace window to skip — except inside the
    // host's exit teardown, where the kill joins the exit batch.
    if (process.platform === "win32") {
      const orphans = this.windowsOrphanTargets(shellPid);
      this.killWindows(shellPid, orphans, true);
      // For the kill log only: what the last sweep saw under the shell, plus
      // the ledger's candidates. The helper decides what is actually ours.
      const live = this.processTreeCache?.getDescendantPids(shellPid) ?? [];
      const covered = new Set([...live, shellPid]);
      return [...orphans.map((o) => o.pid).filter((pid) => !covered.has(pid)), ...live, shellPid];
    }

    // A kill already mid-way through its grace window (kill() then dispose())
    // only needs its escalation completed. Restarting from a fresh walk would
    // miss everything the first SIGTERM already orphaned from the shell.
    if (immediate && pending && pending.shellPid === shellPid) {
      this.capturedCensus = null;
      this.escalate(pending, this.lineage?.takeKillCensus?.() ?? null);
      return [...pending.targets.keys(), shellPid];
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
    let shellStartTime = census?.startTimeOf(shellPid);
    if (census) {
      if (shellStartTime === undefined) this.shellIdentity = SHELL_GONE;
      else if (this.shellIdentity === null) this.shellIdentity = shellStartTime;
      else if (this.shellIdentity !== shellStartTime) shellStartTime = undefined;
    }
    // A fresh census without our shell means the PID is free for reuse, so
    // nothing below may signal it — including node-pty's SIGHUP.
    const shellGone = census !== null && shellStartTime === undefined;
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

    if (!shellGone) {
      try {
        this.ptyProcess.kill();
      } catch {
        // Process may already be dead
      }
    }

    // node-pty's IPty.kill() sends SIGHUP to the shell, which also queues
    // while stopped. Wake the shell so the queued SIGHUP delivers. Kept
    // outside the ptyProcess.kill() try/catch so it still fires if that
    // throws (already-dead shell → ESRCH here, silent). A fresh census that
    // lacks the shell means it is already gone and its PID is up for reuse.
    if (!shellGone) {
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
          targets: new Map([
            // A repeated kill keeps what the first one signalled: those targets
            // may have reparented out of reach of this pass's walk.
            ...(pending?.shellPid === shellPid ? pending.targets : []),
            ...descendants.flatMap((pid) => {
              const startTime = census.startTimeOf(pid);
              return startTime === undefined ? [] : [[pid, startTime] as const];
            }),
          ]),
        }
      : // Without a census nothing new is learned, but what an earlier kill
        // recorded is still the best evidence of what to SIGKILL.
        pending?.shellPid === shellPid
        ? pending
        : null;

    const targets = shellGone ? descendants : [...descendants, shellPid];
    if (census) this.recordIdentities(census, targets);

    if (immediate) {
      // Re-read even here: a snapshot taken before the SIGTERM pass cannot
      // prove that a target survived it rather than exiting and being replaced.
      if (state) this.escalate(state, this.lineage?.takeKillCensus?.() ?? null);
      else this.sigkillSweep(shellPid);
      return targets;
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
    return targets;
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

    this.recordIdentities(census, ordered);
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
   * @returns The orphaned descendants this pass targeted.
   */
  reapAfterRootExit(immediate: boolean = false, escalationDelayMs?: number): number[] {
    this.abort();
    this.capturedCensus = null;

    const shellPid = this.ptyProcess.pid;
    if (shellPid === undefined || shellPid <= 0) return [];

    this.lineage?.markRootClosing(shellPid);

    // Windows: the helper verifies each ledger identity against its own census
    // and each handle, so nothing is probed here and the shell — gone, its PID
    // free for reuse — is never a root.
    if (process.platform === "win32") {
      const targets = this.windowsOrphanTargets(shellPid);
      if (targets.length === 0) return [];
      this.killWindows(null, targets, false);
      return targets.map((t) => t.pid);
    }

    // Deliberately no live-walk subtraction here. The census is up to one sweep
    // old and still lists the exited shell's children beneath it, so a live walk
    // is stale by construction — and since the shell is gone, every one of those
    // children has already been reparented. Asking the ledger for its whole set
    // also means each PID is start-time verified before it is signalled, which a
    // stale live-walk entry would not be.
    let orphans = this.resolveOrphans(shellPid, []);
    if (orphans.length === 0) return [];

    // With orphans to signal, re-verify them against one fresh census so the
    // identities recorded for the survivor check are the processes signalled
    // below. Skipped on the exit path, whose budget belongs to the kill itself
    // and whose check could never run.
    const census = immediate ? null : (this.lineage?.takeKillCensus?.() ?? null);
    if (census) {
      orphans = this.resolveOrphans(shellPid, [], census);
      this.recordIdentities(census, orphans);
    }

    for (const pid of orphans) {
      this.signal(pid, "SIGTERM");
      this.signal(pid, "SIGCONT");
    }

    if (immediate) {
      // `process.on("exit")` context — no timer will ever fire, so escalate now.
      this.sigkillSweep(shellPid, { includeShell: false, includeLiveWalk: false });
      return orphans;
    }

    this.killTreeTimer = setTimeout(() => {
      this.killTreeTimer = null;
      this.sigkillSweep(shellPid, { includeShell: false, includeLiveWalk: false });
    }, escalationDelayMs ?? SIGKILL_ESCALATION_DELAY_MS);
    this.killTreeTimer.unref?.();
    return orphans;
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

  /**
   * Whether a Windows tree kill of this root is still running and owns the
   * root's release (`ProcessTreeKillTarget.kill()`), which it makes when it
   * settles or at its backstop. A caller about to release the root itself must
   * leave that to the killer: releasing the pseudoconsole first ends the shell
   * the walk starts from.
   */
  hasPendingTreeKill(): boolean {
    return (this.windowsJobs.size > 0 && this.releasePtyWhenSettled) || this.releaseQueuedInBatch;
  }

  /**
   * The ledger's recorded descendants of this root, each with the identity the
   * helper must find before touching it. Unverified here on purpose: the
   * helper's census and handle checks are the verification, and probing first
   * would block the host's only thread on a PowerShell per kill.
   */
  private windowsOrphanTargets(shellPid: number): WindowsTreeKillTarget[] {
    const tracked = this.lineage?.getTrackedPids?.(shellPid) ?? [];
    return tracked
      .filter((entry) => entry.pid !== shellPid && isKillableWindowsPid(entry.pid))
      .map((entry) => ({ pid: entry.pid, startTime: entry.startTime }));
  }

  /**
   * End the shell's tree (when `shellPid` is given) and every orphan's, each
   * from a fresh creation-time walk and by verified handle, never `taskkill /T`
   * — /T follows ParentProcessId links without checking creation times, so it
   * can end an older, unrelated program that names a reused PID as its parent.
   *
   * Ordering. The pseudoconsole is released only once the helper has finished:
   * closing it ends the shell within milliseconds, and the walk starts from a
   * live shell. A bounded backstop releases it regardless. The patched node-pty
   * (scripts/patchNodePtyConpty.cjs) makes that release safe after the shell
   * has already exited, and this killer releases it at most once.
   *
   * Pending jobs. A kill that arrives while one covering the shell is still
   * running joins it — no second walk of the same tree — and only takes over
   * the pending release. Inside the host's exit teardown the kill goes to the
   * exit batch instead, and is repeated there when the shell has an identity
   * to pass: the batch's walk is then as identity-checked as the first. A
   * shell whose first kill has not reported yet has none, and that kill may
   * already have ended it and freed its PID, so the batch waits for the
   * pending kill rather than walk the bare PID again.
   *
   * The shell is passed with the identity a previous kill's census recorded,
   * and not at all once a census showed it gone. A first kill has none to
   * pass: node-pty holds the shell's process handle until it observes the
   * exit, which keeps the PID from being reused while the shell lives.
   */
  private killWindows(
    shellPid: number | null,
    orphans: WindowsTreeKillTarget[],
    releasePty: boolean
  ): void {
    const identity = this.windowsShellIdentity;
    const includeShell = shellPid !== null && identity !== SHELL_GONE;
    const targets: WindowsTreeKillTarget[] = [];
    if (includeShell) {
      targets.push(
        typeof identity === "number" ? { pid: shellPid, startTime: identity } : { pid: shellPid }
      );
    }
    targets.push(...orphans);
    const release = () => {
      if (releasePty) this.releasePty();
    };

    if (windowsExitBatch) {
      const pendingShellKill =
        includeShell && identity === null
          ? [...this.windowsJobs].find((job) => job.coversShell)
          : undefined;
      if (pendingShellKill && shellPid !== null) {
        windowsExitBatch.joined.push({ shellPid, job: pendingShellKill });
        windowsExitBatch.targets.push(...orphans);
      } else {
        windowsExitBatch.targets.push(...targets);
      }
      if (releasePty) {
        // Owned until the flush, so a caller releasing the root itself (a
        // plugin PTY's teardown) leaves it to the batch.
        this.releaseQueuedInBatch = true;
        windowsExitBatch.after.push(() => {
          this.releaseQueuedInBatch = false;
          release();
        });
      }
      return;
    }

    const pending = [...this.windowsJobs];
    if (pending.length > 0 && (!includeShell || pending.some((job) => job.coversShell))) {
      if (releasePty) this.releasePtyWhenSettled = true;
      return;
    }

    if (targets.length === 0) {
      release();
      return;
    }

    if (releasePty) this.releasePtyWhenSettled = true;
    const backstop = setTimeout(() => this.settleRelease(), WINDOWS_PTY_RELEASE_BACKSTOP_MS);
    backstop.unref?.();
    const job: WindowsJob = { coversShell: includeShell, started: false, done: Promise.resolve() };
    this.windowsJobs.add(job);
    job.done = killWindowsProcessTrees(targets, {
      timeoutMs: WINDOWS_TREE_KILL_TIMEOUT_MS,
      onStart: () => {
        job.started = true;
      },
    })
      .then(
        (results) => {
          if (includeShell) this.learnShellIdentity(results[0]);
          logWindowsKillProblems(targets, results);
        },
        (error: unknown) => {
          console.warn(`[ProcessTreeKiller] tree kill failed: ${(error as Error)?.message}`);
        }
      )
      .finally(() => {
        // Whatever the outcome, this kill may have ended the shell, and its
        // pseudoconsole is released next: from here node-pty's handle no
        // longer vouches for the PID. A shell no census identified is never
        // named again.
        if (includeShell && this.windowsShellIdentity === null) {
          this.windowsShellIdentity = SHELL_GONE;
        }
        clearTimeout(backstop);
        this.windowsJobs.delete(job);
        if (this.windowsJobs.size === 0) this.settleRelease();
      });
  }

  private settleRelease(): void {
    if (!this.releasePtyWhenSettled) return;
    this.releasePtyWhenSettled = false;
    this.releasePty();
  }

  private releasePty(): void {
    if (this.ptyReleased) return;
    this.ptyReleased = true;
    try {
      this.ptyProcess.kill();
    } catch {
      // Process may already be dead
    }
  }

  private learnShellIdentity(result: WindowsTreeKillResult | undefined): void {
    if (!result) return;
    if (result.mode === "gone" || result.mode === "identity-mismatch") {
      this.windowsShellIdentity = SHELL_GONE;
    } else if (result.rootStartTime !== undefined && this.windowsShellIdentity === null) {
      this.windowsShellIdentity = result.rootStartTime;
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
