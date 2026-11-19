import { useCallback, useEffect, useRef, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsSwitch } from "@/hooks/useDecisionsOn";
import {
  answerKey,
  isInFlight,
  useAnswerRecord,
  useDecisionsAnswerStore,
  type DeclinePhase,
} from "@/store/decisionsAnswerStore";
import { useDecisionsFollowUpStore } from "@/store/decisionsFollowUpStore";
import { useDecisionsImageReviewStore } from "@/store/decisionsImageReviewStore";
import type {
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionQuestionReference,
} from "@shared/types/decisionsQuestion";
import { useAnswerComposerMode, type AnswerComposerMode } from "./DecisionAnswerComposer";
import {
  dismissFallback,
  dismissOutcomeText,
  dismissProgressText,
  type DecisionCancelMode,
  type DecisionCancelTarget,
} from "./decisionCancelModel";
import { followDecline } from "./decisionDeclineSend";
import { aliasLabel } from "./decisionQuestionModel";
import {
  readTargetContent,
  targetKey,
  type DecisionQuestionTarget,
} from "./decisionQuestionTarget";

/** While shown, how often the question is read again for follow-ups the pane's state doesn't show. */
const REREAD_MS = 15_000;

/**
 * How long a read may stay out before one more starts beside it. No deadline
 * on the way to main or a Remote Host guarantees a read settles, and one that
 * never did would otherwise hold every later read back. Never more than one
 * beside it, so reads that never settle can't pile up.
 */
const STALL_MS = 60_000;

export type QuestionRead = DecisionQuestionContentResult | { result: "failed" };

/** One read, tagged with what it was for, so a late answer never shows under another question. */
export interface TaggedRead {
  key: string;
  read: QuestionRead;
}

/**
 * Be told whenever the question may have moved: its pane's state, for one of
 * a pane's; its place in this computer's list, for one opened by reference.
 */
function onQuestionMoved(target: DecisionQuestionTarget, moved: () => void): () => void {
  if (target.scope === "pane") {
    return decisionsClient.onPaneState((state) => {
      if (state.terminalId === target.terminalId) moved();
    });
  }
  const key = targetKey(target);
  let last: string | undefined;
  return decisionsClient.onQuestionsChanged((list) => {
    const item = list.questions.find(
      (question) => targetKey({ scope: "reference", reference: question.reference }) === key
    );
    // The person's marks (#17895) move nothing that is read; a new ask does.
    const now = JSON.stringify(item === undefined ? null : { ...item, inbox: item.inbox?.ask });
    if (now === last) return;
    last = now;
    moved();
  });
}

/** Whether the question still waits for an answer, and so can be dismissed or withdrawn. */
export function isWaiting(status: DecisionQuestionContent["status"]): boolean {
  return status === "queued" || status === "open";
}

/**
 * What a surface showing Decisions questions owes the switch: closed at once
 * when Decisions turns off, a record of which images were seen dropped
 * whenever it isn't known to be on, and drafts, answers and follow-ups
 * dropped only once it is known to be off, so one being followed isn't
 * forgotten while main is still saying whether it is on. Opened before main
 * has answered, it waits.
 */
export function useDecisionsReaderRetention(isOpen: boolean, close: () => void): void {
  const decisionsSwitch = useDecisionsSwitch();
  const clearReviews = useDecisionsImageReviewStore((state) => state.clear);
  const clearAnswers = useDecisionsAnswerStore((state) => state.clear);
  const clearFollowUps = useDecisionsFollowUpStore((state) => state.clear);
  const on = decisionsSwitch === "on";

  useEffect(() => {
    if (decisionsSwitch === "off" && isOpen) close();
  }, [decisionsSwitch, isOpen, close]);

  useEffect(() => {
    if (!on) clearReviews();
  }, [on, clearReviews]);

  useEffect(() => {
    if (decisionsSwitch === "off") {
      clearAnswers();
      clearFollowUps();
    }
  }, [decisionsSwitch, clearAnswers, clearFollowUps]);
}

