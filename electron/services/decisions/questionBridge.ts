import {
  BridgeError,
  DecisionsBridge,
  paneIdentityOf,
  type DecisionView,
  type AnswerQuestionInput,
  type DeclineQuestionInput,
  type InvolvementView,
  type OwnerAnswerResult,
  type OwnerDeclineResult,
  type PaneIdentity,
  type PostMessageResult,
  type QuestionOrigin,
  type QuestionRow,
  type RegisterResult,
} from "@daintreehq/decisions-client";
import type {
  AnswerDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerOutcome,
  DecisionAnswerResultRead,
  DecisionDeclineOutcome,
  DecisionDeclineResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionCancelRefusal,
  DecisionQuestionCancelResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionReference,
} from "../../../shared/types/decisionsQuestion.js";
import { inScope, type QuestionReadScope } from "./questionContent.js";
import type { QuestionSource } from "./relayConnection.js";
import { RetiredAttemptError, holdingTerminalSink } from "./relayTransport.js";

/** The question a follow-up names, if it names one; the library refuses the rest. */
function questionIdOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const id = (input as { question_id?: unknown }).question_id;
  return typeof id === "string" ? id : null;
}

/**
 * Why a person can't withdraw a question in this state; null while it still
 * waits (queued or open), or is already withdrawn.
 */
function cancelRefusal(status: QuestionRow["local_status"]): DecisionQuestionCancelRefusal | null {
  switch (status) {
    case "queued":
    case "open":
    case "cancelled":
      return null;
    // The relay would take a cancel of the model's answer, but that answer is already the agent's to read.
    case "human-answered":
    case "proxy-answered":
      return "answered";
    case "expired":
      return "expired";
    case "publish-failed":
      return "publish-failed";
  }
}

/** The library's outcome, without the ids the result carries alongside it. */
function answerOutcome(result: OwnerAnswerResult): DecisionAnswerOutcome {
  switch (result.status) {
    case "closed":
      return { status: "closed", reason: result.reason };
    case "unsupported":
      return { status: "unsupported", by: result.by };
    case "rejected":
      return { status: "rejected", code: result.code };
    default:
      return { status: result.status };
  }
}

/** The library's outcome of a decline, without the ids the result carries alongside it. */
function declineOutcome(result: OwnerDeclineResult): DecisionDeclineOutcome {
  switch (result.status) {
    case "closed":
      return { status: "closed", reason: result.reason };
    case "unsupported":
      return { status: "unsupported", by: result.by };
    case "rejected":
      return { status: "rejected", code: result.code };
    default:
      return { status: result.status };
  }
}

export interface QuestionBridgeOptions {
  source: QuestionSource;
  /**
   * Whether `pane` is still exactly the run its request was let in as. Asked
   * again at each call: the handler authenticates before it reads the body,
   * and a pane revoked or relaunched since then must not ask, read, cancel or post.
   */
  isCurrent(pane: PaneIdentity): boolean;
}

/**
 * The bridge the MCP handler is given (#16011). Relay attempts each get a
 * bridge of their own and there is none between them, but a question must be
 * askable then too: it is committed locally and published once an attempt is
 * live. So each call goes to the live attempt's bridge when there is one, and
 * otherwise to this bridge itself, which is stopped before it is used and so
 * never pumps, publishes, receives or delivers: it only writes to and reads
 * from the lifetime's store, under the identity the attempts last held.
 *
 * Asks run one at a time. The library counts a pane's open questions and
 * then commits in separate steps, so two asks at once could both pass the
 * limit.
 */
export class QuestionBridge extends DecisionsBridge {
  private readonly question: QuestionBridgeOptions;
  private asks: Promise<unknown> = Promise.resolve();
  private posts: Promise<unknown> = Promise.resolve();

