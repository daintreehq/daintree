import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
import { NOTIFY_TARGET_SETTLE_MS } from "../../../shared/types/terminalNotify.js";
import {
  extractReply,
  type NoticeReply,
  type NotifyStateChange,
  type NotifyTerminalInfo,
} from "./terminalNotify.js";

/**
 * Blocking replies (`waitForReply`): a send or launch that holds its MCP call
 * open until the agent it prompted finishes, and returns that agent's reply
 * as part of the result. The same end conditions as a terminal notice — the
 * handback marker for this prompt, otherwise a settle out of `working` that
 * holds for {@link NOTIFY_TARGET_SETTLE_MS}, an exit or a close — but the
 * reply goes back to the caller instead of into a prompt, so any MCP client
 * can use it, a pane of its own or not.
 *
 * A marker ends the wait {@link HANDBACK_REPLY_HOLD_MS} after it printed, or
 * sooner when the agent leaves `working`. The marker is often seen before the
 * screen has the reply: Grok's thinking preview carries its drafted marker, and
 * the final render lands after it. The marker's own summary comes back in
 * `handback`, which survives a screen the quote cannot read.
 *
 * A waiter can be created before the terminal is known (a launch) and bound
 * once the dispatch reports it; the target's recent state changes are kept
 * while waiters exist, so nothing between the dispatch and the bind is lost.
 */

export type AwaitedReplyOutcome = "handback" | "settled" | "exited" | "closed" | "timeout";

/** How long a wait holds after its marker prints before reading the screen. */
export const HANDBACK_REPLY_HOLD_MS = 1_500;

/**
 * The longest a hold can run from the first marker, however often a changed
 * capture restarts it.
 */
export const HANDBACK_REPLY_HOLD_MAX_MS = 5_000;

export interface AwaitedReply {
  terminalId: string;
  outcome: AwaitedReplyOutcome;
  /** The state it stopped in, or was in at the timeout. */
  state?: AgentState;
  waitingReason?: WaitingReason;
  /** The agent's last screen lines; with a handback, ending at its marker. */
  reply?: NoticeReply;
  /**
   * The summary the agent wrote into its marker, when it printed one; empty
   * for a bare marker.
   */
  handback?: string;
}

export interface ReplyWaiterPtyClient {
  getTerminalAsync(id: string): Promise<NotifyTerminalInfo | null>;
  getSerializedStateAsync?(id: string): Promise<{ data: string } | null>;
  on(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
  off(event: "exit", listener: (id: string, exitCode: number) => void): unknown;
}

export interface ReplyWaiterDeps {
  getPtyClient: () => ReplyWaiterPtyClient | null;
  onStateChanged: (listener: (payload: NotifyStateChange) => void) => () => void;
  onHandbackObserved: (
    listener: (terminalId: string, handback: TerminalHandback, code?: string) => void
  ) => () => void;
  onKilled: (listener: (terminalId: string) => void) => () => void;
  onTrashed: (listener: (terminalId: string) => void) => () => void;
  now?: () => number;
}

export interface ReplyWaitOptions {
  /** Known up front for a send; bound later for a launch. */
  terminalId?: string;
  /** Epoch ms from which the target's changes count. */
  since: number;
  replyLines: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** A send: only the handback for its own submission ends the wait, once bound. */
  expectsToken?: boolean;
}

export interface ReplyWait {
  /** Name the terminal (a launch) and the submission its handback must answer. */
  bind(terminalId: string | undefined, submissionToken?: string): void;
  /** The send or launch failed: settle without waiting. */
  cancel(): void;
  promise: Promise<AwaitedReply>;
}

/**
 * Waits held at once, across sessions. A client that drops its connection does
 * not abort its request, so an abandoned wait lasts until its timeout; the cap
 * bounds what those can hold. One past it returns at once as still going.
 */
export const MAX_OUTSTANDING_REPLY_WAITS = 128;

/** State changes kept per terminal while waiters exist, for a late bind. */
const MAX_RECENT_CHANGES = 16;

interface Waiter {
  terminalId?: string;
  submissionToken?: string;
  expectsToken: boolean;
  since: number;
  replyLines: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  settling?: { state: AgentState; waitingReason?: WaitingReason; startedAt: number };
  /** The latest marker seen for this wait; a later one replaces a draft. */
  handback?: TerminalHandback;
  /** Its code, when the observation named it: the reply is cut at that marker. */
  handbackCode?: string;
  /** Holding after a marker, for the screen to catch up with it. */
  holdTimer?: ReturnType<typeof setTimeout>;
  /** When the first marker of the hold printed; the cap counts from here. */
  holdStartedAt?: number;
  timeout: ReturnType<typeof setTimeout>;
  done: boolean;
  finish: (outcome: AwaitedReplyOutcome, state?: AgentState, reason?: WaitingReason) => void;
}

export class ReplyWaiterService {
  private readonly waiters = new Set<Waiter>();
  private readonly recent = new Map<string, NotifyStateChange[]>();
  /** Terminals closed while waiters exist, so a late bind learns of it. */
  private readonly recentlyClosed = new Set<string>();
  /** Handbacks seen while waiters exist: the PTY reports each marker once. */
  private readonly recentHandbacks = new Map<
    string,
    Array<{ handback: TerminalHandback; code?: string }>
  >();
  private unsubscribers: Array<() => void> = [];
  private subscribedClient: ReplyWaiterPtyClient | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ReplyWaiterDeps) {
    this.now = deps.now ?? Date.now;
  }

