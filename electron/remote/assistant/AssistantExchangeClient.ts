import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { EXCHANGE_RETRY_WINDOW_MS, EXCHANGE_TTL_MS } from "../exchange/AssistantExchangeStore.js";
import type {
  AssistantExchangeJournal,
  JournalEntry,
} from "../exchange/AssistantExchangeJournal.js";
import type { CreateDisposition, ExchangeChanges, ExchangeRecord } from "../exchange/types.js";
import type { LinkSession } from "../link/session.js";
import type { AssistantMessagingPolicy, MessagingRequestKind } from "./AssistantMessagingPolicy.js";
import {
  AssistantLinkMethod,
  ExchangeChangedPayloadSchema,
  ExchangeChangesSchema,
  ExchangeRecordSchema,
  ExchangeResponsesSchema,
  LaneListSchema,
  MAX_EXCHANGE_PAGE,
  SendResultSchema,
  type AssistantSendPayload,
  type EnrolledLane,
  type ExchangeResponse,
} from "./linkMethods.js";

export interface AssistantExchangeClientDeps {
  journal: AssistantExchangeJournal;
  /** The host's open session, connecting it if need be; null when the host can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** This Shell's policy: whether its hub may message assistants on a host at all. */
  policy?: () => AssistantMessagingPolicy | undefined;
  /**
   * Told after a reconcile with the exchanges whose state it moved, each with
   * the enrollment generation of the hub that sent it in this run. One sent
   * before a restart has none and isn't told: nothing is rebound to a new hub.
   */
  onExchangesMoved?: (hostId: HostId, moved: MovedExchange[]) => void;
  callTimeoutMs?: number;
}

export type AssistantSendResult =
  | { status: "accepted"; disposition: CreateDisposition; record: ExchangeRecord }
  /**
   * The send may or may not have reached the host. Nothing failed: the Shell
   * looks the messageId up when it next has a session there.
   */
  | { status: "unknown"; messageId: string };

export interface MovedExchange {
  record: ExchangeRecord;
  hubGeneration: string;
}

const CALL_TIMEOUT_MS = 15_000;

/**
 * This Shell's own refusal to resend a message whose outcome stayed unknown
 * past its retry window. Its own class, so it is never mistaken for a host's
 * VALIDATION, which crosses the link as plain text.
 */
export class RetryWindowPassedError extends AppError {
  constructor(messageId: string) {
    super({
      code: "VALIDATION",
      message: `Exchange ${messageId} went unanswered past its retry window; look it up or send a new message`,
    });
    this.name = "RetryWindowPassedError";
  }
}

/**
 * What the host answers before it records anything: no authenticated sender,
 * no consent for the lane, an earlier generation, no support at all. A
 * resend of a recorded messageId is answered from its record ahead of these.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  "PERMISSION",
  "STALE_GENERATION",
  "UNSUPPORTED",
]);
const MAX_RECONCILE_PAGES = 200;
const RECONCILE_RETRY_MS = 30_000;

function sentKey(hostId: HostId, messageId: string): string {
  return `${hostId}\u0000${messageId}`;
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function isUnknownOutcome(error: unknown): boolean {
  const code = codeOf(error);
  return code === "OUTCOME_UNKNOWN" || code === "HOST_DISCONNECTED";
}

function unsupported(hostId: HostId, cause: unknown): AppError {
  return new AppError({
    code: "UNSUPPORTED",
    message: `Host ${hostId} doesn't support assistant messaging`,
    userMessage: "This host doesn't support assistant messaging.",
    cause: cause instanceof Error ? cause : undefined,
  });
}

function unreachable(hostId: HostId): AppError {
  return new AppError({
    code: "HOST_DISCONNECTED",
    message: `Host ${hostId} is not connected`,
    userMessage: "Couldn't reach this host. Check that it is on and try again.",
  });
}

function invalidAnswer(hostId: HostId, method: string): AppError {
  return new AppError({
    code: "INTERNAL",
    message: `Host ${hostId} sent an invalid ${method} answer`,
  });
}

/**
 * The Shell's side of assistant exchanges: the calls it makes on a host, and
 * the journal it keeps of what it sent. Every session that opens to a host
 * this Shell has sent to reconciles: it reads the host's changes since the
 * journal's cursor and looks up each send whose answer it never got. A host
 * that sleeps or a link that drops leaves an exchange where it was.
 */
