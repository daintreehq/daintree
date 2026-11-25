import {
  canContinueAtLimitReset,
  type CodexLimitContinueChange,
  type CodexLimitContinueEntry,
  type CodexLimitContinueResult,
  type CodexLimitContinueSkipReason,
  type CodexLimitContinueState,
  type CodexLimitStopRef,
} from "../../../shared/types/codexLimitContinuation.js";
import type { CodexLimitStop } from "../codex/CodexLimitReset.js";
import type { LimitFallback } from "./limitFallback.js";

/**
 * How long after the reset the line is typed: the server's clock and Codex's
 * may sit a little apart, and a line typed into a window not yet open stops
 * on the same limit again.
 */
export const CONTINUE_AFTER_RESET_MS = 60_000;
/** Node can't hold a timer longer than this; a later deadline is looked at again then. */
const MAX_TIMER_MS = 2_147_483_647;
/** Reset instants remembered per pane, so one already continued never fires twice. */
const MAX_FIRED_PER_PANE = 8;
/**
 * How long after the machine wakes before a wait is judged: the pty host holds
 * its terminals' reads for a moment after a resume and releases them one by
 * one, and a pane read before then can't be told apart from one that moved on.
 */
export const WAKE_SETTLE_MS = 15_000;
/** How soon a pane whose output was held unread is asked again, and how many times. */
export const READS_PAUSED_RETRY_MS = 10_000;
const READS_PAUSED_RETRIES = 6;
/**
 * How long a launch's preset default waits for its host to confirm the spawn
 * (#17912). Only a backstop for a spawn never answered: a crash replay's
 * answer, under a newer generation, still confirms it.
 */
export const LAUNCH_CONFIRMATION_MS = 10 * 60_000;

/** A pane as its host reports it, as far as arming and the fallback read it. */
export interface ContinuationTerminal {
  projectId: string | undefined;
  launchAgentId: string | undefined;
  detectedAgentId: string | undefined;
  agentPresetId: string | undefined;
  originalAgentPresetId: string | undefined;
  fallbackChainIndex: number | undefined;
  isAssistantTerminal: boolean;
  /** Names the pane's process: a successor under the same id has another. */
  spawnedAt: number | undefined;
  /** The ledger generation the pane's process runs under, when its host says. */
  launchGeneration: number | undefined;
}

export type Timer = unknown;

/**
 * A launch the spawn handler just sent (#17912), whose preset default is
 * applied once the host confirms that spawn.
 */
export interface ContinuationLaunch {
  terminalId: string;
  projectId: string;
  /** The ledger generation the spawn went out under, which its result echoes. */
  launchGeneration: number;
  /**
   * The user's own original preset arms the pane, or doesn't; `keep` for a
   * launch that decides nothing (a shell, an agent Daintree can't continue),
   * noted only so it can't take an older launch's default for its own.
   */
  arms: boolean | "keep";
}

/** A host's answer to a spawn, as far as arming reads it. */
export interface ContinuationSpawnResult {
  success: boolean;
  launchGeneration?: number;
  spawnedAt?: number;
}

export interface CodexLimitContinuationDeps {
  now(): number;
  /** Null for a pane that is gone; rejects when its host didn't answer. */
  readTerminal(terminalId: string): Promise<ContinuationTerminal | null>;
  /** #17906's answer for the banner on screen, and its sighting. Never rejects. */
  readStop(terminalId: string): Promise<CodexLimitStop>;
  decideFallback(terminal: ContinuationTerminal): Promise<LimitFallback>;
  /** The host's check and write at the reset; rejects when it didn't answer. */
  continueAt(terminalId: string, stop: CodexLimitStopRef): Promise<CodexLimitContinueResult>;
  /** Tell the pane's host whether to report its settled stop. */
  setHostArmed(terminalId: string, armed: boolean): void;
  notify(projectId: string, change: CodexLimitContinueChange): void;
  setTimer(callback: () => void, delayMs: number): Timer;
  clearTimer(timer: Timer): void;
  /**
   * True once a pane is armed or a launch awaits its spawn, false once none
   * is: the live listeners follow it.
   */
  onActiveChange(active: boolean): void;
}

