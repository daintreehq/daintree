import { spawn, type ChildProcess } from "child_process";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";
import type { NormalizedTreeKillTarget, WindowsTreeKillResult } from "./windowsTreeKill.js";

/**
 * Line that ends one run's report, suffixed with the id of the request it
 * answers. Output is routed by helper identity as well, so a report from a
 * helper already given up on can never settle the run that replaced it.
 */
export const TREE_KILL_SENTINEL_PREFIX = "__DAINTREE_TREE_KILL_END__:";

/** How long the helper may sit with nothing queued before it is retired. */
export const TREE_KILL_HELPER_IDLE_RETIRE_MS = 30_000;

/**
 * After a failing helper is terminated, how long to wait for its pipe to close.
 * Until it does, output it wrote before dying may still be unread, and the
 * recovery must not assume no kill had started.
 */
export const TREE_KILL_HELPER_CLOSE_GRACE_MS = 1500;

/**
 * Runaway guard on one run's report: a few lines per process in the trees.
 * Matches the one-shot helper's `maxBuffer`.
 */
const MAX_REPORT_CHARS = 4 * 1024 * 1024;

/** Consecutive failures before runs skip the persistent helper for a while. */
export const TREE_KILL_FAILURES_BEFORE_COOLDOWN = 3;
export const TREE_KILL_COOLDOWN_BASE_MS = 15_000;
export const TREE_KILL_COOLDOWN_CEILING_MS = 60_000;

export interface TreeKillBudget {
  /** Upper bound on the run: helper start (when cold), census, terminations and exit wait. */
  timeoutMs: number;
  /** How long, of that, to wait for terminated processes to exit. */
  waitMs: number;
}

/**
 * What the service needs to know about the tree kill itself. The service is
 * transport only — queueing, framing, the helper's lifetime — and every
 * decision about which process may be killed stays in `windowsTreeKill.ts`.
 */
export interface TreeKillEngine {
  /** `powershell.exe` arguments that start the request loop. */
  readonly serverArgs: readonly string[];
  /** One run's input: a single line of JSON, never script text. */
  encodeInput(targets: readonly NormalizedTreeKillTarget[], waitMs: number): string;
  /** Results in target order for a report that ends in `END`, or null for one that does not. */
  readReport(
    targets: readonly NormalizedTreeKillTarget[],
    report: string
  ): WindowsTreeKillResult[] | null;
  /**
   * Finish a run the persistent helper did not, through the one-shot helper
   * and from whatever the partial report proves. `complete` says whether
   * `partial` is everything the helper wrote for this run, so a lost line can
   * never be read as a kill that had not started.
   */
  recover(
    targets: readonly NormalizedTreeKillTarget[],
    partial: string,
    complete: boolean,
    budget: TreeKillBudget,
    reason: string
  ): Promise<WindowsTreeKillResult[]>;
}

export interface WindowsTreeKillServiceOptions {
  engine: TreeKillEngine;
  /** Injected by tests; `child_process.spawn` otherwise. */
  spawn?: typeof spawn;
  idleRetireMs?: number;
}

interface PendingKill {
  targets: readonly NormalizedTreeKillTarget[];
  budget: TreeKillBudget;
  resolve: (results: WindowsTreeKillResult[]) => void;
  onStart?: () => void;
}

interface Run {
  id: number;
  kills: PendingKill[];
  /** Every request's targets, concatenated in submission order. */
  targets: NormalizedTreeKillTarget[];
  budget: TreeKillBudget;
  /** The persistent helper serving this run; null when the one-shot does. */
  child: ChildProcess | null;
  output: string;
  timer: NodeJS.Timeout | null;
  /** Why the persistent helper failed this run; set once. */
  failure: string | null;
  /** Recovery or results are on their way; nothing else may settle the run. */
  finishing: boolean;
  /** A helper process has the request. */
  started: boolean;
}

