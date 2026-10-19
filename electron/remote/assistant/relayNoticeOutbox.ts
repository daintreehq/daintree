import { randomUUID } from "node:crypto";
import type { RelayedNotice } from "../../services/mcp-server/terminalNotify.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import {
  AssistantLinkMethod,
  MAX_RELAY_NOTICES_PER_CALL,
  type RelayNotice,
} from "./linkMethods.js";

/** How long a notice waits for its Shell: as long as a dropped link may take to resume. */
export const RELAY_NOTICE_TTL_MS = 10 * 60_000;
/** Notices waiting for one link session; the oldest go first. */
export const MAX_RELAY_NOTICES_PER_LINK = 64;
/** Notices waiting across every link; the oldest go first. */
const MAX_RELAY_NOTICES_TOTAL = 1024;
/** Ended link sessions remembered, for notices armed before theirs went. */
const MAX_ENDED_LINKS = 256;
const CALL_TIMEOUT_MS = 15_000;
const RETRY_MS = 15_000;

/** Answers after which a Shell will never take these notices, so they are not sent again. */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(["UNSUPPORTED", "VALIDATION"]);

interface Entry {
  notice: RelayNotice;
  expiresAt: number;
}

interface LinkQueue {
  entries: Entry[];
  sending: boolean;
  retryAt: number;
}

export interface RelayNoticeOutboxDeps {
  server: MetricsSessionSource;
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
 * the Shell that made each call. A notice goes only over the link session its
 * call came in on, which a resume keeps: one that can't resume takes its
 * notices with it, and none waits longer than a dropped link may take to come
 * back. In memory and best effort, since a Shell also polls what it started.
 */
export class RelayNoticeOutbox {
  private readonly queues = new Map<string, LinkQueue>();
  private readonly ended = new Set<string>();
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
    // A resumed session keeps its id: what waited while it was away goes now.
    this.offSession = deps.server.onSession(({ sessionId }) => {
      const queue = this.queues.get(sessionId);
      if (queue === undefined) return;
      queue.retryAt = 0;
      this.flush(sessionId);
    });
  }

  enqueue(notices: readonly RelayedNotice[]): void {
    if (this.disposed) return;
    const touched = new Set<string>();
    const expiresAt = this.now() + this.ttlMs;
    for (const notice of notices) {
      if (this.ended.has(notice.linkSessionId)) continue;
      let queue = this.queues.get(notice.linkSessionId);
      if (queue === undefined) {
        queue = { entries: [], sending: false, retryAt: 0 };
        this.queues.set(notice.linkSessionId, queue);
      }
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
      if (queue.entries.length > MAX_RELAY_NOTICES_PER_LINK) queue.entries.shift();
      touched.add(notice.linkSessionId);
    }
    while (this.waiting() > MAX_RELAY_NOTICES_TOTAL) this.dropOldest();
    for (const linkSessionId of touched) this.flush(linkSessionId);
  }

  /** The link session can't resume: what waits for it goes, and nothing more is queued for it. */
  endLink(linkSessionId: string): void {
    this.ended.add(linkSessionId);
    if (this.ended.size > MAX_ENDED_LINKS) this.ended.delete(this.ended.values().next().value!);
    this.queues.delete(linkSessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.offSession();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.queues.clear();
  }

  private flush(linkSessionId: string): void {
    const queue = this.queues.get(linkSessionId);
    if (this.disposed || queue === undefined || queue.sending) return;
    const now = this.now();
    queue.entries = queue.entries.filter((entry) => entry.expiresAt > now);
    if (queue.entries.length === 0) {
      this.queues.delete(linkSessionId);
      this.schedule();
      return;
    }
    const session = this.sessionFor(linkSessionId);
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
        if (this.queues.get(linkSessionId) === queue) this.flush(linkSessionId);
      });
  }

  /** Take a batch the Shell answered for out of its queue; an expiry meanwhile may have taken some. */
  private settle(queue: LinkQueue, batch: readonly Entry[]): void {
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
    let oldest: LinkQueue | null = null;
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

  private sessionFor(linkSessionId: string): LinkSession | null {
    for (const ctx of this.deps.server.sessions) {
      if (ctx.sessionId === linkSessionId && ctx.session.isOpen) return ctx.session;
    }
    return null;
  }

  /** One timer, for the soonest retry over an open link or the soonest expiry. */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    let soonest: number | null = null;
    for (const [linkSessionId, queue] of this.queues) {
      if (queue.sending || queue.entries.length === 0) continue;
      let due = queue.entries[0]!.expiresAt;
      if (this.sessionFor(linkSessionId) !== null) due = Math.min(due, queue.retryAt);
      soonest = soonest === null ? due : Math.min(soonest, due);
    }
    if (soonest === null) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        for (const linkSessionId of [...this.queues.keys()]) this.flush(linkSessionId);
      },
      Math.max(0, soonest - this.now())
    );
    this.timer.unref?.();
  }
}