export class CodexLimitContinuationError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "UNSUPPORTED" | "DRIVEN_ELSEWHERE"
  ) {
    super(message);
    this.name = "CodexLimitContinuationError";
  }
}

interface PendingWait {
  stop: CodexLimitStopRef;
  resetsAt: number;
  continueAt: number;
  /** Taken for checking and typing: a timer and a wake landing together share it. */
  claimed: boolean;
  /** Times the host found the pane's output held unread. */
  pausedRetries: number;
}

interface ArmedPane {
  terminalId: string;
  projectId: string;
  revision: number;
  state: CodexLimitContinueState;
  wait: PendingWait | null;
  /**
   * Bumped by every new stop and every process change, so an answer read for
   * an earlier one is dropped.
   */
  epoch: number;
  /** The pane's current process, as last read or spawned: a late exit of an earlier one changes nothing. */
  spawnedAt: number | undefined;
  /** The newest spawn confirmed under the pane, so an older one's late answer changes nothing. */
  launchGeneration: number | undefined;
}

interface PendingLaunch extends ContinuationLaunch {
  timer: Timer;
}

/**
 * Continuing armed Codex panes once their usage limit resets (#17909). The
 * user arms a pane; its host reports the stop once it has settled; this asks
 * whether the pane falls back instead and when the limit resets, waits until
 * then, and has the host check the pane and type the line. Lives in main, so
 * it runs whether or not any view of the project is on screen, and on a
 * Remote Host with no Shell attached. A preset can arm every pane launched on
 * it (#17912), and the pane's menu outranks that. Held in memory: an app
 * restart forgets every menu choice, and a restored pane takes its preset's.
 */
export class CodexLimitContinuation {
  private readonly panes = new Map<string, ArmedPane>();
  /** The latest arm or disarm asked per pane, so an earlier one answered late changes nothing. */
  private readonly requests = new Map<string, number>();
  private readonly fired = new Map<string, number[]>();
  /**
   * The user's menu choice per pane, by the project it was made from (#17912).
   * It outranks the pane's preset at every launch there, so it sticks across
   * the preset being edited, until the pane is closed for good.
   */
  private readonly overrides = new Map<string, Map<string, boolean>>();
  /**
   * Launches whose preset default waits on the host confirming the spawn,
   * oldest generation first: a duplicate spawn queued behind a live one
   * doesn't displace it.
   */
  private readonly launches = new Map<string, PendingLaunch[]>();
  /** Whether the live listeners are wanted, as last told. */
  private active = false;
  /**
   * Seeded from the clock, so revisions keep rising across a restart of the
   * host a view outlives: a view that held a disarm at an earlier revision
   * still takes what the new process says.
   */
  private nextRevision: number;
  private nextRequest = 1;
  private timer: Timer | null = null;
  private timerAt: number | null = null;
  /** No wait is judged before this, after the machine wakes. */
  private wakeHoldUntil = 0;

  constructor(private readonly deps: CodexLimitContinuationDeps) {
    this.nextRevision = deps.now();
  }

  list(projectId: string): CodexLimitContinueEntry[] {
    return [...this.panes.values()]
      .filter((pane) => pane.projectId === projectId)
      .map(({ terminalId, revision, state }) => ({ terminalId, revision, state }));
  }

  isArmed(terminalId: string): boolean {
    return this.panes.has(terminalId);
  }

  /** Whether a launch under `terminalId` can change anything: it is armed, or a launch awaits its spawn. */
  followsLaunches(terminalId: string): boolean {
    return this.panes.has(terminalId) || this.launches.has(terminalId);
  }

  /**
   * Any other spawn sent under an id a launch awaits, so its answer settles
   * only itself: it leaves the pane's arming as it was.
   */
  noteSpawn(terminalId: string, projectId: string, launchGeneration: number): void {
    if (!this.launches.has(terminalId)) return;
    this.noteLaunch({ terminalId, projectId, launchGeneration, arms: "keep" });
  }