export class AssistantExchangeClient {
  private readonly authenticated = new WeakSet<LinkSession>();
  private readonly reconciling = new Map<HostId, Promise<void>>();
  /** The hub enrollment each exchange sent in this run went out under, by host and messageId. */
  private readonly sentBy = new Map<string, { hubGeneration: string; sentAt: number }>();
  /** Hosts that announced a change while their reconcile was already reading. */
  private readonly again = new Set<HostId>();
  private readonly disposers: Array<() => void> = [];
  private readonly retries = new Map<HostId, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private readonly timeoutMs: number;

  constructor(private readonly deps: AssistantExchangeClientDeps) {
    this.timeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  start(): void {
    this.disposers.push(
      this.deps.onSessionOpened((hostId, session) => {
        // A host only announces to a session that authenticated, so this answers nothing before then.
        session.registerCallHandler(
          AssistantLinkMethod.EXCHANGE_CHANGED,
          ExchangeChangedPayloadSchema,
          ({ revision }) => {
            if (this.disposed) return null;
            if (revision > this.deps.journal.cursor(hostId)) void this.reconcile(hostId, session);
            return null;
          }
        );
        if (this.deps.journal.existingCredential(hostId) === null) return;
        void this.reconcile(hostId, session);
      })
    );
    // Exchanges still open from before a restart are read again; their link is then held.
    for (const hostId of this.deps.journal.hosts()) {
      if (this.deps.journal.hasOpen(hostId, EXCHANGE_RETRY_WINDOW_MS)) void this.reconcile(hostId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.sentBy.clear();
  }

  /** The lanes this Shell's current session to the host enrolled. */
  async listLanes(hostId: HostId): Promise<EnrolledLane[]> {
    this.checkHost(hostId, "inspect");
    const session = await this.open(hostId);
    const parsed = LaneListSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.LIST_LANES, null)
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.LIST_LANES);
    return parsed.data.lanes;
  }

  /**
   * Send one message. The journal holds it before anything leaves, so an
   * answer lost on the way back resolves by its messageId later. Sending the
   * same messageId again is safe: the host answers from its record, and
   * refuses one reused for a different message.
   */
  async send(hostId: HostId, payload: AssistantSendPayload): Promise<AssistantSendResult> {
    this.checkHost(hostId, "admit");
    const { journal } = this.deps;
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    const entry = journal.get(hostId, payload.messageId);
    // Past the window the host's record may be gone, so only a lookup is safe.
    const pastWindow =
      entry?.lapsedAt != null ||
      (entry?.unresolvedAt != null && Date.now() - entry.sentAt > EXCHANGE_RETRY_WINDOW_MS);
    if (pastWindow) {
      if (entry?.unresolvedAt != null) await this.lookUp(hostId, session, payload.messageId);
      throw new RetryWindowPassedError(payload.messageId);
    }
    const attempt = journal.noteSending(hostId, payload.messageId);
    // Only a message new to the journal is this hub's: a resend keeps whose it was, and
    // one sent before a restart stays no hub's.
    const hub = entry === null ? this.deps.policy?.()?.getHub() : null;
    if (hub) this.bind(sentKey(hostId, payload.messageId), hub.generation);
    let answer: unknown;
    try {
      answer = await session.call(AssistantLinkMethod.SEND, payload, { timeoutMs: this.timeoutMs });
    } catch (error) {
      if (isUnknownOutcome(error)) return { status: "unknown", messageId: payload.messageId };
      // Refused before anything was recorded there. Any other error leaves the
      // attempt unresolved, for a lookup to settle.
      if (DEFINITE_REFUSALS.has(codeOf(error) ?? "")) {
        journal.abandonAttempt(hostId, payload.messageId, attempt);
      }
      if (codeOf(error) === "UNSUPPORTED") throw unsupported(hostId, error);
      throw error;
    }
    const parsed = SendResultSchema.safeParse(answer);
    // Answered, but unreadable: what the host holds is learned on the next reconcile.
    if (!parsed.success) return { status: "unknown", messageId: payload.messageId };
    journal.recordAnswer(hostId, parsed.data.record);
    return { status: "accepted", ...parsed.data };
  }

  /** The host's record of one of this Shell's exchanges, or null when it has none. */
  async get(hostId: HostId, messageId: string): Promise<ExchangeRecord | null> {
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    return this.lookUp(hostId, session, messageId);
  }

  /** This Shell's exchanges on the host changed since `cursor`, straight from the host. */
  async listChanges(hostId: HostId, cursor: number, limit?: number): Promise<ExchangeChanges> {
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    return this.listPage(hostId, session, cursor, limit);
  }

  /**
   * The answers the receiving lane gave one of this Shell's exchanges, while
   * the host still holds them. A host from before the call throws UNSUPPORTED.
   */
  async getResponses(hostId: HostId, messageId: string): Promise<ExchangeResponse[]> {
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    const parsed = ExchangeResponsesSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.GET_RESPONSES, { messageId })
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.GET_RESPONSES);
    return parsed.data.responses;
  }

  /** What this Shell's journal last knew of an exchange, without asking the host. */
  known(hostId: HostId, messageId: string): JournalEntry | null {
    return this.deps.journal.get(hostId, messageId);
  }

  /** Ask the host to cancel. Once delivery may have happened this is only a recorded request. */
  async cancel(hostId: HostId, messageId: string): Promise<ExchangeRecord> {
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    const parsed = ExchangeRecordSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.CANCEL_EXCHANGE, { messageId })
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.CANCEL_EXCHANGE);
    this.deps.journal.recordAnswer(hostId, parsed.data);
    return parsed.data;
  }

  /**
   * Catch the journal up with the host: its changes since the saved cursor,
   * then each send whose answer never came. One at a time per host; a failure
   * leaves the rest for the next session.
   */
  reconcile(hostId: HostId, session?: LinkSession): Promise<void> {
    const running = this.reconciling.get(hostId);
    if (running) {
      // It may have read past what changed already, so it reads once more when done.
      this.again.add(hostId);
      return running;
    }
    const run = this.reconcileUntilSettled(hostId, session)
      .catch((error: unknown) => {
        if (codeOf(error) === "UNSUPPORTED") return;
        // Asleep or out of reach: its exchanges stay where they were until a session opens.
        if (codeOf(error) === "HOST_DISCONNECTED") return;
        console.warn(`[AssistantExchanges] Couldn't reconcile with host ${hostId}:`, error);
        // A change announced meanwhile would otherwise wait for the next one: read once more, later.
        if (this.again.has(hostId)) this.retryLater(hostId, session);
      })
      .finally(() => {
        this.reconciling.delete(hostId);
        this.again.delete(hostId);
      });
    this.reconciling.set(hostId, run);
    return run;
  }

  /** Bindings outlive no exchange: past its TTL the host has expired it whatever happened. */
  private bind(key: string, hubGeneration: string): void {
    const now = Date.now();
    for (const [other, binding] of this.sentBy) {
      if (now - binding.sentAt > EXCHANGE_TTL_MS) this.sentBy.delete(other);
    }
    this.sentBy.set(key, { hubGeneration, sentAt: now });
  }

  private retryLater(hostId: HostId, session?: LinkSession): void {
    if (this.disposed || this.retries.has(hostId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(hostId);
      if (!this.disposed) void this.reconcile(hostId, session);
    }, RECONCILE_RETRY_MS);
    timer.unref?.();
    this.retries.set(hostId, timer);
  }

  private async reconcileUntilSettled(hostId: HostId, session?: LinkSession): Promise<void> {
    do {
      this.again.delete(hostId);
      await this.runReconcile(hostId, session);
    } while (this.again.has(hostId));
  }

  private async runReconcile(hostId: HostId, given?: LinkSession): Promise<void> {
    const session = given && given.isOpen ? given : await this.open(hostId);
    await this.authenticate(hostId, session);
    const { journal } = this.deps;
    const moved = new Map<string, ExchangeRecord>();
    const noteMoves = (records: readonly ExchangeRecord[]): void => {
      for (const record of records) {
        const known = journal.get(hostId, record.messageId)?.record;
        // An exchange first seen past where its send left it moved while its answer was lost.
        // Delivery facts move the revision too; only a new state or a reply is the hub's business.
        const isMove = known
          ? known.revision < record.revision &&
            (known.state !== record.state ||
              (known.delivery.replyReceivedAt === null && record.delivery.replyReceivedAt !== null))
          : record.state !== "submitted";
        if (isMove) {
          moved.set(record.messageId, record);
        }
      }
    };
    try {
      for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
        const changes = await this.listPage(
          hostId,
          session,
          journal.cursor(hostId),
          MAX_EXCHANGE_PAGE
        );
        noteMoves(changes.records);
        journal.applyChanges(hostId, changes);
        if (!changes.hasMore) break;
      }
      for (const messageId of journal.unresolved(hostId)) {
        await this.lookUp(hostId, session, messageId, (record) => noteMoves([record]));
      }
    } finally {
      if (moved.size > 0) this.tellMoved(hostId, [...moved.values()]);
    }
  }

  private tellMoved(hostId: HostId, records: ExchangeRecord[]): void {
    const moved: MovedExchange[] = [];
    for (const record of records) {
      const key = sentKey(hostId, record.messageId);
      const binding = this.sentBy.get(key);
      if (binding === undefined) continue;
      moved.push({ record, hubGeneration: binding.hubGeneration });
      // A reply may still land after another terminal state, so only a reply or expiry ends it.
      if (record.delivery.replyReceivedAt !== null || record.tombstonedAt !== null) {
        this.sentBy.delete(key);
      }
    }
    if (moved.length === 0 || this.disposed) return;
    try {
      this.deps.onExchangesMoved?.(hostId, moved);
    } catch (error) {
      console.error("[AssistantExchanges] Telling the hub of moved exchanges failed:", error);
    }
  }

  private checkHost(hostId: HostId, kind: MessagingRequestKind): void {
    const policy = this.deps.policy?.();
    if (!policy) return;
    const decision = policy.checkHost({ hostId, kind });
    if (decision.ok) return;
    throw new AppError({
      code: decision.reason === "unsupported-platform" ? "UNSUPPORTED" : "PERMISSION",
      message: `Assistant messaging to host ${hostId} refused: ${decision.reason}`,
    });
  }

  private async open(hostId: HostId): Promise<LinkSession> {
    const session = await this.deps.session(hostId);
    if (!session || !session.isOpen) throw unreachable(hostId);
    return session;
  }

  private async authenticate(hostId: HostId, session: LinkSession): Promise<void> {
    if (this.authenticated.has(session)) return;
    // Saved before it is ever presented, so a host never knows a sender this Shell forgot.
    const credential = this.deps.journal.credential(hostId);
    await this.call(hostId, session, AssistantLinkMethod.AUTHENTICATE, { credential });
    this.authenticated.add(session);
  }

  private async lookUp(
    hostId: HostId,
    session: LinkSession,
    messageId: string,
    beforeRecording?: (record: ExchangeRecord) => void
  ): Promise<ExchangeRecord | null> {
    const { journal } = this.deps;
    // The attempt this lookup is about: a send started after it is not settled by its answer.
    const attempt = journal.get(hostId, messageId)?.unresolvedAt ?? null;
    const answer = await this.call(hostId, session, AssistantLinkMethod.GET_EXCHANGE, {
      messageId,
    });
    if (answer === null) {
      if (attempt !== null) {
        journal.resolveMissing(hostId, messageId, attempt, EXCHANGE_RETRY_WINDOW_MS);
      }
      return null;
    }
    const parsed = ExchangeRecordSchema.safeParse(answer);
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.GET_EXCHANGE);
    beforeRecording?.(parsed.data);
    journal.recordAnswer(hostId, parsed.data);
    return parsed.data;
  }

  private async listPage(
    hostId: HostId,
    session: LinkSession,
    cursor: number,
    limit?: number
  ): Promise<ExchangeChanges> {
    const parsed = ExchangeChangesSchema.safeParse(
      await this.call(hostId, session, AssistantLinkMethod.LIST_EXCHANGES, {
        cursor,
        ...(limit === undefined ? {} : { limit }),
      })
    );
    if (!parsed.success) throw invalidAnswer(hostId, AssistantLinkMethod.LIST_EXCHANGES);
    return parsed.data;
  }

  private async call(
    hostId: HostId,
    session: LinkSession,
    method: string,
    payload: unknown
  ): Promise<unknown> {
    try {
      return await session.call(method, payload, { timeoutMs: this.timeoutMs });
    } catch (error) {
      if (codeOf(error) === "UNSUPPORTED") throw unsupported(hostId, error);
      throw error;
    }
  }
}
