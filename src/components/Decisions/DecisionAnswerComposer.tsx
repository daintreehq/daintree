import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { KbdChord } from "@/components/ui/Kbd";
import { Textarea } from "@/components/ui/textarea";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  answerKey,
  readAnswerRecord,
  useAnswerRecord,
  useDecisionsAnswerStore,
  type AnswerRecord,
} from "@/store/decisionsAnswerStore";
import { useReviewedImages } from "@/store/decisionsImageReviewStore";
import type { DecisionQuestionContent } from "@shared/types/decisionsQuestion";
import {
  canStartAnswer,
  followAnswer,
  isCommitted,
  isDeclineCommitted,
  sendAnswer,
} from "./decisionAnswerSend";
import { attemptText, closedText, holdText, progressText } from "./decisionAnswerText";
import {
  chosenOption,
  composeShape,
  composeVerdict,
  isAnswerable,
  sendHint,
  type AnswerDraft,
  type UnshownImages,
} from "./decisionComposeModel";
import { DecisionMarkdown } from "./DecisionMarkdown";
import { questionOf, type DecisionQuestionTarget } from "./decisionQuestionTarget";
import { useDeadlineClock } from "./useDecisionsClock";

/** A place focus is sent to when what held it goes; never tabbed to. */
const FOCUS_TARGET =
  "rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary";

/** While an answer is queued, how long after one read of its standing the next starts. */
const QUEUED_READ_MS = 2_000;

const STALE_TEXT = "This question changed. Review the update before sending.";

/**
 * Said while only this computer's clock has the deadline passed (#17943): the
 * draft stays where it was written, but can't be sent, until the store says
 * how the question closed (or a reopen takes it again).
 */
const ELAPSED_TEXT =
  "The deadline has passed, so this can't be sent. Anything written here stays while Daintree waits to hear how the question closed.";

/**
 * What the view shows of the person's answer to this question:
 * - `form`: it takes an answer, and none from here is being sent or taken;
 * - `progress`: one from here is being sent or was taken;
 * - `closed`: it stopped taking answers while one was being written;
 * - `none`: nothing to show, so the question's options read as they always did,
 *   as they do while a dismissal from here is under way or was taken.
 */
export type AnswerComposerMode = "form" | "progress" | "closed" | "none";

export function answerComposerMode(
  record: AnswerRecord,
  question: DecisionQuestionContent,
  nowMs: number
): AnswerComposerMode {
  const submission = record.submission;
  if (submission !== null && isCommitted(submission.phase)) return "progress";
  // Taken already, and read back before this view knew of it.
  if (
    submission !== null &&
    question.thread.some(
      (entry) => entry.type === "answer" && entry.entryId === submission.answerId
    )
  ) {
    return "progress";
  }
  // Dismissed from here, or being dismissed: nothing to answer unless that falls through.
  if (isDeclineCommitted(record)) return "none";
  if (isAnswerable(question, nowMs)) return "form";
  const writing =
    record.draft !== null || record.hold !== null || submission !== null || record.engaged === true;
  // Only the clock says it passed (#17943): for someone who was in it, the form stays, locked,
  // rather than vanish from under them and their focus, until the store says how it closed.
  // One opened after its deadline, untouched, lists its options as a closed one does.
  if (writing && (question.status === "open" || question.status === "queued")) return "form";
  return writing ? "closed" : "none";
}

export interface DecisionAnswerComposerProps {
  question: DecisionQuestionContent;
  target: DecisionQuestionTarget;
  /** The question's images this view couldn't show: an approval can still be rejected without them. */
  unshown: UnshownImages;
  /** The question may have moved: read it again now rather than at the next change. */
  onMoved: () => void;
  /** Said beside Send once it would go, when an answer sent now won't go at once. */
  sendNote?: string | null;
  /**
   * Why nothing can take an answer now (#18029), said before one is
   * written; the form stays usable, since an answer is still recorded.
   */
  deliveryNotice?: string | null;
  /** Send started an answer; `prior` is the submission the record held before it, if any. */
  onSend?: (prior: string | null) => void;
}

