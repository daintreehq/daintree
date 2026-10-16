import { assistantSlotKey } from "../../../shared/config/assistantSlots.js";
import {
  ASSISTANT_INBOX_PAGE_MAX,
  ASSISTANT_INBOX_PAGE_MAX_BYTES,
  type AssistantGetInboxArgs,
  type AssistantGetInboxResult,
  type AssistantInboxMessage,
  type AssistantMessagingOutcome,
  type AssistantMessagingRefusalCode,
  type AssistantReplyArgs,
  type AssistantReplyResult,
  type AssistantSendMessageArgs,
  type AssistantSendMessageResult,
} from "../../../shared/types/assistantMessaging.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { isAppError } from "../../utils/errorTypes.js";
import type { AssistantExchangeStore } from "../exchange/AssistantExchangeStore.js";
import {
  TERMINAL_EXCHANGE_STATES,
  type ExchangeKey,
  type ExchangeReceiver,
  type ExchangeRecord,
  type ReceiverActor,
} from "../exchange/types.js";
import {
  fenceUntrustedBody,
  inboxBodyFits,
  type AssistantInbox,
  type InboxEnvelope,
  type InboxEntry,
  type InboxResponse,
} from "./AssistantInbox.js";
import type { AssistantHostOutboxHandle } from "./AssistantHostOutbox.js";
import type {
  AssistantMessagingPolicy,
  LaneEnrollment,
  LaneRef,
  MessagingDenial,
} from "./AssistantMessagingPolicy.js";

/**
 * The receiver the host's link calls file a lane's exchanges under: the slot
 * key and the enrollment's own generation, so a record addressed to an
 * earlier enrollment never matches this one.
 */
export function exchangeReceiverFor(enrollment: LaneEnrollment): ExchangeReceiver {
  return {
    hostId: LOCAL_HOST_ID,
    laneId: assistantSlotKey(enrollment.projectId, enrollment.slot),
    enrollmentGeneration: enrollment.generation,
  };
}

export type AssistantMessagingErrorCode = AssistantMessagingRefusalCode;

/**
 * Every message is fixed text Daintree wrote. These errors reach the MCP
 * audit log, so none may carry what the caller sent or what a message said.
 */
const ERROR_MESSAGES: Record<AssistantMessagingErrorCode, string> = {
  NOT_ELIGIBLE:
    "Only an assistant whose lane is enrolled for messaging, in the session it was enrolled with, has an inbox.",
  INVALID_ARGS: "The arguments don't match this tool's schema.",
  UNKNOWN_TASK: "No message in this assistant's inbox has that taskId.",
  EXCHANGE_CLOSED: "That exchange has already ended, so it takes no further answer.",
  TOO_MANY_RESPONSES: "That exchange has taken as many answers as it can hold.",
  PAUSED: "Assistant messaging is paused on this machine, so no new message can be sent.",
  HOP_LIMIT:
    "This conversation has reached its hop limit. Ask the user before continuing it, or start a new one only if they want you to.",
  TOO_LARGE: "The message is too large for an assistant to be handed whole. Shorten it.",
  OUTBOX_FULL:
    "Too many of your messages are still waiting or unanswered. Check them with assistant.getInbox view sent.",
  UNAVAILABLE: "Assistant messages can't be read or recorded right now.",
};

export class AssistantMessagingError extends Error {
  constructor(readonly code: AssistantMessagingErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AssistantMessagingError";
  }
}

export type CallerResolution =
  | { ok: true; enrollment: LaneEnrollment; actor: ReceiverActor }
  | { ok: false; reason: "not-a-lane" | MessagingDenial };

export interface AssistantMessagingRuntimeDeps {
  policy: AssistantMessagingPolicy;
  store: AssistantExchangeStore;
  inbox: AssistantInbox;
  /** The lane a live help session was provisioned for; null once it is revoked or ending. */
  getSessionLane(helpSessionId: string): LaneRef | null;
  /** Messages a host's lanes start to their Shell's hub (#13338); read at each call. */
  outbox?: () => AssistantHostOutboxHandle | undefined;
  /** Whether this machine has a host of its own, so a lane here may become its hub. */
  hasHosts?: () => boolean;
  /**
   * Types the wake line for an exchange into its lane again, outside the one
   * reserved first wake: what `reannounce` uses once a lane has its tools back.
   */
  rewake?: (enrollment: LaneEnrollment, record: ExchangeRecord, stillOwed: () => boolean) => void;
  now?: () => number;
}

