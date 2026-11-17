import { ACTIVE_AGENT_STATES, coerceAgentState } from "../../../shared/types/agent.js";
import type { HostIdleObservation } from "../../../shared/types/hostIdle.js";
import { hasAgentIdentity, type CountableTerminal } from "../../services/projectAgentCounts.js";
import { stampNow, type ElapsedStamp } from "../link/elapsed.js";

/** What one check of this host found. */
export interface HostWorkReading {
  /**
   * Agents working, waiting or directing (`active`), and agents whose state
   * can't be read; null when the agents couldn't all be read.
   */
  agents: { active: number; unreadable: number } | null;
  /** Whether a Shell has a window open on this host over a live link. */
  shellViews: boolean;
}

export interface HostIdleTrackerDeps {
  read(): Promise<HostWorkReading>;
  /** The idle time set on this host, read again for every observation. */
  idleAfterMinutes(): number;
  clock?(): ElapsedStamp;
  intervalMs?: number;
  /** A read that takes longer counts as one that failed: busy. */
  readTimeoutMs?: number;
}

type AgentTerminal = Pick<
  CountableTerminal,
  "hasPty" | "agentState" | "detectedAgentId" | "launchAgentId" | "everDetectedAgent"
>;

/**
 * The agents in `terminals` that hold the idle clock. Every agent with a
 * process counts, the assistant's, a throwaway run's and a trashed pane's
 * included: the fleet leaves those out of what it shows, but they still use
 * the machine. An agent in a state that isn't one of the known ones can't be
 * read, and counts as work.
 */
export function agentWorkOf(terminals: readonly AgentTerminal[]): {
  active: number;
  unreadable: number;
} {
  let active = 0;
  let unreadable = 0;
  for (const terminal of terminals) {
    if (terminal.hasPty === false || !hasAgentIdentity(terminal)) continue;
    const state = coerceAgentState(terminal.agentState);
    if (state === undefined) unreadable += 1;
    else if (ACTIVE_AGENT_STATES.has(state)) active += 1;
  }
  return { active, unreadable };
}

const CHECK_INTERVAL_MS = 15_000;
const READ_TIMEOUT_MS = 10_000;

/** Whether a reading holds the idle clock. Anything it can't see is work. */
export function seesWork(reading: HostWorkReading): boolean {
  return (
    reading.shellViews ||
    reading.agents === null ||
    reading.agents.active > 0 ||
    reading.agents.unreadable > 0
  );
}

/**
 * When this host last saw work, judged on the host itself so it holds with no
 * Shell attached (#17357). Checks on its own timer, and takes an agent's turn
 * to work from its event at once, so a burst between checks still counts.
 * Nothing here stops anything: whatever acts on idleness reads
 * {@link observation} and checks again before it acts.
 */
export class HostIdleTracker {
  private readonly clock: () => ElapsedStamp;
  private lastWork: ElapsedStamp;
  private busy = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly deps: HostIdleTrackerDeps) {
    this.clock = deps.clock ?? stampNow;
    // A host that just started hasn't been idle for any time yet.
    this.lastWork = this.clock();
  }

  start(): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), this.deps.intervalMs ?? CHECK_INTERVAL_MS);
    this.timer.unref?.();
    void this.check();
  }

  /** Work seen outside a check: an agent that just started working or waiting. */
  noteWork(): void {
    if (this.disposed) return;
    this.lastWork = this.clock();
    this.busy = true;
  }

  /** One check; a check already under way is shared rather than doubled. */
  check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.reading ??= this.readOnce().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  observation(): HostIdleObservation {
    const idleAfterMinutes = this.deps.idleAfterMinutes();
    const lastWorkAt = this.lastWork.wall;
    if (this.busy) return { idleAfterMinutes, lastWorkAt, busy: true, idleEndsAt: null };
    const now = this.clock();
    // The lesser of the two clocks: one stepped either way, or a machine
    // asleep, never makes the idle time end sooner than really passed.
    const idleFor = Math.max(
      0,
      Math.min(now.mono - this.lastWork.mono, now.wall - this.lastWork.wall)
    );
    return {
      idleAfterMinutes,
      lastWorkAt,
      busy: false,
      idleEndsAt: now.wall + idleAfterMinutes * 60_000 - idleFor,
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private async readOnce(): Promise<void> {
    const startedAt = this.clock();
    let reading: HostWorkReading | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      reading = await Promise.race([
        this.deps.read(),
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), this.deps.readTimeoutMs ?? READ_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } catch {
      reading = null;
    } finally {
      clearTimeout(timeout);
    }
    if (this.disposed) return;
    if (reading === null || seesWork(reading)) {
      this.lastWork = this.clock();
      this.busy = true;
      return;
    }
    // Work noted while this read was out is newer than what it saw.
    if (this.lastWork.mono > startedAt.mono) return;
    if (this.busy) {
      // The work was there until some time after the check that last saw it:
      // the idle time is counted from the first check that found none.
      this.lastWork = startedAt;
      this.busy = false;
    }
  }
}