/**
 * The question a dismissal from here names, and the revision it is signed
 * against: as read now, or, for a Remote Host's question while its Host is
 * away, as this computer last read it open (#17946), with when.
 */
export interface DismissalSubject {
  reference: DecisionQuestionReference;
  revision: number;
  alias: number;
  status: DecisionQuestionContent["status"];
  /** When it was last read (epoch ms) while its Host is away; null when read just now. */
  lastReadAt: number | null;
}

export interface DecisionQuestionReader {
  /** The read for the target shown now; null until one lands. */
  current: QuestionRead | null;
  /** `current` as it was tagged: a new one for every read that lands for the target shown. */
  shownRead: TaggedRead | null;
  /** `current`'s question, once it was read. */
  question: DecisionQuestionContent | null;
  /** What a dismissal from here would name: `question`, or what was last read of it. */
  subject: DismissalSubject | null;
  /** `q-42`, once the question was read, or last read while its Host is away. */
  alias: string | null;
  showSkeleton: boolean;
  answerMode: AnswerComposerMode;
  /** Still waiting for an answer, and none from here on its way: it can be dismissed or withdrawn. */
  cancellable: boolean;
  /**
   * Read the question shown again now, or once more after the read still out.
   * Bound to that question and stable while it's shown: a late call once
   * another is shown goes nowhere.
   */
  reread: () => void;
  /** As `reread`, for a question named after an await: only while it's still the one shown. */
  readAgain: (question: DecisionQuestionTarget | null) => void;
  /** Lets go of the question's words: the surface has finished closing. */
  release: () => void;
}

/**
 * One Decisions question, read on demand while `open` and Decisions is on
 * (#17098): on opening, whenever the question moves, and every few seconds
 * for follow-ups. One read is out at a time; only the newest read to land
 * for the target shown may paint. Content is held in memory only, and
 * `release` drops it.
 */