function settle<T>(work: () => T): AssistantMessagingOutcome<T> {
  try {
    return { ok: true, value: work() };
  } catch (err) {
    if (err instanceof AssistantMessagingError) {
      return { ok: false, code: err.code, message: err.message };
    }
    console.error("[AssistantMessaging] Unexpected failure:", err);
    return { ok: false, code: "UNAVAILABLE", message: ERROR_MESSAGES.UNAVAILABLE };
  }
}

function isLive(record: ExchangeRecord, now: number): boolean {
  return (
    record.tombstonedAt === null &&
    record.expiresAt > now &&
    !TERMINAL_EXCHANGE_STATES.has(record.state)
  );
}

/**
 * What an enrolled lane's own tools run against: its inbox, read as tool
 * results, and its answers, recorded on the exchange (#13335). The caller is
 * always a help session id the MCP transport bound to the bearer; which lane,
 * which enrollment and which exchanges follow from that alone.
 *
 * A caller must be the very session the lane was enrolled with, still running
 * in the PTY incarnation it was enrolled in, so a revoked, displaced or
 * relaunched lane reads nothing. Pause does not stop it: a lane may still read
 * and answer what reached it before the pause, as the policy's `reply` kind
 * allows.
 */
export class AssistantMessagingRuntime {
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private readonly responseListeners = new Set<(key: ExchangeKey) => void>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: AssistantMessagingRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.unsubscribe = deps.policy.onChange(() => this.handlePolicyChange());
  }

  resolveCaller(helpSessionId: string): CallerResolution {
    const lane = this.deps.getSessionLane(helpSessionId);
    if (lane === null) return { ok: false, reason: "not-a-lane" };
    const enrollment = this.deps.policy.getEnrollment(lane);
    if (enrollment === null) return { ok: false, reason: "not-enrolled" };
    // Consent was given to one session; a newer one on the same slot is not it.
    if (enrollment.sessionId !== helpSessionId) return { ok: false, reason: "stale-generation" };
    const checked = this.deps.policy.checkLane({
      lane,
      generation: enrollment.generation,
      shell: enrollment.enrolledBy,
      kind: "reply",
    });
    if (!checked.ok) return checked;
    return {
      ok: true,
      enrollment: checked.enrollment,
      actor: { kind: "receiver", ...exchangeReceiverFor(checked.enrollment) },
    };
  }

  isAvailable(helpSessionId: string): boolean {
    return this.resolveCaller(helpSessionId).ok;
  }

  /**
   * Whether the caller may start a message to a hub: a lane enrolled by a
   * remote Shell, on a machine whose host side is listening. A hub has no hub
   * of its own to write to.
   */
  isSendAvailable(helpSessionId: string): boolean {
    const resolved = this.resolveCaller(helpSessionId);
    return (
      resolved.ok &&
      resolved.enrollment.enrolledBy.kind === "remote" &&
      this.deps.outbox?.() !== undefined
    );
  }

  /**
   * Whether this lane could ever be enrolled here: a help session on a
   * machine that listens as a host or has hosts of its own. Its tools are
   * offered from the session's start on that alone, because some clients
   * (Codex) read the tool list once and never act on `tools/list_changed`;
   * the calls still refuse until the lane is enrolled.
   */
  isReachable(helpSessionId: string): boolean {
    return this.isMachineReachable() && this.deps.getSessionLane(helpSessionId) !== null;
  }

  /** Whether another machine's assistant could ever message one here: it listens as a host or has hosts. */
  isMachineReachable(): boolean {
    return (
      this.deps.policy.isSupported() &&
      (this.deps.outbox?.() !== undefined || this.deps.hasHosts?.() === true)
    );
  }

  /** Whether a lane here could be one a remote Shell enrolls, and so write to its hub. */
  isSendReachable(helpSessionId: string): boolean {
    return (
      this.deps.policy.isSupported() &&
      this.deps.getSessionLane(helpSessionId) !== null &&
      this.deps.outbox?.() !== undefined
    );
  }

  getInbox(
    helpSessionId: string,
    args: AssistantGetInboxArgs
  ): AssistantMessagingOutcome<AssistantGetInboxResult> {
    return settle(() =>
      args.view === "sent"
        ? this.readSent(helpSessionId, args)
        : this.readInbox(helpSessionId, args)
    );
  }

  sendMessage(
    helpSessionId: string,
    args: AssistantSendMessageArgs
  ): AssistantMessagingOutcome<AssistantSendMessageResult> {
    return settle(() => this.start(helpSessionId, args));
  }

  reply(
    helpSessionId: string,
    args: AssistantReplyArgs
  ): AssistantMessagingOutcome<AssistantReplyResult> {
    return settle(() => this.answer(helpSessionId, args));
  }

  /**
   * Queues a message to the hub of the Shell that enrolled the caller's lane.
   * Nothing names the hub: it is whichever one that Shell has when the
   * message reaches it, and no other Shell can be addressed at all.
   */
  private start(helpSessionId: string, args: AssistantSendMessageArgs): AssistantSendMessageResult {
    const resolved = this.resolveCaller(helpSessionId);
    if (!resolved.ok || resolved.enrollment.enrolledBy.kind !== "remote") {
      throw new AssistantMessagingError("NOT_ELIGIBLE");
    }
    const { enrollment } = resolved;
    const outbox = this.deps.outbox?.();
    if (!outbox) throw new AssistantMessagingError("UNAVAILABLE");
    const admitted = this.deps.policy.checkLane({
      lane: { projectId: enrollment.projectId, slot: enrollment.slot },
      generation: enrollment.generation,
      shell: enrollment.enrolledBy,
      kind: "admit",
    });
    if (!admitted.ok) {
      throw new AssistantMessagingError(admitted.reason === "paused" ? "PAUSED" : "NOT_ELIGIBLE");
    }
    const queued = outbox.enqueue(enrollment, args);
    if (!queued.ok) throw new AssistantMessagingError(queued.code);
    return queued.value;
  }

  private readSent(helpSessionId: string, args: AssistantGetInboxArgs): AssistantGetInboxResult {
    const resolved = this.resolveCaller(helpSessionId);
    if (!resolved.ok) throw new AssistantMessagingError("NOT_ELIGIBLE");
    const cursor = args.cursor ?? 0;
    const outbox = this.deps.outbox?.();
    if (!outbox || resolved.enrollment.enrolledBy.kind !== "remote") {
      return { messages: [], sent: [], cursor, hasMore: false };
    }
    const page = outbox.listSent(
      resolved.enrollment,
      cursor,
      Math.min(args.limit ?? ASSISTANT_INBOX_PAGE_MAX, ASSISTANT_INBOX_PAGE_MAX)
    );
    return { messages: [], sent: page.sent, cursor: page.cursor, hasMore: page.hasMore };
  }

  private readInbox(helpSessionId: string, args: AssistantGetInboxArgs): AssistantGetInboxResult {
    const actor = this.requireCaller(helpSessionId);
    const limit = Math.min(args.limit ?? ASSISTANT_INBOX_PAGE_MAX, ASSISTANT_INBOX_PAGE_MAX);
    const now = this.now();
    let cursor = args.cursor ?? 0;
    let hasMore = false;
    let bytes = 0;
    const picked: Array<{ entry: InboxEntry; message: AssistantInboxMessage }> = [];
    for (const entry of this.deps.inbox.list(actor, cursor)) {
      if (picked.length >= limit) {
        hasMore = true;
        break;
      }
      const record = this.read(() => this.deps.store.get(actor, entry.key));
      if (record === null || record.taskId !== entry.taskId || !isLive(record, now)) {
        this.deps.inbox.drop(entry.taskId);
        cursor = entry.seq;
        continue;
      }
      const message: AssistantInboxMessage = {
        taskId: entry.taskId,
        messageId: entry.key.messageId,
        contextId: entry.contextId,
        state: record.state as AssistantInboxMessage["state"],
        receivedAt: entry.admittedAt,
        provenance: { ...entry.provenance },
        bodyChars: entry.body.length,
        untrustedBody: fenceUntrustedBody(entry.body),
      };
      // Measured as the result carries it, so the page fits the MCP result
      // cap whole; admission keeps any single message small enough to.
      const size = Buffer.byteLength(JSON.stringify(message), "utf8");
      if (picked.length > 0 && bytes + size > ASSISTANT_INBOX_PAGE_MAX_BYTES) {
        hasMore = true;
        break;
      }
      bytes += size;
      picked.push({ entry, message });
      cursor = entry.seq;
    }
    for (const { entry } of picked) {
      const fetched = this.read(() =>
        this.deps.store.recordDelivery(actor, entry.key, "inbox-fetched")
      );
      // Read by the lane it was for: from here the exchange is with that assistant.
      if (fetched.state === "submitted")
        this.bestEffort(() => this.deps.store.setState(actor, entry.key, "working"));
    }
    const messages = picked.map(({ message }) => message);
    return { messages, cursor, hasMore };
  }

  private answer(helpSessionId: string, args: AssistantReplyArgs): AssistantReplyResult {
    const actor = this.requireCaller(helpSessionId);
    // Measured as the sender will be handed it, fenced, so no answer is ever too big to show.
    if (!inboxBodyFits(args.text)) throw new AssistantMessagingError("TOO_LARGE");
    const entry = this.deps.inbox.find(actor, args.taskId);
    if (entry === null) throw new AssistantMessagingError("UNKNOWN_TASK");
    const record = this.read(() => this.deps.store.get(actor, entry.key));
    if (record === null || !isLive(record, this.now())) {
      this.deps.inbox.drop(entry.taskId);
      throw new AssistantMessagingError("EXCHANGE_CLOSED");
    }
    if (!this.deps.inbox.canRespond(entry.taskId)) {
      throw new AssistantMessagingError("TOO_MANY_RESPONSES");
    }
    const updated = this.read(() =>
      args.state === "input-required"
        ? this.deps.store.setState(actor, entry.key, "input-required")
        : this.deps.store.recordDelivery(actor, entry.key, "reply-received", { body: args.text })
    );
    this.deps.inbox.respond(entry, args.state, args.text);
    if (args.state === "completed") {
      this.deps.inbox.drop(entry.taskId);
      this.closeAnsweredQuestions(actor, entry, record.referenceTaskIds, args.text);
    }
    this.announceResponse(entry.key);
    return { taskId: entry.taskId, state: args.state, revision: updated.revision };
  }

  /**
   * A sender answers a lane's question by sending again, naming the asking
   * exchange in `referenceTaskIds`; nothing addresses the asking exchange
   * itself. So when the lane completes that follow-up, each exchange it names
   * from the same sender, to this lane, still waiting on its question
   * completes with the same reply rather than sitting at input-required until
   * it expires. Only an explicit reference closes one: sharing a conversation
   * proves nothing about which question a message answers.
   */
  private closeAnsweredQuestions(
    actor: ReceiverActor,
    answered: InboxEntry,
    referenceTaskIds: readonly string[],
    text: string
  ): void {
    if (referenceTaskIds.length === 0) return;
    const named = new Set(referenceTaskIds);
    for (const asked of this.deps.inbox.list(actor, 0)) {
      if (
        asked.taskId === answered.taskId ||
        asked.key.senderId !== answered.key.senderId ||
        !named.has(asked.key.messageId)
      ) {
        continue;
      }
      const closed = this.bestEffort(() => {
        const record = this.deps.store.get(actor, asked.key);
        if (record?.state !== "input-required" || !isLive(record, this.now())) return false;
        if (!this.deps.inbox.canRespond(asked.taskId)) return false;
        this.deps.store.recordDelivery(actor, asked.key, "reply-received", { body: text });
        return true;
      });
      if (closed !== true) continue;
      this.deps.inbox.respond(asked, "completed", text);
      this.deps.inbox.drop(asked.taskId);
      this.announceResponse(asked.key);
    }
  }

  /** Follow-on bookkeeping that must never fail the call it follows. */
  private bestEffort<T>(work: () => T): T | undefined {
    try {
      return work();
    } catch (err) {
      console.warn("[AssistantMessaging] Follow-on exchange update failed:", err);
      return undefined;
    }
  }

  /**
   * Hands a message's body to the lane it was admitted for. The link call
   * that admits an exchange (#13334) calls this once the store has the
   * record; a record addressed to anything but a standing enrollment here is
   * refused.
   */
  admit(record: ExchangeRecord, envelope: InboxEnvelope): void {
    const enrolled = this.deps.policy
      .listEnrollments()
      .some((enrollment) => this.isReceiverOf(enrollment, record.receiver));
    if (!enrolled) {
      throw new AssistantMessagingError("NOT_ELIGIBLE");
    }
    this.deps.inbox.admit(record, envelope);
  }

  /**
   * Wakes a lane again for each exchange it still owes an answer, once a view
   * has taken its assistant over after the one it ran through went away (a
   * Shell restart, #13392). Its tool calls failed meanwhile, so it may have
   * given up on a message it had already read. Answered and question-asking
   * exchanges are left alone. Returns how many were announced, or null while
   * the lane can't be woken yet: its Shell hasn't proved itself on a new
   * session since a restart, or messaging is paused.
   */
  reannounce(lane: LaneRef): number | null {
    const rewake = this.deps.rewake;
    const enrollment = this.deps.policy.getEnrollment(lane);
    if (!rewake || enrollment === null) return 0;
    const wakeable = this.deps.policy.checkLane({
      lane,
      generation: enrollment.generation,
      shell: enrollment.enrolledBy,
      kind: "wake",
    });
    if (!wakeable.ok) return null;
    const actor: ReceiverActor = { kind: "receiver", ...exchangeReceiverFor(enrollment) };
    let announced = 0;
    const owed = (entry: InboxEntry): ExchangeRecord | null => {
      const record = this.bestEffort(() => this.deps.store.get(actor, entry.key));
      if (!record || !isLive(record, this.now()) || record.state === "input-required") return null;
      return this.deps.inbox.canRespond(entry.taskId) ? record : null;
    };
    for (const entry of this.deps.inbox.list(actor, 0)) {
      const record = owed(entry);
      if (!record) continue;
      this.bestEffort(() => rewake(enrollment, record, () => owed(entry) !== null));
      announced++;
    }
    return announced;
  }

  /** The answers to an exchange, for the Shell that sent it. */
  getResponses(key: ExchangeKey): InboxResponse[] {
    return this.deps.inbox.getResponses(key);
  }

  /**
   * Called after a lane answers an exchange, once the answer is held: a
   * repeated question leaves the exchange's state, and so its revision, as it
   * was, so a reader of answers can't wait on the store alone.
   */
  onResponse(listener: (key: ExchangeKey) => void): () => void {
    this.responseListeners.add(listener);
    return () => {
      this.responseListeners.delete(listener);
    };
  }

  /** Called whenever a lane may have gained or lost its tools. */
  onAvailabilityChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.responseListeners.clear();
    this.deps.inbox.clear();
  }

  private announceResponse(key: ExchangeKey): void {
    for (const listener of [...this.responseListeners]) {
      try {
        listener({ ...key });
      } catch (err) {
        console.error("[AssistantMessaging] Response listener failed:", err);
      }
    }
  }

  private requireCaller(helpSessionId: string): ReceiverActor {
    const resolved = this.resolveCaller(helpSessionId);
    if (!resolved.ok) throw new AssistantMessagingError("NOT_ELIGIBLE");
    return resolved.actor;
  }

  /** Store failures carry exchange ids in their text; the caller gets a fixed one. */
  private read<T>(work: () => T): T {
    try {
      return work();
    } catch (err) {
      if (isAppError(err)) {
        if (err.code === "NOT_FOUND") throw new AssistantMessagingError("UNKNOWN_TASK");
        if (err.code === "VALIDATION") throw new AssistantMessagingError("EXCHANGE_CLOSED");
      }
      console.error("[AssistantMessaging] Exchange store failed:", err);
      throw new AssistantMessagingError("UNAVAILABLE");
    }
  }

  private isReceiverOf(enrollment: LaneEnrollment, receiver: ExchangeReceiver): boolean {
    const own = exchangeReceiverFor(enrollment);
    return (
      own.hostId === receiver.hostId &&
      own.laneId === receiver.laneId &&
      own.enrollmentGeneration === receiver.enrollmentGeneration
    );
  }

  private handlePolicyChange(): void {
    const standing = this.deps.policy.listEnrollments();
    this.deps.inbox.retainReceivers((receiver) =>
      standing.some((enrollment) => this.isReceiverOf(enrollment, receiver))
    );
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("[AssistantMessaging] Availability listener failed:", err);
      }
    }
  }
}
