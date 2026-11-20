import type {
  DecisionsHostAttentionAnswer,
  DecisionsHostAttentionRequest,
} from "../../../shared/types/decisionsAttention.js";
import type { DecisionsHostRuntime } from "../../../shared/types/decisionsHosts.js";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionImagePartResult,
  DecisionQuestionPaneResult,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
} from "../../../shared/types/decisionsQuestion.js";
import type {
  DecisionsHostQuestionRead,
  HeldHost,
  HostAcceptResult,
  HostIdentityReport,
  HostRequestResult,
  OwnerStateAnnouncement,
} from "../../types/decisionsHosts.js";
import type { LinkSession } from "../link/session.js";
import { HostAttentionRequestSchema, MAX_HOST_ATTENTION_BYTES } from "./attentionSchemas.js";
import {
  DecisionsLinkMethod,
  EnrollHostPayloadSchema,
  HostAcceptResultSchema,
  HostRequestResultSchema,
  HostRuntimeSchema,
  HostRuntimeV2Schema,
  HostStatusResultSchema,
  legacyRuntime,
  OwnerStatePayloadSchema,
  OwnerStateV2PayloadSchema,
  type EnrollHostPayload,
  type HostStatusResult,
} from "./linkMethods.js";
import {
  HostCancelQuestionPayloadSchema,
  HostQuestionContentV2ReadSchema,
  HostQuestionListV2ReadSchema,
  HostQuestionReadSchema,
  legacyContent,
  legacyItem,
  MAX_HOST_QUESTION_LIST_BYTES,
  MAX_HOST_QUESTIONS,
  type HostQuestionList,
  type HostQuestionListPayload,
  type HostQuestionListV2Payload,
  type HostQuestionRead,
  v2Content,
} from "./questionSchemas.js";

/** One attached Shell's session; the session itself is what pending keys are bound to. */
export interface DecisionsSessionContext {
  session: LinkSession;
}

export interface DecisionsSessionSource {
  readonly sessions: ReadonlyArray<DecisionsSessionContext>;
  onSession(listener: (ctx: DecisionsSessionContext) => void): () => void;
}

/**
 * This Host's enrollment as a Decisions device, loaded on the first CALL. The
 * `link` each step names is the session it came over: keys made for one
 * session are accepted only on that session.
 */
export interface DecisionsHostEnrollment {
  status(): Promise<HostIdentityReport>;
  request(
    link: object,
    input: { attempt: string; label: string; replace?: string; allowWeakStorage?: boolean }
  ): Promise<HostRequestResult>;
  accept(link: object, input: { attempt: string; response: string }): Promise<HostAcceptResult>;
  /** The session closed: the keys it was given and never accepted are dropped. */
  forget(link: object): void;
  dispose(): Promise<void>;
}

type Answer = HostStatusResult | HostRequestResult | HostAcceptResult;

/** What a Shell this Host doesn't serve its questions to reads of one: off, for it. */
const OFF = { result: "off" } as const;

/** What a Shell this Host doesn't serve its questions to is told: a list of none. */
const NO_QUESTIONS = { hostId: null, owner: null, questions: [] } as const;
/** A v2 list before the session's next `seq` is put on it. */
type UnsequencedListV2 = Omit<HostQuestionListV2Payload, "seq">;

const NO_QUESTIONS_V2: UnsequencedListV2 = { ...NO_QUESTIONS, questions: [], asks: [] };

/** The longest owner ids a list can name, for sizing its envelope before knowing which owner. */
const LONGEST_OWNER = { installationId: "x".repeat(64), ownerDeviceId: "x".repeat(64) };

/**
 * The newest questions within what one message carries, by count and by
 * size, the asks a v2 list sends with them counted in (#17895).
 */
