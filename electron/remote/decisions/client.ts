import type { z } from "zod";
import type {
  DecisionsHostAttentionAnswer,
  DecisionsHostAttentionRequest,
} from "../../../shared/types/decisionsAttention.js";
import type {
  DecisionsHostRuntime,
  DecisionsHostRuntimeObservation,
} from "../../../shared/types/decisionsHosts.js";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionLastRead,
  DecisionQuestionListItem,
  DecisionQuestionReference,
  DecisionQuestionStatus,
} from "../../../shared/types/decisionsQuestion.js";
import {
  boundedDetail,
  type DecisionsHostEntry,
  type DecisionsHostQuestionAnswer,
  type DecisionsHostQuestionRead,
  type DecisionsHostQuestions,
  type DecisionsHostLink,
  type DecisionsHostsPort,
  type HostAcceptResult,
  type HostAgentStopChange,
  type HostCallOutcome,
  type HostIdentityReport,
  type HostRequestResult,
  type OwnerStateAnnouncement,
} from "../../types/decisionsHosts.js";
import { hostAttentionResultSchema } from "./attentionSchemas.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostRuntimePayloadSchema,
  HostRuntimeV2PayloadSchema,
  HostStatusResultSchema,
  OwnerStatePayloadSchema,
  OwnerStateV2PayloadSchema,
  type EnrollHostPayload,
} from "./linkMethods.js";
import {
  HostQuestionCancelResultSchema,
  HostQuestionContentResultSchema,
  HostQuestionContentV2ResultSchema,
  HostQuestionContentV3ResultSchema,
  HostQuestionImagePartResultSchema,
  HostQuestionPaneResultSchema,
  HostQuestionAskSchema,
  HostQuestionItemSchema,
  HostQuestionItemV3Schema,
  HostQuestionListSchema,
  HostQuestionListV2Schema,
  HostQuestionListV3Schema,
  HostQuestionSummariesResultSchema,
  HostQuestionsChangedPayloadSchema,
  HostQuestionsChangedV2PayloadSchema,
  HostQuestionsChangedV3PayloadSchema,
  MAX_HOST_IMAGE_PART_BYTES,
  type HostQuestionListPayload,
} from "./questionSchemas.js";

/** Long enough for a Host to open its key file, a keychain prompt included. */
export const HOST_STATUS_TIMEOUT_MS = 75_000;
/** Making keys can wait on the Host's keychain, which has its own 60 s deadline. */
export const HOST_REQUEST_TIMEOUT_MS = 75_000;
/** Sealing the identity waits on the same keychain. */
export const HOST_ACCEPT_TIMEOUT_MS = 75_000;
export const OWNER_STATE_TIMEOUT_MS = 75_000;
/** A Host's list, or one of its questions opened there: an image is fetched and checked first. */
export const HOST_QUESTION_TIMEOUT_MS = 75_000;
/**
 * How long a resume of a Host's stopped delivery is waited on (#18031): the
 * Host reopens the session and waits up to a minute and a half for its
 * prompt before delivery has its go. Past this its outcome is unknown.
 */
export const HOST_ATTENTION_RESUME_TIMEOUT_MS = 180_000;