  /**
   * Arm a pane of `projectId` for agents whose limit Daintree can wait out,
   * or disarm it, which drops a pending wait at once. Asked twice in quick
   * succession from the project, the later request wins; another project's
   * pane is never touched. `mayAct` is asked again once the host has answered,
   * so a caller that stopped driving the project meanwhile arms nothing.
   */
  async set(
    terminalId: string,
    enabled: boolean,
    projectId: string,
    mayAct: () => boolean = () => true
  ): Promise<void> {
    const owned = this.panes.get(terminalId);
    if (owned && owned.projectId !== projectId) {
      throw new CodexLimitContinuationError(
        `No terminal ${terminalId} in this project`,
        "NOT_FOUND"
      );
    }
    const requestKey = `${projectId}\u0000${terminalId}`;
    if (!enabled) {
      // An arm still waiting on its host read is superseded too.
      this.requests.delete(requestKey);
      this.setOverride(terminalId, projectId, false);
      this.disarm(terminalId);
      return;
    }
    if (owned) {
      this.setOverride(terminalId, projectId, true);
      return;
    }
    const request = this.nextRequest++;
    this.requests.set(requestKey, request);
    const terminal = await this.deps.readTerminal(terminalId).catch(() => null);
    if (this.requests.get(requestKey) !== request) return;
    this.requests.delete(requestKey);
    if (!mayAct()) {
      throw new CodexLimitContinuationError(
        "This project is being driven from another screen",
        "DRIVEN_ELSEWHERE"
      );
    }
    if (!terminal || terminal.projectId !== projectId) {
      throw new CodexLimitContinuationError(
        `No terminal ${terminalId} in this project`,
        "NOT_FOUND"
      );
    }
    const agentId = terminal.detectedAgentId ?? terminal.launchAgentId;
    if (terminal.isAssistantTerminal || !canContinueAtLimitReset(agentId)) {
      throw new CodexLimitContinuationError(
        "This terminal's agent can't be continued when its usage limit resets",
        "UNSUPPORTED"
      );
    }
    this.setOverride(terminalId, projectId, true);
    if (this.panes.has(terminalId)) return;
    this.arm(terminalId, projectId, terminal.spawnedAt, terminal.launchGeneration);
  }

  /**
   * A launch the spawn handler just sent, carrying whether its preset arms the
   * pane (#17912). Applied once the host confirms that very spawn; one never
   * confirmed is dropped.
   */
  noteLaunch(launch: ContinuationLaunch): void {
    const pending: PendingLaunch = {
      ...launch,
      timer: this.deps.setTimer(() => {
        this.dropLaunches(launch.terminalId, (held) => held === pending);
        this.updateActive();
      }, LAUNCH_CONFIRMATION_MS),
    };
    const held = this.launches.get(launch.terminalId) ?? [];
    this.launches.set(
      launch.terminalId,
      [...held, pending].sort((a, b) => a.launchGeneration - b.launchGeneration)
    );
    this.updateActive();
  }

  /**
   * The host answered a spawn. A refused one changes nothing: a process still
   * running under the id stays the pane's, wait and all. A confirmed launch
   * takes its preset's default unless the user chose for the pane; any other
   * new process under an armed pane's id keeps it armed.
   */
  handleSpawnResult(terminalId: string, result: ContinuationSpawnResult): void {
    this.settleSpawnResult(terminalId, result);
    this.updateActive();
  }

  private settleSpawnResult(terminalId: string, result: ContinuationSpawnResult): void {
    const generation = result.launchGeneration;
    if (!result.success) {
      if (generation !== undefined) {
        this.dropLaunches(terminalId, (held) => held.launchGeneration === generation);
      }
      return;
    }
    const pane = this.panes.get(terminalId);
    // An earlier spawn's answer arriving after a later one's, as across shards.
    if (
      generation !== undefined &&
      pane?.launchGeneration !== undefined &&
      generation < pane.launchGeneration
    ) {
      return;
    }
    // Its own launch, or for a crash replay, which resends a launch under a
    // newer generation, the newest one noted before it.
    let launch: PendingLaunch | undefined;
    if (generation !== undefined) {
      launch = this.launches
        .get(terminalId)
        ?.filter((held) => held.launchGeneration <= generation)
        .at(-1);
      this.dropLaunches(terminalId, (held) => held.launchGeneration <= generation);
    }
    if (launch && this.applyLaunch(launch, result.spawnedAt, generation)) return;
    this.handleSpawn(terminalId, result.spawnedAt, generation);
  }

