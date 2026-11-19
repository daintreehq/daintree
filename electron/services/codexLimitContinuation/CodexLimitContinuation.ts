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

/** A pane as its host reports it, as far as arming and the fallback read it. */
export interface ContinuationTerminal {
  projectId: string | undefined;
  launchAgentId: string | undefined;
  detectedAgentId: string | undefined;
  agentPresetId: string | undefined;
  originalAgentPresetId: string | undefined;
  fallbackChainIndex: number | undefined;
  isAssistantTerminal: boolean;
}

export type Timer = unknown;

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
  /** True once a pane is armed, false once none is: the live listeners follow it. */
  onActiveChange(active: boolean): void;
}

export class CodexLimitContinuationError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "UNSUPPORTED"
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
}

/**
 * Continuing armed Codex panes once their usage limit resets (#17909). The
 * user arms a pane; its host reports the stop once it has settled; this asks
 * whether the pane falls back instead and when the limit resets, waits until
 * then, and has the host check the pane and type the line. Lives in main, so
 * it runs whether or not any view of the project is on screen, and on a
 * Remote Host with no Shell attached. Held in memory: an app restart starts
 * every pane disarmed.
 */
export class CodexLimitContinuation {
  private readonly panes = new Map<string, ArmedPane>();
  /** The latest arm or disarm asked per pane, so an earlier one answered late changes nothing. */
  private readonly requests = new Map<string, number>();
  private readonly fired = new Map<string, number[]>();
  private nextRevision = 1;
  private nextRequest = 1;
  private timer: Timer | null = null;
  private timerAt: number | null = null;

  constructor(private readonly deps: CodexLimitContinuationDeps) {}

  list(projectId: string): CodexLimitContinueEntry[] {
    return [...this.panes.values()]
      .filter((pane) => pane.projectId === projectId)
      .map(({ terminalId, revision, state }) => ({ terminalId, revision, state }));
  }

  isArmed(terminalId: string): boolean {
    return this.panes.has(terminalId);
  }

  /**
   * Arm a pane of `projectId` for agents whose limit Daintree can wait out,
   * or disarm it, which drops a pending wait at once. Asked twice in quick
   * succession, the later request wins.
   */
  async set(terminalId: string, enabled: boolean, projectId: string): Promise<void> {
    const request = this.nextRequest++;
    this.requests.set(terminalId, request);
    if (!enabled) {
      this.disarm(terminalId);
      return;
    }
    if (this.panes.has(terminalId)) return;
    const terminal = await this.deps.readTerminal(terminalId).catch(() => null);
    if (this.requests.get(terminalId) !== request) return;
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
    if (this.panes.has(terminalId)) return;
    const wasActive = this.panes.size > 0;
    const pane: ArmedPane = {
      terminalId,
      projectId,
      revision: this.nextRevision++,
      state: { status: "armed" },
      wait: null,
      epoch: 0,
    };
    this.panes.set(terminalId, pane);
    if (!wasActive) this.deps.onActiveChange(true);
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
    if (this.panes.size === 0) this.deps.onActiveChange(false);
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
    const { reset, stamp } = await reading;
    if (this.panes.get(terminalId) !== pane || pane.epoch !== epoch) return;
    if (terminal === "gone") return;
    if (terminal === "unanswered") return this.record(pane, "host-unanswered");
    if (fallback === "fallback") return this.record(pane, "falls-back");
    if (fallback !== "none") return this.record(pane, "fallback-undetermined");
    if (reset.status === "unknown") return this.record(pane, reset.reason);
    if (stamp === null || stamp.run !== stop.run || stamp.seq !== stop.seq) {
      return this.record(pane, "banner-changed");
    }
    if (this.fired.get(terminalId)?.includes(reset.resetsAt)) {
      return this.record(pane, "already-continued");
    }
    const continueAt = reset.resetsAt + CONTINUE_AFTER_RESET_MS;
    pane.wait = { stop, resetsAt: reset.resetsAt, continueAt, claimed: false };
    this.setState(pane, { status: "waiting", resetsAt: reset.resetsAt, continueAt });
    this.checkDue();
  }

  /**
   * The pane's process changed: it exited, restarted, fell back or moved to
   * another account. A pending wait was for the old process and is dropped;
   * the pane stays armed for the new one.
   */
  handleProcessChange(terminalId: string): void {
    const pane = this.panes.get(terminalId);
    if (!pane) return;
    pane.epoch++;
    const hadWait = pane.wait !== null;
    pane.wait = null;
    if (hadWait) this.reschedule();
    if (pane.state.status !== "armed") this.setState(pane, { status: "armed" });
  }

  /** A new process under an armed pane's id: its host has to be told it is armed. */
  handleSpawn(terminalId: string): void {
    if (!this.panes.has(terminalId)) return;
    this.handleProcessChange(terminalId);
    this.deps.setHostArmed(terminalId, true);
  }

  /**
   * Continue every wait whose time has come, by the wall clock: after a
   * timer, and after the machine wakes, when one passed while it slept.
   */
  checkDue(): void {
    const now = this.deps.now();
    for (const pane of this.panes.values()) {
      const wait = pane.wait;
      if (wait && !wait.claimed && wait.continueAt <= now) {
        wait.claimed = true;
        void this.fire(pane, wait);
      }
    }
    this.reschedule();
  }

  dispose(): void {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.timerAt = null;
    const wasActive = this.panes.size > 0;
    this.panes.clear();
    if (wasActive) this.deps.onActiveChange(false);
  }

  private async fire(pane: ArmedPane, wait: PendingWait): Promise<void> {
    const fired = this.fired.get(pane.terminalId) ?? [];
    fired.push(wait.resetsAt);
    this.fired.set(pane.terminalId, fired.slice(-MAX_FIRED_PER_PANE));
    const result = await this.deps
      .continueAt(pane.terminalId, wait.stop)
      .catch((): CodexLimitContinueResult => ({ status: "skipped", reason: "host-unanswered" }));
    if (this.panes.get(pane.terminalId) !== pane || pane.wait !== wait) return;
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

  /** One timer, for the earliest wait still to come; none while nothing waits. */
  private reschedule(): void {
    let earliest: number | null = null;
    for (const pane of this.panes.values()) {
      const wait = pane.wait;
      if (wait && !wait.claimed && (earliest === null || wait.continueAt < earliest)) {
        earliest = wait.continueAt;
      }
    }
    if (earliest === this.timerAt) return;
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
