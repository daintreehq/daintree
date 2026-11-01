import type {
  ScheduledRun,
  ScheduledRunEvidence,
  ScheduledRunOrigin,
  ScheduledRunProcess,
  ScheduledRunResume,
  ScheduledRunSkipReason,
} from "../../../shared/types/scheduledRuns.js";
import { outcomeForEvidence } from "../../../shared/utils/scheduledRuns.js";
import type { DaintreeEventMap } from "../events.js";
import type { ScheduledRunStore } from "./ScheduledRunStore.js";

export interface RegisterScheduledLaunchInput {
  readonly id: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly origin: ScheduledRunOrigin;
  /** Reserved for the launch, which spawns under this id. */
  readonly terminalId: string;
  /** Claude's session id is assigned at launch, so it can be here from the start. */
  readonly resume: ScheduledRunResume;
  /**
   * The handback code minted for the launch prompt (#15982). The run settles
   * on a marker for this code alone; null for a launch that asked for none.
   */
  readonly handbackCode?: string | null;
}

export interface RegisterRefusedLaunchInput {
  readonly id: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly origin: ScheduledRunOrigin;
  /** The terminal id reserved for the launch that never started, if one was. */
  readonly terminalId?: string | null;
  /** Why it didn't start, worded for the person reading the history. */
  readonly message: string;
}

export interface RegisterScheduledSkipInput {
  readonly id: string;
  readonly scheduleId: string;
  readonly projectId: string;
  readonly origin: ScheduledRunOrigin;
  readonly reason: ScheduledRunSkipReason;
  /** A terminal id registration reserved before the run was skipped, if any. */
  readonly terminalId?: string | null;
}

/** A PTY spawn's answer, as `PtyClient` emits `spawn-result`. */
export interface ScheduledRunSpawnFact {
  readonly success: boolean;
  /** The host's start time of the incarnation that spawned. */
  readonly spawnedAt?: number;
  readonly launchGeneration?: number;
  readonly error?: { readonly message: string };
}

/** An incarnation died with its pty-host, as `PtyClient` emits `incarnation-lost`. */
export interface ScheduledRunLostFact {
  readonly terminalId: string;
  readonly launchGeneration: number;
}

/** A PTY exit of one incarnation, as `PtyClient` emits `incarnation-exit`. */
export interface ScheduledRunExitFact {
  readonly terminalId: string;
  readonly spawnedAt?: number;
  readonly exitCode: number | null;
  readonly signal?: number | null;
}

/** A run's launch marker printed, as the pty-host reports it (`agent:run-handback-observed`). */
export interface ScheduledRunHandbackFact {
  readonly terminalId: string;
  /** The incarnation that printed it. */
  readonly spawnedAt: number;
  readonly code: string;
  readonly report: "done" | "needs-you";
  readonly message: string | null;
  readonly truncated: boolean;
}

/** The parts of an `agent-session:captured` payload a run's history reads. */
export interface ScheduledRunSessionFact {
  readonly record: {
    readonly sessionId: string;
    readonly agentId: string;
    readonly projectId: string | null;
    readonly terminal?: { readonly id: string; readonly spawnedAt: number };
  };
}

/**
 * A run the overlap policy is closing to put another in its place. Its own
 * exit or loss still lands on its process, but the settlement that would make
 * is held back until {@link finish} says whether the replacement went through.
 */
export interface ScheduledRunReplacement {
  /** Resolves once the run's PTY exit, or its loss, is recorded. */
  readonly gone: Promise<void>;
  readonly isGone: () => boolean;
  /**
   * Ends the hold. With a successor id the run settles as replaced by it;
   * with null it settles on whatever its own facts said meanwhile, or stays
   * open when they said nothing. Null when it settled on neither: another
   * service settled it first, or it's gone from the history.
   */
  readonly finish: (replacedByRunId: string | null) => ScheduledRun | null;
}

export interface ScheduledRunsChange {
  readonly projectId: string;
  readonly scheduleIds: readonly string[];
}

