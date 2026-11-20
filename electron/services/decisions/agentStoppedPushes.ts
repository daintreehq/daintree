import type { AgentStoppedPushResult } from "@daintreehq/decisions-client";
import { LIMITS } from "@daintreehq/decisions-protocol";
import type { UserPresence } from "../userPresence.js";
import { electronPresenceWatchers, type PresenceWatchers } from "./desktopPresence.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * How long a batch gathers stops from its first: agents finishing together
 * reach the phone as one push.
 */
export const AGENT_STOPPED_BATCH_MS = 3_000;
/**
 * How long a stop must hold before it's sent, the desktop completion banner's
 * debounce: a turn that ends and picks straight up again isn't a stop.
 */
export const AGENT_STOPPED_SETTLE_MS = 2_000;
/**
 * The least time between two requests. The relay takes one a minute and drops
 * the rest, so stops in that minute wait for the next rather than being sent
 * to be dropped; the second covers the two clocks disagreeing a little.
 */
export const AGENT_STOPPED_COOLDOWN_MS = LIMITS.agentStoppedPushWindowMs + 1_000;

const STOPPED_STATES = new Set(["completed", "exited"]);

/** One observed transition of an agent on this computer, as the bus carries it. */
export interface AgentTransition {
  terminalId?: string;
  state: string;
  previousState: string;
  /** Daintree itself was ending the terminal (a kill, or quitting): not the agent stopping. */
  terminalClosing?: boolean;
}

export interface AgentStoppedPushesOptions {
  /** Whether stops may be pushed now: Decisions and the switch on, in this run. Read each time. */
  allowed(): boolean;
  /** Daintree's reading of the person; only `away` admits or sends a stop. */
  presence(): UserPresence;
  /** This computer's scheduled quiet hours are on now. */
  quiet(): boolean;
  /** The run was put aside (parked or snoozed), so nothing pages for it. */
  putAside(terminalId: string): boolean;
  /** Hears this computer's agent transitions until the returned function is called. */
  watchTransitions(listener: (transition: AgentTransition) => void): () => void;
  /**
   * Asks the bridge live now for one push; null when none is, so nothing was
   * asked. Supplied by the connection.
   */
  send(): Promise<AgentStoppedPushResult> | null;
  watch?: PresenceWatchers;
  /** A clock that never runs backwards; `performance.now` by default. */
  now?: () => number;
}

/**
 * Tells the person's phone that an agent on this computer stopped (#17319):
 * an observed turn into `completed` or `exited` while Daintree reads them as
 * away and outside quiet hours. Stops that land close together go out as one
 * request, and nothing about which agent, where or how many leaves this
 * computer: the request carries none of it.
 *
 * Presence, quiet hours and the switch are read again as a batch goes out,
 * and a batch is dropped, never held, when any of them says no, when the
 * person is seen back (an unlock or a Daintree window focused) or the
 * computer sleeps, and when no bridge is live to ask. Every request is final,
 * whatever comes of it. Nothing listens while `allowed` says no.
 */
export class AgentStoppedPushes {
  private offs: Array<() => void> = [];
  /** The stops in the batch: each pane once, with when its stop was observed. */
  private readonly pending = new Map<string, number>();
  private batchStartedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** When the last request was made; kept across a stop and start, since the relay's minute is too. */
  private lastSentAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly o: AgentStoppedPushesOptions) {
    this.now = o.now ?? (() => performance.now());
  }

  get listening(): boolean {
    return this.offs.length > 0;
  }

  /** Listens while `allowed` says yes, and stops, dropping the batch, when it says no. */
  update(): void {
    if (!this.o.allowed()) {
      this.stop();
      return;
    }
    if (this.offs.length > 0) return;
    const watch = this.o.watch ?? electronPresenceWatchers;
    this.offs = [
      this.o.watchTransitions((transition) => this.observe(transition)),
      // Asleep, a batch would go out on waking, however late.
      watch.onSuspend(() => this.drop()),
      watch.onChange(() => {
        if (this.pending.size > 0 && this.o.presence() !== "away") this.drop();
      }),
    ];
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.drop();
  }

  private observe(transition: AgentTransition): void {
    const { terminalId, state, previousState } = transition;
    if (!terminalId || state === previousState) return;
    if (!STOPPED_STATES.has(state) || transition.terminalClosing === true) {
      // Back at work, waiting, or being closed by Daintree: whatever stop it had isn't one now.
      if (this.pending.delete(terminalId) && this.pending.size === 0) this.drop();
      return;
    }
    // Completed then exited is still the one stop, from when it was first seen.
    if (this.pending.has(terminalId)) return;
    if (!this.admits(terminalId)) return;
    const now = this.now();
    if (this.pending.size === 0) this.batchStartedAt = now;
    this.pending.set(terminalId, now);
    this.schedule();
  }

  private admits(terminalId: string): boolean {
    return (
      this.o.allowed() &&
      this.o.presence() === "away" &&
      !this.o.quiet() &&
      !this.o.putAside(terminalId)
    );
  }

  /**
   * The batch goes once its window has passed, the relay's minute since the
   * last request is up, and at least one stop has held for the settle time.
   */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    let settledAt = Infinity;
    for (const observedAt of this.pending.values()) {
      settledAt = Math.min(settledAt, observedAt + AGENT_STOPPED_SETTLE_MS);
    }
    const due = Math.max(
      this.batchStartedAt + AGENT_STOPPED_BATCH_MS,
      this.lastSentAt + AGENT_STOPPED_COOLDOWN_MS,
      settledAt
    );
    this.timer = setTimeout(() => this.flush(), Math.max(0, due - this.now()));
    this.timer.unref?.();
  }

  private flush(): void {
    this.timer = null;
    if (!this.o.allowed() || this.o.presence() !== "away" || this.o.quiet()) {
      this.drop();
      return;
    }
    for (const terminalId of Array.from(this.pending.keys())) {
      if (this.o.putAside(terminalId)) this.pending.delete(terminalId);
    }
    if (this.pending.size === 0) return;
    const now = this.now();
    const settled = Array.from(this.pending.values()).some(
      (observedAt) => now - observedAt >= AGENT_STOPPED_SETTLE_MS
    );
    if (!settled || now < this.lastSentAt + AGENT_STOPPED_COOLDOWN_MS) {
      this.schedule();
      return;
    }
    const count = this.pending.size;
    this.drop();
    let request: Promise<AgentStoppedPushResult> | null;
    try {
      request = this.o.send();
    } catch (error) {
      console.warn(
        "[Decisions] Agent-stopped push couldn't be asked for:",
        formatErrorMessage(error, "error")
      );
      return;
    }
    // No bridge to ask: the batch goes, so nothing reaches the phone late.
    if (request === null) return;
    this.lastSentAt = now;
    request.then(
      (result) => {
        if (result.outcome !== "sent") {
          console.info(`[Decisions] Agent-stopped push for ${count} stop(s): ${result.outcome}`);
        }
      },
      (error: unknown) => {
        console.warn("[Decisions] Agent-stopped push failed:", formatErrorMessage(error, "error"));
      }
    );
  }

  private drop(): void {
    this.pending.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