export function useDecisionQuestionReader(
  target: DecisionQuestionTarget | null,
  open: boolean
): DecisionQuestionReader {
  const on = useDecisionsSwitch() === "on";
  const [tagged, setTagged] = useState<TaggedRead | null>(null);
  /** The shown question's reads: read it again now, or once more after the read still out. */
  const readsRef = useRef<{ key: string; read: () => void } | null>(null);
  const key = target !== null ? targetKey(target) : null;

  useEffect(() => {
    if (!open || !on || target === null) return;
    const thisKey = targetKey(target);
    let live = true;
    // One read at a time (#17564): a newer one started over a slow read would
    // discard it, and on a link slower than the poll none would ever paint.
    // What moves while it's out is read once after it lands.
    let started = 0;
    let shown = 0;
    let out = 0;
    let reading = false;
    let again = false;
    // The newest read is past its stall deadline, but one given up on is still out.
    let overdue = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      // A listener the event bus had already snapshotted can still call in after cleanup.
      if (!live) return;
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      again = false;
      overdue = false;
      clearTimeout(poll);
      started += 1;
      out += 1;
      const seq = started;
      stall = setTimeout(() => {
        if (out > 1) overdue = true;
        else giveUp();
      }, STALL_MS);
      const settle = (result: QuestionRead) => {
        if (!live) return;
        out -= 1;
        // A read given up on still paints if nothing newer has.
        if (seq > shown) {
          shown = seq;
          setTagged({ key: thisKey, read: result });
        }
        if (seq !== started) {
          if (overdue) giveUp();
          return;
        }
        clearTimeout(stall);
        overdue = false;
        reading = false;
        if (again) read();
        // A follow-up can change the thread without moving the pane's state.
        else poll = setTimeout(read, REREAD_MS);
      };
      readTargetContent(target).then(settle, () =>
        // Never the error itself: it could carry what the question says.
        settle({ result: "failed" })
      );
    };
    // Stop waiting on the newest read and start one more beside it.
    const giveUp = () => {
      reading = false;
      read();
    };
    read();
    // An answer or its delivery moves the question; read again so the thread keeps up.
    const off = onQuestionMoved(target, read);
    readsRef.current = { key: thisKey, read };
    return () => {
      live = false;
      off();
      clearTimeout(poll);
      clearTimeout(stall);
      readsRef.current = null;
    };
  }, [open, on, target]);

  const shownRead = tagged !== null && tagged.key === key ? tagged : null;
  const current = shownRead?.read ?? null;
  // Only while it's still the question shown: a withdrawal or an answer settles after an await.
  const readAgain = useCallback((question: DecisionQuestionTarget | null) => {
    const reads = readsRef.current;
    if (reads !== null && question !== null && reads.key === targetKey(question)) reads.read();
  }, []);
  const showSkeleton = useSkeletonGate(open && current === null);
  const question = current?.result === "read" ? current.question : null;
  // A Host away: what was last read of its question open, by the reference that read it.
  const lastRead =
    current?.result === "host-not-connected" &&
    current.lastRead?.result === "read" &&
    target?.scope === "reference"
      ? { reference: target.reference, ...current.lastRead }
      : null;
  const subject: DismissalSubject | null =
    question !== null
      ? {
          reference: question.reference,
          revision: question.revision,
          alias: question.alias,
          status: question.status,
          lastReadAt: null,
        }
      : lastRead !== null
        ? {
            reference: lastRead.reference,
            revision: lastRead.revision,
            alias: lastRead.alias,
            status: "open",
            lastReadAt: lastRead.readAt,
          }
        : null;
  const answerMode = useAnswerComposerMode(question);
  const subjectRecord = useAnswerRecord(subject !== null ? answerKey(subject.reference) : "");
  const answering = isInFlight(subjectRecord) || answerMode === "progress";
  // Bound to the question the composer was shown for, and stable: its effects call it.
  const reread = useCallback(() => readAgain(target), [readAgain, target]);
  const release = useCallback(() => setTagged(null), []);

  return {
    current,
    shownRead,
    question,
    subject,
    alias: subject !== null ? aliasLabel(subject.alias) : null,
    showSkeleton,
    answerMode,
    // Not while an answer from here is on its way: one or the other would be turned away.
    cancellable: subject !== null && target !== null && isWaiting(subject.status) && !answering,
    reread,
    readAgain,
    release,
  };
}

/** Where the shown question's dismissal from here stands, while it still waits (#17239). */
export interface QuestionDismissal {
  /** Its phase; null when none was asked for here, or the question no longer waits. */
  phase: DeclinePhase | null;
  /** How far it has got, while under way or taken and not yet closed here. */
  progress: string | null;
  /** Why it can't be taken where withdrawing still can: withdrawing is offered instead. */
  fallback: string | null;
  /** Why one that settled without being taken wasn't, once out of the confirmation. */
  outcome: string | null;
  /** Checks again, by its id, whether a dismissal whose reply was lost was taken. */
  retry: () => void;
}

export interface QuestionCancel {
  dismissal: QuestionDismissal;
  /** Asks about dismissing the question shown now. */
  ask: () => void;
  /** Asks about withdrawing it instead, once its dismissal couldn't be taken. */
  askToWithdraw: () => void;
  /** For the surface's `DecisionCancelDialog`, beside `restoreFocusTo`. */
  dialog: {
    target: DecisionCancelTarget | null;
    isOpen: boolean;
    mode: DecisionCancelMode | undefined;
    fallback: DeclinePhase | null | undefined;
    waiting: boolean;
    queued: boolean;
    onClose: () => void;
    onCancelling: () => void;
    onDismissing: () => void;
  };
}

/**
 * The confirmation before a question shown in a reader is dismissed, or
 * withdrawn where a dismissal can't be taken, and where a dismissal from
 * here stands meanwhile. The confirmation belongs to the question it was
 * asked about: it ends with the surface, or once the surface moves to
 * another question, and neither brings it back.
 */