export interface ScheduledRunRecorderDeps {
  readonly store: ScheduledRunStore;
  readonly now?: () => number;
  /**
   * True once Daintree is quitting. A quit kills every terminal, and those
   * exits are the quit's, not the run's: they're recorded on the process, and
   * the run stays open for the next startup to settle as interrupted.
   */
  readonly isShuttingDown?: () => boolean;
  /** After a committed change, for the views of each project. */
  readonly onChanged?: (change: ScheduledRunsChange) => void;
  /** A run was registered to launch; for other main-side services. */
  readonly onRunStarted?: (payload: DaintreeEventMap["scheduled-run:started"]) => void;
  /** A run settled, once; for other main-side services. */
  readonly onRunEnded?: (payload: DaintreeEventMap["scheduled-run:ended"]) => void;
  /** A schedule's history was deleted, and its runs with it will never end. */
  readonly onRunsDeleted?: (payload: DaintreeEventMap["scheduled-runs:deleted"]) => void;
  readonly logWarn?: (message: string, error?: unknown) => void;
}

/** The incarnation a run's terminal was first seen spawning. */
interface Claim {
  readonly spawnedAt: number;
  /** Null when it was first seen exiting, which needs no later loss. */
  readonly launchGeneration: number | null;
}

// Signals are positive or null in the record; node-pty reports 0 for none.
function normalizeSignal(signal: number | null | undefined): number | null {
  return typeof signal === "number" && Number.isInteger(signal) && signal > 0 ? signal : null;
}

// A process last seen running whose host is gone: nothing is known of its exit.
function goneProcess(process: ScheduledRunProcess, at: number): ScheduledRunProcess {
  if (process.state !== "running") return process;
  return {
    state: "exited",
    startedAt: process.startedAt,
    exitedAt: at,
    exitCode: null,
    signal: null,
  };
}

function exitedProcess(
  previous: ScheduledRunProcess,
  exitedAt: number,
  exitCode: number | null,
  signal: number | null,
  startedAt: number
): ScheduledRunProcess {
  return {
    state: "exited",
    startedAt: previous.state === "running" ? previous.startedAt : startedAt,
    exitedAt,
    exitCode,
    signal,
  };
}

/**
 * Durable history of scheduled runs (#15976). A run is registered before its
 * terminal spawns, then the facts that arrive for its terminal incarnation are
 * recorded on it: the spawn, the PTY's exit, and a session id captured at exit.
 * Every write is synchronous and committed before anyone is told of it.
 *
 * Runs are matched to facts by terminal incarnation, `{terminalId, spawnedAt}`.
 * A run takes the first incarnation its reserved terminal spawns; a restart or
 * a crashed pty-host's replay under the same id is another incarnation, and
 * its facts aren't the run's. The run's own still reports its exit, or its
 * loss with the pty-host that ran it.
 */
export class ScheduledRunRecorder {
  private readonly store: ScheduledRunStore;
  private readonly now: () => number;
  private readonly isShuttingDown: () => boolean;
  private readonly onChanged: (change: ScheduledRunsChange) => void;
  private readonly onRunStarted: NonNullable<ScheduledRunRecorderDeps["onRunStarted"]>;
  private readonly onRunEnded: NonNullable<ScheduledRunRecorderDeps["onRunEnded"]>;
  private readonly onRunsDeleted: NonNullable<ScheduledRunRecorderDeps["onRunsDeleted"]>;
  private readonly logWarn: (message: string, error?: unknown) => void;
  /**
   * The incarnation each terminal of a run launched in this lifetime was first
   * seen spawning, null until then. Held here rather than read back, so a
   * write that failed can't let a later incarnation take the run. Facts for
   * any other terminal are skipped without a read: runs from an earlier
   * lifetime were settled as interrupted before any of these were added.
   */
  private readonly incarnations = new Map<string, Claim | null>();
  /**
   * The handback code each terminal's run launched with, for the life of the
   * process like the claims above. A marker for any other code (a later
   * prompt's, sent by hand or by an orchestrator) is never the run's report.
   */
  private readonly handbackCodes = new Map<string, string>();
  /** Runs being replaced, with the settlement their own facts made meanwhile. */
  private readonly replacing = new Map<
    string,
    { held: ScheduledRunEvidence | null; gone: boolean; markGone: () => void }
  >();

  constructor(deps: ScheduledRunRecorderDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.isShuttingDown = deps.isShuttingDown ?? (() => false);
    this.onChanged = deps.onChanged ?? (() => {});
    this.onRunStarted = deps.onRunStarted ?? (() => {});
    this.onRunEnded = deps.onRunEnded ?? (() => {});
    this.onRunsDeleted = deps.onRunsDeleted ?? (() => {});
    this.logWarn = deps.logWarn ?? console.warn;
  }