  constructor(options: QuestionBridgeOptions) {
    const identity = options.source.identity();
    if (identity === null) throw new Error("The relay connection has ended");
    const attachments = options.source.attachments;
    super({
      identity,
      store: options.source.store,
      policy: options.source.policy,
      sink: holdingTerminalSink,
      pumpIntervalMs: 0,
      ...(attachments ? { resolver: attachments.resolver, spool: attachments.spool } : {}),
    });
    this.question = options;
    // The library reserves, settles and reads a person's answer under its
    // bridge's lock: what this bridge commits between attempts takes its turn
    // with a live attempt's flush, never beside it.
    if (options.source.lock) this.ctx.lock = options.source.lock;
    // Synchronous for a bridge that never started; from here `pump` does nothing.
    void super.stop();
  }

  override registerQuestion(args: {
    origin: QuestionOrigin;
    input: unknown;
  }): Promise<RegisterResult> {
    const ask = (): Promise<RegisterResult> => {
      const live = this.admit(paneIdentityOf(args.origin));
      return live ? live.registerQuestion(args) : super.registerQuestion(args);
    };
    const attachments = this.question.source.attachments;
    // The lifetime's gate also holds the asks of a route this one replaced, and its spool sweeps.
    const run = this.asks.then(() => (attachments ? attachments.register(ask) : ask()));
    this.asks = run.catch(() => {});
    return run;
  }

  override async getDecision(questionId: string, pane?: PaneIdentity): Promise<DecisionView> {
    const live = this.admit(pane);
    const asker = await this.askerOf(questionId, pane!);
    return live ? live.getDecision(questionId, asker) : super.getDecision(questionId, asker);
  }

  override async cancelQuestion(questionId: string, pane?: PaneIdentity): Promise<void> {
    const live = this.admit(pane);
    const asker = await this.askerOf(questionId, pane!);
    if (live === null) return super.cancelQuestion(questionId, asker);
    // The library checks the question is this pane's before anything is touched.
    await live.getDecision(questionId, asker);
    await this.keepCreate(questionId);
    return live.cancelQuestion(questionId, asker);
  }

  /**
   * A person withdrawing a question from Daintree's own view of its pane
   * (#17099), never reachable from an agent. The view's scope stands in for
   * the asker: the question must be one that pane asked on this machine, in
   * the view's project, and still waiting. Unlike an agent's cancel, the run
   * that asked needn't be current, since a person may withdraw a question
   * after its agent exited or was relaunched. It goes the way an agent's
   * cancel does from there, in turn with posts, so a follow-up committed for
   * the question never interleaves with it.
   */
  cancelForPerson(
    questionId: string,
    scope: QuestionReadScope
  ): Promise<DecisionQuestionCancelResult> {
    const cancel = async (): Promise<DecisionQuestionCancelResult> => {
      const store = this.question.source.store;
      const row = await store.getQuestion(questionId);
      if (row === null || row.history_only || !inScope(row, scope)) {
        return { result: "refused", reason: "not-found" };
      }
      if (row.local_status === "cancelled") return { result: "cancelled" };
      const refusal = cancelRefusal(row.local_status);
      if (refusal !== null) return { result: "refused", reason: refusal };
      const live = this.connected();
      if (live === null) {
        await super.cancelQuestion(questionId);
      } else {
        await this.keepCreate(questionId);
        await live.cancelQuestion(questionId);
      }
      // What the store records once the request is in: dropped here, or a
      // relay's confirmation that already landed, reads as cancelled.
      const status = (await store.getQuestion(questionId))?.local_status ?? null;
      await this.ctx.audit.log({
        event: "question.cancel-requested",
        question_id: questionId,
        requirement: row.requirement,
        result: "person",
        detail: { status },
      });
      return { result: status === "cancelled" ? "cancelled" : "cancelling" };
    };
    const run = this.posts.then(cancel);
    this.posts = run.catch(() => {});
    return run;
  }

  /**
   * Never for an agent: the bridge agents ask on can't sign the person's
   * answer, whatever reaches it. The person's own answer goes through
   * `answerForPerson`, from Daintree's view (#17101).
   */
  override answerQuestion(_input: AnswerQuestionInput): Promise<OwnerAnswerResult> {
    return Promise.reject(new BridgeError("forbidden", "an agent can't answer for the person"));
  }