/**
 * One long-lived `powershell.exe` that runs Windows tree kills (#13173's
 * verified, handle-pinned kill) instead of a fresh PowerShell per kill.
 *
 * A PowerShell start is most of a one-shot kill: 1.1 s warm, 1.9 s cold on a
 * Windows 11 laptop, against a census and a handful of terminations that take
 * a few hundred milliseconds. A closed terminal holds its pseudoconsole and
 * node-pty's output thread until its kill settles, and closing a project
 * started one PowerShell per terminal at once.
 *
 * Requests are queued and coalesced. At most one run executes at a time; every
 * request that arrives while it does joins the next run, and requests made in
 * the same tick share the first, so a burst of N kills is one census and at
 * most two runs. All of a run's roots go to the helper together, which is what
 * the one-shot batch already did: one census and one set of pinned handles
 * cover them all.
 *
 * Built on `WindowsProcessCensus`'s shape — stdin request lines, a sentinel per
 * response, idle retirement, a failure ladder — with one deliberate
 * difference: a kill is never dropped, so a run the persistent helper cannot
 * finish (it would not start, died, timed out, or answered out of protocol)
 * is finished by the one-shot helper instead, and every request resolves.
 * The helper announces its kill plan before it terminates anything, so that
 * recovery knows which roots may already have been ended and pins each to the
 * identity the helper's census saw, rather than walking a PID that may have
 * been reused since.
 *
 * Construction does not spawn; the first run does, or {@link setKeepWarm}.
 * Left alone, the helper is retired once it has been idle for
 * {@link TREE_KILL_HELPER_IDLE_RETIRE_MS}; held warm, it stays.
 */
export class WindowsTreeKillService {
  private readonly engine: TreeKillEngine;
  private readonly spawnHelper: typeof spawn;
  private readonly idleRetireMs: number;

  private child: ChildProcess | null = null;
  private queue: PendingKill[] = [];
  private run: Run | null = null;
  private dispatchScheduled = false;
  private nextRunId = 1;
  private consecutiveFailures = 0;
  private cooldownTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private keepWarm = false;
  private disposed = false;

  constructor(options: WindowsTreeKillServiceOptions) {
    this.engine = options.engine;
    this.spawnHelper = options.spawn ?? spawn;
    this.idleRetireMs = options.idleRetireMs ?? TREE_KILL_HELPER_IDLE_RETIRE_MS;
  }

  /** PID of the live helper, or null while none is running. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  /** A run is executing or requests are waiting for one. */
  get isBusy(): boolean {
    return this.run !== null || this.queue.length > 0;
  }

