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
  /** A read that reuses nothing taken before it started; `read` when absent. */
  readFresh?(): Promise<HostWorkReading>;
  /** The idle time set on this host, read again for every observation. */
  idleAfterMinutes(): number;
  clock?(): ElapsedStamp;
  intervalMs?: number;
  /** A read that takes longer counts as one that failed: busy. */
  readTimeoutMs?: number;
}

/**
 * The agents in `terminals` that hold the idle clock. Every agent with a
 * process counts, the assistant's, a throwaway run's and a trashed pane's
 * included: the fleet leaves those out of what it shows, but they still use
 * the machine. An agent in a state that isn't one of the known ones can't be
 * read, and counts as work.
 */
export function agentWorkOf(terminals: readonly CountableTerminal[]): {
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

/** What acts on idleness here needs of the tracker. */
export type HostIdleActorSource = Pick<
  HostIdleTracker,
  "observation" | "checkFresh" | "mayClaim" | "tryClaim" | "noteWork"
>;

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
 * Nothing here stops anything: whatever acts on idleness takes a fresh reading
 * with {@link checkFresh} and claims the ended idle time with {@link tryClaim}
 * before it acts, so only one of them ever acts on one idle time (#17922).
 */
export class HostIdleTracker {
  private readonly clock: () => ElapsedStamp;
  private lastWork: ElapsedStamp;
  private busy = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reading: Promise<number | null> | null = null;
  /** Ends the read under way as a failed one: set while it is out. */
  private abandonRead: (() => void) | null = null;
  /**
   * Counts every time work restarted the clock, noted or found by a check: a
   * read can tell work came while it was out, and a claim that its reading
   * still describes the idle time under way.
   */
  private workSeen = 0;
  /** Who claimed the idle time under way; cleared by the next work. */
  private claimedBy: symbol | null = null;
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
    this.recordWork();
  }

  /** One check; a check already under way is shared rather than doubled. */
  async check(): Promise<void> {
    if (this.disposed) return;
    this.reading ??= this.readOnce(this.deps.read).finally(() => {
      this.reading = null;
    });
    await this.reading;
  }

  /**
   * A check whose read starts now: one already under way may have looked
   * before the latest work. For whatever acts on idleness, just before it does.
   * Resolves to the reading to claim with: null when it saw work, failed, or
   * work came while it was out.
   */
  async checkFresh(): Promise<number | null> {
    while (this.reading) await this.reading;
    if (this.disposed) return null;
    this.reading = this.readOnce(this.deps.readFresh ?? this.deps.read).finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  /**
   * Whether `owner` could claim the idle time now, by the latest check: it has
   * ended and nobody else claimed it. Asks nothing; {@link tryClaim} decides.
   */
  mayClaim(owner: symbol, retryOwn = false): boolean {
    if (this.disposed || !this.ended(this.clock())) return false;
    return this.claimedBy === null || (retryOwn && this.claimedBy === owner);
  }

  /**
   * Claims the idle time `reading` (from {@link checkFresh}) found for
   * `owner`, once and for all: until new work restarts the clock, nobody else
   * is granted it, whatever becomes of the owner. `retryOwn` lets an owner
   * whose own attempt definitely didn't happen try again on its own claim.
   * Decided at once, so the caller acts in the same turn it is granted.
   */
  tryClaim(reading: number | null, owner: symbol, retryOwn = false): boolean {
    if (reading === null || reading !== this.workSeen || !this.mayClaim(owner, retryOwn)) {
      return false;
    }
    this.claimedBy = owner;
    return true;
  }

  observation(): HostIdleObservation {
    const idleAfterMinutes = this.deps.idleAfterMinutes();
    const lastWorkAt = this.lastWork.wall;
    if (this.busy) return { idleAfterMinutes, lastWorkAt, busy: true, idleEndsAt: null };
    const now = this.clock();
    return {
      idleAfterMinutes,
      lastWorkAt,
      busy: false,
      idleEndsAt: now.wall + idleAfterMinutes * 60_000 - this.elapsed(now),
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.abandonRead?.();
  }

  /** How long since the last work, by the lesser of the two clocks. */
  private elapsed(now: ElapsedStamp): number {
    // One stepped either way, or a machine asleep, never makes the idle time
    // end sooner than really passed.
    return Math.max(0, Math.min(now.mono - this.lastWork.mono, now.wall - this.lastWork.wall));
  }

  /** Whether the idle time has ended by `now`. */
  private ended(now: ElapsedStamp): boolean {
    return !this.busy && this.elapsed(now) >= this.deps.idleAfterMinutes() * 60_000;
  }

  private recordWork(): void {
    this.workSeen += 1;
    this.lastWork = this.clock();
    this.busy = true;
    this.claimedBy = null;
  }

  /** The work count this read describes when it found none; null otherwise. */
  private async readOnce(read: () => Promise<HostWorkReading>): Promise<number | null> {
    const seen = this.workSeen;
    let reading: HostWorkReading | null;
    try {
      reading = await Promise.race([read.call(this.deps), this.readDeadline()]);
    } catch {
      reading = null;
    } finally {
      this.abandonRead?.();
    }
    if (this.disposed) return null;
    if (reading === null || seesWork(reading)) {
      this.recordWork();
      return null;
    }
    // Work noted while this read was out is newer than what it saw.
    if (this.workSeen !== seen) return null;
    if (this.busy) {
      // The read's parts are taken at different moments during it, and the
      // work may have ended only just before the last: the idle time counts
      // from when the first check that found none finished.
      this.lastWork = this.clock();
      this.busy = false;
    }
    return seen;
  }

  /** Resolves null once a read has taken too long, or is abandoned. */
  private readDeadline(): Promise<null> {
    return new Promise<null>((resolve) => {
      const timeout = setTimeout(() => settle(), this.deps.readTimeoutMs ?? READ_TIMEOUT_MS);
      timeout.unref?.();
      const settle = () => {
        clearTimeout(timeout);
        if (this.abandonRead === settle) this.abandonRead = null;
        resolve(null);
      };
      this.abandonRead = settle;
    });
  }
}