/** Whether this question shows its composer rather than the plain list of its options. */
export function useAnswerComposerMode(
  question: DecisionQuestionContent | null
): AnswerComposerMode {
  const record = useAnswerRecord(question === null ? "" : answerKey(question.reference));
  const now = useDeadlineClock(question?.expiresAt ?? null);
  return question === null ? "none" : answerComposerMode(record, question, now);
}

/**
 * The person's answer to a question, given here (#17102): what the phone
 * offers for the question's kind, held in memory per question until it is
 * sent, then where it stands until it is typed into the terminal that asked.
 */
export function DecisionAnswerComposer({
  question,
  target,
  unshown,
  onMoved,
  sendNote = null,
  deliveryNotice = null,
  onSend,
}: DecisionAnswerComposerProps) {
  const key = answerKey(question.reference);
  const record = useAnswerRecord(key);
  const update = useDecisionsAnswerStore((state) => state.update);
  const announce = useAnnouncerStore((state) => state.announce);
  const { terminalId, questionId } = questionOf(target);
  const reviewed = useReviewedImages(terminalId, questionId);
  const now = useDeadlineClock(question.expiresAt);
  const mode = answerComposerMode(record, question, now);
  // Its form kept for a draft past the deadline: locked, as a stale one is.
  const elapsed = mode === "form" && !isAnswerable(question, now);
  const shape = composeShape(question);
  const draft: AnswerDraft = record.draft ?? {
    revision: question.revision,
    selected: null,
    text: "",
  };
  const stale = mode === "form" && !elapsed && draft.revision !== question.revision;
  const locked = stale || elapsed;
  const verdict = composeVerdict({
    question,
    draft,
    reviewed,
    unshown,
    stale,
    closed: mode !== "form" || elapsed,
  });
  const chosen = chosenOption(question, draft);
  const ready = verdict.canSend && canStartAnswer(record);
  const submission = record.submission;
  const queued =
    submission?.phase.kind === "settled" && submission.phase.outcome.status === "queued";
  const answerId = submission?.answerId ?? null;
  const radioId = useId();
  const groupName = `decision-answer-${radioId}`;
  const hintId = useId();
  const statusRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // A queued answer is read again until the relay takes it or turns it away;
  // reopening the view reads it at once. Stops with the view or the step away.
  useEffect(() => {
    if (!queued) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void followAnswer(key).finally(() => {
        if (live) timer = setTimeout(read, QUEUED_READ_MS);
      });
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [queued, key, answerId]);

  // Once the relay has taken it, the question's own record shows it typed in.
  const phaseKind = submission?.phase.kind ?? null;
  const outcomeStatus =
    submission?.phase.kind === "settled" ? submission.phase.outcome.status : null;
  useEffect(() => {
    if (phaseKind === "settled" || phaseKind === "refused") onMoved();
  }, [phaseKind, outcomeStatus, answerId, onMoved]);

  // A Send or Retry that found the question closed or changed shows it as it is now.
  const holdReason = record.hold;
  useEffect(() => {
    if (holdReason !== null) onMoved();
  }, [holdReason, onMoved]);

  const progress =
    mode === "progress" && submission !== null
      ? progressText(submission.phase, question, submission.answerId)
      : null;
  const attempt = mode !== "progress" && submission !== null ? attemptText(submission.phase) : null;
  const closed = mode === "closed" ? (attempt ?? closedText(question.status)) : null;
  const notice =
    mode === "form"
      ? elapsed
        ? ELAPSED_TEXT
        : stale
          ? null
          : (attempt ?? (record.hold !== null ? holdText(record.hold) : null))
      : null;
  const spoken = progress ?? closed ?? (stale ? STALE_TEXT : notice);

  // Said once as it changes, never for what was already so when the view opened.
  const spokenRef = useRef(spoken);
  useEffect(() => {
    if (spoken === spokenRef.current) return;
    spokenRef.current = spoken;
    if (spoken !== null) announce(spoken);
  }, [spoken, announce]);

  // Send, Retry and the form itself go as the answer moves on; focus that was
  // on one goes to where the answer stands rather than to the page.
  const focusedInside = useRef(false);
  const trackFocus = {
    onFocus: () => {
      focusedInside.current = true;
      if (record.engaged !== true) {
        update(key, (current) =>
          current.engaged === true ? current : { ...current, engaged: true }
        );
      }
    },
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (next instanceof Node && !event.currentTarget.contains(next)) {
        focusedInside.current = false;
      }
    },
  };
  useEffect(() => {
    const active = document.activeElement;
    if (focusedInside.current && (active === null || active === document.body)) {
      statusRef.current?.focus({ preventScroll: true });
    }
  });

  const edit = (change: Partial<Omit<AnswerDraft, "revision">>) => {
    // Locked past the deadline: what was written stays as it was.
    if (elapsed) return;
    update(key, (current) => {
      if (current.preparing) return current;
      const base = current.draft ?? draft;
      // A failed attempt's words go with the next change; a taken one's never do.
      const keepAttempt = current.submission !== null && isCommitted(current.submission.phase);
      return {
        ...current,
        draft: { ...base, ...change },
        hold: null,
        submission: keepAttempt ? current.submission : null,
      };
    });
  };

  const reviewUpdate = () => {
    update(key, (current) => ({
      ...current,
      draft: { revision: question.revision, selected: null, text: current.draft?.text ?? "" },
      hold: null,
      submission: null,
    }));
    // The warning goes; focus goes back to the answer.
    requestAnimationFrame(() => {
      const first =
        formRef.current?.querySelector<HTMLElement>("input:not(:disabled)") ?? textRef.current;
      first?.focus({ preventScroll: true });
    });
  };

  const send = () => {
    if (!ready) return;
    const prior = readAnswerRecord(key).submission?.answerId ?? null;
    const sending = sendAnswer(key, target, unshown);
    onSend?.(prior);
    void sending.finally(onMoved);
  };

  if (mode === "none") return null;

  if (mode !== "form") {
    const lost = submission?.phase.kind === "lost";
    return (
      <section
        className="flex flex-col gap-1.5"
        aria-label="Your answer"
        data-decision-answer=""
        {...trackFocus}
      >
        <h3 className="text-xs font-medium text-text-secondary">Your answer</h3>
        <div
          ref={statusRef}
          tabIndex={-1}
          className={FOCUS_TARGET}
          data-testid="decision-answer-status"
        >
          <Callout
            severity={closed !== null ? "neutral" : lost ? "warning" : "neutral"}
            size="compact"
            action={
              lost ? (
                <Button variant="outline" size="xs" onClick={() => void followAnswer(key, true)}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {progress ?? closed}
          </Callout>
        </div>
      </section>
    );
  }

  const hint = sendHint(verdict, sendNote);
  const shortcut = isMac() ? "Meta+Enter" : "Control+Enter";

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Your answer"
      // Where a surface that shows the question sends the keyboard to answer it.
      data-decision-answer=""
      data-testid="decision-answer-composer"
      // From anywhere in the answer, a choice as much as the words: the chips on Send say so.
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing) return;
        // A button's own Enter is its own action (Clear choice, Review update, Send itself).
        if (event.defaultPrevented || event.target instanceof HTMLButtonElement) return;
        const mod = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
        if (!mod || event.altKey || event.shiftKey) return;
        event.preventDefault();
        send();
      }}
      {...trackFocus}
    >
      <h3 className="text-xs font-medium text-text-secondary">Your answer</h3>
      {/* Out of the section's rhythm while it says nothing, so the heading sits on the choices;
          still rendered and focusable, since focus falls back to it when a control goes. */}
      <div
        ref={statusRef}
        tabIndex={-1}
        className={cn("flex flex-col gap-2 empty:-mt-3", FOCUS_TARGET)}
      >
        {stale && (
          <Callout
            severity="warning"
            size="compact"
            action={
              <Button variant="outline" size="xs" onClick={reviewUpdate}>
                Review update
              </Button>
            }
            data-testid="decision-answer-stale"
          >
            {STALE_TEXT}
          </Callout>
        )}
        {notice !== null && (
          <Callout severity="warning" size="compact" data-testid="decision-answer-notice">
            {notice}
          </Callout>
        )}
        {/* Not past the deadline: the locked form already says it can't be sent. */}
        {deliveryNotice !== null && !elapsed && (
          <Callout severity="warning" size="compact" data-testid="decision-answer-delivery">
            {deliveryNotice}
          </Callout>
        )}
      </div>
      <div ref={formRef} className="flex flex-col gap-3">
        {shape.hasOptions && (
          <RadioChoiceGroup legend={shape.legend} legendHidden>
            {question.options.map((option) => (
              <RadioChoiceRow
                key={option.id}
                name={groupName}
                value={option.id}
                checked={chosen === option.id}
                onChange={() => edit({ selected: option.id })}
                label={option.label}
                description={
                  option.description !== null ? (
                    <DecisionMarkdown text={option.description} size="xs" tone="secondary" />
                  ) : undefined
                }
                // An approval decides on its images, so its choices wait until each is opened,
                // all but Reject past one that couldn't be shown. Past the deadline they stay
                // focusable, and edits are refused instead.
                disabled={stale || verdict.blockedOptions.includes(option.id)}
                testId="decision-answer-option"
              />
            ))}
          </RadioChoiceGroup>
        )}
        {shape.mixed && chosen !== null && !locked && (
          <Button
            variant="ghost"
            size="xs"
            className="self-start"
            onClick={() => {
              edit({ selected: null });
              // This button goes with the choice; the answer is in the words now.
              textRef.current?.focus({ preventScroll: true });
            }}
          >
            Clear choice
          </Button>
        )}
        {shape.textAllowed && (
          // A hidden label still takes a track in the field's grid: no gap after it.
          <Field className={shape.textIsAnswer ? "gap-0" : undefined}>
            {/* The section's heading already names a text question's answer. */}
            <FieldLabel
              className={shape.textIsAnswer ? "sr-only" : "text-xs font-medium text-text-secondary"}
            >
              {/* Once a choice is made, the words go with it rather than instead of it. */}
              {shape.textIsAnswer
                ? "Your answer"
                : shape.mixed && chosen === null
                  ? "Or answer in your own words"
                  : "Note (optional)"}
            </FieldLabel>
            <Textarea
              ref={textRef}
              rows={shape.textIsAnswer ? 4 : 2}
              // Grows with what is written: a note is usually a line, an answer a paragraph.
              className={cn(
                "max-h-72 [field-sizing:content]",
                shape.textIsAnswer ? "min-h-28" : "min-h-16"
              )}
              value={draft.text}
              readOnly={locked}
              aria-keyshortcuts={shortcut}
              onChange={(event) => edit({ text: event.target.value })}
              data-testid="decision-answer-text"
            />
          </Field>
        )}
      </div>
      <div className="flex items-center justify-end gap-3">
        {hint !== null && (
          <p id={hintId} className="text-xs text-text-secondary [text-wrap:pretty]">
            {hint}
          </p>
        )}
        <Button
          variant="contrast"
          aria-disabled={!ready || undefined}
          loading={record.preparing}
          aria-describedby={hint !== null ? hintId : undefined}
          aria-keyshortcuts={shortcut}
          onClick={send}
          className="shrink-0"
          data-testid="decision-answer-send"
        >
          {shape.sendLabel}
          {/* Named by aria-keyshortcuts on the field; the chips are for the eye, and
              only once Send would go, since an unavailable button's ink washes them out. */}
          {ready && (
            <span aria-hidden="true" className="ml-1 flex">
              <KbdChord shortcut="Cmd+Enter" density="compact" foreground="inverse" />
            </span>
          )}
        </Button>
      </div>
    </section>
  );
}
