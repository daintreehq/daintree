import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import type {
  AnswerDecisionQuestionPayload,
  DeclineDecisionQuestionPayload,
  DecisionAnswerResultRead,
  DecisionDeclineResultRead,
  DecisionFollowUpResultRead,
  DecisionQuestionAnswerResult,
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionDeclineResult,
  DecisionQuestionFollowUpResult,
  DecisionQuestionImagePart,
  DecisionQuestionImagePartResult,
  DecisionQuestionImageResult,
  DecisionQuestionList,
  DecisionQuestionMarkResult,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
  MarkDecisionQuestionsPayload,
  SendDecisionFollowUpPayload,
} from "@shared/types/decisionsQuestion";
import { DECISION_QUESTION_MARKS_PER_CALL } from "@shared/types/decisionsQuestion";
import type { DecisionsHostsResult } from "@shared/types/decisionsHosts";
import type {
  DecisionsInvolvementRead,
  DecisionsInvolvementSaveResult,
  SetDecisionsInvolvementPayload,
} from "@shared/types/decisionsInvolvement";

/** The protocol's largest image: a part claiming more is refused before anything is allocated. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Thrown when an image's parts don't add up to one image; never carries its bytes. */
export class DecisionImagePartsError extends Error {
  constructor() {
    super("The image's parts didn't add up to one image");
    this.name = "DecisionImagePartsError";
  }
}

/**
 * One of a question's images, read part by part with `readPart`, each part
 * from a read that checked the whole image against its digest. Stops between
 * parts once `signal` aborts, rejecting with its reason.
 */
async function readQuestionImage(
  attachmentId: string,
  readPart: (offset: number) => Promise<DecisionQuestionImagePartResult>,
  signal?: AbortSignal
): Promise<DecisionQuestionImageResult> {
  let whole: { first: DecisionQuestionImagePart; bytes: Uint8Array<ArrayBuffer> } | null = null;
  let offset = 0;
  for (;;) {
    signal?.throwIfAborted();
    const read = await readPart(offset);
    if (read.result !== "read") return read;
    const { part } = read;
    // A Remote Host's link carries whatever its peer sent: nothing is taken on trust.
    if (!(part.bytes instanceof Uint8Array) || !Number.isSafeInteger(part.size) || part.size < 1) {
      throw new DecisionImagePartsError();
    }
    const length = part.bytes.length;
    const first: DecisionQuestionImagePart = whole?.first ?? part;
    if (
      part.attachmentId !== attachmentId ||
      part.offset !== offset ||
      length === 0 ||
      part.size > MAX_IMAGE_BYTES ||
      offset + length > part.size ||
      part.size !== first.size ||
      part.sha256 !== first.sha256 ||
      part.mime !== first.mime
    ) {
      throw new DecisionImagePartsError();
    }
    if (whole === null) {
      // One part that is the whole image needs no copy.
      if (length === part.size) {
        return {
          result: "read",
          image: { attachmentId, mime: part.mime, sha256: part.sha256, bytes: part.bytes },
        };
      }
      whole = { first: part, bytes: new Uint8Array(part.size) };
    }
    whole.bytes.set(part.bytes, offset);
    offset += length;
    if (offset === part.size) {
      return {
        result: "read",
        image: { attachmentId, mime: first.mime, sha256: first.sha256, bytes: whole.bytes },
      };
    }
  }
}

