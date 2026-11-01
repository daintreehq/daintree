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
  readonly error?: { readonly message: string };
}

/** A PTY exit of one incarnation, as `PtyClient` emits `incarnation-exit`. */
export interface ScheduledRunExitFact {
  readonly terminalId: string;
  readonly spawnedAt?: number;
  readonly exitCode: number | null;
  readonly signal?: number | null;
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
  readonly logWarn?: (message: string, error?: unknown) => void;
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
 * A run takes the first incarnation its reserved terminal spawns. The host
 * spawns an id again only once the terminal it had is gone, so a later
 * incarnation under the id (a restart, or a crashed pty-host's replay) means
 * the run's own ended unseen if its exit hasn't arrived: the run is `lost`.
 */
export class ScheduledRunRecorder {
  private readonly store: ScheduledRunStore;
  private readonly now: () => number;
  private readonly isShuttingDown: () => boolean;
  private readonly onChanged: (change: ScheduledRunsChange) => void;
  private readonly onRunStarted: NonNullable<ScheduledRunRecorderDeps["onRunStarted"]>;
  private readonly onRunEnded: NonNullable<ScheduledRunRecorderDeps["onRunEnded"]>;
  private readonly logWarn: (message: string, error?: unknown) => void;
  /**
   * The incarnation each terminal of a run launched in this lifetime was first
   * seen spawning, null until then. Held here rather than read back, so a
   * write that failed can't let a later incarnation take the run. Facts for
   * any other terminal are skipped without a read: runs from an earlier
   * lifetime were settled as interrupted before any of these were added.
   */
  private readonly incarnations = new Map<string, number | null>();

  constructor(deps: ScheduledRunRecorderDeps) {
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.isShuttingDown = deps.isShuttingDown ?? (() => false);
    this.onChanged = deps.onChanged ?? (() => {});
    this.onRunStarted = deps.onRunStarted ?? (() => {});
    this.onRunEnded = deps.onRunEnded ?? (() => {});
    this.logWarn = deps.logWarn ?? console.warn;
  }

  /**
   * Records a run about to launch. It is committed before this returns, so the
   * caller spawns only after; a run whose occurrence already has one throws
   * {@link ScheduledRunConflictError} and must not launch.
   */
  registerLaunch(input: RegisterScheduledLaunchInput): ScheduledRun {
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
    if (!this.incarnations.has(input.terminalId)) this.incarnations.set(input.terminalId, null);
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

  /** Records an occurrence that was skipped, with its reason. It never launches. */
  registerSkip(input: RegisterScheduledSkipInput): ScheduledRun {
    const timestamp = this.now();
    const evidence: ScheduledRunEvidence = { kind: "skip", reason: input.reason };
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

  /** A spawn of `terminalId` answered. */
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
    if (claimed === null) this.incarnations.set(terminalId, spawnedAt);
    if (claimed === null || claimed === spawnedAt) {
      // Also retries a binding whose earlier write failed.
      for (const run of this.store.findByTerminal(terminalId)) {
        if (run.terminalSpawnedAt !== null || run.process.pty.state !== "not-started") continue;
        this.commit({
          ...run,
          terminalSpawnedAt: spawnedAt,
          process: { ...run.process, pty: { state: "running", startedAt: spawnedAt } },
        });
      }
      return;
    }
    // A later incarnation under the run's terminal id.
    const at = this.now();
    for (const run of this.store.findByTerminal(terminalId)) {
      if (run.process.pty.state === "exited") continue;
      let next: ScheduledRun = {
        ...run,
        terminalSpawnedAt: claimed,
        process: {
          ...run.process,
          pty: exitedProcess(run.process.pty, at, null, null, claimed),
        },
      };
      const settles = next.settlement.state === "open" && !this.isShuttingDown();
      if (settles) next = this.withSettlement(next, { kind: "lost" }, at);
      this.commit(next, settles);
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
    if (claimed === null) this.incarnations.set(fact.terminalId, spawnedAt);
    else if (claimed !== spawnedAt) return;
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
      if (settles) {
        next = this.withSettlement(
          next,
          { kind: "exit", process: "pty", exitCode, signal },
          exitedAt
        );
      }
      this.commit(next, settles);
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
    if (!terminal || this.incarnations.get(terminal.id) !== terminal.spawnedAt) return;
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

  listByProject(projectId: string): ScheduledRun[] {
    return this.store.listByProject(projectId);
  }

  listBySchedule(scheduleId: string): ScheduledRun[] {
    return this.store.listBySchedule(scheduleId);
  }

  /**
   * Deletes a schedule's history with it. A fact arriving later for one of its
   * runs finds no row and records nothing.
   */
  deleteForSchedule(scheduleId: string): void {
    const projectIds = this.store.deleteForSchedule(scheduleId);
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
