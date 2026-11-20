import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { answerKey } from "@/store/decisionsAnswerStore";
import {
  isFollowUpInFlight,
  useDecisionsFollowUpStore,
  useFollowUpRecord,
} from "@/store/decisionsFollowUpStore";
import type { DecisionQuestionContent } from "@shared/types/decisionsQuestion";
import {
  awaitsConfirmation,
  confirmFollowUpInThread,
  followFollowUp,
  isFollowUpCommitted,
  sendFollowUp,
} from "./decisionFollowUpSend";
import {
  followUpAttemptText,
  followUpHoldText,
  followUpProgressText,
  followUpVerdict,
  replyRequest,
  takesFollowUp,
} from "./decisionFollowUpModel";
import type { DecisionQuestionTarget } from "./decisionQuestionTarget";
import { contentDeadlineElapsed } from "./decisionDeadline";
import { useDeadlineClock } from "./useDecisionsClock";

/** A place focus is sent to when what held it goes; never tabbed to. */
const FOCUS_TARGET =
  "rounded-[var(--radius-md)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary";

/** While a follow-up is queued, how long after one read of its standing the next starts. */
const QUEUED_READ_MS = 2_000;

const CLOSED_TEXT = "This question no longer takes follow-ups.";

/** Said while only this computer's clock has an open question's deadline passed (#17943). */
const ELAPSED_TEXT =
  "The deadline has passed, so this can't be sent. Your words stay here while Daintree waits to hear how the question closed.";

/** Said while typing into the asking terminal stopped and nobody has resolved it (#18028). */
const PAUSED_TEXT =
  "Delivery to the terminal that asked needs attention. You can't send a new follow-up until it's resolved.";

export interface DecisionFollowUpComposerProps {
  question: DecisionQuestionContent;
  target: DecisionQuestionTarget;
  /** The view's main action: nothing else on it takes an answer now. */
  primary: boolean;
  /** The question may have moved: read it again now rather than at the next change. */
  onMoved: () => void;
  /**
   * Typing into the asking terminal stopped on this question and nobody has
   * resolved it (#18028): a new follow-up would only wait behind it.
   */
  stalled: boolean;
  /**
   * Whether the surface is open. One closing starts nothing: as it closes it
   * no longer hears of the stall, but its field still has the keyboard.
   */
  active: boolean;
}

/**
 * The person's follow-up on a question's thread, written here (#17238):
 * before its answer or after it, typed into the terminal that asked as sent
 * from this computer, and never an answer. Held in memory per question until
 * it is sent, then where it stands until it is typed in.
 */