  /**
   * Records a run about to launch. It is committed before this returns, so the
   * caller spawns only after; a run whose occurrence already has one throws
   * {@link ScheduledRunConflictError} and must not launch. The terminal id is
   * reserved for this run alone: one another run already holds is refused, or
   * the two would share each other's facts.
   */
  registerLaunch(input: RegisterScheduledLaunchInput): ScheduledRun {
    if (
      this.incarnations.has(input.terminalId) ||
      this.store.findByTerminal(input.terminalId).length > 0
    ) {
      throw new Error(`Terminal ${input.terminalId} is already reserved for another run`);
    }
    const timestamp = this.now();
    const run: ScheduledRun = {
      id: input.id,
      scheduleId: input.scheduleId,
      projectId: input.projectId,
      origin: input.origin,
      createdAt: timestamp,
      terminalId: input.terminalId,
      terminalSpawnedAt: null,
      settlement: { state: "open" },
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      pane: { state: "none" },
      resume: input.resume,
    };
    this.store.transaction(() => {
      this.store.insert(run);
      this.store.prune(run.scheduleId);
    });
    this.incarnations.set(input.terminalId, null);
    if (input.handbackCode) this.handbackCodes.set(input.terminalId, input.handbackCode);
    this.changed([run]);
    this.notify(() =>
      this.onRunStarted({
        runId: run.id,
        scheduleId: run.scheduleId,
        projectId: run.projectId,
        terminalId: input.terminalId,
        timestamp,
      })
    );
    return run;
  }

  /**
   * Records a run whose launch was refused before its terminal spawned (a
   * panel limit, an agent that can't start, a project or worktree that's
   * gone), settled at once as failed with the reason. Like a skip it neither
   * starts nor ends, and it has nothing to resume: no launch plan ran.
   */
  registerRefusedLaunch(input: RegisterRefusedLaunchInput): ScheduledRun {
    return this.insertSettled(input, { kind: "launch-error", message: input.message });
  }

  /** Records an occurrence that was skipped, with its reason. It never launches. */
  registerSkip(input: RegisterScheduledSkipInput): ScheduledRun {
    return this.insertSettled(input, { kind: "skip", reason: input.reason });
  }

  /** Whether a run of the project is registered and not yet settled. */
  hasOpenRun(projectId: string): boolean {
    return this.store
      .listLive()
      .some((run) => run.projectId === projectId && run.settlement.state === "open");
  }

  private insertSettled(
    input: Pick<
      RegisterScheduledSkipInput,
      "id" | "scheduleId" | "projectId" | "origin" | "terminalId"
    >,
    evidence: ScheduledRunEvidence
  ): ScheduledRun {
    const timestamp = this.now();
    const run: ScheduledRun = {
      id: input.id,
      scheduleId: input.scheduleId,
      projectId: input.projectId,
      origin: input.origin,
      createdAt: timestamp,
      terminalId: input.terminalId ?? null,
      terminalSpawnedAt: null,
      settlement: {
        state: "settled",
        settledAt: timestamp,
        outcome: outcomeForEvidence(evidence),
        evidence,
      },
      process: { agent: { state: "not-started" }, pty: { state: "not-started" } },
      pane: { state: "none" },
      resume: null,
    };
    this.store.transaction(() => {
      this.store.insert(run);
      this.store.prune(run.scheduleId);
    });
    this.changed([run]);
    return run;
  }

  /**
   * Settles an open run on a fact another service saw: a handback, a launch
   * error, a cancel or a replacement. Returns the settled run, or null when
   * it's gone or was already settled, which never changes. Its terminal's
   * facts are still recorded on it afterwards.
   */
  settle(runId: string, evidence: ScheduledRunEvidence): ScheduledRun | null {
    const run = this.store.get(runId);
    if (!run || run.settlement.state !== "open") return null;
    const settled = this.withSettlement(run, evidence, this.now());
    return this.commit(settled, true) ? settled : null;
  }