  private dropLaunches(terminalId: string, matches: (held: PendingLaunch) => boolean): void {
    const held = this.launches.get(terminalId);
    if (!held) return;
    const kept = held.filter((launch) => {
      if (!matches(launch)) return true;
      this.deps.clearTimer(launch.timer);
      return false;
    });
    if (kept.length > 0) this.launches.set(terminalId, kept);
    else this.launches.delete(terminalId);
  }

  private setOverride(terminalId: string, projectId: string, armed: boolean): void {
    const choices = this.overrides.get(terminalId) ?? new Map<string, boolean>();
    choices.set(projectId, armed);
    this.overrides.set(terminalId, choices);
  }

  /**
   * The pane is closed for good (#17912): its menu choice, its arming and what
   * it already continued go with it, so a later pane given the same id starts
   * from its own preset.
   */
  forgetPane(terminalId: string): void {
    this.overrides.delete(terminalId);
    this.fired.delete(terminalId);
    this.dropLaunches(terminalId, () => true);
    // An arm still waiting on its host read arms nothing now.
    const suffix = `\u0000${terminalId}`;
    for (const key of [...this.requests.keys()]) {
      if (key.endsWith(suffix)) this.requests.delete(key);
    }
    this.disarm(terminalId);
    this.updateActive();
  }

  /**
   * A project was removed: everything held for its panes goes (#17912), and
   * nothing another project holds under the same ids.
   */
  forgetProject(projectId: string): void {
    for (const pane of [...this.panes.values()]) {
      if (pane.projectId !== projectId) continue;
      this.fired.delete(pane.terminalId);
      this.disarm(pane.terminalId);
    }
    for (const [terminalId, choices] of [...this.overrides]) {
      choices.delete(projectId);
      if (choices.size === 0) this.overrides.delete(terminalId);
    }
    for (const terminalId of [...this.launches.keys()]) {
      this.dropLaunches(terminalId, (held) => held.projectId === projectId);
    }
    const prefix = `${projectId}\u0000`;
    for (const key of [...this.requests.keys()]) {
      if (key.startsWith(prefix)) this.requests.delete(key);
    }
    this.updateActive();
  }

  /** True when the launch armed or disarmed the pane, which tells the host itself. */
  private applyLaunch(
    launch: ContinuationLaunch,
    spawnedAt: number | undefined,
    generation: number | undefined
  ): boolean {
    const { terminalId, projectId } = launch;
    const pane = this.panes.get(terminalId);
    // An id another project now runs under is not the pane that was armed.
    if (pane && pane.projectId !== projectId) {
      this.disarm(terminalId);
      return this.applyLaunch(launch, spawnedAt, generation);
    }
    if (launch.arms === "keep") return false;
    const wanted = this.overrides.get(terminalId)?.get(projectId) ?? launch.arms;
    if (wanted && !pane) {
      this.arm(terminalId, projectId, spawnedAt, generation);
      return true;
    }
    if (!wanted && pane) {
      this.disarm(terminalId);
      return true;
    }
    return false;
  }

  private arm(
    terminalId: string,
    projectId: string,
    spawnedAt: number | undefined,
    launchGeneration: number | undefined
  ): void {
    const pane: ArmedPane = {
      terminalId,
      projectId,
      revision: this.nextRevision++,
      state: { status: "armed" },
      wait: null,
      epoch: 0,
      spawnedAt,
      launchGeneration,
    };
    this.panes.set(terminalId, pane);
    this.updateActive();
    this.publish(pane);
    this.deps.setHostArmed(terminalId, true);
  }