  wait(options: ReplyWaitOptions): ReplyWait {
    const client = this.deps.getPtyClient();
    if (client !== null) this.ensureSubscribed(client);
    let resolvePromise!: (value: AwaitedReply) => void;
    const promise = new Promise<AwaitedReply>((resolve) => {
      resolvePromise = resolve;
    });

    const waiter: Waiter = {
      terminalId: options.terminalId,
      expectsToken: options.expectsToken === true,
      since: options.since,
      replyLines: options.replyLines,
      done: false,
      timeout: setTimeout(() => waiter.finish("timeout"), options.timeoutMs),
      finish: (outcome, state, reason) => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timeout);
        if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
        if (waiter.holdTimer) clearTimeout(waiter.holdTimer);
        this.waiters.delete(waiter);
        this.maybeUnsubscribe();
        const terminalId = waiter.terminalId;
        if (terminalId === undefined) {
          resolvePromise({ terminalId: "", outcome });
          return;
        }
        void this.readReply(
          terminalId,
          waiter.replyLines,
          outcome,
          state,
          reason,
          waiter.handback,
          waiter.handbackCode
        ).then(resolvePromise);
      },
    };
    this.waiters.add(waiter);
    if (options.signal?.aborted || this.waiters.size > MAX_OUTSTANDING_REPLY_WAITS) {
      waiter.finish("timeout");
    } else if (options.signal) {
      const signal = options.signal;
      const onAbort = () => waiter.finish("timeout");
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.finally(() => signal.removeEventListener("abort", onAbort));
    }

    return {
      bind: (terminalId, submissionToken) => {
        if (waiter.done) return;
        if (terminalId !== undefined) waiter.terminalId = terminalId;
        if (submissionToken !== undefined) waiter.submissionToken = submissionToken;
        if (waiter.terminalId === undefined) return;
        if (this.recentlyClosed.has(waiter.terminalId)) {
          waiter.finish("closed");
          return;
        }
        const matching = (this.recentHandbacks.get(waiter.terminalId) ?? []).filter(
          ({ handback }) =>
            handback.observedAt >= waiter.since && this.handbackMatches(waiter, handback)
        );
        const latest = matching[matching.length - 1];
        if (latest !== undefined) this.holdForReply(waiter, latest.handback, latest.code);
        for (const change of this.recent.get(waiter.terminalId) ?? []) {
          this.apply(waiter, change);
          if (waiter.done) return;
        }
      },
      cancel: () => {
        if (waiter.done) return;
        waiter.terminalId = undefined;
        waiter.finish("closed");
      },
      promise,
    };
  }

  dispose(): void {
    for (const waiter of [...this.waiters]) waiter.finish("timeout");
    this.unsubscribe();
  }

  private async readReply(
    terminalId: string,
    lines: number,
    outcome: AwaitedReplyOutcome,
    state?: AgentState,
    reason?: WaitingReason,
    handback?: TerminalHandback,
    code?: string
  ): Promise<AwaitedReply> {
    const client = this.deps.getPtyClient();
    let finalState = state;
    let finalReason = reason;
    if (outcome === "timeout" && client !== null) {
      const info = await client.getTerminalAsync(terminalId).catch(() => null);
      finalState = info?.agentState;
      finalReason = info?.waitingReason;
    }
    let reply: NoticeReply | null = null;
    if (outcome !== "closed" && lines > 0 && client?.getSerializedStateAsync) {
      const snapshot = await client.getSerializedStateAsync(terminalId).catch(() => null);
      if (snapshot !== null) {
        const endAt =
          handback === undefined
            ? outcome === "handback"
            : { message: handback.message, ...(code !== undefined ? { code } : {}) };
        reply = extractReply(snapshot.data, lines, endAt).reply;
      }
    }
    return {
      terminalId,
      outcome,
      ...(finalState !== undefined ? { state: finalState } : {}),
      ...(finalReason !== undefined ? { waitingReason: finalReason } : {}),
      ...(reply !== null ? { reply } : {}),
      ...(handback !== undefined ? { handback: handback.message ?? "" } : {}),
    };
  }

  private apply(waiter: Waiter, change: NotifyStateChange): void {
    if (change.timestamp < waiter.since) return;
    const handbackNow =
      change.lastHandback !== undefined && this.handbackMatches(waiter, change.lastHandback);
    if (handbackNow) waiter.handback = change.lastHandback;
    // A marker already held for: the agent stopping is all the hold waits for.
    const holding = waiter.handback !== undefined && change.timestamp >= waiter.handback.observedAt;
    if ((handbackNow || holding) && change.state !== "working") {
      waiter.finish("handback", change.state, change.waitingReason);
      return;
    }
    if (change.state === "exited") {
      waiter.finish("exited", change.state);
      return;
    }
    if (change.state === "working") {
      // Replay can deliver a settle that already held before the next turn
      // began: that finished turn is the reply.
      const settled = waiter.settling;
      if (settled && change.timestamp - settled.startedAt >= NOTIFY_TARGET_SETTLE_MS) {
        waiter.finish("settled", settled.state, settled.waitingReason);
        return;
      }
      if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
      waiter.settleTimer = undefined;
      waiter.settling = undefined;
      return;
    }
    if (waiter.settling !== undefined) {
      waiter.settling.state = change.state;
      waiter.settling.waitingReason = change.waitingReason;
      return;
    }
    if (change.previousState !== "working") return;
    waiter.settling = {
      state: change.state,
      waitingReason: change.waitingReason,
      startedAt: change.timestamp,
    };
    const delay = Math.max(0, change.timestamp + NOTIFY_TARGET_SETTLE_MS - this.now());
    waiter.settleTimer = setTimeout(() => {
      const settling = waiter.settling;
      if (settling) waiter.finish("settled", settling.state, settling.waitingReason);
    }, delay);
  }

  /**
   * A marker for this wait printed: keep the newest capture, and end the wait
   * {@link HANDBACK_REPLY_HOLD_MS} after it, unless the agent is seen to stop
   * sooner. A capture that says something different — the reply replacing a
   * drafted marker — restarts the hold, up to {@link HANDBACK_REPLY_HOLD_MAX_MS}
   * from the first. A settle already under way hands over to the hold, keeping
   * the state it stopped in: its timer could otherwise end the wait a moment
   * after the marker, before the screen has caught up.
   */
  private holdForReply(waiter: Waiter, handback: TerminalHandback, code?: string): void {
    const previous = waiter.handback;
    waiter.handback = handback;
    if (code !== undefined) waiter.handbackCode = code;
    if (waiter.settleTimer !== undefined) {
      clearTimeout(waiter.settleTimer);
      waiter.settleTimer = undefined;
    }
    if (waiter.holdTimer !== undefined) {
      if (previous?.message === handback.message) return;
      clearTimeout(waiter.holdTimer);
    }
    waiter.holdStartedAt ??= handback.observedAt;
    const dueAt = Math.min(
      handback.observedAt + HANDBACK_REPLY_HOLD_MS,
      waiter.holdStartedAt + HANDBACK_REPLY_HOLD_MAX_MS
    );
    waiter.holdTimer = setTimeout(
      () => waiter.finish("handback", waiter.settling?.state, waiter.settling?.waitingReason),
      Math.max(0, dueAt - this.now())
    );
  }

  private handbackMatches(waiter: Waiter, handback: TerminalHandback): boolean {
    if (waiter.submissionToken === undefined) return !waiter.expectsToken;
    return handback.submissionToken === waiter.submissionToken;
  }

  private ensureSubscribed(client: ReplyWaiterPtyClient): void {
    if (this.unsubscribers.length > 0 && this.subscribedClient === client) return;
    this.unsubscribe();
    const onExit = (id: string) => this.forTerminal(id, (w) => w.finish("exited", "exited"));
    client.on("exit", onExit);
    this.subscribedClient = client;
    this.unsubscribers = [
      () => client.off("exit", onExit),
      this.deps.onStateChanged((change) => {
        if (change.terminalId === undefined) return;
        const list = this.recent.get(change.terminalId) ?? [];
        list.push(change);
        if (list.length > MAX_RECENT_CHANGES) list.shift();
        this.recent.set(change.terminalId, list);
        this.forTerminal(change.terminalId, (w) => this.apply(w, change));
      }),
      this.deps.onHandbackObserved((terminalId, handback, code) => {
        const list = this.recentHandbacks.get(terminalId) ?? [];
        list.push({ handback, ...(code !== undefined ? { code } : {}) });
        if (list.length > MAX_RECENT_CHANGES) list.shift();
        this.recentHandbacks.set(terminalId, list);
        this.forTerminal(terminalId, (w) => {
          if (this.handbackMatches(w, handback)) this.holdForReply(w, handback, code);
        });
      }),
      this.deps.onKilled((terminalId) => this.closeTerminal(terminalId)),
      this.deps.onTrashed((terminalId) => this.closeTerminal(terminalId)),
    ];
  }

  private closeTerminal(terminalId: string): void {
    this.recentlyClosed.add(terminalId);
    this.forTerminal(terminalId, (w) => w.finish("closed"));
  }

  private forTerminal(terminalId: string, fn: (waiter: Waiter) => void): void {
    for (const waiter of [...this.waiters]) {
      if (!waiter.done && waiter.terminalId === terminalId) fn(waiter);
    }
  }

  private maybeUnsubscribe(): void {
    if (this.waiters.size === 0) {
      this.unsubscribe();
      this.recent.clear();
      this.recentlyClosed.clear();
      this.recentHandbacks.clear();
    }
  }

  private unsubscribe(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.subscribedClient = null;
  }
}