  /**
   * Holds back the settlement a run's own exit or loss would make while the
   * overlap policy closes its terminal to replace it, so the close reads as a
   * replacement rather than as the run failing. Null when the run isn't open,
   * or is already being replaced.
   */
  beginReplacement(runId: string): ScheduledRunReplacement | null {
    const run = this.store.get(runId);
    if (!run || run.settlement.state !== "open" || this.replacing.has(runId)) return null;
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const entry: { held: ScheduledRunEvidence | null; gone: boolean; markGone: () => void } = {
      held: null,
      gone: false,
      markGone: () => {
        entry.gone = true;
        markGone();
      },
    };
    this.replacing.set(runId, entry);
    return {
      gone,
      isGone: () => entry.gone,
      finish: (replacedByRunId) => {
        if (this.replacing.get(runId) !== entry) return null;
        this.replacing.delete(runId);
        const evidence: ScheduledRunEvidence | null =
          replacedByRunId !== null ? { kind: "replace", replacedByRunId } : entry.held;
        return evidence ? this.settle(runId, evidence) : null;
      },
    };
  }

  /** A spawn of `terminalId` answered. Only the first incarnation seen is the run's. */
  handleSpawnResult(terminalId: string, result: ScheduledRunSpawnFact): void {
    if (!this.incarnations.has(terminalId)) return;
    const claimed = this.incarnations.get(terminalId) ?? null;
    if (!result.success) {
      // Refused before the terminal ever started, it is the run's launch
      // failing; after, it is some later attempt under the id.
      if (claimed !== null) return;
      const message = result.error?.message ?? "The terminal couldn't start";
      for (const run of this.store.findByTerminal(terminalId)) {
        if (run.settlement.state !== "open" || run.process.pty.state !== "not-started") continue;
        this.commit(this.withSettlement(run, { kind: "launch-error", message }, this.now()), true);
      }
      return;
    }
    const spawnedAt = result.spawnedAt;
    if (typeof spawnedAt !== "number") {
      this.logWarn(`[ScheduledRuns] A spawn of terminal ${terminalId} carried no incarnation`);
      return;
    }
    if (claimed === null) {
      this.incarnations.set(terminalId, {
        spawnedAt,
        launchGeneration: result.launchGeneration ?? null,
      });
    } else if (claimed.spawnedAt !== spawnedAt) {
      return;
    } else if (claimed.launchGeneration === null && result.launchGeneration !== undefined) {
      // A report that beat its spawn answer claimed the incarnation; the
      // generation it couldn't know is what a later loss is matched by.
      this.incarnations.set(terminalId, { spawnedAt, launchGeneration: result.launchGeneration });
    }
    // Also retries a binding whose earlier write failed.
    for (const run of this.store.findByTerminal(terminalId)) {
      if (run.terminalSpawnedAt !== null || run.process.pty.state !== "not-started") continue;
      this.commit({
        ...run,
        terminalSpawnedAt: spawnedAt,
        process: { ...run.process, pty: { state: "running", startedAt: spawnedAt } },
      });
    }
  }

  /**
   * The run's incarnation died with its pty-host, which is replaying the
   * terminal as a new one. Its exit will never come: the run is lost.
   */
  handleIncarnationLost(fact: ScheduledRunLostFact): void {
    const claimed = this.incarnations.get(fact.terminalId);
    if (!claimed || claimed.launchGeneration !== fact.launchGeneration) return;
    const at = this.now();
    for (const run of this.store.findByTerminal(fact.terminalId)) {
      if (run.process.pty.state === "exited") continue;
      let next: ScheduledRun = {
        ...run,
        terminalSpawnedAt: claimed.spawnedAt,
        process: {
          ...run.process,
          pty: exitedProcess(run.process.pty, at, null, null, claimed.spawnedAt),
        },
      };
      const settles = next.settlement.state === "open" && !this.isShuttingDown();
      const replacing = this.replacing.get(run.id);
      if (settles) {
        if (replacing) replacing.held = { kind: "lost" };
        else next = this.withSettlement(next, { kind: "lost" }, at);
      }
      this.commit(next, settles && !replacing);
      replacing?.markGone();
    }
  }

