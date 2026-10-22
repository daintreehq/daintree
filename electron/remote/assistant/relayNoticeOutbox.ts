import { randomUUID } from "node:crypto";
import type { RelayedNotice } from "../../services/mcp-server/terminalNotify.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import {
  AssistantLinkMethod,
  MAX_RELAY_NOTICES_PER_CALL,
  RELAY_NOTICE_WINDOW_MS,
  type RelayNotice,
} from "./linkMethods.js";
import type { SenderSessions } from "./senderSessions.js";

/** How long a notice waits for its Shell: as long as that Shell takes a call's notices. */
export const RELAY_NOTICE_TTL_MS = RELAY_NOTICE_WINDOW_MS;
/** Notices waiting for one Shell's sender; the oldest go first. */
export const MAX_RELAY_NOTICES_PER_SENDER = 64;
/** Notices waiting across every sender; the oldest go first. */
const MAX_RELAY_NOTICES_TOTAL = 1024;
const CALL_TIMEOUT_MS = 15_000;
const RETRY_MS = 15_000;

/** Answers after which a Shell will never take these notices, so they are not sent again. */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(["UNSUPPORTED", "VALIDATION"]);

interface Entry {
  notice: RelayNotice;
  expiresAt: number;
}

interface SenderQueue {
  entries: Entry[];
  sending: boolean;
  retryAt: number;
}

export interface RelayNoticeOutboxDeps {
  server: MetricsSessionSource;
  /** Read at each send: the sender each session proved, by its transport or its session id. */
  senders(): Pick<SenderSessions, "senderOf" | "senderOfSessionId"> | undefined;
  now?: () => number;
  newId?: () => string;
  ttlMs?: number;
  retryMs?: number;
  callTimeoutMs?: number;
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/**
 * The notices this host's relayed calls armed (#13500), on their way back to
 * the Shell that made each call. A notice goes only to the sender its call
 * proved, over whichever open session proved that sender: a resumed one by
 * its session id, a new one once it authenticates again. So a link that
 * can't resume doesn't take its notices with it (#13930); none waits longer
 * than the Shell takes them. In memory and best effort, since a Shell also
 * polls what it started.
 */
export class RelayNoticeOutbox {
  private readonly queues = new Map<string, SenderQueue>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private readonly offSession: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly deps: RelayNoticeOutboxDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? randomUUID;
    this.ttlMs = deps.ttlMs ?? RELAY_NOTICE_TTL_MS;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.timeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
    // A resumed session keeps its id and the sender it proved: what waited goes now.
    this.offSession = deps.server.onSession(() => {
      for (const senderId of [...this.queues.keys()]) this.flushSender(senderId);
    });
  }

  /** Notices a call relayed for `senderId` armed, for that Shell. */
  enqueue(senderId: string, notices: readonly RelayedNotice[]): void {
    if (this.disposed || notices.length === 0) return;
    const expiresAt = this.now() + this.ttlMs;
    let queue = this.queues.get(senderId);
    if (queue === undefined) {
      queue = { entries: [], sending: false, retryAt: 0 };
      this.queues.set(senderId, queue);
    }
    for (const notice of notices) {
      queue.entries.push({
        notice: {
          noticeId: this.newId(),
          helpSessionId: notice.helpSessionId,
          callId: notice.callId,
          terminalId: notice.terminalId,
          observation: notice.observation,
          ...(notice.awaitingHandback === true ? { awaitingHandback: true } : {}),
        },
        expiresAt,
      });
      if (queue.entries.length > MAX_RELAY_NOTICES_PER_SENDER) queue.entries.shift();
    }
    while (this.waiting() > MAX_RELAY_NOTICES_TOTAL) this.dropOldest();
    this.flush(senderId);
  }

  /** A session just proved `senderId`: what waits for it goes now. */
  flushSender(senderId: string): void {
    const queue = this.queues.get(senderId);
    if (queue === undefined) return;
    queue.retryAt = 0;
    this.flush(senderId);
  }

  /** The calls of one of a sender's help sessions with notices still waiting here. */
  waitingCalls(senderId: string, helpSessionId: string): Set<string> {
    const calls = new Set<string>();
    const now = this.now();
    for (const { notice, expiresAt } of this.queues.get(senderId)?.entries ?? []) {
      if (expiresAt > now && notice.helpSessionId === helpSessionId) calls.add(notice.callId);
    }
    return calls;
  }

  dispose(): void {
    this.disposed = true;
    this.offSession();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queues.clear();
  }

  private flush(senderId: string): void {
    const queue = this.queues.get(senderId);
    if (this.disposed || queue === undefined || queue.sending) return;
    const now = this.now();
    queue.entries = queue.entries.filter((entry) => entry.expiresAt > now);
    if (queue.entries.length === 0) {
      this.queues.delete(senderId);
      this.schedule();
      return;
    }
    const session = this.sessionFor(senderId);
    if (session === null || queue.retryAt > now) {
      this.schedule();
      return;
    }
    const batch = queue.entries.slice(0, MAX_RELAY_NOTICES_PER_CALL);
    queue.sending = true;
    session
      .call(
        AssistantLinkMethod.RELAY_NOTICES,
        { notices: batch.map((entry) => entry.notice) },
        { timeoutMs: this.timeoutMs }
      )
      .then(
        () => this.settle(queue, batch),
        (error: unknown) => {
          // A resend under the same noticeIds is typed once, so trying again is safe.
          if (PERMANENT_REFUSALS.has(codeOf(error) ?? "")) this.settle(queue, batch);
          else queue.retryAt = this.now() + this.retryMs;
        }
      )
      .finally(() => {
        queue.sending = false;
        if (this.queues.get(senderId) === queue) this.flush(senderId);
      });
  }

  /** Take a batch the Shell answered for out of its queue; an expiry meanwhile may have taken some. */
  private settle(queue: SenderQueue, batch: readonly Entry[]): void {
    const sent = new Set(batch);
    queue.entries = queue.entries.filter((entry) => !sent.has(entry));
    queue.retryAt = 0;
  }

  private waiting(): number {
    let count = 0;
    for (const queue of this.queues.values()) count += queue.entries.length;
    return count;
  }

  private dropOldest(): void {
    let oldest: SenderQueue | null = null;
    for (const queue of this.queues.values()) {
      const head = queue.entries[0];
      if (
        head !== undefined &&
        (oldest === null || head.expiresAt < oldest.entries[0]!.expiresAt)
      ) {
        oldest = queue;
      }
    }
    oldest?.entries.shift();
  }

  /** An open session that proved `senderId`: its transport did, or the session it resumes did. */
  private sessionFor(senderId: string): LinkSession | null {
    const senders = this.deps.senders();
    if (senders === undefined) return null;
    for (const ctx of this.deps.server.sessions) {
      if (!ctx.session.isOpen) continue;
      const proved = senders.senderOf(ctx.session) ?? senders.senderOfSessionId(ctx.sessionId);
      if (proved === senderId) return ctx.session;
    }
    return null;
  }

  /** One timer, for the soonest retry over an open link or the soonest expiry. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    let soonest: number | null = null;
    for (const [senderId, queue] of this.queues) {
      if (queue.sending || queue.entries.length === 0) continue;
      let due = queue.entries[0]!.expiresAt;
      if (this.sessionFor(senderId) !== null) due = Math.min(due, queue.retryAt);
      soonest = soonest === null ? due : Math.min(soonest, due);
    }
    if (soonest === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        for (const senderId of [...this.queues.keys()]) this.flush(senderId);
      },
      Math.max(0, soonest - this.now())
    );
    this.timer.unref?.();
  }
}