function bounded(list: HostQuestionList): HostQuestionList {
  const kept: HostQuestionList["questions"] = [];
  let bytes = Buffer.byteLength(
    JSON.stringify({
      hostId: list.hostId,
      owner: LONGEST_OWNER,
      questions: [],
      asks: [],
      seq: Number.MAX_SAFE_INTEGER,
    })
  );
  for (let i = list.questions.length - 1; i >= 0 && kept.length < MAX_HOST_QUESTIONS; i--) {
    const question = list.questions[i]!;
    // Each question, and the comma before it when one is already kept.
    bytes += Buffer.byteLength(JSON.stringify(question)) + (kept.length > 0 ? 1 : 0);
    const { questionId } = question.reference;
    const ask = list.asks?.get(questionId);
    if (ask !== undefined) {
      bytes += Buffer.byteLength(JSON.stringify({ questionId, ask })) + (kept.length > 0 ? 1 : 0);
    }
    if (bytes > MAX_HOST_QUESTION_LIST_BYTES) break;
    kept.push(question);
  }
  if (kept.length === list.questions.length) return list;
  return {
    hostId: list.hostId,
    questions: kept.reverse(),
    ...(list.asks !== undefined ? { asks: list.asks } : {}),
  };
}

/** The list as a Shell from before #17943 reads it: its items without their rounds. */
function legacyList(list: HostQuestionList): HostQuestionList {
  return { ...list, questions: list.questions.map(legacyItem) };
}

/**
 * The newest of the list's questions that fit one message as a session reads
 * them (#17943): with their rounds for one that reads v3, else without, so a
 * Shell from before them is never cut short by fields it isn't sent.
 */
function boundedFor(list: HostQuestionList, rounds: boolean): HostQuestionList {
  return bounded(rounds ? list : legacyList(list));
}

/**
 * The list as sent to one session: named with the owner that session's
 * announcement named, its items as a Shell from before #17943 reads them.
 */
function servedTo(list: HostQuestionList, owner: OwnerOf): HostQuestionListPayload {
  return {
    hostId: list.hostId,
    owner: { installationId: owner.installationId, ownerDeviceId: owner.ownerDeviceId },
    questions: list.questions.map(legacyItem),
  };
}

/** What each of the list's questions in Needs you asks now (#17895). */
function asksOf(list: HostQuestionList): { questionId: string; ask: string | null }[] {
  const asks: { questionId: string; ask: string | null }[] = [];
  for (const question of list.questions) {
    const ask = list.asks?.get(question.reference.questionId);
    if (ask !== undefined) asks.push({ questionId: question.reference.questionId, ask });
  }
  return asks;
}

/** `servedTo`, with what each of its questions in Needs you asks now (#17895). */
function servedToV2(list: HostQuestionList, owner: OwnerOf): UnsequencedListV2 {
  return { ...servedTo(list, owner), asks: asksOf(list) };
}

/** `servedToV2` with each item's round (#17943), for a Shell that read v3. */
function servedToV3(list: HostQuestionList, owner: OwnerOf): UnsequencedListV2 {
  return {
    hostId: list.hostId,
    owner: { installationId: owner.installationId, ownerDeviceId: owner.ownerDeviceId },
    questions: list.questions,
    asks: asksOf(list),
  };
}

type OwnerOf = Pick<OwnerStateAnnouncement, "installationId" | "ownerDeviceId">;

/** This Host's own Decisions (#16022), once loaded. */
export interface DecisionsHostLifetime {
  /** Applies what the owner's Shell said, and answers what the Host then reports to it. */
  apply(state: OwnerStateAnnouncement): Promise<DecisionsHostRuntime>;
  /**
   * The key file holds `held`, just accepted or read: what this Host runs as,
   * off from the start if its owner's Shell last said so (`ownerEnabled`).
   */
  adopt(held: HeldHost, ownerEnabled: boolean | undefined): Promise<void>;
  /** What the Host reports to `owner` now. */
  reportFor(owner: OwnerOf): DecisionsHostRuntime;
  /** Called whenever what it reports may have changed. */
  onChanged(listener: () => void): () => void;
  /** This Host's own questions (#17230), content-free; null while it serves none. */
  questions(): HostQuestionList | null;
  /** Called whenever its questions may have changed. */
  onQuestionsChanged(listener: () => void): () => void;
  /** One of this Host's own questions read by reference, here and never on another machine. */
  readQuestion(
    read: DecisionsHostQuestionRead
  ): Promise<
    | DecisionQuestionContentResult
    | DecisionQuestionImagePartResult
    | DecisionQuestionSummariesResult
    | DecisionQuestionPaneResult
  >;
  /** The person withdrawing one of this Host's own questions by reference. */
  cancelQuestion(reference: DecisionQuestionReference): Promise<DecisionQuestionCancelResult>;
  /**
   * One of this Host's own stopped deliveries read or acted on by reference
   * (#18031), through the delivery this Host's own windows act through.
   */
  attention(request: DecisionsHostAttentionRequest): Promise<DecisionsHostAttentionAnswer>;
}