  /**
   * One incarnation's PTY exited. It always lands on the process; it settles
   * the run when the run is still open, unless Daintree is quitting.
   */
  handleExit(fact: ScheduledRunExitFact): void {
    const spawnedAt = fact.spawnedAt;
    if (typeof spawnedAt !== "number" || !this.incarnations.has(fact.terminalId)) return;
    const claimed = this.incarnations.get(fact.terminalId) ?? null;
    // An exit can arrive before its spawn answer; it is then the first incarnation seen.
    if (claimed === null) {
      this.incarnations.set(fact.terminalId, { spawnedAt, launchGeneration: null });
    } else if (claimed.spawnedAt !== spawnedAt) {
      return;
    }
    const exitedAt = this.now();
    const signal = normalizeSignal(fact.signal);
    const exitCode = fact.exitCode;
    for (const run of this.store.findByTerminal(fact.terminalId)) {
      if (run.process.pty.state === "exited") continue;
      let next: ScheduledRun = {
        ...run,
        terminalSpawnedAt: spawnedAt,
        process: {
          ...run.process,
          pty: exitedProcess(run.process.pty, exitedAt, exitCode, signal, spawnedAt),
        },
      };
      const settles = next.settlement.state === "open" && !this.isShuttingDown();
      const replacing = this.replacing.get(run.id);
      if (settles) {
        const evidence: ScheduledRunEvidence = { kind: "exit", process: "pty", exitCode, signal };
        if (replacing) replacing.held = evidence;
        else next = this.withSettlement(next, evidence, exitedAt);
      }
      this.commit(next, settles && !replacing);
      replacing?.markGone();
    }
  }

  /**
   * The run's agent printed the marker its launch prompt asked for (#15982):
   * `done` or `needs-you`, with its one-line summary. The first such marker
   * from the run's own incarnation settles it; a later one, a marker for any
   * other code, and one from a later incarnation under the same id record
   * nothing. Agent state plays no part: the marker is the fact.
   */
  handleHandback(fact: ScheduledRunHandbackFact): void {
    const { terminalId, spawnedAt } = fact;
    if (this.handbackCodes.get(terminalId) !== fact.code) return;
    const claimed = this.incarnations.get(terminalId) ?? null;
    // A report can arrive before its spawn answer; it is then the first incarnation seen.
    if (claimed === null) {
      this.incarnations.set(terminalId, { spawnedAt, launchGeneration: null });
    } else if (claimed.spawnedAt !== spawnedAt) {
      return;
    }
    const at = this.now();
    for (const run of this.store.findByTerminal(terminalId)) {
      if (run.settlement.state !== "open") continue;
      if (run.terminalSpawnedAt !== null && run.terminalSpawnedAt !== spawnedAt) continue;
      const bound: ScheduledRun = {
        ...run,
        terminalSpawnedAt: spawnedAt,
        process:
          run.process.pty.state === "not-started"
            ? { ...run.process, pty: { state: "running", startedAt: spawnedAt } }
            : run.process,
      };
      this.commit(
        this.withSettlement(
          bound,
          {
            kind: "handback",
            report: fact.report,
            summary: fact.message === null || fact.message === "" ? null : fact.message,
            truncated: fact.message !== null && fact.truncated,
          },
          at
        ),
        true
      );
    }
  }

  /**
   * A session was captured from a terminal incarnation. It fills the run's
   * session id when the run doesn't have one yet, settled or not; an id
   * already there is never replaced.
   */
  handleSessionCaptured(fact: ScheduledRunSessionFact): void {
    const { record } = fact;
    const terminal = record.terminal;
    if (!terminal || this.incarnations.get(terminal.id)?.spawnedAt !== terminal.spawnedAt) return;
    for (const run of this.store.findByTerminal(terminal.id)) {
      if (run.terminalSpawnedAt !== null && run.terminalSpawnedAt !== terminal.spawnedAt) continue;
      if (!run.resume || run.resume.agentId !== record.agentId) continue;
      if (record.projectId !== null && record.projectId !== run.projectId) continue;
      if (run.resume.agentSessionId !== null) {
        if (run.resume.agentSessionId !== record.sessionId) {
          this.logWarn(`[ScheduledRuns] Kept run ${run.id}'s session; another was captured`);
        }
        continue;
      }
      this.commit({
        ...run,
        terminalSpawnedAt: terminal.spawnedAt,
        resume: { ...run.resume, agentSessionId: record.sessionId },
      });
    }
  }