  private disarm(terminalId: string): void {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    this.panes.delete(terminalId);
    this.deps.setHostArmed(terminalId, false);
    this.deps.notify(pane.projectId, {
      terminalId,
      revision: this.nextRevision++,
      state: null,
    });
    this.reschedule();
    this.updateActive();
  }

  /** The live listeners follow armed panes and launches awaiting their spawn. */
  private updateActive(): void {
    const active = this.panes.size > 0 || this.launches.size > 0;
    if (active === this.active) return;
    this.active = active;
    this.deps.onActiveChange(active);
  }

  /**
   * An armed pane's host reports its settled stop: fall back, record why it
   * can't be waited on, or wait for the reset.
   */
  async handleStop(terminalId: string, stop: CodexLimitStopRef): Promise<void> {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    const { wait } = pane;
    if (wait && wait.stop.run === stop.run && wait.stop.seq === stop.seq) return;
    const epoch = ++pane.epoch;
    // A newer stop replaces a wait for an older one, and the answer to one
    // already being typed: the host refuses it, as its banner has changed.
    if (wait) {
      pane.wait = null;
      this.reschedule();
      // Its time goes with it: a view must never show a deadline no timer
      // holds, while the new stop is read or after it comes to nothing.
      this.setState(pane, { status: "armed" });
    }
    // Asked at once: once the printed minute begins, what was spent at the
    // stop can no longer be told.
    const reading = this.deps.readStop(terminalId);
    const terminal = await this.deps.readTerminal(terminalId).then(
      (read) => read ?? ("gone" as const),
      () => "unanswered" as const
    );
    const fallback =
      typeof terminal === "string"
        ? null
        : await this.deps.decideFallback(terminal).catch(() => "unknown" as const);
    const { reset, stamp, skipAtStop } = await reading;
    if (this.panes.get(terminalId) !== pane || pane.epoch !== epoch) return;
    if (terminal === "gone") return;
    if (terminal === "unanswered") return this.record(pane, "host-unanswered");
    // An id another project now runs under is not the pane that was armed.
    if (terminal.projectId !== pane.projectId) return this.disarm(terminalId);
    pane.spawnedAt = terminal.spawnedAt ?? pane.spawnedAt;
    if (fallback === "fallback") return this.record(pane, "falls-back");
    if (fallback !== "none") return this.record(pane, "fallback-undetermined");
    // A stop its user took over (#18192), whatever its reset says: only one
    // about this very sighting, so a verdict on another never suppresses it.
    if (skipAtStop !== undefined && stamp?.run === stop.run && stamp.seq === stop.seq) {
      return this.record(pane, skipAtStop);
    }
    if (reset.status === "unknown") return this.record(pane, reset.reason);
    if (stamp === null || stamp.run !== stop.run || stamp.seq !== stop.seq) {
      return this.record(pane, "banner-changed");
    }
    if (this.fired.get(terminalId)?.includes(reset.resetsAt)) {
      return this.record(pane, "already-continued");
    }
    const continueAt = reset.resetsAt + CONTINUE_AFTER_RESET_MS;
    pane.wait = {
      stop,
      resetsAt: reset.resetsAt,
      continueAt,
      claimed: false,
      pausedRetries: 0,
    };
    this.setState(pane, { status: "waiting", resetsAt: reset.resetsAt, continueAt });
    this.checkDue();
  }

  /**
   * The pane's process changed: it exited, restarted, fell back or moved to
   * another account. A pending wait was for the old process and is dropped;
   * the pane stays armed for the new one. `spawnedAt` names the process the
   * fact is about, when known: a late exit of an earlier one leaves a
   * successor's wait alone.
   */
  handleProcessChange(terminalId: string, spawnedAt?: number): void {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    if (spawnedAt !== undefined && pane.spawnedAt !== undefined && spawnedAt !== pane.spawnedAt) {
      return;
    }
    pane.epoch++;
    const hadWait = pane.wait !== null;
    pane.wait = null;
    if (hadWait) this.reschedule();
    if (pane.state.status !== "armed") this.setState(pane, { status: "armed" });
  }