export function useQuestionCancel(
  target: DecisionQuestionTarget | null,
  reader: DecisionQuestionReader,
  isOpen: boolean
): QuestionCancel {
  // The dismissal or withdrawal asked about: its question, and what the confirmation asks first.
  const [cancel, setCancel] = useState<{
    target: DecisionCancelTarget;
    open: boolean;
    mode: DecisionCancelMode;
    /** The dismissal that couldn't be taken, when it asks to withdraw instead. */
    fallback: DeclinePhase | null;
  } | null>(null);
  const { subject, alias, cancellable, reread, readAgain } = reader;
  const key = target !== null ? targetKey(target) : null;
  // A Remote Host's question while its Host is away (#17946): dismissed from its last read, never withdrawn.
  const away = subject !== null && subject.lastReadAt !== null;

  const declineKey = subject !== null ? answerKey(subject.reference) : "";
  const declinePhase = useAnswerRecord(declineKey).decline?.phase ?? null;
  const shownDecline = cancellable ? declinePhase : null;
  const progress = shownDecline !== null ? dismissProgressText(shownDecline, away) : null;
  // A relay that didn't hold the question yet is no reason once it reads as sent.
  const fallback =
    shownDecline !== null && alias !== null && subject !== null
      ? dismissFallback(alias, shownDecline, subject.status, !away)
      : null;
  // One that settled without being taken, once out of the confirmation (read again on its own, or Retry).
  const outcome =
    shownDecline !== null && alias !== null && subject !== null && target !== null
      ? dismissOutcomeText(
          {
            question: target,
            label: alias,
            line: null,
            revision: subject.revision,
            lastReadAt: subject.lastReadAt,
          },
          shownDecline
        )
      : null;
  // Where the shown dismissal settled, other than queued: a queued one is read again on its own.
  const declineSettled =
    shownDecline?.kind === "settled" && shownDecline.outcome.status !== "queued"
      ? shownDecline.outcome.status
      : null;

  // Settled: read again now rather than at the next change, so it shows
  // declined once recorded, or the update a changed question brought.
  useEffect(() => {
    if (declineSettled !== null) reread();
  }, [declineSettled, reread]);

  const askFor = (mode: DecisionCancelMode, because: DeclinePhase | null) => {
    if (subject === null || target === null) return;
    setCancel({
      target: {
        question: target,
        label: aliasLabel(subject.alias),
        line: null,
        revision: subject.revision,
        lastReadAt: subject.lastReadAt,
      },
      open: true,
      mode,
      fallback: because,
    });
  };

  // The dismissal or withdrawal asked about, while this surface still shows that question.
  const cancelShown = cancel !== null && key === targetKey(cancel.target.question);
  const status = cancelShown && subject !== null ? subject.status : null;
  // A read that couldn't be made says nothing of whether it still waits: only one that found
  // it gone or settled does, so a dismissal whose standing is unknown can still be tried again.
  const waiting = status !== null ? isWaiting(status) : reader.current?.result !== "not-found";
  if (cancel !== null && cancel.open && (!isOpen || !cancelShown)) {
    setCancel({ ...cancel, open: false });
  }
  return {
    dismissal: {
      phase: shownDecline,
      progress,
      fallback,
      outcome,
      retry: () => void followDecline(declineKey, true),
    },
    ask: () => askFor("dismiss", null),
    askToWithdraw: () => askFor("withdraw", shownDecline),
    dialog: {
      target: cancel?.target ?? null,
      isOpen: isOpen && cancelShown && cancel.open,
      mode: cancel?.mode,
      fallback: cancel?.fallback,
      waiting,
      queued: status === "queued",
      onClose: () => setCancel((asked) => (asked === null ? null : { ...asked, open: false })),
      // Read again now rather than at the next change: it shows withdrawn once the relay confirms.
      onCancelling: () => readAgain(cancel?.target.question ?? null),
      onDismissing: () => readAgain(cancel?.target.question ?? null),
    },
  };
}
