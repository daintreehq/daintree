import type { DecisionsStatus, PaneDecisionState } from "@shared/types/decisions";
import type {
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import type {
  DecisionQuestionCancelResult,
  DecisionQuestionContentResult,
  DecisionQuestionImagePart,
  DecisionQuestionImagePartResult,
  DecisionQuestionImageResult,
  DecisionQuestionList,
  DecisionQuestionReference,
  DecisionQuestionSummariesResult,
} from "@shared/types/decisionsQuestion";

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
   * can't roll it back. A read that fails calls nothing. The returned
   * function stops it, read included.
   */
  watchStatus: (onStatus: (status: DecisionsStatus) => void): (() => void) => {
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
    window.electron.decisions.getStatus().then(accept, () => {});
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

  /** Sends the answer to the pane the person confirmed; recorded in the audit trail. */
  reassignAnswer: (questionId: string, terminalId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.reassignAnswer({ questionId, terminalId }),

  /** The person dealt with it: it leaves the list and is never typed in. */
  markAnswerHandled: (questionId: string): Promise<DecisionsAnswerOutcome> =>
    window.electron.decisions.markAnswerHandled({ questionId }),

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

  /** Every change to that list, with the new list. */
  onQuestionsChanged: (callback: (list: DecisionQuestionList) => void): (() => void) =>
    window.electron.events.on("decisions:questions-changed", callback),

  /**
   * That list from now on: subscribes before reading, and keeps whichever
   * carries the higher revision, so a read that lands after a push can't roll
   * it back. A read that fails calls nothing. The returned function stops it,
   * read included.
   */
  watchQuestions: (onList: (list: DecisionQuestionList) => void): (() => void) => {
    let latest = -1;
    let stopped = false;
    const accept = (list: DecisionQuestionList) => {
      if (stopped || list.revision <= latest) return;
      latest = list.revision;
      onList(list);
    };
    const off = window.electron.events.on("decisions:questions-changed", accept);
    window.electron.decisions.listQuestions().then(accept, () => {});
    return () => {
      stopped = true;
      off();
    };
  },

  /**
   * Main asking this window to open one question in its question view: a
   * click on the question's desktop notification (#17232).
   */
  onOpenQuestion: (callback: (reference: DecisionQuestionReference) => void): (() => void) =>
    window.electron.events.on("decisions:open-question", ({ reference }) => callback(reference)),

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
