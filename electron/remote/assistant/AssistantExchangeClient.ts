import type { HostId } from "../../../shared/types/remoteHosts.js";
import { AppError } from "../../utils/errorTypes.js";
import { EXCHANGE_RETRY_WINDOW_MS } from "../exchange/AssistantExchangeStore.js";
import type { AssistantExchangeJournal } from "../exchange/AssistantExchangeJournal.js";
import type { CreateDisposition, ExchangeChanges, ExchangeRecord } from "../exchange/types.js";
import type { LinkSession } from "../link/session.js";
import type { AssistantMessagingPolicy, MessagingRequestKind } from "./AssistantMessagingPolicy.js";
import {
  AssistantLinkMethod,
  ExchangeChangesSchema,
  ExchangeRecordSchema,
  LaneListSchema,
  MAX_EXCHANGE_PAGE,
  SendResultSchema,
  type AssistantSendPayload,
  type EnrolledLane,
} from "./linkMethods.js";

export interface AssistantExchangeClientDeps {
  journal: AssistantExchangeJournal;
  /** The host's open session, connecting it if need be; null when the host can't be reached. */
  session(hostId: HostId): Promise<LinkSession | null>;
  onSessionOpened(listener: (hostId: HostId, session: LinkSession) => void): () => void;
  /** This Shell's policy: whether its hub may message assistants on a host at all. */
  policy?: () => AssistantMessagingPolicy | undefined;
  callTimeoutMs?: number;
}

export type AssistantSendResult =
  | { status: "accepted"; disposition: CreateDisposition; record: ExchangeRecord }
  /**
   * The send may or may not have reached the host. Nothing failed: the Shell
   * looks the messageId up when it next has a session there.
   */
  | { status: "unknown"; messageId: string };

const CALL_TIMEOUT_MS = 15_000;

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
  private readonly disposers: Array<() => void> = [];
  private readonly timeoutMs: number;

  constructor(private readonly deps: AssistantExchangeClientDeps) {
    this.timeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS;
  }

  start(): void {
    this.disposers.push(
      this.deps.onSessionOpened((hostId, session) => {
        if (this.deps.journal.existingCredential(hostId) === null) return;
        void this.reconcile(hostId, session);
      })
    );
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
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
    if (journal.get(hostId, payload.messageId)?.lapsedAt != null) {
      throw new AppError({
        code: "VALIDATION",
        message: `Exchange ${payload.messageId} went unanswered past its retry window; send it as a new message`,
      });
    }
    const session = await this.open(hostId);
    await this.authenticate(hostId, session);
    const attempt = journal.noteSending(hostId, payload.messageId);
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
    if (running) return running;
    const run = this.runReconcile(hostId, session)
      .catch((error: unknown) => {
        if (codeOf(error) === "UNSUPPORTED") return;
        console.warn(`[AssistantExchanges] Couldn't reconcile with host ${hostId}:`, error);
      })
      .finally(() => this.reconciling.delete(hostId));
    this.reconciling.set(hostId, run);
    return run;
  }

  private async runReconcile(hostId: HostId, given?: LinkSession): Promise<void> {
    const session = given && given.isOpen ? given : await this.open(hostId);
    await this.authenticate(hostId, session);
    const { journal } = this.deps;
    // A listing that restarts from the beginning, read to its end, is the host's whole set.
    let restartedAt: number | null = null;
    for (let page = 0; page < MAX_RECONCILE_PAGES; page++) {
      const cursor = journal.cursor(hostId);
      const mark = journal.mark();
      const changes = await this.listPage(hostId, session, cursor, MAX_EXCHANGE_PAGE);
      if (changes.reset) restartedAt = mark;
      journal.applyChanges(hostId, changes);
      if (!changes.hasMore) {
        if (restartedAt !== null) journal.pruneUnseen(hostId, restartedAt);
        break;
      }
    }
    for (const messageId of journal.unresolved(hostId)) {
      await this.lookUp(hostId, session, messageId);
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
    messageId: string
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
