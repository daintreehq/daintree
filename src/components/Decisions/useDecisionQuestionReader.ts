import { useCallback, useEffect, useRef, useState } from "react";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsSwitch } from "@/hooks/useDecisionsOn";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsImageReviewStore } from "@/store/decisionsImageReviewStore";
import type {
  DecisionQuestionContent,
  DecisionQuestionContentResult,
} from "@shared/types/decisionsQuestion";
import {
  useAnswerComposerMode,
  useAnswerInFlight,
  type AnswerComposerMode,
} from "./DecisionAnswerComposer";
import type { DecisionCancelTarget } from "./decisionCancelModel";
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
    const now = JSON.stringify(item ?? null);
    if (now === last) return;
    last = now;
    moved();
  });
}

/** Whether the question still waits for an answer, and so can be withdrawn. */
export function isWaiting(status: DecisionQuestionContent["status"]): boolean {
  return status === "queued" || status === "open";
}

/**
 * What a surface showing Decisions questions owes the switch: closed at once
 * when Decisions turns off, a record of which images were seen dropped
 * whenever it isn't known to be on, and drafts and answers dropped only once
 * it is known to be off, so one being followed isn't forgotten while main is
 * still saying whether it is on. Opened before main has answered, it waits.
 */
export function useDecisionsReaderRetention(isOpen: boolean, close: () => void): void {
  const decisionsSwitch = useDecisionsSwitch();
  const clearReviews = useDecisionsImageReviewStore((state) => state.clear);
  const clearAnswers = useDecisionsAnswerStore((state) => state.clear);
  const on = decisionsSwitch === "on";

  useEffect(() => {
    if (decisionsSwitch === "off" && isOpen) close();
  }, [decisionsSwitch, isOpen, close]);

  useEffect(() => {
    if (!on) clearReviews();
  }, [on, clearReviews]);

  useEffect(() => {
    if (decisionsSwitch === "off") clearAnswers();
  }, [decisionsSwitch, clearAnswers]);
}

export interface DecisionQuestionReader {
  /** The read for the target shown now; null until one lands. */
  current: QuestionRead | null;
  /** `current` as it was tagged: a new one for every read that lands for the target shown. */
  shownRead: TaggedRead | null;
  /** `current`'s question, once it was read. */
  question: DecisionQuestionContent | null;
  /** `q-42`, once the question was read. */
  alias: string | null;
  showSkeleton: boolean;
  answerMode: AnswerComposerMode;
  /** Still waiting for an answer, and none from here on its way: it can be withdrawn. */
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
  const answerMode = useAnswerComposerMode(question);
  const answering = useAnswerInFlight(question) || answerMode === "progress";
  // Bound to the question the composer was shown for, and stable: its effects call it.
  const reread = useCallback(() => readAgain(target), [readAgain, target]);
  const release = useCallback(() => setTagged(null), []);

  return {
    current,
    shownRead,
    question,
    alias: question !== null ? aliasLabel(question.alias) : null,
    showSkeleton,
    answerMode,
    // Not while an answer from here is on its way: one or the other would be turned away.
    cancellable: question !== null && target !== null && isWaiting(question.status) && !answering,
    reread,
    readAgain,
    release,
  };
}

export interface QuestionCancel {
  /** Asks about withdrawing the question shown now. */
  ask: () => void;
  /** Forgets the question asked about: the surface has finished closing. */
  release: () => void;
  /** Rises with every release; key the surface's `DecisionCancelDialog` on it so its read goes too. */
  generation: number;
  /** For the surface's `DecisionCancelDialog`, beside `restoreFocusTo`. */
  dialog: {
    target: DecisionCancelTarget | null;
    isOpen: boolean;
    waiting: boolean;
    queued: boolean;
    onClose: () => void;
    onCancelling: () => void;
  };
}

/**
 * The confirmation before a question shown in a reader is withdrawn. It
 * belongs to the question it was asked about: it ends with the surface, or
 * once the surface moves to another question, and neither brings it back.
 */
export function useQuestionCancel(
  target: DecisionQuestionTarget | null,
  reader: DecisionQuestionReader,
  isOpen: boolean
): QuestionCancel {
  const [cancel, setCancel] = useState<{ target: DecisionCancelTarget; open: boolean } | null>(
    null
  );
  const [generation, setGeneration] = useState(0);
  const key = target !== null ? targetKey(target) : null;
  // The withdrawal asked about, while this surface still shows that question.
  const cancelShown = cancel !== null && key === targetKey(cancel.target.question);
  const status = cancelShown && reader.question !== null ? reader.question.status : null;
  if (cancel !== null && cancel.open && (!isOpen || !cancelShown)) {
    setCancel({ ...cancel, open: false });
  }
  const { question } = reader;
  return {
    ask: () => {
      if (question === null || target === null) return;
      setCancel({
        target: { question: target, label: aliasLabel(question.alias), line: null },
        open: true,
      });
    },
    release: () => {
      setCancel(null);
      setGeneration((n) => n + 1);
    },
    generation,
    dialog: {
      target: cancel?.target ?? null,
      isOpen: isOpen && cancelShown && cancel.open,
      waiting: status !== null && isWaiting(status),
      queued: status === "queued",
      onClose: () => setCancel((asked) => (asked === null ? null : { ...asked, open: false })),
      // Read again now rather than at the next change: it shows withdrawn once the relay confirms.
      onCancelling: () => reader.readAgain(cancel?.target.question ?? null),
    },
  };
}