/** How the link reaches this Host's own Decisions, loading nothing until it must. */
export interface DecisionsHostRuntimeSource {
  /** The saved record names an enrollment by `owner`; read without loading anything. */
  enrolledBy(owner: OwnerOf): boolean;
  load(): Promise<DecisionsHostLifetime>;
}

/**
 * Host side of enrollment (#16021): every attached Shell's session can ask,
 * and only the owner's will, since only it can sign an enrollment. Nothing
 * of Decisions loads until a Shell first asks; the keys are made, checked and
 * sealed here, and only their public halves are ever answered.
 *
 * With `runtime`, the owner's Shell also says whether its Decisions is on
 * (#16022), which turns this Host's own off or on, and hears what the Host
 * reports of it whenever that changes. An owner that never enrolled this
 * Host loads nothing.
 *
 * The owner that enrolled this Host, while its Decisions is on, also reads
 * the Host's own questions (#17230): their content-free list, pushed again
 * whenever it changes, and each one by reference. Nothing of them goes to a
 * session whose owner didn't enroll it.
 */
export function installDecisionsHostWith(
  server: DecisionsSessionSource,
  load: (onHeld: (held: HeldHost) => void) => Promise<DecisionsHostEnrollment>,
  runtime?: DecisionsHostRuntimeSource
): () => Promise<void> {
  let loading: Promise<DecisionsHostEnrollment> | null = null;
  let loaded: DecisionsHostEnrollment | null = null;
  let disposed = false;
  const wired = new WeakSet<LinkSession>();
  const unregisters = new Set<() => void>();
  /** The owner each session last announced (#16022): only those sessions hear the Host's reports. */
  const owners = new Map<LinkSession, OwnerStateAnnouncement>();
  /** What each session was last told, so a report it already has isn't sent again. */
  const told = new Map<LinkSession, string>();
  /**
   * Sessions pushed v2 reports (#17942): those whose Shell last announced
   * with `OWNER_STATE_V3`, until one refuses a v2 push. A reply goes as the
   * method it answers asks, whatever this says by then.
   */
  const runtimeV2 = new WeakSet<LinkSession>();
  /** `report` as v2, or without its policy as a Shell from before #17942 reads it. */
  const reportAs = (v2: boolean, report: DecisionsHostRuntime): DecisionsHostRuntime =>
    v2 ? HostRuntimeV2Schema.parse(report) : HostRuntimeSchema.parse(legacyRuntime(report));
  /** What each owner's Shells last said, by owner: an enrollment taken up later starts as it says. */
  const latestByOwner = new Map<string, OwnerStateAnnouncement>();
  const ownerKey = (owner: OwnerOf) => `${owner.installationId}\n${owner.ownerDeviceId}`;
  let lifetime: Promise<DecisionsHostLifetime> | null = null;
  let offChanged: (() => void) | null = null;
  let offQuestions: (() => void) | null = null;
  /** The list each session was last sent, so one it already has isn't sent again. */
  const toldQuestions = new Map<LinkSession, string>();
  /** Sessions whose Shell answered a pushed list UNSUPPORTED: from before #17230, sent no more. */
  const beforeQuestions = new WeakSet<LinkSession>();
  /** Sessions whose Shell reads the list with its asks (#17895): their pushes carry them too. */
  const listsV2 = new WeakSet<LinkSession>();
  /** Sessions whose Shell reads v3 items (#17943), each also in `listsV2`. */
  const listsV3 = new WeakSet<LinkSession>();
  /** The last `seq` each v2 session was sent, read or pushed. */
  const listSeqs = new WeakMap<LinkSession, number>();
  const sequenced = (session: LinkSession, list: UnsequencedListV2): HostQuestionListV2Payload => {
    const seq = (listSeqs.get(session) ?? 0) + 1;
    listSeqs.set(session, seq);
    return { ...list, seq };
  };
  /** This Host's Decisions once loaded, so a list told again reads what it lists now. */
  let loadedLifetime: DecisionsHostLifetime | null = null;

  /** The session's owner enrolled this Host and has Decisions on: only it reads the questions. */
  const servesQuestions = (session: LinkSession): boolean => {
    if (disposed || !session.isOpen) return false;
    const owner = owners.get(session);
    return owner !== undefined && owner.enabled && runtime?.enrolledBy(owner) === true;
  };

  /** `list` is the Host's whole list: each session is sent what fits as it reads it. */
  const tellQuestions = (session: LinkSession, whole: HostQuestionList, owner: OwnerOf): void => {
    const v2 = listsV2.has(session);
    const v3 = v2 && listsV3.has(session);
    const list = boundedFor(whole, v3);
    const payload: HostQuestionListPayload = v3
      ? servedToV3(list, owner)
      : v2
        ? servedToV2(list, owner)
        : servedTo(list, owner);
    // What was said, not when: the same list again isn't sent.
    const key = JSON.stringify(payload);
    if (toldQuestions.get(session) === key || beforeQuestions.has(session)) return;
    toldQuestions.set(session, key);
    const method = v3
      ? DecisionsLinkMethod.QUESTIONS_CHANGED_V3
      : v2
        ? DecisionsLinkMethod.QUESTIONS_CHANGED_V2
        : DecisionsLinkMethod.QUESTIONS_CHANGED;
    const sent = v2 ? sequenced(session, payload as UnsequencedListV2) : payload;
    session.call(method, sent).catch((error: unknown) => {
      const unsupported = (error as { code?: unknown } | null)?.code === "UNSUPPORTED";
      if (toldQuestions.get(session) === key) toldQuestions.delete(session);
      if (!unsupported) return;
      if (v3) {
        // A Shell that read v3 takes it pushed; one that doesn't hears v2, as for v2 below.
        listsV3.delete(session);
        const current = owners.get(session);
        const now = loadedLifetime?.questions() ?? null;
        if (now !== null && current !== undefined && servesQuestions(session)) {
          tellQuestions(session, now, current);
        }
      } else if (v2) {
        // A Shell that read the list with its asks takes them pushed; one that doesn't hears v1:
        // the list this Host's Decisions holds now, only while it still serves that session.
        listsV2.delete(session);
        const current = owners.get(session);
        const now = loadedLifetime?.questions() ?? null;
        if (now !== null && current !== undefined && servesQuestions(session)) {
          tellQuestions(session, now, current);
        }
      } else {
        beforeQuestions.add(session);
      }
    });
  };

  /** The Host's questions changed: every session it serves them to hears the new list. */
  const pushQuestions = (made: DecisionsHostLifetime): void => {
    if (disposed) return;
    const list = made.questions();
    // A Host that stopped serving its questions says nothing: its owner keeps what it last heard.
    if (list === null) return;
    for (const [session, owner] of owners) {
      if (servesQuestions(session)) tellQuestions(session, list, owner);
    }
  };

  const tell = (session: LinkSession, report: DecisionsHostRuntime): void => {
    if (!session.isOpen) return;
    const v2 = runtimeV2.has(session);
    const sent = reportAs(v2, report);
    const key = JSON.stringify(sent);
    if (told.get(session) === key) return;
    told.set(session, key);
    const method = v2 ? DecisionsLinkMethod.HOST_RUNTIME_V2 : DecisionsLinkMethod.HOST_RUNTIME;
    session.call(method, { runtime: sent }).catch((error: unknown) => {
      const unsupported = (error as { code?: unknown } | null)?.code === "UNSUPPORTED";
      // A Shell from before reports were pushed answers UNSUPPORTED; its next announcement reads it.
      if (!v2 && unsupported) return;
      // Anything else wasn't taken, so the same report is told again when it next changes.
      if (told.get(session) === key) told.delete(session);
      if (!unsupported) return;
      // One that announced with v3 reads v2 pushes; should it not, it hears v1 from now on: what
      // the Host reports to its owner now, never the report that was refused, which may be stale.
      runtimeV2.delete(session);
      const owner = owners.get(session);
      if (disposed || owner === undefined || loadedLifetime === null) return;
      tell(session, loadedLifetime.reportFor(owner));
    });
  };

  const tellOwners = (made: DecisionsHostLifetime): void => {
    if (disposed) return;
    for (const [session, owner] of owners) tell(session, made.reportFor(owner));
  };

  /** Loads the Host's Decisions and follows what it reports, once. */
  const followLifetime = (): Promise<DecisionsHostLifetime> | null => {
    if (!runtime || disposed) return null;
    if (!lifetime) {
      const made = runtime.load().then((lifetimeOf) => {
        if (!disposed && offChanged === null) {
          loadedLifetime = lifetimeOf;
          offChanged = lifetimeOf.onChanged(() => tellOwners(lifetimeOf));
          offQuestions = lifetimeOf.onQuestionsChanged(() => pushQuestions(lifetimeOf));
          // Sessions told "not enrolled" before an enrollment hear what it is now.
          tellOwners(lifetimeOf);
        }
        return lifetimeOf;
      });
      lifetime = made;
      // A failed load is tried again by the next announcement.
      made.catch(() => {
        if (lifetime === made) lifetime = null;
      });
    }
    return lifetime;
  };

  const announced = async (
    session: LinkSession,
    state: OwnerStateAnnouncement,
    v2 = false
  ): Promise<{ runtime: DecisionsHostRuntime }> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    // The method it announced with says how it reads reports, its pushes included, from now on.
    if (v2) runtimeV2.add(session);
    else runtimeV2.delete(session);
    owners.set(session, state);
    latestByOwner.set(ownerKey(state), state);
    // An owner that never enrolled this Host loads nothing of Decisions here.
    if (!runtime?.enrolledBy(state)) {
      const none: DecisionsHostRuntime = { state: "not-enrolled" };
      told.set(session, JSON.stringify(none));
      return { runtime: none };
    }
    const made = await followLifetime();
    if (!made) throw new Error("This Host stopped serving Shells");
    const report = await made.apply(state);
    // A session that closed, or announced again, meanwhile keeps no record of this answer: one
    // that keeps it has been told the report as its pushes would carry it, whatever the reply.
    if (!disposed && session.isOpen && owners.get(session) === state) {
      told.set(session, JSON.stringify(reportAs(runtimeV2.has(session), report)));
    }
    return { runtime: reportAs(v2, report) };
  };

  /** Adoptions still running: stopping waits for them, so none outlives this installer. */
  const adoptions = new Set<Promise<void>>();

  /**
   * The key file holds `held`: its lifetime takes it up, as its owner last
   * said. What the owner said is read once the lifetime has loaded, and its
   * latest word is applied again after: an announcement that came while
   * there was no record yet was only remembered.
   */
  const onHeld = (held: HeldHost): void => {
    const made = followLifetime();
    if (!made) return;
    const key = ownerKey(held);
    const adoption = made
      .then(async (lifetimeOf) => {
        if (disposed) return;
        await lifetimeOf.adopt(held, latestByOwner.get(key)?.enabled);
        // Once taken up, the owner's latest word follows, even if this installer stopped meanwhile.
        const latest = latestByOwner.get(key);
        if (latest === undefined) return;
        await lifetimeOf.apply({
          installationId: held.installationId,
          ownerDeviceId: held.ownerDeviceId,
          enabled: latest.enabled,
          terminalSnapshots: latest.terminalSnapshots,
        });
      })
      .catch((err: unknown) => {
        console.warn("[Decisions] This Host's enrollment couldn't be taken up:", err);
      });
    adoptions.add(adoption);
    void adoption.finally(() => adoptions.delete(adoption));
  };

  const enrollment = (): Promise<DecisionsHostEnrollment> => {
    loading ??= load(onHeld).then((made) => {
      loaded = made;
      return made;
    });
    // A failed load is tried again by the next CALL.
    loading.catch(() => {
      if (loaded === null) loading = null;
    });
    return loading;
  };

  const answer = async (session: LinkSession, payload: EnrollHostPayload): Promise<Answer> => {
    const made = await enrollment();
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    switch (payload.step) {
      case "status":
        return HostStatusResultSchema.parse({ step: "status", identity: await made.status() });
      case "request":
        return HostRequestResultSchema.parse(
          await made.request(session, {
            attempt: payload.attempt,
            label: payload.label,
            ...(payload.replace !== undefined ? { replace: payload.replace } : {}),
            ...(payload.allowWeakStorage === true ? { allowWeakStorage: true } : {}),
          })
        );
      case "accept":
        return HostAcceptResultSchema.parse(
          await made.accept(session, { attempt: payload.attempt, response: payload.response })
        );
    }
  };

  /** A read of the Host's questions (#17230), for the owner that enrolled it only. */
  const readQuestions = async (session: LinkSession, payload: HostQuestionRead) => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return payload.read === "list" ? NO_QUESTIONS : OFF;
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    // Checked again: the owner may have said otherwise while the lifetime loaded.
    if (!servesQuestions(session)) return payload.read === "list" ? NO_QUESTIONS : OFF;
    if (payload.read === "list") {
      // A Shell reading the list without its asks is from before them, and is told it that way.
      listsV2.delete(session);
      listsV3.delete(session);
      const list = made.questions();
      const owner = owners.get(session);
      if (list === null || owner === undefined) return NO_QUESTIONS;
      const sent = servedTo(boundedFor(list, false), owner);
      toldQuestions.set(session, JSON.stringify(sent));
      return sent;
    }
    const answer = await made.readQuestion(payload);
    // What was read goes only to a session still served: its owner may have said otherwise meanwhile.
    if (!servesQuestions(session)) return OFF;
    // Content read this way is a Shell's from before #17943, whose strict read takes only that.
    return payload.read === "content" && answer.result === "read" && "question" in answer
      ? { ...answer, question: legacyContent(answer.question) }
      : answer;
  };

  /**
   * One question's content with its round (#17943), and with v3 the agent's
   * preparation (#18042), for the owner that enrolled this Host only.
   */
  const readQuestionContentV2 = async (
    session: LinkSession,
    reference: DecisionQuestionReference,
    v3 = false
  ): Promise<DecisionQuestionContentResult> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const answer = (await made.readQuestion({
      read: "content",
      reference,
    })) as DecisionQuestionContentResult;
    if (!servesQuestions(session)) return OFF;
    // Content read as v2 is a Shell's from before #18042, whose strict read takes only that.
    return !v3 && answer.result === "read"
      ? { ...answer, question: v2Content(answer.question) }
      : answer;
  };

  /**
   * The list with its asks (#17895), and with v3 items each item's round
   * (#17943), for the owner that enrolled this Host only.
   */
  const readQuestionListV2 = async (
    session: LinkSession,
    v3 = false
  ): Promise<HostQuestionListV2Payload> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    // Its pushes carry the asks from now on, whatever this read answers, and v3 items when it read v3.
    listsV2.add(session);
    if (v3) listsV3.add(session);
    else listsV3.delete(session);
    if (!servesQuestions(session)) return sequenced(session, NO_QUESTIONS_V2);
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return sequenced(session, NO_QUESTIONS_V2);
    const list = made.questions();
    const owner = owners.get(session);
    if (list === null || owner === undefined) return sequenced(session, NO_QUESTIONS_V2);
    const sent = (v3 ? servedToV3 : servedToV2)(boundedFor(list, v3), owner);
    toldQuestions.set(session, JSON.stringify(sent));
    return sequenced(session, sent);
  };

  /**
   * The pane that asked one of this Host's questions, as it shows now
   * (#18037), for the owner that enrolled this Host only, and only while it
   * still serves that owner once the read is done.
   */
  const readQuestionPane = async (
    session: LinkSession,
    reference: DecisionQuestionReference
  ): Promise<DecisionQuestionPaneResult> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const answer = (await made.readQuestion({
      read: "pane",
      reference,
    })) as DecisionQuestionPaneResult;
    // What was read goes only to a session still served: its owner may have said otherwise meanwhile.
    if (!servesQuestions(session)) return OFF;
    return answer;
  };

  const cancelQuestion = async (
    session: LinkSession,
    reference: DecisionQuestionReference
  ): Promise<DecisionQuestionCancelResult> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    return made.cancelQuestion(reference);
  };

  /**
   * One of the Host's stopped deliveries read or acted on (#18031), for the
   * owner that enrolled it only. What was read goes only to a session still
   * served, and only whole: one that doesn't fit a reply says so instead.
   */
  const attention = async (
    session: LinkSession,
    request: DecisionsHostAttentionRequest
  ): Promise<DecisionsHostAttentionAnswer> => {
    if (disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const made = await followLifetime();
    if (!made || disposed || !session.isOpen) throw new Error("This Host stopped serving Shells");
    if (!servesQuestions(session)) return OFF;
    const answer = await made.attention(request);
    // A resume or Mark handled that ran is answered whatever the owner said meanwhile: it happened.
    const reads = request.action === "read" || request.action === "copy";
    if (reads && !servesQuestions(session)) return OFF;
    return Buffer.byteLength(JSON.stringify(answer)) > MAX_HOST_ATTENTION_BYTES
      ? { result: "too-large" }
      : answer;
  };

  const wire = ({ session }: DecisionsSessionContext): void => {
    if (disposed || wired.has(session)) return;
    wired.add(session);
    const offCall = session.registerCallHandler(
      DecisionsLinkMethod.ENROLL_HOST,
      EnrollHostPayloadSchema,
      (payload) => answer(session, payload)
    );
    const offOwnerState = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.OWNER_STATE,
          OwnerStatePayloadSchema,
          // A Shell from before terminal snapshots shares none of this Host's.
          (payload) => announced(session, { ...payload, terminalSnapshots: false })
        )
      : () => {};
    const offOwnerStateV3 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.OWNER_STATE_V3,
          OwnerStateV2PayloadSchema,
          (payload) => announced(session, payload, true)
        )
      : () => {};
    const offOwnerStateV2 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.OWNER_STATE_V2,
          OwnerStateV2PayloadSchema,
          (payload) => announced(session, payload)
        )
      : () => {};
    const offQuestionReads = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTIONS,
          HostQuestionReadSchema,
          (payload) => readQuestions(session, payload)
        )
      : () => {};
    const offQuestionListV2 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTION_LIST_V2,
          HostQuestionListV2ReadSchema,
          () => readQuestionListV2(session)
        )
      : () => {};
    const offQuestionListV3 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTION_LIST_V3,
          HostQuestionListV2ReadSchema,
          () => readQuestionListV2(session, true)
        )
      : () => {};
    const offQuestionContentV2 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTION_CONTENT_V2,
          HostQuestionContentV2ReadSchema,
          ({ reference }) => readQuestionContentV2(session, reference)
        )
      : () => {};
    const offQuestionContentV3 = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTION_CONTENT_V3,
          HostQuestionContentV2ReadSchema,
          ({ reference }) => readQuestionContentV2(session, reference, true)
        )
      : () => {};
    const offQuestionPane = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.QUESTION_PANE,
          HostQuestionContentV2ReadSchema,
          ({ reference }) => readQuestionPane(session, reference)
        )
      : () => {};
    const offCancelQuestion = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.CANCEL_QUESTION,
          HostCancelQuestionPayloadSchema,
          ({ reference }) => cancelQuestion(session, reference)
        )
      : () => {};
    const offAttention = runtime
      ? session.registerCallHandler(
          DecisionsLinkMethod.ATTENTION,
          HostAttentionRequestSchema,
          (request) => attention(session, request)
        )
      : () => {};
    let offClose: () => void = () => {};
    const unregister = () => {
      offCall();
      offOwnerState();
      offOwnerStateV2();
      offOwnerStateV3();
      offQuestionReads();
      offQuestionListV2();
      offQuestionListV3();
      offQuestionContentV2();
      offQuestionContentV3();
      offQuestionPane();
      offCancelQuestion();
      offAttention();
      offClose();
      unregisters.delete(unregister);
      owners.delete(session);
      told.delete(session);
      toldQuestions.delete(session);
      loaded?.forget(session);
    };
    unregisters.add(unregister);
    offClose = session.onClose(unregister);
  };

  for (const ctx of server.sessions) wire(ctx);
  const offSession = server.onSession(wire);
  // Resolves once a step already under way has finished, so a listener
  // started again never has two enrollments writing the same key file.
  return async () => {
    disposed = true;
    offSession();
    offChanged?.();
    offChanged = null;
    offQuestions?.();
    offQuestions = null;
    for (const unregister of [...unregisters]) unregister();
    const made = loaded ?? (loading ? await loading.catch(() => null) : null);
    await made?.dispose();
    await Promise.all([...adoptions]);
  };
}