  /**
   * Kill these trees in the next run. Resolves in target order once the run
   * has finished, by the persistent helper or the one-shot. Never rejects.
   * `onStart` is called once a helper process has the request — from then on
   * the kill completes even if this process exits.
   */
  kill(
    targets: readonly NormalizedTreeKillTarget[],
    budget: TreeKillBudget,
    onStart?: () => void
  ): Promise<WindowsTreeKillResult[]> {
    if (targets.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.queue.push({ targets, budget, resolve, ...(onStart ? { onStart } : {}) });
      this.scheduleDispatch();
    });
  }

  /**
   * While `warm`, keep a helper running — starting one now if none is — rather
   * than retiring it when idle. Costs one idle `powershell.exe` for as long as
   * it is held; buys every kill in that time a warm helper.
   */
  setKeepWarm(warm: boolean): void {
    this.keepWarm = warm;
    if (warm) {
      this.clearIdleTimer();
      this.prewarm();
    } else if (!this.isBusy) {
      this.armIdleTimer();
    }
  }

  /** Retire the helper if nothing is running or queued. Returns whether one was stopped. */
  retireIfIdle(): boolean {
    if (this.isBusy || !this.child || this.keepWarm) return false;
    this.retireChild();
    return true;
  }

  /**
   * Stop the helper. A run it was serving is finished by the one-shot helper,
   * and so is every later request, so nothing waiting on a kill is stranded.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    this.clearIdleTimer();
    const run = this.run;
    if (run?.child) this.fail(run, "tree-kill helper was disposed");
    this.retireChild();
  }

  private scheduleDispatch(): void {
    if (this.dispatchScheduled || this.run) return;
    this.dispatchScheduled = true;
    // One tick of slack so a synchronous burst — killByProject looping over a
    // project's terminals — lands in one run instead of one plus the rest.
    setImmediate(() => {
      this.dispatchScheduled = false;
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (this.run || this.queue.length === 0) return;
    this.clearIdleTimer();
    const kills = this.queue.splice(0);
    const run: Run = {
      id: this.nextRunId++,
      kills,
      targets: kills.flatMap((kill) => kill.targets),
      budget: {
        timeoutMs: Math.max(...kills.map((kill) => kill.budget.timeoutMs)),
        waitMs: Math.max(...kills.map((kill) => kill.budget.waitMs)),
      },
      child: null,
      output: "",
      timer: null,
      failure: null,
      finishing: false,
      started: false,
    };
    this.run = run;

    if (this.disposed || this.cooldownTimer) {
      this.recover(
        run,
        "",
        true,
        this.disposed
          ? "tree-kill helper was disposed"
          : "tree-kill helper is cooling down after consecutive failures"
      );
      return;
    }

    let child: ChildProcess;
    try {
      child = this.child ?? this.launch();
    } catch (error) {
      this.noteFailure();
      this.recover(run, "", true, formatErrorMessage(error, "tree-kill helper did not start"));
      return;
    }

    run.child = child;
    run.timer = setTimeout(
      () => this.fail(run, `tree-kill helper timed out after ${run.budget.timeoutMs}ms`),
      run.budget.timeoutMs
    );
    try {
      child.stdin?.write(`${run.id} ${this.engine.encodeInput(run.targets, run.budget.waitMs)}\n`);
    } catch (error) {
      this.fail(run, formatErrorMessage(error, "tree-kill helper did not take the request"));
      return;
    }
    this.markStarted(run);
  }

  private markStarted(run: Run): void {
    if (run.started) return;
    run.started = true;
    for (const kill of run.kills) {
      try {
        kill.onStart?.();
      } catch {
        // A caller's bookkeeping must not stop the run.
      }
    }
  }

  private launch(): ChildProcess {
    const child = this.spawnHelper("powershell.exe", [...this.engine.serverArgs], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onOutput(child, chunk));
    // Not part of the protocol, but an undrained pipe would block the helper.
    child.stderr?.resume();
    // A stream `error` with no listener reaches the host's uncaughtException
    // handler, which exits the host. EPIPE on stdin is the usual one.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (error) => this.onHelperError(child, error));
    // `close`, not `exit`: it comes after the pipes have drained, so every
    // line the helper wrote has been read by then.
    child.on("close", (code, signal) => this.onHelperClose(child, code, signal));

    // An idle helper must never hold a process open. A run in flight keeps the
    // loop alive through its timeout timer.
    child.unref?.();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      (stream as { unref?: () => void } | null)?.unref?.();
    }
    return child;
  }

  private onOutput(child: ChildProcess, chunk: string): void {
    const run = this.run;
    if (!run || run.child !== child || run.finishing) {
      // Output nobody asked for: the stream is out of step and the next frame
      // could not be trusted.
      if (this.child === child) this.retireChild();
      return;
    }

    const previousLength = run.output.length;
    run.output += chunk;
    if (run.output.length > MAX_REPORT_CHARS) {
      this.fail(run, `tree-kill report exceeded ${MAX_REPORT_CHARS} characters`);
      return;
    }

    const marker = `${TREE_KILL_SENTINEL_PREFIX}${run.id}`;
    const end = findSentinelLine(
      run.output,
      marker,
      Math.max(0, previousLength - marker.length - 2)
    );
    if (end === null) return;

    const report = run.output.slice(0, end.at);
    const trailing = run.output.slice(end.after);
    // A complete answer is used even from a helper already being given up on:
    // it says exactly what was done.
    const results = this.engine.readReport(run.targets, report);
    if (!results) {
      const reason = "tree-kill helper sent an incomplete report";
      this.fail(run, reason);
      // The sentinel closes the run's output: this is all of it, no need to
      // wait for the pipe.
      this.recover(run, report, true, run.failure ?? reason);
      return;
    }
    if (trailing.trim().length > 0 && this.child === child) this.retireChild();
    if (run.failure === null) this.consecutiveFailures = 0;
    this.settle(run, results);
  }

  private onHelperError(child: ChildProcess, error: Error): void {
    const run = this.run;
    if (run?.child === child) {
      this.fail(run, formatErrorMessage(error, "tree-kill helper failed"));
    } else if (this.child === child) {
      // An idle helper that fails — a prewarm that could not start — is a
      // failure like any other, or a machine without PowerShell would try
      // again at every terminal event.
      this.noteFailure();
      this.retireChild();
    }
  }

  private onHelperClose(child: ChildProcess, code: number | null, signal: string | null): void {
    if (this.child === child) {
      // Only retirement ends a helper on purpose, and it lets go first.
      this.child = null;
      if (this.run?.child !== child) this.noteFailure();
    }
    const run = this.run;
    if (run?.child !== child || run.finishing) return;
    if (run.failure === null) {
      run.failure = `tree-kill helper exited (code=${String(code)} signal=${String(signal)})`;
      this.noteFailure();
    }
    // The pipe has closed, so the partial report is all there is.
    this.recover(run, run.output, true, run.failure);
  }

  /**
   * Give up on the persistent helper for this run: terminate it and finish the
   * run from its partial report once its pipe has closed. Without a close
   * within the grace period the report may be missing lines, and the recovery
   * is told so.
   */
  private fail(run: Run, reason: string): void {
    if (run.finishing || run.failure !== null) return;
    run.failure = reason;
    this.noteFailure();
    if (run.timer) clearTimeout(run.timer);
    const child = run.child;
    if (this.child === child) this.retireChild();
    if (!child || typeof child.pid !== "number") {
      // Never started: it wrote nothing.
      this.recover(run, run.output, true, reason);
      return;
    }
    run.timer = setTimeout(
      () => this.recover(run, run.output, false, reason),
      TREE_KILL_HELPER_CLOSE_GRACE_MS
    );
  }

  private recover(run: Run, partial: string, complete: boolean, reason: string): void {
    if (run.finishing) return;
    run.finishing = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    console.warn(
      `[WindowsTreeKill] ${reason}; finishing ${run.targets.length} root(s) with a one-shot helper`
    );
    // The run stays current until the one-shot finishes: one kill run at a time.
    // The one-shot is spawned before this call returns.
    const recovery = this.engine.recover(run.targets, partial, complete, run.budget, reason);
    this.markStarted(run);
    recovery.then(
      (results) => this.settle(run, results),
      (error: unknown) =>
        this.settle(
          run,
          run.targets.map(() => untouchedResult(formatErrorMessage(error, reason)))
        )
    );
  }

  private settle(run: Run, results: readonly WindowsTreeKillResult[]): void {
    if (this.run !== run) return;
    run.finishing = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    this.run = null;
    let offset = 0;
    for (const kill of run.kills) {
      const slice = results.slice(offset, offset + kill.targets.length);
      offset += kill.targets.length;
      kill.resolve(
        slice.length === kill.targets.length
          ? slice
          : kill.targets.map(() => untouchedResult("no report for this root"))
      );
    }

    if (this.queue.length > 0) {
      this.scheduleDispatch();
    } else if (this.keepWarm) {
      // A failed run retired its helper; the next request should not pay for that.
      this.prewarm();
    } else {
      this.armIdleTimer();
    }
  }

  private prewarm(): void {
    if (!this.keepWarm || this.child || this.disposed || this.cooldownTimer) return;
    try {
      this.launch();
    } catch (error) {
      this.noteFailure();
      console.warn(
        `[WindowsTreeKill] ${formatErrorMessage(error, "tree-kill helper did not start")}`
      );
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (!this.child || this.keepWarm) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.retireIfIdle();
    }, this.idleRetireMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private noteFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < TREE_KILL_FAILURES_BEFORE_COOLDOWN) return;
    const steps = this.consecutiveFailures - TREE_KILL_FAILURES_BEFORE_COOLDOWN;
    const delayMs = Math.min(
      TREE_KILL_COOLDOWN_BASE_MS * 2 ** steps,
      TREE_KILL_COOLDOWN_CEILING_MS
    );
    // While it runs, kills go straight to the one-shot helper: a helper that
    // keeps failing should cost no starts at all.
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
    }, delayMs);
    this.cooldownTimer.unref?.();
  }

  /**
   * Stop the current helper. Closing stdin ends its loop; the kill follows at
   * once because the pty-host's parent force-kills it shortly after asking it
   * to quit. Listeners stay attached and are guarded on identity, so a late
   * event from this child is inert and an EPIPE still has its handler.
   */
  private retireChild(): void {
    const child = this.child;
    this.child = null;
    this.clearIdleTimer();
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Where the sentinel LINE starts and where its terminator ends, or null until
 * both have arrived. A line that merely contains the marker is not one: an
 * error message could, and a prefix match would let run 1 accept run 10's end.
 */
function findSentinelLine(
  buffer: string,
  marker: string,
  from: number
): { at: number; after: number } | null {
  let at = buffer.indexOf(marker, from);
  while (at !== -1) {
    if (at === 0 || buffer[at - 1] === "\n") {
      const end = at + marker.length;
      if (buffer[end] === "\n") return { at, after: end + 1 };
      if (buffer[end] === "\r" && buffer[end + 1] === "\n") return { at, after: end + 2 };
      if (buffer[end] === undefined || (buffer[end] === "\r" && buffer[end + 1] === undefined)) {
        return null;
      }
    }
    at = buffer.indexOf(marker, at + 1);
  }
  return null;
}

function untouchedResult(error: string): WindowsTreeKillResult {
  return {
    mode: "untouched",
    targeted: [],
    killed: [],
    alreadyGone: [],
    timedOut: [],
    unconfirmed: [],
    failed: [],
    identityMismatch: [],
    stale: [],
    rootEnded: false,
    error,
  };
}