  /** A new process under an armed pane's id: its host has to be told it is armed. */
  handleSpawn(terminalId: string, spawnedAt?: number, launchGeneration?: number): void {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    this.handleProcessChange(terminalId);
    pane.spawnedAt = spawnedAt;
    if (launchGeneration !== undefined) pane.launchGeneration = launchGeneration;
    this.deps.setHostArmed(terminalId, true);
  }

  /**
   * The machine woke. A wait whose time passed in sleep is judged once the
   * pty host has let its terminals' reads go again, through the same checks;
   * the timer is set again from the wall clock, as one that stopped counting
   * in sleep would fire late.
   */
  handleWake(): void {
    this.wakeHoldUntil = this.deps.now() + WAKE_SETTLE_MS;
    this.reschedule(true);
  }

  /**
   * Continue every wait whose time has come, by the wall clock: after a
   * timer, and after the machine wakes, when one passed while it slept.
   */
  checkDue(): void {
    const now = this.deps.now();
    if (now >= this.wakeHoldUntil) {
      for (const pane of this.panes.values()) {
        const wait = pane.wait;
        if (wait && !wait.claimed && wait.continueAt <= now) {
          wait.claimed = true;
          void this.fire(pane, wait);
        }
      }
    }
    this.reschedule();
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
    for (const held of this.launches.values()) {
      for (const launch of held) this.deps.clearTimer(launch.timer);
    }
    this.launches.clear();
    this.overrides.clear();
    this.panes.clear();
    this.updateActive();
  }

  private async fire(pane: ArmedPane, wait: PendingWait): Promise<void> {
    const result = await this.deps
      .continueAt(pane.terminalId, wait.stop)
      .catch((): CodexLimitContinueResult => ({ status: "skipped", reason: "host-unanswered" }));
    if (this.panes.get(pane.terminalId) !== pane || pane.wait !== wait) return;
    // Output held unread says nothing yet: the same wait is judged again soon.
    if (
      result.status === "skipped" &&
      result.reason === "reads-paused" &&
      wait.pausedRetries < READS_PAUSED_RETRIES
    ) {
      wait.pausedRetries++;
      wait.claimed = false;
      wait.continueAt = this.deps.now() + READS_PAUSED_RETRY_MS;
      this.setState(pane, {
        status: "waiting",
        resetsAt: wait.resetsAt,
        continueAt: wait.continueAt,
      });
      this.reschedule();
      return;
    }
    const fired = this.fired.get(pane.terminalId) ?? [];
    fired.push(wait.resetsAt);
    this.fired.set(pane.terminalId, fired.slice(-MAX_FIRED_PER_PANE));
    pane.wait = null;
    if (result.status === "continued") {
      this.setState(pane, { status: "continued", at: this.deps.now(), line: result.line });
      return;
    }
    this.record(pane, result.reason);
  }

  private record(pane: ArmedPane, reason: CodexLimitContinueSkipReason): void {
    this.setState(pane, { status: "skipped", at: this.deps.now(), reason });
  }

  private setState(pane: ArmedPane, state: CodexLimitContinueState): void {
    pane.state = state;
    pane.revision = this.nextRevision++;
    this.publish(pane);
  }

  private publish(pane: ArmedPane): void {
    this.deps.notify(pane.projectId, {
      terminalId: pane.terminalId,
      revision: pane.revision,
      state: pane.state,
    });
  }

  /**
   * One timer, for the earliest wait still to come, never before a wake's
   * hold ends; none while nothing waits. `force` sets it again even for the
   * same deadline.
   */
  private reschedule(force = false): void {
    let earliest: number | null = null;
    for (const pane of this.panes.values()) {
      const wait = pane.wait;
      if (wait && !wait.claimed && (earliest === null || wait.continueAt < earliest)) {
        earliest = wait.continueAt;
      }
    }
    if (earliest !== null) earliest = Math.max(earliest, this.wakeHoldUntil);
    if (!force && earliest === this.timerAt) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = earliest;
    if (earliest === null) return;
    const delay = Math.min(Math.max(earliest - this.deps.now(), 0), MAX_TIMER_MS);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.timerAt = null;
      this.checkDue();
    }, delay);
  }
}
