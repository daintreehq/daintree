import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Textarea } from "@/components/ui/textarea";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  answerKey,
  isInFlight,
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
  type AnswerDraft,
} from "./decisionComposeModel";
import { DecisionMarkdown } from "./DecisionMarkdown";
import { questionOf, type DecisionQuestionTarget } from "./decisionQuestionTarget";

/** A place focus is sent to when what held it goes; never tabbed to. */
const FOCUS_TARGET =
  "rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary";

/** While an answer is queued, how long after one read of its standing the next starts. */
const QUEUED_READ_MS = 2_000;

const STALE_TEXT = "This question changed. Review the update before sending.";

/** The longest a browser timer waits; a later expiry is checked again after this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The time, moved on when the question's expiry passes, so an answer is never
 * offered past it while the question waits for the store to record it.
 */
function useExpiryClock(expiresAt: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const at = Date.parse(expiresAt);
    // Nothing left to wait for once a render has seen it pass. One that passed
    // between the render and here still moves the clock, at once.
    if (Number.isNaN(at) || now >= at) return;
    const delay = Math.max(0, at - Date.now()) + 1;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [expiresAt, now]);
  return now;
}

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
  const writing = record.draft !== null || record.hold !== null || submission !== null;
  return writing ? "closed" : "none";
}

export interface DecisionAnswerComposerProps {
  question: DecisionQuestionContent;
  target: DecisionQuestionTarget;
  /** The question may have moved: read it again now rather than at the next change. */
  onMoved: () => void;
}

/** An answer from here whose fate isn't known yet: the question isn't offered for withdrawal meanwhile. */
export function useAnswerInFlight(question: DecisionQuestionContent | null): boolean {
  const record = useAnswerRecord(question === null ? "" : answerKey(question.reference));
  return isInFlight(record);
}

/** Whether this question shows its composer rather than the plain list of its options. */
export function useAnswerComposerMode(
  question: DecisionQuestionContent | null
): AnswerComposerMode {
  const record = useAnswerRecord(question === null ? "" : answerKey(question.reference));
  const now = useExpiryClock(question?.expiresAt ?? null);
  return question === null ? "none" : answerComposerMode(record, question, now);
}

/**
 * The person's answer to a question, given here (#17102): what the phone
 * offers for the question's kind, held in memory per question until it is
 * sent, then where it stands until it is typed into the terminal that asked.
 */
export function DecisionAnswerComposer({ question, target, onMoved }: DecisionAnswerComposerProps) {
  const key = answerKey(question.reference);
  const record = useAnswerRecord(key);
  const update = useDecisionsAnswerStore((state) => state.update);
  const announce = useAnnouncerStore((state) => state.announce);
  const { terminalId, questionId } = questionOf(target);
  const reviewed = useReviewedImages(terminalId, questionId);
  const now = useExpiryClock(question.expiresAt);
  const mode = answerComposerMode(record, question, now);
  const shape = composeShape(question);
  const draft: AnswerDraft = record.draft ?? {
    revision: question.revision,
    selected: null,
    text: "",
  };
  const stale = mode === "form" && draft.revision !== question.revision;
  const verdict = composeVerdict({
    question,
    draft,
    reviewed,
    stale,
    closed: mode !== "form",
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
      ? stale
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

  const edit = (change: Partial<Omit<AnswerDraft, "revision">>) =>
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
    void sendAnswer(key, target).finally(onMoved);
  };

  if (mode === "none") return null;

  if (mode !== "form") {
    const lost = submission?.phase.kind === "lost";
    return (
      <section className="flex flex-col gap-1.5" aria-label="Your answer" {...trackFocus}>
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

  const imagesFirst = verdict.remainingImages > 0;
  const shortcut = isMac() ? "Meta+Enter" : "Control+Enter";

  return (
    <section
      className="flex flex-col gap-3"
      aria-label="Your answer"
      data-testid="decision-answer-composer"
      {...trackFocus}
    >
      <h3 className="text-xs font-medium text-text-secondary">Your answer</h3>
      <div ref={statusRef} tabIndex={-1} className={cn("flex flex-col gap-2", FOCUS_TARGET)}>
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
                    <DecisionMarkdown text={option.description} className="text-xs" />
                  ) : undefined
                }
                // An approval decides on its images, so its choices wait until each is opened.
                disabled={imagesFirst || stale}
                testId="decision-answer-option"
              />
            ))}
          </RadioChoiceGroup>
        )}
        {shape.mixed && chosen !== null && (
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
          <Field>
            {/* The section's heading already names a text question's answer. */}
            <FieldLabel className={shape.textIsAnswer ? "sr-only" : undefined}>
              {shape.textIsAnswer
                ? "Your answer"
                : shape.mixed
                  ? "Or answer in your own words"
                  : "Note (optional)"}
            </FieldLabel>
            <Textarea
              ref={textRef}
              rows={3}
              value={draft.text}
              readOnly={stale}
              aria-keyshortcuts={shortcut}
              onChange={(event) => edit({ text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing) return;
                const mod = isMac()
                  ? event.metaKey && !event.ctrlKey
                  : event.ctrlKey && !event.metaKey;
                if (!mod || event.altKey || event.shiftKey) return;
                event.preventDefault();
                send();
              }}
              data-testid="decision-answer-text"
            />
          </Field>
        )}
      </div>
      <div className="flex items-center justify-end gap-3">
        {verdict.hint !== null && (
          <p id={hintId} className="text-xs text-text-secondary [text-wrap:pretty]">
            {verdict.hint}
          </p>
        )}
        <Button
          variant="contrast"
          aria-disabled={!ready || undefined}
          loading={record.preparing}
          aria-describedby={verdict.hint !== null ? hintId : undefined}
          onClick={send}
          className="shrink-0"
          data-testid="decision-answer-send"
        >
          {shape.sendLabel}
        </Button>
      </div>
    </section>
  );
}
