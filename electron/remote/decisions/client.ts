import type { z } from "zod";
import type {
  DecisionsHostRuntime,
  DecisionsHostRuntimeObservation,
} from "../../../shared/types/decisionsHosts.js";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionListItem,
  DecisionQuestionReference,
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
  type HostCallOutcome,
  type HostIdentityReport,
  type HostRequestResult,
  type OwnerStateAnnouncement,
} from "../../types/decisionsHosts.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostRuntimePayloadSchema,
  HostStatusResultSchema,
  OwnerStatePayloadSchema,
  OwnerStateV2PayloadSchema,
  type EnrollHostPayload,
} from "./linkMethods.js";
import {
  HostQuestionCancelResultSchema,
  HostQuestionContentResultSchema,
  HostQuestionImagePartResultSchema,
  HostQuestionItemSchema,
  HostQuestionListSchema,
  HostQuestionSummariesResultSchema,
  HostQuestionsChangedPayloadSchema,
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
  questions: Omit<DecisionQuestionListItem, "remoteHost">[];
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
  }
}

type DecisionQuestionContentResultLike = z.infer<typeof HostQuestionContentResultSchema>;
type ImagePartResultLike = z.infer<typeof HostQuestionImagePartResultSchema>;
type SummariesResultLike = z.infer<typeof HostQuestionSummariesResultSchema>;

function answerSchemaOf(read: DecisionsHostQuestionRead): z.ZodType {
  switch (read.read) {
    case "content":
      return HostQuestionContentResultSchema;
    case "image":
      return HostQuestionImagePartResultSchema;
    case "summaries":
      return HostQuestionSummariesResultSchema;
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
  private readonly listeners = new Set<() => void>();
  /** Each wired session's handler and close listener, removed on stop. */
  private readonly unwires = new Set<() => void>();
  /** Each Host's questions as it last reported them (#17230), kept when its link closes. */
  private readonly questionReports = new Map<string, HostQuestionsReport>();
  /** Counts each Host's lists, so a read answered after a newer push can't replace it. */
  private readonly questionTurns = new Map<string, number>();
  /** Sessions whose Host answered a read of its questions UNSUPPORTED: from before #17230. */
  private readonly beforeQuestions = new WeakSet<DecisionsHostSession>();
  private readonly questionListeners = new Set<() => void>();
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
    // A Host taken off the host list takes what it reported with it.
    for (const hostId of [...this.questionReports.keys()]) {
      if (!present.has(hostId)) this.questionReports.delete(hostId);
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
    return this.callHost(hostId, DecisionsLinkMethod.QUESTIONS, read, answerSchemaOf(read)).then(
      (answered): HostCallOutcome<DecisionsHostQuestionAnswer<R>> =>
        answered.ok && !answersRead(read, answered.value)
          ? { ok: false, failure: "unexpected-answer" }
          : (answered as HostCallOutcome<DecisionsHostQuestionAnswer<R>>)
    );
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
    schema: S
  ): Promise<HostCallOutcome<z.infer<S>>> {
    const session = this.deps.sessionFor(hostId);
    if (!session?.isOpen) return { ok: false, failure: "disconnected" };
    const release = this.deps.hold(hostId);
    let raw: unknown;
    try {
      raw = await session.call(method, payload, { timeoutMs: HOST_QUESTION_TIMEOUT_MS });
    } catch (error) {
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
    try {
      raw = await session.call(
        DecisionsLinkMethod.QUESTIONS,
        { read: "list" },
        { timeoutMs: HOST_QUESTION_TIMEOUT_MS }
      );
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
    payload: HostQuestionListPayload
  ): void {
    const owner = ownerKeyOf(this.deps.ownerState());
    if (owner === null || payload.hostId === null || !this.takesList(hostId, session, payload)) {
      return;
    }
    const questionHostId = payload.hostId;
    const questions: Omit<DecisionQuestionListItem, "remoteHost">[] = [];
    for (const raw of payload.questions) {
      const item = HostQuestionItemSchema.safeParse(raw);
      if (item.success && item.data.reference.hostId === questionHostId) questions.push(item.data);
    }
    this.questionReports.set(hostId, { session, owner, questionHostId, questions });
    this.questionsChanged();
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
        // Newer than any announcement still waiting for its answer.
        this.announced.set(hostId, (this.announced.get(hostId) ?? 0) + 1);
        this.observe(hostId, session, runtime);
        return null;
      }
    );
    const offQuestions = session.registerCallHandler(
      DecisionsLinkMethod.QUESTIONS_CHANGED,
      HostQuestionsChangedPayloadSchema,
      (payload) => {
        // A replaced link's list, or one served to another owner, moves nothing: not even a read's turn.
        if (!this.takesList(hostId, session, payload)) return null;
        // Newer than any read still waiting for its answer.
        this.questionTurns.set(hostId, (this.questionTurns.get(hostId) ?? 0) + 1);
        this.hearQuestions(hostId, session, payload);
        return null;
      }
    );
    const unwire = () => {
      offReport();
      offQuestions();
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
    let raw: unknown;
    try {
      raw = await this.sendOwnerState(session, state);
    } catch {
      // A Host from before Hosts ran Decisions, or a link that went: nothing to keep.
      return;
    }
    // Whatever the owner said, the Host's questions as they stand now (#17230).
    void this.readQuestions(hostId, session);
    if (this.announced.get(hostId) !== turn) return;
    const parsed = HostRuntimePayloadSchema.safeParse(raw);
    if (parsed.success) this.observe(hostId, session, parsed.data.runtime);
  }

  /**
   * `state` as the Host can take it (#16230): with terminal snapshots, or,
   * to a Host from before them, without, which it reads as off.
   */
  private async sendOwnerState(
    session: DecisionsHostSession,
    state: OwnerStateAnnouncement
  ): Promise<unknown> {
    const options = { timeoutMs: OWNER_STATE_TIMEOUT_MS };
    if (!this.beforeSnapshots.has(session)) {
      try {
        return await session.call(
          DecisionsLinkMethod.OWNER_STATE_V2,
          OwnerStateV2PayloadSchema.parse(state),
          options
        );
      } catch (error) {
        if (codeOf(error) !== "UNSUPPORTED") throw error;
        this.beforeSnapshots.add(session);
      }
    }
    const { terminalSnapshots: _snapshots, ...earlier } = state;
    return session.call(
      DecisionsLinkMethod.OWNER_STATE,
      OwnerStatePayloadSchema.parse(earlier),
      options
    );
  }

  private observe(
    hostId: string,
    session: DecisionsHostSession,
    runtime: DecisionsHostRuntime
  ): void {
    if (!session.isOpen) return;
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
