import type { AgentState, WaitingReason } from "../../../shared/types/agent.js";
import type { TerminalHandback } from "../../../shared/types/handback.js";
import { NOTIFY_TARGET_SETTLE_MS } from "../../../shared/types/terminalNotify.js";
import {
  extractNoticeReply,
  type NoticeReply,
  type NotifyStateChange,
  type NotifyTerminalInfo,
} from "./terminalNotify.js";

/**
 * Blocking replies (`waitForReply`): a send or launch that holds its MCP call
 * open until the agent it prompted finishes, and returns that agent's reply
 * as part of the result. The same end conditions as a terminal notice — the
 * handback marker for this prompt at once, otherwise a settle out of
 * `working` that holds for {@link NOTIFY_TARGET_SETTLE_MS}, an exit or a
 * close — but the reply goes back to the caller instead of into a prompt, so
 * any MCP client can use it, a pane of its own or not.
 *
 * A waiter can be created before the terminal is known (a launch) and bound
 * once the dispatch reports it; the target's recent state changes are kept
 * while waiters exist, so nothing between the dispatch and the bind is lost.
 */

export type AwaitedReplyOutcome = "handback" | "settled" | "exited" | "closed" | "timeout";

export interface AwaitedReply {
  terminalId: string;
  outcome: AwaitedReplyOutcome;
  /** The state it stopped in, or was in at the timeout. */
  state?: AgentState;
  waitingReason?: WaitingReason;
  /** The agent's last screen lines; with a handback, ending at its marker. */
  reply?: NoticeReply;
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
    listener: (terminalId: string, handback: TerminalHandback) => void
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
}

export interface ReplyWait {
  /** Name the terminal (a launch) and the submission its handback must answer. */
  bind(terminalId: string | undefined, submissionToken?: string): void;
  /** The send or launch failed: settle without waiting. */
  cancel(): void;
  promise: Promise<AwaitedReply>;
}

/** State changes kept per terminal while waiters exist, for a late bind. */
const MAX_RECENT_CHANGES = 16;

interface Waiter {
  terminalId?: string;
  submissionToken?: string;
  since: number;
  replyLines: number;
  settleTimer?: ReturnType<typeof setTimeout>;
  settling?: { state: AgentState; waitingReason?: WaitingReason; startedAt: number };
  timeout: ReturnType<typeof setTimeout>;
  done: boolean;
  finish: (outcome: AwaitedReplyOutcome, state?: AgentState, reason?: WaitingReason) => void;
}

export class ReplyWaiterService {
  private readonly waiters = new Set<Waiter>();
  private readonly recent = new Map<string, NotifyStateChange[]>();
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
      since: options.since,
      replyLines: options.replyLines,
      done: false,
      timeout: setTimeout(() => waiter.finish("timeout"), options.timeoutMs),
      finish: (outcome, state, reason) => {
        if (waiter.done) return;
        waiter.done = true;
        clearTimeout(waiter.timeout);
        if (waiter.settleTimer) clearTimeout(waiter.settleTimer);
        this.waiters.delete(waiter);
        this.maybeUnsubscribe();
        const terminalId = waiter.terminalId;
        if (terminalId === undefined) {
          resolvePromise({ terminalId: "", outcome });
          return;
        }
        void this.readReply(terminalId, waiter.replyLines, outcome, state, reason).then(
          resolvePromise
        );
      },
    };
    this.waiters.add(waiter);
    options.signal?.addEventListener("abort", () => waiter.finish("timeout"), { once: true });

    return {
      bind: (terminalId, submissionToken) => {
        if (waiter.done) return;
        if (terminalId !== undefined) waiter.terminalId = terminalId;
        if (submissionToken !== undefined) waiter.submissionToken = submissionToken;
        if (waiter.terminalId === undefined) return;
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
    reason?: WaitingReason
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
      if (snapshot !== null)
        reply = extractNoticeReply(snapshot.data, lines, outcome === "handback");
    }
    return {
      terminalId,
      outcome,
      ...(finalState !== undefined ? { state: finalState } : {}),
      ...(finalReason !== undefined ? { waitingReason: finalReason } : {}),
      ...(reply !== null ? { reply } : {}),
    };
  }

  private apply(waiter: Waiter, change: NotifyStateChange): void {
    if (change.timestamp < waiter.since) return;
    const handbackNow =
      change.lastHandback !== undefined && this.handbackMatches(waiter, change.lastHandback);
    if (handbackNow && change.state !== "working") {
      waiter.finish("handback", change.state, change.waitingReason);
      return;
    }
    if (change.state === "exited") {
      waiter.finish("exited", change.state);
      return;
    }
    if (change.state === "working") {
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

  private handbackMatches(waiter: Waiter, handback: TerminalHandback): boolean {
    return (
      waiter.submissionToken === undefined || handback.submissionToken === waiter.submissionToken
    );
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
      this.deps.onHandbackObserved((terminalId, handback) =>
        this.forTerminal(terminalId, (w) => {
          if (this.handbackMatches(w, handback)) w.finish("handback");
        })
      ),
      this.deps.onKilled((terminalId) => this.forTerminal(terminalId, (w) => w.finish("closed"))),
      this.deps.onTrashed((terminalId) => this.forTerminal(terminalId, (w) => w.finish("closed"))),
    ];
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
    }
  }

  private unsubscribe(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.subscribedClient = null;
  }
}