export interface DecisionsHostSession {
  readonly isOpen: boolean;
  call(method: string, payload: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  onClose(listener: () => void): () => void;
  registerCallHandler<S extends z.ZodType>(
    method: string,
    schema: S,
    handler: (payload: z.infer<S>) => unknown
  ): () => void;
}

export interface DecisionsHostsClientDeps {
  /** Every host in the host list, by the id and name this Shell knows it by. */
  hosts(): DecisionsHostEntry[];
  /** The host's current session, or null while it has none. Never dials. */
  sessionFor(hostId: string): DecisionsHostSession | null;
  onSessionOpened(listener: (hostId: string, session: DecisionsHostSession) => void): () => void;
  onHostsChanged(listener: () => void): () => void;
  hold(hostId: string): () => void;
  /**
   * Whether Decisions is on here, and as which owner (#16022), as the setting
   * reads now; null while this computer holds no owner identity, so nothing
   * is announced.
   */
  ownerState(): OwnerStateAnnouncement | null;
  /** Hosts' agents' stops as the host summaries' client hears them (#17933). */
  onAgentStopChanges?(listener: (hostId: string, change: HostAgentStopChange) => void): () => void;
  now?: () => number;
}

interface HostReport {
  session: DecisionsHostSession;
  runtime: DecisionsHostRuntime;
  at: number;
}

/** A Host's questions as it last reported them (#17230), and to which owner. */
interface HostQuestionsReport {
  session: DecisionsHostSession;
  owner: string;
  questionHostId: string;
  questions: Omit<DecisionQuestionListItem, "remoteHost" | "inbox">[];
  /** What each in Needs you asks now (#17895), by question id; absent from a Host from before it. */
  asks?: ReadonlyMap<string, string | null>;
}

/**
 * A Host's questions as this computer last read them over its link (#17946),
 * under one owner identity and one Host device: what the owner dismisses one
 * by while the Host is away.
 */
interface HostReads {
  owner: string;
  deviceId: string | null;
  questions: Map<string, HostQuestionRead>;
}

interface HostQuestionRead {
  /** When the read went out, so one answered after a later read can't replace it. */
  turn: number;
  /** What it found; null once the Host said it no longer holds the question. */
  found: {
    reference: DecisionQuestionReference;
    revision: number;
    alias: number;
    status: DecisionQuestionStatus;
    at: number;
  } | null;
}

/** A content read as it went out to a Host: its question, who it was for, and its turn. */
interface ReadGoingOut {
  reference: DecisionQuestionReference;
  owner: string | null;
  deviceId: string | null;
  turn: number;
}

/** The Decisions device a Host reports itself enrolled as; null before it reports one. */
function deviceOf(runtime: DecisionsHostRuntime | undefined): string | null {
  return runtime === undefined || runtime.state === "not-enrolled" ? null : runtime.deviceId;
}

function ownerKey(state: Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">): string {
  return `${state.installationId}\n${state.ownerDeviceId}`;
}

function ownerKeyOf(state: OwnerStateAnnouncement | null): string | null {
  return state === null ? null : ownerKey(state);
}

function sameReference(a: DecisionQuestionReference, b: DecisionQuestionReference): boolean {
  return (
    a.hostId === b.hostId &&
    a.projectId === b.projectId &&
    a.terminalId === b.terminalId &&
    a.questionId === b.questionId
  );
}

/**
 * Whether a Host's answer is the one asked for: content of that question, a
 * part of that image starting where asked, opening lines of those questions.
 */
function answersRead(read: DecisionsHostQuestionRead, answer: unknown): boolean {
  switch (read.read) {
    case "content": {
      const result = answer as DecisionQuestionContentResultLike;
      if (result.result !== "read") return true;
      const { question } = result;
      return (
        sameReference(question.reference, read.reference) &&
        question.questionId === read.reference.questionId &&
        question.terminalId === read.reference.terminalId
      );
    }
    case "image": {
      const result = answer as ImagePartResultLike;
      if (result.result !== "read") return true;
      const { part } = result;
      // The part that starts where asked: as much as is left, up to one part, and none past the end.
      const expected = Math.min(MAX_HOST_IMAGE_PART_BYTES, Math.max(0, part.size - part.offset));
      return (
        part.attachmentId === read.attachmentId &&
        part.offset === read.offset &&
        part.bytes.byteLength === expected
      );
    }
    case "summaries": {
      const result = answer as SummariesResultLike;
      if (result.result !== "read") return true;
      const asked = new Set(read.references.map((reference) => reference.questionId));
      const answered = new Set(result.summaries.map((summary) => summary.questionId));
      return (
        answered.size === result.summaries.length && [...answered].every((id) => asked.has(id))
      );
    }
    case "pane": {
      const result = answer as PaneResultLike;
      return result.result !== "read" || sameReference(result.reference, read.reference);
    }
  }
}

type DecisionQuestionContentResultLike = z.infer<typeof HostQuestionContentResultSchema>;
type ImagePartResultLike = z.infer<typeof HostQuestionImagePartResultSchema>;
type SummariesResultLike = z.infer<typeof HostQuestionSummariesResultSchema>;
type PaneResultLike = z.infer<typeof HostQuestionPaneResultSchema>;

function answerSchemaOf(read: DecisionsHostQuestionRead): z.ZodType {
  switch (read.read) {
    case "content":
      return HostQuestionContentResultSchema;
    case "image":
      return HostQuestionImagePartResultSchema;
    case "summaries":
      return HostQuestionSummariesResultSchema;
    case "pane":
      return HostQuestionPaneResultSchema;
  }
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

function failureOf<T>(error: unknown): HostCallOutcome<T> {
  switch (codeOf(error)) {
    case "UNSUPPORTED":
      return { ok: false, failure: "needs-update" };
    case "HOST_DISCONNECTED":
      return { ok: false, failure: "disconnected" };
    case "OUTCOME_UNKNOWN":
      return { ok: false, failure: "outcome-unknown" };
    // A Host that knows the method but not this step reads it as malformed.
    case "VALIDATION":
      return { ok: false, failure: "needs-update" };
  }
  const message = (error as { message?: unknown } | null)?.message;
  const detail = boundedDetail(typeof message === "string" ? message : undefined);
  return detail === undefined
    ? { ok: false, failure: "failed" }
    : { ok: false, failure: "failed", detail };
}

/**
 * One session to a Host, as Decisions enrolls through it. What goes out is
 * checked against the method's payload schema, and nothing the Host answers
 * is trusted until it has been read against the result's.
 */
class HostLink implements DecisionsHostLink {
  constructor(
    private readonly hostId: string,
    private readonly session: DecisionsHostSession,
    private readonly holdHost: (hostId: string) => () => void
  ) {}

  get isOpen(): boolean {
    return this.session.isOpen;
  }

  onClose(listener: () => void): () => void {
    return this.session.onClose(listener);
  }

  hold(): () => void {
    return this.holdHost(this.hostId);
  }

  async status(): Promise<HostCallOutcome<HostIdentityReport>> {
    const answered = await this.call(
      { step: "status" },
      HostStatusResultSchema,
      HOST_STATUS_TIMEOUT_MS
    );
    return answered.ok ? { ok: true, value: answered.value.identity } : answered;
  }

  request(input: {
    attempt: string;
    label: string;
    replace?: string;
    allowWeakStorage?: boolean;
  }): Promise<HostCallOutcome<HostRequestResult>> {
    return this.call(
      {
        step: "request",
        attempt: input.attempt,
        label: input.label,
        ...(input.replace !== undefined ? { replace: input.replace } : {}),
        ...(input.allowWeakStorage === true ? { allowWeakStorage: true as const } : {}),
      },
      HostRequestResultSchema,
      HOST_REQUEST_TIMEOUT_MS
    );
  }

  accept(input: { attempt: string; response: string }): Promise<HostCallOutcome<HostAcceptResult>> {
    return this.call(
      { step: "accept", attempt: input.attempt, response: input.response },
      HostAcceptResultSchema,
      HOST_ACCEPT_TIMEOUT_MS
    );
  }

  private async call<S extends z.ZodType>(
    payload: EnrollHostPayload,
    result: S,
    timeoutMs: number
  ): Promise<HostCallOutcome<z.infer<S>>> {
    // Checked here too: a payload the Host would refuse never goes out.
    const sent = EnrollHostPayloadSchema.parse(payload);
    if (!this.session.isOpen) return { ok: false, failure: "disconnected" };
    let raw: unknown;
    try {
      raw = await this.session.call(DecisionsLinkMethod.ENROLL_HOST, sent, { timeoutMs });
    } catch (error) {
      return failureOf(error);
    }
    const parsed = result.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data as z.infer<S> }
      : { ok: false, failure: "unexpected-answer" };
  }
}

/**
 * Shell side of enrolling Hosts as Decisions devices (#16021): the port
 * Decisions reaches its Hosts through. Each session gets one link, so a
 * reconnect is a new link and never the old one again.
 */
export class DecisionsHostsClient implements DecisionsHostsPort {
  private readonly links = new WeakMap<DecisionsHostSession, HostLink>();
  private readonly wired = new WeakSet<DecisionsHostSession>();
  private readonly reports = new Map<string, HostReport>();
  /** Counts each Host's announcements, so an answer to an older one can't replace a newer one's. */
  private readonly announced = new Map<string, number>();
  /** Sessions whose Host answered `OWNER_STATE_V2` UNSUPPORTED: they are told the older method only. */
  private readonly beforeSnapshots = new WeakSet<DecisionsHostSession>();
  /**
   * Sessions whose Host answered `OWNER_STATE_V3` UNSUPPORTED (#17942): they
   * are told `OWNER_STATE_V2` or older, and report no question policy.
   */
  private readonly beforeQuestionPolicy = new WeakSet<DecisionsHostSession>();
  /**
   * The latest word each owner identity announced on each session, recorded
   * as the announcement begins: what a fallback says for that owner.
   */
  private readonly announcedStates = new WeakMap<
    DecisionsHostSession,
    Map<string, OwnerStateAnnouncement>
  >();
  /**
   * The newest turn each Host's report was taken from, a push's or an
   * announcement's: an answer to an older announcement never replaces it,
   * while one whose newer announcement failed is still taken.
   */
  private readonly observedTurns = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  /** Each wired session's handler and close listener, removed on stop. */
  private readonly unwires = new Set<() => void>();
  /** Each Host's questions as it last reported them (#17230), kept when its link closes. */
  private readonly questionReports = new Map<string, HostQuestionsReport>();
  /** Counts each Host's lists, so a read answered after a newer push can't replace it. */
  private readonly questionTurns = new Map<string, number>();
  /** Sessions whose Host answered a read of its questions UNSUPPORTED: from before #17230. */
  private readonly beforeQuestions = new WeakSet<DecisionsHostSession>();
  /** Sessions whose Host answered the list with its asks UNSUPPORTED: from before #17895. */
  private readonly beforeAsks = new WeakSet<DecisionsHostSession>();
  /** Sessions whose Host answered the list with rounds UNSUPPORTED: from before #17943. */
  private readonly beforeRounds = new WeakSet<DecisionsHostSession>();
  /** Sessions whose Host answered content with rounds UNSUPPORTED: from before #17943. */
  private readonly beforeContentRounds = new WeakSet<DecisionsHostSession>();
  /** Sessions whose Host answered content with its preparation UNSUPPORTED: from before #18042. */
  private readonly beforePreparation = new WeakSet<DecisionsHostSession>();
  /** Sessions whose Host answered its stopped deliveries UNSUPPORTED: from before #18031. */
  private readonly beforeAttention = new WeakSet<DecisionsHostSession>();
  /**
   * Reads of the list with its asks out, per session. A Host answers one with
   * its list as it stands then, after any v1 push it sent before the read
   * reached it, so such a push never supersedes the read.
   */
  private readonly readingAsks = new WeakMap<DecisionsHostSession, number>();
  /**
   * Sessions whose Host lists asks to this Shell: from then on it pushes only
   * v2, so a v1 push that arrives later was sent before and is stale.
   */
  private readonly listsAsks = new WeakSet<DecisionsHostSession>();
  /** The newest v2 list each session has delivered, by its `seq`. */
  private readonly listSeqs = new WeakMap<DecisionsHostSession, number>();
  private readonly questionListeners = new Set<() => void>();
  /** Each Host's questions as this computer last read them (#17946), kept when its link closes. */
  private readonly lastReads = new Map<string, HostReads>();
  private readTurns = 0;
  private readonly now: () => number;