  /**
   * Settles every run an earlier lifetime left open as interrupted, and marks
   * processes last seen running as exited with nothing known of how: the PTY
   * host they ran in is gone. Their exit time is when this found them gone.
   * Runs once, before any run of this lifetime is registered.
   */
  reconcileInterrupted(): number {
    const at = this.now();
    const changed: ScheduledRun[] = [];
    const interrupted: ScheduledRun[] = [];
    this.store.transaction(() => {
      for (const run of this.store.listLive()) {
        let next: ScheduledRun = {
          ...run,
          process: {
            agent: goneProcess(run.process.agent, at),
            pty: goneProcess(run.process.pty, at),
          },
        };
        if (next.settlement.state === "open") {
          next = this.withSettlement(next, { kind: "interrupted" }, at);
          interrupted.push(next);
        }
        if (this.store.update(next)) changed.push(next);
      }
    });
    this.changed(changed);
    for (const run of interrupted) this.ended(run);
    return interrupted.length;
  }

  get(runId: string): ScheduledRun | null {
    return this.store.get(runId);
  }

  /**
   * The latest occurrence the schedule had a run registered for, launched,
   * refused or skipped, or null. It moves with that run's registration and
   * outlives its pruning, so no occurrence at or before it runs again.
   */
  evaluationPoint(scheduleId: string): number | null {
    return this.store.evaluationPoint(scheduleId);
  }

  listByProject(projectId: string): ScheduledRun[] {
    return this.store.listByProject(projectId);
  }

  listBySchedule(scheduleId: string): ScheduledRun[] {
    return this.store.listBySchedule(scheduleId);
  }

  /**
   * Deletes a schedule's history with it. A fact arriving later for one of its
   * runs finds no row and records nothing, so none of them ends: other
   * services hear of the deletion instead.
   */
  deleteForSchedule(scheduleId: string): void {
    const projectIds = this.store.deleteForSchedule(scheduleId);
    const timestamp = this.now();
    // Before the views hear of it: a view listener that throws must not keep
    // a deleted run holding anything.
    for (const projectId of projectIds) {
      this.notify(() => this.onRunsDeleted({ projectId, scheduleId, timestamp }));
    }
    for (const projectId of projectIds) this.onChanged({ projectId, scheduleIds: [scheduleId] });
  }

  private withSettlement(
    run: ScheduledRun,
    evidence: ScheduledRunEvidence,
    settledAt: number
  ): ScheduledRun {
    return {
      ...run,
      settlement: { state: "settled", settledAt, outcome: outcomeForEvidence(evidence), evidence },
    };
  }

  /**
   * Writes a changed run and tells its project's views; `ended` when this
   * write settled it. A settled run past the history limit goes once it's no
   * longer live. Returns false when nothing was written: the run is gone, or
   * the write failed.
   */
  private commit(run: ScheduledRun, ended = false): boolean {
    let written: boolean;
    try {
      written = this.store.transaction(() => {
        const updated = this.store.update(run);
        if (updated && run.settlement.state === "settled") this.store.prune(run.scheduleId);
        return updated;
      });
    } catch (error) {
      this.logWarn(`[ScheduledRuns] Couldn't record a fact on run ${run.id}`, error);
      return false;
    }
    if (!written) return false;
    this.changed([run]);
    if (ended) this.ended(run);
    return true;
  }

  private changed(runs: readonly ScheduledRun[]): void {
    const byProject = new Map<string, Set<string>>();
    for (const run of runs) {
      let schedules = byProject.get(run.projectId);
      if (!schedules) byProject.set(run.projectId, (schedules = new Set()));
      schedules.add(run.scheduleId);
    }
    for (const [projectId, schedules] of byProject) {
      try {
        this.onChanged({ projectId, scheduleIds: [...schedules] });
      } catch (error) {
        this.logWarn("[ScheduledRuns] Change listener threw", error);
      }
    }
  }

  private ended(run: ScheduledRun): void {
    const { settlement } = run;
    if (settlement.state !== "settled") return;
    this.notify(() =>
      this.onRunEnded({
        runId: run.id,
        scheduleId: run.scheduleId,
        projectId: run.projectId,
        terminalId: run.terminalId,
        outcome: settlement.outcome,
        timestamp: settlement.settledAt,
      })
    );
  }

  // Listeners follow a run that is already committed; one that throws can't undo it.
  private notify(send: () => void): void {
    try {
      send();
    } catch (error) {
      this.logWarn("[ScheduledRuns] A run listener threw", error);
    }
  }
}