  override getAnswerResult(_answerId: string): Promise<OwnerAnswerResult | null> {
    return Promise.reject(new BridgeError("forbidden", "an agent can't read the person's answers"));
  }

  /** Never for an agent either: the person's decline goes through `declineForPerson` (#17239). */
  override declineQuestion(_input: DeclineQuestionInput): Promise<OwnerDeclineResult> {
    return Promise.reject(new BridgeError("forbidden", "an agent can't decline for the person"));
  }

  override getDeclineResult(_declineId: string): Promise<OwnerDeclineResult | null> {
    return Promise.reject(
      new BridgeError("forbidden", "an agent can't read the person's declines")
    );
  }

  /**
   * The person's answer from Daintree's own view on the owner computer
   * (#17101), never reachable from an agent, signed with this computer's key
   * and published through the outbox. A question this computer holds must be
   * the one the reference names: asked here, in that project and terminal.
   * One it doesn't hold is a Remote Host's, named by the content the Host
   * served the view, and is answered without a local copy: the relay holds
   * it to its own record of the question, and the Host checks what it is
   * sent. A reference naming this computer for a question it doesn't hold
   * names nothing. Answered on the live attempt when there is one, so it is
   * sent at once; between attempts it is committed here and the next
   * attempt sends it.
   */
  async answerForPerson(
    payload: AnswerDecisionQuestionPayload,
    hostId: string | null
  ): Promise<DecisionQuestionAnswerResult> {
    const refusal = await this.personRefusal(payload.reference, hostId);
    if (refusal !== null) return refusal;
    const { reference } = payload;
    const input: AnswerQuestionInput = {
      questionId: reference.questionId,
      expectedRevision: payload.expectedRevision,
      selectedOptionIds: payload.selectedOptionIds,
      reviewedAttachmentDigests: payload.reviewedAttachmentDigests,
      answerId: payload.answerId,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.explicitApproval !== undefined
        ? { explicitApproval: payload.explicitApproval }
        : {}),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    };
    try {
      const result = await this.signForPerson(input);
      return { result: "submitted", answerId: result.answerId, outcome: answerOutcome(result) };
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      switch (error.code) {
        case "validation_error":
          return { result: "refused", reason: "invalid", detail: error.message };
        case "invalid_state":
          return { result: "refused", reason: "unreadable" };
        // Revoked, or the connection ended, after the role was read.
        case "forbidden":
          return { result: "not-running" };
        default:
          throw error;
      }
    }
  }

  /**
   * The person's decline from Daintree's own view on the owner computer
   * (#17239), never reachable from an agent: a cancel signed with this
   * computer's key as the person's decline, which the asking computer files
   * as it would a phone's Dismiss and tells a listening agent about. The
   * question is named and checked as an answer's is, so a Remote Host's
   * question is declined by the content the Host served, without a local
   * copy. On the live attempt when there is one; between attempts it is
   * committed here and the next attempt sends it.
   */
  async declineForPerson(
    payload: DeclineDecisionQuestionPayload,
    hostId: string | null
  ): Promise<DecisionQuestionDeclineResult> {
    const refusal = await this.personRefusal(payload.reference, hostId);
    if (refusal !== null) return refusal;
    try {
      const result = await this.declineOnce({
        questionId: payload.reference.questionId,
        expectedRevision: payload.expectedRevision,
        declineId: payload.declineId,
      });
      return { result: "submitted", declineId: result.declineId, outcome: declineOutcome(result) };
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      switch (error.code) {
        case "validation_error":
          return { result: "refused", reason: "invalid", detail: error.message };
        // Revoked, or the connection ended, after the role was read.
        case "forbidden":
          return { result: "not-running" };
        default:
          throw error;
      }
    }
  }

  /** Where the person's decline stands, by the id it was submitted with (#17239). */
  async declineResultForPerson(declineId: string): Promise<DecisionDeclineResultRead> {
    let result: OwnerDeclineResult | null;
    try {
      result = await this.readDeclineOnce(declineId);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "forbidden") {
        return { result: "not-running" };
      }
      throw error;
    }
    if (result === null) return { result: "not-found" };
    return {
      result: "read",
      questionId: result.questionId,
      expectedRevision: result.expectedRevision,
      outcome: declineOutcome(result),
    };
  }

  /** Where the person's answer stands, by the id it was submitted with (#17101). */
  async answerResultForPerson(answerId: string): Promise<DecisionAnswerResultRead> {
    let result: OwnerAnswerResult | null;
    try {
      result = await this.readForPerson(answerId);
    } catch (error) {
      if (error instanceof BridgeError && error.code === "forbidden") {
        return { result: "not-running" };
      }
      throw error;
    }
    if (result === null) return { result: "not-found" };
    return {
      result: "read",
      questionId: result.questionId,
      expectedRevision: result.expectedRevision,
      outcome: answerOutcome(result),
    };
  }

  /**
   * On the live attempt, or committed here between attempts. The answer id
   * makes a second try the same answer, so one an attempt retired partway
   * through goes again to whichever bridge answers now.
   */
  private async signForPerson(input: AnswerQuestionInput): Promise<OwnerAnswerResult> {
    const live = this.connected();
    if (live === null) return super.answerQuestion(input);
    try {
      return await live.answerQuestion(input);
    } catch (error) {
      if (!(error instanceof RetiredAttemptError)) throw error;
      return this.signForPerson(input);
    }
  }

  private async readForPerson(answerId: string): Promise<OwnerAnswerResult | null> {
    const live = this.connected();
    if (live === null) return super.getAnswerResult(answerId);
    try {
      return await live.getAnswerResult(answerId);
    } catch (error) {
      if (!(error instanceof RetiredAttemptError)) throw error;
      return this.readForPerson(answerId);
    }
  }

  private async declineOnce(input: DeclineQuestionInput): Promise<OwnerDeclineResult> {
    const live = this.connected();
    if (live === null) return super.declineQuestion(input);
    try {
      return await live.declineQuestion(input);
    } catch (error) {
      if (!(error instanceof RetiredAttemptError)) throw error;
      return this.declineOnce(input);
    }
  }

  private async readDeclineOnce(declineId: string): Promise<OwnerDeclineResult | null> {
    const live = this.connected();
    if (live === null) return super.getDeclineResult(declineId);
    try {
      return await live.getDeclineResult(declineId);
    } catch (error) {
      if (!(error instanceof RetiredAttemptError)) throw error;
      return this.readDeclineOnce(declineId);
    }
  }

  /**
   * Why the person's answer or decline naming `reference` can't be signed
   * here, or null when it can: only the owner computer signs for the person.
   * A question this computer holds must be the one the reference names:
   * asked here, in that project and terminal. One it doesn't hold is a Remote
   * Host's, named by the content the Host served the view; a reference naming
   * this computer for a question it doesn't hold names nothing.
   */
  private async personRefusal(
    reference: DecisionQuestionReference,
    hostId: string | null
  ): Promise<
    { result: "not-running" } | { result: "refused"; reason: "not-found" | "not-owner" } | null
  > {
    const identity = this.question.source.identity();
    if (identity === null) return { result: "not-running" };
    if (identity.role !== "owner-desktop") return { result: "refused", reason: "not-owner" };
    const row = await this.question.source.store.getQuestion(reference.questionId);
    if (row !== null && !row.history_only) {
      const scope = { hostId, projectId: reference.projectId, terminalId: reference.terminalId };
      if (reference.hostId !== hostId || !inScope(row, scope)) {
        return { result: "refused", reason: "not-found" };
      }
    } else if (hostId === null || reference.hostId === hostId) {
      return { result: "refused", reason: "not-found" };
    }
    return null;
  }

  /**
   * An agent's follow-up (#16232) goes the way an ask does: to the live
   * attempt, or committed here between attempts, sealed and signed, for the
   * next one to publish after its question. Posts run one at a time: each
   * bridge reserves a question's message count and order under its own lock,
   * and a post committed here could otherwise race one on an attempt that has
   * just gone live. A person's cancel takes its turn with them.
   */
  override postMessage(input: unknown, pane: PaneIdentity): Promise<PostMessageResult> {
    const post = async (): Promise<PostMessageResult> => {
      this.admit(pane);
      const questionId = questionIdOf(input);
      const asker = questionId === null ? pane : await this.askerOf(questionId, pane);
      // Admitted again: an attempt may have gone live or retired while the asker was read.
      const live = this.admit(pane);
      return live ? live.postMessage(input, asker) : super.postMessage(input, asker);
    };
    const run = this.posts.then(post);
    this.posts = run.catch(() => {});
    return run;
  }

  /**
   * `get_involvement` (#17228). The live attempt holds the reads that keep
   * the preference fresh: it reads it as it starts and goes live, and again
   * on each change hint a phone's update sends. So it answers while there is
   * one. Between attempts this bridge answers from the same verified copy,
   * which its own never-started sync can't call fresh: the library's stale
   * preference, or its unavailable result when none was ever read. The
   * handler names no pane, and the preference isn't any pane's. An attempt
   * retired partway through a read has its store refused, so the read goes
   * again to whichever bridge answers now.
   */
  override async getInvolvement(): Promise<InvolvementView> {
    const live = this.connected();
    if (live === null) return super.getInvolvement();
    try {
      return await live.getInvolvement();
    } catch (error) {
      if (!(error instanceof RetiredAttemptError)) throw error;
      return this.getInvolvement();
    }
  }

  override async listPending(pane?: PaneIdentity): Promise<DecisionView[]> {
    const live = this.admit(pane);
    return live ? live.listPending(pane) : super.listPending(pane);
  }

  /**
   * `pane` as the question's asker is matched. The library compares the agent
   * session exactly, but a session learned since the question was asked is
   * that same run's (as delivery takes it, `decisionWake.ts`), so a question
   * asked with none is matched with none.
   */
  private async askerOf(questionId: string, pane: PaneIdentity): Promise<PaneIdentity> {
    if (pane.agent_session_id === null) return pane;
    const row = await this.question.source.store.getQuestion(questionId);
    return row?.origin.agent_session_id === null ? { ...pane, agent_session_id: null } : pane;
  }

  /**
   * A live attempt's flush may already hold this question's create in hand,
   * and would send it even after the library's cancel drops it as never
   * published, bringing the question back. So a cancel while an attempt runs
   * keeps the create, marked as possibly published, and the library queues a
   * real cancel to follow it. The mark is set in place: a flush uploading the
   * question's attachments rewrites the create as it goes, and a copy read
   * here and written back would undo its progress, or put back a create it
   * had just finished. The store keeps the mark across those rewrites.
   */
  private async keepCreate(questionId: string): Promise<void> {
    const store = this.question.source.store;
    if (store.markCreateMaybePublished) {
      await store.markCreateMaybePublished(questionId);
      return;
    }
    const create = (await store.outboxFor(questionId)).find((item) => item.kind === "create");
    const payload = create?.payload;
    if (create === undefined || typeof payload !== "object" || payload === null) return;
    if ((payload as { maybePublished?: unknown }).maybePublished === true) return;
    await store.putOutbox({ ...create, payload: { ...payload, maybePublished: true } });
  }

  /**
   * Throws unless `pane` may still use Decisions; returns the live attempt's
   * bridge to run the call on, or null to run it here, on the current identity.
   */
  private admit(pane: PaneIdentity | undefined): DecisionsBridge | null {
    // Without a pane the library would skip its ownership check.
    if (pane === undefined) throw new BridgeError("not_found", "unknown question");
    if (!this.question.isCurrent(pane)) {
      throw new BridgeError("forbidden", "this terminal's Decisions access has ended");
    }
    return this.connected();
  }

  /**
   * The live attempt's bridge to run a call on, or null to run it here, on
   * the current identity. Throws once the connection has ended.
   */
  private connected(): DecisionsBridge | null {
    const identity = this.question.source.identity();
    if (identity === null) {
      throw new BridgeError("forbidden", "Decisions isn't connected to its relay");
    }
    const live = this.question.source.live();
    if (live === null) this.ctx.identity = identity;
    return live;
  }
}