  constructor(private readonly deps: DecisionsHostsClientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begins announcing this computer's Decisions to every Host as its link
   * comes up (#16022), and hearing what each reports back. Returns the stop.
   */
  start(): () => void {
    const offOpened = this.deps.onSessionOpened((hostId, session) => this.wire(hostId, session));
    for (const { hostId } of this.deps.hosts()) {
      const session = this.deps.sessionFor(hostId);
      if (session?.isOpen) this.wire(hostId, session);
    }
    return () => {
      offOpened();
      for (const unwire of [...this.unwires]) unwire();
      this.listeners.clear();
      this.questionListeners.clear();
      this.lastReads.clear();
    };
  }

  hosts(): DecisionsHostEntry[] {
    return this.deps.hosts();
  }

  runtimeOf(hostId: string): DecisionsHostRuntimeObservation | null {
    const report = this.reports.get(hostId);
    if (!report) return null;
    const live = report.session.isOpen && this.deps.sessionFor(hostId) === report.session;
    return { runtime: report.runtime, at: report.at, live };
  }

  announceOwnerState(): void {
    // Read for an owner identity this computer no longer speaks as: none of it stands, nor for that one again.
    const owner = ownerKeyOf(this.deps.ownerState());
    for (const [hostId, reads] of [...this.lastReads]) {
      if (reads.owner !== owner) this.lastReads.delete(hostId);
    }
    for (const { hostId } of this.deps.hosts()) {
      const session = this.deps.sessionFor(hostId);
      if (session?.isOpen) void this.announce(hostId, session);
    }
  }

  linkFor(hostId: string): DecisionsHostLink | null {
    const session = this.deps.sessionFor(hostId);
    return session?.isOpen ? this.linkOf(hostId, session) : null;
  }

  onLinkOpened(listener: (hostId: string, link: DecisionsHostLink) => void): () => void {
    return this.deps.onSessionOpened((hostId, session) =>
      listener(hostId, this.linkOf(hostId, session))
    );
  }

  onAgentStopChanges(listener: (hostId: string, change: HostAgentStopChange) => void): () => void {
    return this.deps.onAgentStopChanges?.(listener) ?? (() => {});
  }

  onHostsChanged(listener: () => void): () => void {
    const offHosts = this.deps.onHostsChanged(listener);
    this.listeners.add(listener);
    return () => {
      offHosts();
      this.listeners.delete(listener);
    };
  }

  hostQuestions(): DecisionsHostQuestions[] {
    const owner = ownerKeyOf(this.deps.ownerState());
    const hosts = this.deps.hosts();
    const present = new Set(hosts.map((host) => host.hostId));
    // A Host taken off the host list takes what it reported, and what was read of it, with it.
    for (const hostId of [...this.questionReports.keys()]) {
      if (!present.has(hostId)) this.questionReports.delete(hostId);
    }
    for (const [hostId, reads] of [...this.lastReads]) {
      // Read for another owner identity: nothing of it stands for this one, nor for that one again.
      if (!present.has(hostId) || reads.owner !== owner) this.lastReads.delete(hostId);
    }
    if (owner === null) return [];
    const heard: DecisionsHostQuestions[] = [];
    for (const { hostId, name } of hosts) {
      const report = this.questionReports.get(hostId);
      // Heard for another owner identity: none of this one's.
      if (!report || report.owner !== owner) continue;
      // Only a Host that reported itself enrolled by this owner, and still does.
      const runtime = this.reports.get(hostId)?.runtime.state;
      if (runtime !== "running" && runtime !== "owner-off") continue;
      heard.push({
        hostId,
        name,
        connected: report.session.isOpen && this.deps.sessionFor(hostId) === report.session,
        questionHostId: report.questionHostId,
        questions: report.questions,
        ...(report.asks !== undefined ? { asks: report.asks } : {}),
      });
    }
    const claims = new Map<string, number>();
    for (const host of heard) {
      claims.set(host.questionHostId, (claims.get(host.questionHostId) ?? 0) + 1);
    }
    // An id two Hosts' questions both name routes to neither.
    return heard.filter((host) => claims.get(host.questionHostId) === 1);
  }

  onHostQuestionsChanged(listener: () => void): () => void {
    const offHosts = this.deps.onHostsChanged(listener);
    this.questionListeners.add(listener);
    return () => {
      offHosts();
      this.questionListeners.delete(listener);
    };
  }

  readHostQuestion<R extends DecisionsHostQuestionRead>(
    questionHostId: string,
    read: R
  ): Promise<HostCallOutcome<DecisionsHostQuestionAnswer<R>>> | null {
    const hostId = this.hostAsking(questionHostId);
    if (hostId === null) return null;
    const going: ReadGoingOut | null =
      read.read === "content"
        ? {
            reference: read.reference,
            owner: ownerKeyOf(this.deps.ownerState()),
            deviceId: deviceOf(this.reports.get(hostId)?.runtime),
            turn: ++this.readTurns,
          }
        : null;
    return this.callQuestionRead(hostId, read).then(
      (answered): HostCallOutcome<DecisionsHostQuestionAnswer<R>> => {
        if (!answered.ok) return answered;
        if (!answersRead(read, answered.value)) return { ok: false, failure: "unexpected-answer" };
        if (going !== null) {
          this.noteRead(hostId, going, answered.value as DecisionQuestionContentResultLike);
        }
        return answered as HostCallOutcome<DecisionsHostQuestionAnswer<R>>;
      }
    );
  }

  /**
   * A read over the Host's current link: content with its preparation (#18042)
   * and round (#17943) where the Host reads them, else with its round alone,
   * else as `QUESTIONS` reads it, as everything else is.
   */
  private async callQuestionRead(
    hostId: string,
    read: DecisionsHostQuestionRead
  ): Promise<HostCallOutcome<unknown>> {
    // Only its own method reads a pane: a Host from before it is told it needs updating.
    if (read.read === "pane") {
      return this.callHost(
        hostId,
        DecisionsLinkMethod.QUESTION_PANE,
        { reference: read.reference },
        HostQuestionPaneResultSchema
      );
    }
    const session = this.deps.sessionFor(hostId);
    if (read.read === "content" && session !== null && !this.beforePreparation.has(session)) {
      let unsupported = false;
      const answered = await this.callHost(
        hostId,
        DecisionsLinkMethod.QUESTION_CONTENT_V3,
        { reference: read.reference },
        HostQuestionContentV3ResultSchema,
        () => {
          unsupported = true;
        }
      );
      if (!unsupported) return answered;
      // A Host from before #18042, asked again from the top as below.
      this.beforePreparation.add(session);
      return this.callQuestionRead(hostId, read);
    }
    if (read.read === "content" && session !== null && !this.beforeContentRounds.has(session)) {
      // Only the method itself going unknown says the Host is older: a refused step of a
      // method it knows reads as `needs-update` too, and must never cost later reads their round.
      let unsupported = false;
      const answered = await this.callHost(
        hostId,
        DecisionsLinkMethod.QUESTION_CONTENT_V2,
        { reference: read.reference },
        HostQuestionContentV2ResultSchema,
        () => {
          unsupported = true;
        }
      );
      if (!unsupported) return answered;
      // A Host from before #17943 reads content only as `QUESTIONS` does. Asked again from the
      // top, so a link that replaced this one meanwhile is asked for the round in its own right.
      this.beforeContentRounds.add(session);
      return this.callQuestionRead(hostId, read);
    }
    return this.callHost(hostId, DecisionsLinkMethod.QUESTIONS, read, answerSchemaOf(read));
  }

  lastHostRead(reference: DecisionQuestionReference): DecisionQuestionLastRead | null {
    const host = this.hostQuestions().find((heard) => heard.questionHostId === reference.hostId);
    const standing = host?.questions.find((question) =>
      sameReference(question.reference, reference)
    )?.standing;
    // Open for the person, or not sent yet, as the Host last listed it: an answered question
    // waiting on a reply, or one already settled, has nothing to dismiss.
    const waiting =
      standing !== undefined &&
      ((standing.kind === "waiting" && standing.reason === "open") || standing.kind === "queued");
    // Only while its link is down: a Host connected answers for itself, whatever it says.
    if (host === undefined || this.deps.sessionFor(host.hostId)?.isOpen || !waiting) return null;
    const reads = this.lastReads.get(host.hostId);
    const read = reads?.questions.get(reference.questionId)?.found;
    const current =
      reads !== undefined &&
      reads.owner === ownerKeyOf(this.deps.ownerState()) &&
      reads.deviceId === deviceOf(this.reports.get(host.hostId)?.runtime);
    if (!current || read == null || !sameReference(read.reference, reference)) {
      return { result: "not-read" };
    }
    switch (read.status) {
      case "open":
        return { result: "read", revision: read.revision, alias: read.alias, readAt: read.at };
      case "queued":
        return { result: "not-sent" };
      // Read as moved on where the list still has it waiting: which revision it waits at is unknown.
      default:
        return { result: "not-read" };
    }
  }

  /**
   * Keeps what a content read found, while the Host still answers for the
   * same owner as the same device and its questions still route to it, unless
   * a read that went out later already landed. One that went out to the owner
   * or device before is dropped untouched. A question its Host no longer
   * holds is remembered as gone, so an earlier read landing later can't bring it back.
   */
  private noteRead(
    hostId: string,
    going: ReadGoingOut,
    result: DecisionQuestionContentResultLike
  ): void {
    const { reference } = going;
    const owner = ownerKeyOf(this.deps.ownerState());
    const deviceId = deviceOf(this.reports.get(hostId)?.runtime);
    if (
      owner === null ||
      going.owner !== owner ||
      going.deviceId !== deviceId ||
      this.hostAsking(reference.hostId) !== hostId
    ) {
      return;
    }
    if (result.result !== "read" && result.result !== "not-found") return;
    let reads = this.lastReads.get(hostId);
    if (reads !== undefined && (reads.owner !== owner || reads.deviceId !== deviceId)) {
      this.lastReads.delete(hostId);
      reads = undefined;
    }
    const known = reads?.questions.get(reference.questionId);
    if (known !== undefined && known.turn > going.turn) return;
    if (reads === undefined) {
      reads = { owner, deviceId, questions: new Map() };
      this.lastReads.set(hostId, reads);
    }
    if (result.result === "not-found") {
      reads.questions.set(reference.questionId, { turn: going.turn, found: null });
      return;
    }
    const { question } = result;
    reads.questions.set(reference.questionId, {
      turn: going.turn,
      found: {
        reference: question.reference,
        revision: question.revision,
        alias: question.alias,
        status: question.status,
        at: this.now(),
      },
    });
  }

  cancelHostQuestion(
    reference: DecisionQuestionReference
  ): Promise<HostCallOutcome<DecisionQuestionCancelResult>> | null {
    const hostId = this.hostAsking(reference.hostId);
    if (hostId === null) return null;
    return this.callHost(
      hostId,
      DecisionsLinkMethod.CANCEL_QUESTION,
      { reference },
      HostQuestionCancelResultSchema
    );
  }

  hostAttention(
    request: DecisionsHostAttentionRequest
  ): Promise<HostCallOutcome<DecisionsHostAttentionAnswer>> | null {
    const { reference } = request;
    const host = this.hostQuestions().find((heard) => heard.questionHostId === reference.hostId);
    // Only a question the Host lists: one it never listed has nothing to act on here.
    if (!host?.questions.some((question) => sameReference(question.reference, reference))) {
      return null;
    }
    // Only over the link its list came on: a newer one hasn't listed the question yet.
    if (!host.connected) return Promise.resolve({ ok: false, failure: "disconnected" });
    const session = this.deps.sessionFor(host.hostId);
    // A Host that answered this link UNSUPPORTED is never asked again on it: it's from before.
    if (session?.isOpen && this.beforeAttention.has(session)) {
      return Promise.resolve({ ok: false, failure: "needs-update" });
    }
    return this.callHost(
      host.hostId,
      DecisionsLinkMethod.ATTENTION,
      request,
      hostAttentionResultSchema(request.action),
      (unsupported) => this.beforeAttention.add(unsupported),
      request.action === "resume" ? HOST_ATTENTION_RESUME_TIMEOUT_MS : HOST_QUESTION_TIMEOUT_MS
    ).then((answered): HostCallOutcome<DecisionsHostAttentionAnswer> => {
      if (!answered.ok || answered.value.result !== "read" || answered.value.item === null) {
        return answered;
      }
      const { item } = answered.value;
      if (
        item.questionId !== reference.questionId ||
        item.origin.projectId !== reference.projectId ||
        item.origin.paneId !== reference.terminalId
      ) {
        return { ok: false, failure: "unexpected-answer" };
      }
      // `canReassign` stays as the Host said: choosing another of its panes is offered only there,
      // but handling it here still takes that away, so it still asks first.
      return {
        ok: true,
        value: {
          result: "read",
          item: {
            ...item,
            origin: { ...item.origin, otherHost: { hostId: reference.hostId, name: host.name } },
          },
        },
      };
    });
  }

  /** The Host whose questions name `questionHostId`, by its host list id; null when none's do. */
  private hostAsking(questionHostId: string): string | null {
    return (
      this.hostQuestions().find((host) => host.questionHostId === questionHostId)?.hostId ?? null
    );
  }

  /** One CALL to the Host's current link, held open for it, its answer read against `schema`. */
  private async callHost<S extends z.ZodType>(
    hostId: string,
    method: string,
    payload: unknown,
    schema: S,
    onUnsupported?: (session: DecisionsHostSession) => void,
    timeoutMs = HOST_QUESTION_TIMEOUT_MS
  ): Promise<HostCallOutcome<z.infer<S>>> {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) return { ok: false, failure: "disconnected" };
    const release = this.deps.hold(hostId);
    let raw: unknown;
    try {
      raw = await session.call(method, payload, { timeoutMs });
    } catch (error) {
      if (codeOf(error) === "UNSUPPORTED") onUnsupported?.(session);
      return failureOf(error);
    } finally {
      release();
    }
    const parsed = schema.safeParse(raw);
    return parsed.success
      ? { ok: true, value: parsed.data as z.infer<S> }
      : { ok: false, failure: "unexpected-answer" };
  }

  /** Reads the Host's questions over `session`, kept unless a newer list came meanwhile. */
  private async readQuestions(hostId: string, session: DecisionsHostSession): Promise<void> {
    if (this.beforeQuestions.has(session) || !session.isOpen) return;
    const turn = (this.questionTurns.get(hostId) ?? 0) + 1;
    this.questionTurns.set(hostId, turn);
    let raw: unknown;
    let withAsks = !this.beforeAsks.has(session);
    let withRounds = withAsks && !this.beforeRounds.has(session);
    try {
      if (withAsks) {
        this.readingAsks.set(session, (this.readingAsks.get(session) ?? 0) + 1);
        try {
          if (withRounds) {
            try {
              raw = await session.call(
                DecisionsLinkMethod.QUESTION_LIST_V3,
                {},
                { timeoutMs: HOST_QUESTION_TIMEOUT_MS }
              );
            } catch (error) {
              // A Host from before #17943 lists its questions without their rounds.
              if (codeOf(error) !== "UNSUPPORTED") throw error;
              this.beforeRounds.add(session);
              withRounds = false;
            }
          }
          if (!withRounds) {
            raw = await session.call(
              DecisionsLinkMethod.QUESTION_LIST_V2,
              {},
              { timeoutMs: HOST_QUESTION_TIMEOUT_MS }
            );
          }
        } catch (error) {
          // A Host from before #17895 lists its questions without what each asks.
          if (codeOf(error) !== "UNSUPPORTED") throw error;
          this.beforeAsks.add(session);
          withAsks = false;
        } finally {
          const out = (this.readingAsks.get(session) ?? 1) - 1;
          if (out > 0) this.readingAsks.set(session, out);
          else this.readingAsks.delete(session);
        }
      }
      if (!withAsks) {
        raw = await session.call(
          DecisionsLinkMethod.QUESTIONS,
          { read: "list" },
          { timeoutMs: HOST_QUESTION_TIMEOUT_MS }
        );
      }
    } catch (error) {
      // A Host from before #17230 lists none, whatever an earlier build of it reported;
      // anything else is read again on the next announcement.
      if (codeOf(error) === "UNSUPPORTED") {
        this.beforeQuestions.add(session);
        if (this.deps.sessionFor(hostId) === session && this.questionReports.delete(hostId)) {
          this.questionsChanged();
        }
      }
      return;
    }
    if (withAsks) {
      // Ordered by the Host's own count, not by turns: a push can arrive after a newer reply.
      const parsed = (withRounds ? HostQuestionListV3Schema : HostQuestionListV2Schema).safeParse(
        raw
      );
      if (!parsed.success) return;
      this.listsAsks.add(session);
      if (this.listCounts(hostId, session, parsed.data)) {
        this.hearQuestions(hostId, session, parsed.data, parsed.data.asks, withRounds);
      }
      return;
    }
    if (this.questionTurns.get(hostId) !== turn) return;
    const parsed = HostQuestionListSchema.safeParse(raw);
    if (parsed.success) this.hearQuestions(hostId, session, parsed.data);
  }

  /**
   * What the Host says its questions are, each read on its own and kept only
   * when it names the Host's id. A Host that serves none now (`hostId` null)
   * changes nothing: what it reported last stands.
   */
  private hearQuestions(
    hostId: string,
    session: DecisionsHostSession,
    payload: HostQuestionListPayload,
    rawAsks?: readonly unknown[],
    rounds = false
  ): void {
    const owner = ownerKeyOf(this.deps.ownerState());
    if (owner === null || payload.hostId === null || !this.takesList(hostId, session, payload)) {
      return;
    }
    const questionHostId = payload.hostId;
    const questions: Omit<DecisionQuestionListItem, "remoteHost" | "inbox">[] = [];
    // A v3 list's items carry their round (#17943); an older list's are read as they always were.
    const itemSchema = rounds ? HostQuestionItemV3Schema : HostQuestionItemSchema;
    for (const raw of payload.questions) {
      const item = itemSchema.safeParse(raw);
      if (item.success && item.data.reference.hostId === questionHostId) questions.push(item.data);
    }
    // Each ask read on its own, and kept only for a question the list kept.
    let asks: Map<string, string | null> | undefined;
    if (rawAsks !== undefined) {
      asks = new Map();
      const listed = new Set(questions.map((question) => question.reference.questionId));
      for (const raw of rawAsks) {
        const ask = HostQuestionAskSchema.safeParse(raw);
        if (ask.success && listed.has(ask.data.questionId)) {
          asks.set(ask.data.questionId, ask.data.ask);
        }
      }
    }
    this.questionReports.set(hostId, {
      session,
      owner,
      questionHostId,
      questions,
      ...(asks !== undefined ? { asks } : {}),
    });
    this.questionsChanged();
  }

  /**
   * Whether a v2 list is newer than any `session` delivered, taking it as the
   * newest when it is. Only a list counts: one that serves none (`hostId`
   * null), or was served to another owner, changes nothing, so it never puts
   * an older list still on its way out of date.
   */
  private listCounts(
    hostId: string,
    session: DecisionsHostSession,
    payload: HostQuestionListPayload & { seq: number }
  ): boolean {
    if (payload.hostId === null || !this.takesList(hostId, session, payload)) return false;
    if (payload.seq <= (this.listSeqs.get(session) ?? 0)) return false;
    this.listSeqs.set(session, payload.seq);
    return true;
  }

  /** A list heard over the Host's current link, served to the owner this computer speaks as now. */
  private takesList(
    hostId: string,
    session: DecisionsHostSession,
    payload: HostQuestionListPayload
  ): boolean {
    const owner = ownerKeyOf(this.deps.ownerState());
    return (
      session.isOpen &&
      this.deps.sessionFor(hostId) === session &&
      payload.owner !== null &&
      owner !== null &&
      ownerKey(payload.owner) === owner
    );
  }

  private questionsChanged(): void {
    for (const listener of [...this.questionListeners]) {
      try {
        listener();
      } catch (err) {
        console.warn("[Decisions] A Host questions listener threw:", err);
      }
    }
  }

  private wire(hostId: string, session: DecisionsHostSession): void {
    if (this.wired.has(session)) return;
    this.wired.add(session);
    const offReport = session.registerCallHandler(
      DecisionsLinkMethod.HOST_RUNTIME,
      HostRuntimePayloadSchema,
      ({ runtime }) => {
        this.observePushed(hostId, session, runtime);
        return null;
      }
    );
    const offReportV2 = session.registerCallHandler(
      DecisionsLinkMethod.HOST_RUNTIME_V2,
      HostRuntimeV2PayloadSchema,
      ({ runtime }) => {
        this.observePushed(hostId, session, runtime);
        return null;
      }
    );
    const offQuestions = session.registerCallHandler(
      DecisionsLinkMethod.QUESTIONS_CHANGED,
      HostQuestionsChangedPayloadSchema,
      (payload) => {
        // A replaced link's list, or one served to another owner, moves nothing: not even a read's turn.
        if (!this.takesList(hostId, session, payload)) return null;
        // Sent before the Host knew this Shell reads asks: what it listed since is newer.
        if (this.listsAsks.has(session)) return null;
        // Newer than any read still waiting for its answer, except one of the list with its asks.
        if (!this.readingAsks.has(session)) {
          this.questionTurns.set(hostId, (this.questionTurns.get(hostId) ?? 0) + 1);
        }
        this.hearQuestions(hostId, session, payload);
        return null;
      }
    );
    const offQuestionsV2 = session.registerCallHandler(
      DecisionsLinkMethod.QUESTIONS_CHANGED_V2,
      HostQuestionsChangedV2PayloadSchema,
      (payload) => {
        if (!this.takesList(hostId, session, payload)) return null;
        // One sent before the Host knew this Shell reads rounds is older than what it listed
        // since by the session's count; one after is the Host telling it without them.
        this.listsAsks.add(session);
        if (!this.listCounts(hostId, session, payload)) return null;
        this.hearQuestions(hostId, session, payload, payload.asks);
        return null;
      }
    );
    const offQuestionsV3 = session.registerCallHandler(
      DecisionsLinkMethod.QUESTIONS_CHANGED_V3,
      HostQuestionsChangedV3PayloadSchema,
      (payload) => {
        if (!this.takesList(hostId, session, payload)) return null;
        this.listsAsks.add(session);
        if (!this.listCounts(hostId, session, payload)) return null;
        this.hearQuestions(hostId, session, payload, payload.asks, true);
        return null;
      }
    );
    const unwire = () => {
      offReport();
      offReportV2();
      offQuestions();
      offQuestionsV2();
      offQuestionsV3();
      offClose();
      this.unwires.delete(unwire);
    };
    const offClose = session.onClose(() => {
      unwire();
      // What it said last stands, now as what it said before its link closed.
      if (this.reports.get(hostId)?.session === session) this.changed();
      if (this.questionReports.get(hostId)?.session === session) this.questionsChanged();
    });
    this.unwires.add(unwire);
    void this.announce(hostId, session);
  }

  /** Tells one Host whether Decisions is on here, and keeps what it answers it reports. */
  private async announce(hostId: string, session: DecisionsHostSession): Promise<void> {
    const state = this.deps.ownerState();
    if (state === null) return;
    const turn = (this.announced.get(hostId) ?? 0) + 1;
    this.announced.set(hostId, turn);
    let states = this.announcedStates.get(session);
    if (states === undefined) {
      states = new Map();
      this.announcedStates.set(session, states);
    }
    states.set(ownerKey(state), state);
    let answer: { raw: unknown; v2: boolean };
    try {
      answer = await this.sendOwnerState(session, state);
    } catch {
      // A Host from before Hosts ran Decisions, or a link that went: nothing to keep.
      return;
    }
    // Whatever the owner said, the Host's questions as they stand now (#17230).
    void this.readQuestions(hostId, session);
    if (turn <= (this.observedTurns.get(hostId) ?? 0)) return;
    // Read as the method it answered: a v2 report says how a running Host asks, a v1 one can't.
    const parsed = (answer.v2 ? HostRuntimeV2PayloadSchema : HostRuntimePayloadSchema).safeParse(
      answer.raw
    );
    if (!parsed.success) return;
    this.observedTurns.set(hostId, turn);
    this.observe(hostId, session, parsed.data.runtime);
  }

  /** A report the Host pushed: newer than any announcement still waiting for its answer. */
  private observePushed(
    hostId: string,
    session: DecisionsHostSession,
    runtime: DecisionsHostRuntime
  ): void {
    const turn = (this.announced.get(hostId) ?? 0) + 1;
    this.announced.set(hostId, turn);
    this.observedTurns.set(hostId, turn);
    this.observe(hostId, session, runtime);
  }

  /**
   * `state` as the Host can take it, and whether it answered a v2 report
   * (#17942): asked for one, else with terminal snapshots (#16230), or, to a
   * Host from before them, without, which it reads as off. Each method a
   * Host answers UNSUPPORTED is never tried again on that link. A fallback
   * says the latest word its owner announced on this session, not what it
   * said when this one began: a later announcement may have gone ahead while
   * it waited on the refusal, or failed, and the Host must neither apply an
   * older word last nor miss the latest. It stays that owner's word even if
   * this computer has since disconnected or speaks as another owner.
   */
  private async sendOwnerState(
    session: DecisionsHostSession,
    first: OwnerStateAnnouncement
  ): Promise<{ raw: unknown; v2: boolean }> {
    const options = { timeoutMs: OWNER_STATE_TIMEOUT_MS };
    let state = first;
    const latest = (): OwnerStateAnnouncement =>
      this.announcedStates.get(session)?.get(ownerKey(first)) ?? first;
    if (!this.beforeQuestionPolicy.has(session) && !this.beforeSnapshots.has(session)) {
      try {
        const raw = await session.call(
          DecisionsLinkMethod.OWNER_STATE_V3,
          OwnerStateV2PayloadSchema.parse(state),
          options
        );
        return { raw, v2: true };
      } catch (error) {
        if (codeOf(error) !== "UNSUPPORTED") throw error;
        this.beforeQuestionPolicy.add(session);
        state = latest();
      }
    }
    if (!this.beforeSnapshots.has(session)) {
      try {
        const raw = await session.call(
          DecisionsLinkMethod.OWNER_STATE_V2,
          OwnerStateV2PayloadSchema.parse(state),
          options
        );
        return { raw, v2: false };
      } catch (error) {
        if (codeOf(error) !== "UNSUPPORTED") throw error;
        this.beforeSnapshots.add(session);
        state = latest();
      }
    }
    const { terminalSnapshots: _snapshots, ...earlier } = state;
    const raw = await session.call(
      DecisionsLinkMethod.OWNER_STATE,
      OwnerStatePayloadSchema.parse(earlier),
      options
    );
    return { raw, v2: false };
  }

  private observe(
    hostId: string,
    session: DecisionsHostSession,
    runtime: DecisionsHostRuntime
  ): void {
    if (!session.isOpen) return;
    // Another Decisions device now: nothing read of the one before stands for it, nor if it returns.
    const reads = this.lastReads.get(hostId);
    if (reads !== undefined && reads.deviceId !== deviceOf(runtime)) this.lastReads.delete(hostId);
    this.reports.set(hostId, { session, runtime, at: this.now() });
    this.changed();
    // Whether its questions are listed follows what it reports of its enrollment.
    if (this.questionReports.has(hostId)) this.questionsChanged();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.warn("[Decisions] A Hosts listener threw:", err);
      }
    }
  }

  private linkOf(hostId: string, session: DecisionsHostSession): HostLink {
    let link = this.links.get(session);
    if (!link) {
      link = new HostLink(hostId, session, this.deps.hold);
      this.links.set(session, link);
    }
    return link;
  }
}