/** Daintree Decisions, as main observes it. Pane state comes from the machine that owns the pane. */
export const decisionsClient = {
  getStatus: (): Promise<DecisionsStatus> => window.electron.decisions.getStatus(),

  /**
   * Decisions' status from now on: subscribes before reading, and keeps
   * whichever carries the higher revision, so a read that lands after a push
   * can't roll it back. A read that fails calls `onReadFailed`, and only while
   * no status has arrived. The returned function stops it, read included.
   */
  watchStatus: (
    onStatus: (status: DecisionsStatus) => void,
    onReadFailed?: () => void
  ): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (status: DecisionsStatus) => {
      if (stopped) return;
      const revision = status.revision ?? 0;
      if (revision < latest) return;
      latest = revision;
      onStatus(status);
    };
    const off = window.electron.events.on("decisions:status-changed", accept);
    window.electron.decisions.getStatus().then(accept, () => {
      if (!stopped && latest === -1) onReadFailed?.();
    });
    return () => {
      stopped = true;
      off();
    };
  },

  /** Every answer a person has to decide about, opened, oldest question first (#16020). */
  listAttention: (): Promise<DecisionsAttentionList> => window.electron.decisions.listAttention(),

  /** The delimited block of an answer needing attention, to paste in by hand. Rejects when there is none. */
  copyAnswer: (questionId: string): Promise<string> =>
    window.electron.decisions.copyAnswer(questionId),

  /** Reopens the agent that asked and types the answer in; resolves with what became of it. */
  resumeAnswer: (questionId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.resumeAnswer(questionId),

  /** The agents running here now that the answer could be typed into instead. */
  listAnswerDestinations: (questionId: string): Promise<DecisionsAnswerDestinations> =>
    window.electron.decisions.listAnswerDestinations(questionId),

  /**
   * Sends the answer to the destination the person confirmed, as listed:
   * refused once its pane runs another agent. Recorded in the audit trail.
   */
  reassignAnswer: (
    questionId: string,
    destination: Pick<DecisionsAnswerDestination, "terminalId" | "run">,
    expected?: string
  ): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.reassignAnswer({
      questionId,
      terminalId: destination.terminalId,
      run: destination.run,
      ...(expected !== undefined ? { expected } : {}),
    }),

  /** The person dealt with it: it leaves the list and is never typed in. */
  markAnswerHandled: (questionId: string, expected?: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.markAnswerHandled({
      questionId,
      ...(expected !== undefined ? { expected } : {}),
    }),

  /** This view's whole set of hybrid-input draft keys; an answer waits behind a draft (#16282). */
  reportComposerDrafts: (keys: string[]): Promise<void> =>
    window.electron.decisions.reportComposerDrafts(keys),

  /** A pane's current state; null while Decisions is off or the pane has nothing outstanding. */
  getPaneState: (terminalId: string): Promise<PaneDecisionState | null> =>
    window.electron.decisions.getPaneState(terminalId),

  /**
   * One of a pane's questions with its content, answers and follow-ups,
   * read from the machine that owns the pane, whatever the question's status.
   * Content is held in memory only: never log it or keep it in a persisted store.
   */
  getQuestionContent: (
    terminalId: string,
    questionId: string
  ): Promise<DecisionQuestionContentResult> =>
    window.electron.decisions.getQuestionContent({ terminalId, questionId }),

  /**
   * One of a question's images, fetched and checked against its digest on the
   * machine that owns the pane, in parts a Remote Host's link can carry. The
   * bytes are held in memory only: never write them anywhere, log them, or
   * keep them in a persisted store. Rejects with `DecisionImagePartsError`
   * when the parts don't add up, and with `signal`'s reason once it aborts.
   */
  getQuestionImage: (
    terminalId: string,
    questionId: string,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<DecisionQuestionImageResult> =>
    readQuestionImage(
      attachmentId,
      (offset) =>
        window.electron.decisions.getQuestionImage({
          terminalId,
          questionId,
          attachmentId,
          offset,
        }),
      signal
    ),

  /** The opening line of each of a pane's questions, for a list to name them by. */
  getQuestionSummaries: (
    terminalId: string,
    questionIds: string[]
  ): Promise<DecisionQuestionSummariesResult> =>
    window.electron.decisions.getQuestionSummaries({ terminalId, questionIds }),

  /**
   * Withdraws one of a pane's questions, on the machine that owns the pane:
   * dropped there when it was never sent, otherwise withdrawn on every phone
   * once the relay confirms it. Nothing is typed into the terminal.
   */
  cancelQuestion: (terminalId: string, questionId: string): Promise<DecisionQuestionCancelResult> =>
    window.electron.decisions.cancelQuestion({ terminalId, questionId }),

  /**
   * Every question this computer's Decisions holds (#17229), across its
   * projects and terminals, open or closed: ids, labels, times and where each
   * stands, never its words.
   */
  listQuestions: (): Promise<DecisionQuestionList> => window.electron.decisions.listQuestions(),

  /**
   * The Remote Hosts this computer enrolls (#16021), with those whose
   * questions its inbox lists now (#18049). Asks no Host and no relay.
   */
  listHosts: (): Promise<DecisionsHostsResult> => window.electron.decisions.listHosts(),

  /**
   * The person seeing, clearing or restoring questions on this computer
   * (#17895), each named with the ask it was shown with: recorded here only,
   * and the list changes once it is. Nothing is answered, declined or typed
   * in. More than one call takes are marked a page at a time, stopping at
   * the first page that isn't, whose result is the one returned.
   */
  markQuestions: async (
    action: MarkDecisionQuestionsPayload["action"],
    questions: MarkDecisionQuestionsPayload["questions"]
  ): Promise<DecisionQuestionMarkResult> => {
    let marked = 0;
    for (let start = 0; start < questions.length; start += DECISION_QUESTION_MARKS_PER_CALL) {
      const page = questions.slice(start, start + DECISION_QUESTION_MARKS_PER_CALL);
      const result = await window.electron.decisions.markQuestions({ action, questions: page });
      if (result.result !== "marked") return result;
      marked += result.marked;
    }
    return { result: "marked", marked };
  },

  /** Every change to that list, with the new list. */
  onQuestionsChanged: (callback: (list: DecisionQuestionList) => void): (() => void) =>
    window.electron.events.on("decisions:questions-changed", callback),

  /**
   * That list from now on: subscribes before reading, and keeps whichever
   * carries the higher revision, so a read that lands after a push can't roll
   * it back. A read that fails calls `onReadFailed`, and only while no list has
   * arrived; a later push still delivers one. The returned function stops it,
   * read included.
   */
  watchQuestions: (
    onList: (list: DecisionQuestionList) => void,
    onReadFailed?: () => void
  ): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (list: DecisionQuestionList) => {
      if (stopped || list.revision <= latest) return;
      latest = list.revision;
      onList(list);
    };
    const off = window.electron.events.on("decisions:questions-changed", accept);
    window.electron.decisions.listQuestions().then(accept, () => {
      if (!stopped && latest === -1) onReadFailed?.();
    });
    return () => {
      stopped = true;
      off();
    };
  },

  /**
   * Main asking this window to open one question in its question view: a
   * click on the question's desktop notification (#17232), or on a
   * follow-up's, which opens it at that follow-up (#17235).
   */
  onOpenQuestion: (
    callback: (reference: DecisionQuestionReference, messageId: string | undefined) => void
  ): (() => void) =>
    window.electron.events.on("decisions:open-question", ({ reference, messageId }) =>
      callback(reference, messageId)
    ),

  /**
   * Main asking this window to open the list of answers needing attention at
   * a pane's: a click on a stalled answer's desktop notification (#17235).
   */
  onOpenAttention: (callback: (terminalId: string) => void): (() => void) =>
    window.electron.events.on("decisions:open-attention", ({ terminalId }) => callback(terminalId)),

  /**
   * A question by its reference, from any window on this computer, whatever
   * project it shows and whether its terminal is still open. Content is held
   * in memory only: never log it or keep it in a persisted store.
   */
  getQuestionContentByReference: (
    reference: DecisionQuestionReference
  ): Promise<DecisionQuestionContentResult> =>
    window.electron.decisions.getQuestionContentByReference({ reference }),

  /** One of a question's images, by its reference; held as `getQuestionImage`'s are. */
  getQuestionImageByReference: (
    reference: DecisionQuestionReference,
    attachmentId: string,
    signal?: AbortSignal
  ): Promise<DecisionQuestionImageResult> =>
    readQuestionImage(
      attachmentId,
      (offset) =>
        window.electron.decisions.getQuestionImageByReference({ reference, attachmentId, offset }),
      signal
    ),

  /** The opening line of each question, by reference, for a list to name them by. */
  getQuestionSummariesByReference: (
    references: DecisionQuestionReference[]
  ): Promise<DecisionQuestionSummariesResult> =>
    window.electron.decisions.getQuestionSummariesByReference({ references }),

  /** Withdraws a question by its reference, as `cancelQuestion` does one of a pane's. */
  cancelQuestionByReference: (
    reference: DecisionQuestionReference
  ): Promise<DecisionQuestionCancelResult> =>
    window.electron.decisions.cancelQuestionByReference({ reference }),

  /**
   * The person's answer to a question (#17101), signed by this computer,
   * named by the reference and revision its content was read with. Send the
   * same `answerId` again with the same answer when a result is lost.
   */
  answerQuestion: (payload: AnswerDecisionQuestionPayload): Promise<DecisionQuestionAnswerResult> =>
    window.electron.decisions.answerQuestion(payload),

  /** Where an answer stands, by the id it was submitted with: a queued one settles later. */
  getAnswerResult: (answerId: string): Promise<DecisionAnswerResultRead> =>
    window.electron.decisions.getAnswerResult({ answerId }),

  /**
   * The person's decline of a question (#17239), signed by this computer,
   * named as an answer is. Send the same `declineId` again when a result is lost.
   */
  declineQuestion: (
    payload: DeclineDecisionQuestionPayload
  ): Promise<DecisionQuestionDeclineResult> => window.electron.decisions.declineQuestion(payload),

  /** Where a decline stands, by the id it was submitted with: a queued one settles later. */
  getDeclineResult: (declineId: string): Promise<DecisionDeclineResultRead> =>
    window.electron.decisions.getDeclineResult({ declineId }),

  /**
   * The person's follow-up on a question's thread (#17238), signed by this
   * computer, named by the reference its content was read with. Send the
   * same `messageId` again with the same text when a result is lost.
   */
  sendFollowUp: (payload: SendDecisionFollowUpPayload): Promise<DecisionQuestionFollowUpResult> =>
    window.electron.decisions.sendFollowUp(payload),

  /** Where a follow-up stands, by the id it was submitted with: a queued one settles later. */
  getFollowUpResult: (messageId: string): Promise<DecisionFollowUpResultRead> =>
    window.electron.decisions.getFollowUpResult({ messageId }),

  /**
   * The person's involvement preference (#17237), from the copy agents'
   * `get_involvement` reads on this computer. Touches no network.
   */
  getInvolvement: (): Promise<DecisionsInvolvementRead> =>
    window.electron.decisions.getInvolvement(),

  /**
   * The person's change to it, signed by this computer, replacing the
   * revision they reviewed: a newer change from a phone comes back as a
   * conflict, never overwritten.
   */
  setInvolvement: (
    payload: SetDecisionsInvolvementPayload
  ): Promise<DecisionsInvolvementSaveResult> => window.electron.decisions.setInvolvement(payload),

  /** Every pane's state changes for this project. Callers filter by `terminalId`. */
  onPaneState: (callback: (state: PaneDecisionState) => void): (() => void) =>
    window.electron.terminal.onDecisionState(callback),

  /**
   * One pane's state from mount on: subscribes before reading, so a change
   * between the two is never missed, and keeps whichever carries the higher
   * revision, so a read that lands after a push can't roll it back. `onState`
   * is called only with a state newer than the last; a read that finds
   * nothing calls nothing. The returned function stops it, read included.
   */
  watchPaneState: (
    terminalId: string,
    onState: (state: PaneDecisionState) => void
  ): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (state: PaneDecisionState | null) => {
      if (stopped || state === null || state.terminalId !== terminalId) return;
      if (state.revision <= latest) return;
      latest = state.revision;
      onState(state);
    };
    const off = window.electron.terminal.onDecisionState(accept);
    window.electron.decisions.getPaneState(terminalId).then(accept, () => {});
    return () => {
      stopped = true;
      off();
    };
  },
} as const;