export function DecisionFollowUpComposer({
  question,
  target,
  primary,
  onMoved,
  stalled,
  active,
}: DecisionFollowUpComposerProps) {
  const key = answerKey(question.reference);
  const record = useFollowUpRecord(key);
  const update = useDecisionsFollowUpStore((state) => state.update);
  const announce = useAnnouncerStore((state) => state.announce);
  const now = useDeadlineClock(question.status === "open" ? question.expiresAt : null);
  const available = takesFollowUp(question, now);
  // Open by the store, past its deadline by the clock: nothing has said how it closed yet.
  const elapsed = contentDeadlineElapsed(question, now) && question.status === "open";
  // It would take one, but no new one starts until the stall is resolved. One already on its
  // way, and its Retry, go on: only `takesFollowUp` lets one go.
  const paused = available && stalled;
  const inFlight = isFollowUpInFlight(record);
  const verdict = followUpVerdict(record.draft);
  const ready = active && available && !paused && verdict.canSend && !inFlight;
  const submission = record.submission;
  const messageId = submission?.messageId ?? null;
  const queued =
    submission?.phase.kind === "settled" && submission.phase.outcome.status === "queued";
  const asked = replyRequest(question) !== null;
  const hintId = useId();
  const pausedId = useId();
  const statusRef = useRef<HTMLDivElement>(null);
  // Once the person has been in here, the section stays to say the question closed, and to hold focus.
  const [engaged, setEngaged] = useState(false);

  // A follow-up not yet confirmed (lost, or queued with a missed receipt), now in the question's
  // thread: the relay took it.
  const unconfirmedId =
    submission !== null && awaitsConfirmation(submission.phase) ? submission.messageId : null;
  const inThread =
    unconfirmedId !== null &&
    question.thread.some((entry) => entry.type === "message" && entry.messageId === unconfirmedId);
  useEffect(() => {
    if (unconfirmedId !== null && inThread) confirmFollowUpInThread(key, unconfirmedId);
  }, [key, unconfirmedId, inThread]);

  // A queued follow-up is read again until the relay takes it or turns it
  // away; reopening the view reads it at once. Stops with the view or the step away.
  useEffect(() => {
    if (!queued) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void followFollowUp(key).finally(() => {
        if (live) timer = setTimeout(read, QUEUED_READ_MS);
      });
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [queued, key, messageId]);

  // Once the relay has taken it, the question's own thread shows it and how far it got.
  const phaseKind = submission?.phase.kind ?? null;
  const outcomeStatus =
    submission?.phase.kind === "settled" ? submission.phase.outcome.status : null;
  useEffect(() => {
    if (phaseKind === "settled" || phaseKind === "refused") onMoved();
  }, [phaseKind, outcomeStatus, messageId, onMoved]);

  const holdReason = record.hold;
  useEffect(() => {
    if (holdReason !== null) onMoved();
  }, [holdReason, onMoved]);

  const progress =
    submission !== null && isFollowUpCommitted(submission.phase)
      ? followUpProgressText(submission.phase, question, submission.messageId)
      : null;
  const attempt = submission !== null ? followUpAttemptText(submission.phase) : null;
  const hold = record.hold !== null ? followUpHoldText(record.hold) : null;
  // Unsent words, or a person writing here, once it stopped taking them: say so rather than vanish.
  const closed =
    !available && !inFlight && (engaged || record.draft.trim() !== "")
      ? elapsed
        ? ELAPSED_TEXT
        : CLOSED_TEXT
      : null;
  // A draft past the deadline stays in its field, read-only, so focus and words stay put. While
  // paused, the field stays only for what is already in it: words, one on its way, or a person
  // writing.
  const keepField =
    (available && (!paused || record.draft !== "" || inFlight || engaged)) ||
    (elapsed && closed !== null);
  const notice = attempt ?? hold ?? closed;
  // Apart from the notice, so neither hides the other: a failed attempt still says nothing was sent.
  const pausedNote = paused ? PAUSED_TEXT : null;

  // Each said once as it changes, never for what was already so when the view opened. All
  // count: a closed question never keeps where the last follow-up got to from being heard, and
  // those that change together go in one announcement, which the live region keeps whole.
  const saidRef = useRef({ notice, progress, pausedNote });
  useEffect(() => {
    const said = saidRef.current;
    if (notice === said.notice && progress === said.progress && pausedNote === said.pausedNote) {
      return;
    }
    const changed = [
      notice !== said.notice ? notice : null,
      progress !== said.progress ? progress : null,
      pausedNote !== said.pausedNote ? pausedNote : null,
    ].filter((text): text is string => text !== null);
    saidRef.current = { notice, progress, pausedNote };
    if (changed.length > 0) announce(changed.join(" "));
  }, [notice, progress, pausedNote, announce]);

  // Send and Retry go as the follow-up moves on; focus that was on one goes
  // to where it stands rather than to the page.
  const focusedInside = useRef(false);
  const trackFocus = {
    onFocus: () => {
      focusedInside.current = true;
      if (!engaged) setEngaged(true);
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

  const send = () => {
    if (!ready) return;
    void sendFollowUp(key, target).finally(onMoved);
  };

  if (!available && progress === null && notice === null) return null;

  const lost = submission?.phase.kind === "lost";
  const shortcut = isMac() ? "Meta+Enter" : "Control+Enter";
  const heading = asked ? "Reply to the agent" : "Follow up";

  return (
    <section
      className="flex flex-col gap-2"
      aria-label={heading}
      data-testid="decision-follow-up-composer"
      {...trackFocus}
    >
      <h3 className="text-xs font-medium text-text-secondary">{heading}</h3>
      <div ref={statusRef} tabIndex={-1} className={cn("flex flex-col gap-2", FOCUS_TARGET)}>
        {progress !== null && (
          <Callout
            severity={lost ? "warning" : "neutral"}
            size="compact"
            action={
              lost ? (
                <Button variant="outline" size="xs" onClick={() => void followFollowUp(key, true)}>
                  Retry
                </Button>
              ) : undefined
            }
            data-testid="decision-follow-up-status"
          >
            {progress}
          </Callout>
        )}
        {notice !== null && (
          <Callout
            severity={attempt === null && hold === null ? "neutral" : "warning"}
            size="compact"
            data-testid="decision-follow-up-notice"
          >
            {notice}
          </Callout>
        )}
        {pausedNote !== null && (
          <Callout
            id={pausedId}
            severity="neutral"
            size="compact"
            data-testid="decision-follow-up-paused"
          >
            {pausedNote}
          </Callout>
        )}
      </div>
      {keepField && (
        <>
          <Field>
            <FieldLabel className="sr-only">{asked ? "Your reply" : "Your follow-up"}</FieldLabel>
            {/* Never promised while what was typed in last stopped there, deadline or not. */}
            {!stalled && (
              <FieldDescription>
                Typed into the terminal that asked, as sent from this computer. It never changes the
                answer.
              </FieldDescription>
            )}
            <Textarea
              rows={2}
              value={record.draft}
              // Kept while it is on its way, so focus stays here and the words can't change under it.
              readOnly={inFlight || !available}
              aria-keyshortcuts={shortcut}
              onChange={(event) => {
                const text = event.target.value;
                update(key, (current) => {
                  if (isFollowUpInFlight(current)) return current;
                  // A failed attempt's words go with the next change; a taken one's stay until the next Send.
                  const kept =
                    current.submission !== null && isFollowUpCommitted(current.submission.phase)
                      ? current.submission
                      : null;
                  return { ...current, draft: text, hold: null, submission: kept };
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.repeat || event.nativeEvent.isComposing) return;
                const mod = isMac()
                  ? event.metaKey && !event.ctrlKey
                  : event.ctrlKey && !event.metaKey;
                if (!mod || event.altKey || event.shiftKey) return;
                event.preventDefault();
                send();
              }}
              data-testid="decision-follow-up-text"
            />
          </Field>
          <div className="flex items-center justify-end gap-3">
            {verdict.hint !== null && (
              <p id={hintId} className="text-xs text-text-secondary [text-wrap:pretty]">
                {verdict.hint}
              </p>
            )}
            <Button
              variant={primary && !paused ? "contrast" : "outline"}
              aria-disabled={!ready || undefined}
              loading={record.preparing}
              aria-describedby={
                [paused ? pausedId : null, verdict.hint !== null ? hintId : null]
                  .filter((id) => id !== null)
                  .join(" ") || undefined
              }
              onClick={send}
              className="shrink-0"
              data-testid="decision-follow-up-send"
            >
              {asked ? "Send reply" : "Send follow-up"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
