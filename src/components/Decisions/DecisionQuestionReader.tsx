import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { cn } from "@/lib/utils";
import { Check, Clock } from "lucide-react";
import type {
  DecisionQuestionContent,
  DecisionQuestionListItem,
  DecisionThreadEntry,
} from "@shared/types/decisionsQuestion";
import { DecisionAnswerComposer, type AnswerComposerMode } from "./DecisionAnswerComposer";
import { hostAwayNote } from "./decisionCancelModel";
import { DecisionFollowUpComposer } from "./DecisionFollowUpComposer";
import { deliveryStalled } from "./decisionFollowUpModel";
import { DecisionMarkdown } from "./DecisionMarkdown";
import { DecisionQuestionImages } from "./DecisionQuestionImages";
import type { DecisionQuestionTarget } from "./decisionQuestionTarget";
import { imagesKey } from "./questionImageLoader";
import {
  choiceLabels,
  closureNoticeText,
  emptyEntryText,
  planHeading,
  questionStatusText,
  replyModeText,
  requirementText,
  threadEntryHeading,
} from "./decisionQuestionModel";
import {
  clockText,
  contentDeadlineElapsed,
  deadlineMs,
  remainingText,
  replyByText,
} from "./decisionDeadline";
import { useDecisionsClock } from "./useDecisionsClock";
import type { DecisionQuestionReader, QuestionRead } from "./useDecisionQuestionReader";

const UNAVAILABLE: Record<Exclude<QuestionRead["result"], "read">, string> = {
  off: "Decisions is off on the computer that owns this terminal, so the question can't be read.",
  "not-running":
    "Decisions isn't connected to its relay right now, so the question can't be opened. Reconnect it in Settings → Decisions.",
  "not-found": "This question is no longer kept for this terminal.",
  unreadable: "This question couldn't be opened on this computer.",
  "host-not-connected":
    "The Remote Host that asked this question isn't connected, so the question can't be opened right now.",
  failed: "The question couldn't be read.",
};

/** When an expired question's deadline passed, with the exact time one hover away. */
function ExpiredAt({ expiresAt, nowMs }: { expiresAt: string; nowMs: number }) {
  const ms = deadlineMs(expiresAt);
  if (ms === null) return null;
  return (
    <time
      dateTime={expiresAt}
      title={new Date(ms).toLocaleString()}
      className="inline-flex items-center gap-1"
    >
      <Clock className="size-3 shrink-0" aria-hidden="true" />
      {/* When, not how long ago: nothing moves the clock once a deadline is past. */}
      {`Expired at ${clockText(ms, nowMs)}`}
    </time>
  );
}

/**
 * The deadline of a question still asking (#17943): its mode, when to reply by
 * in this computer's time, and how long is left; or, once this computer's
 * clock has passed it, that nothing has confirmed how it closed yet. Never a
 * live region: the minutes ticking down are read on demand, never announced.
 */
function DeadlineLine({ question, nowMs }: { question: DecisionQuestionContent; nowMs: number }) {
  const deadline = deadlineMs(question.expiresAt);
  if (deadline === null || question.expiresAt === null) return null;
  const mode = replyModeText(question.replyMode);
  const elapsed = contentDeadlineElapsed(question, nowMs);
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-primary"
      data-testid="decision-question-deadline"
    >
      <Clock className="size-3 shrink-0 text-text-secondary" aria-hidden="true" />
      {mode !== null && (
        <>
          <span className="font-medium" data-testid="decision-question-mode">
            {mode}
          </span>
          <FactSeparator />
        </>
      )}
      {elapsed ? (
        <>
          <time dateTime={question.expiresAt} title={new Date(deadline).toLocaleString()}>
            Deadline passed at {clockText(deadline, nowMs)}
          </time>
          <FactSeparator />
          <span>Awaiting an update</span>
        </>
      ) : (
        <>
          <time dateTime={question.expiresAt} title={new Date(deadline).toLocaleString()}>
            {replyByText(deadline, nowMs)}
          </time>
          <FactSeparator />
          <span className="tabular-nums">{remainingText(deadline, nowMs)}</span>
        </>
      )}
    </p>
  );
}

/** The plan an advisory round states, in the agent's own words, under what it means (#17943). */
function PlannedFallback({ question }: { question: DecisionQuestionContent }) {
  const plan = question.plannedFallback;
  if (plan == null || question.replyMode !== "advisory") return null;
  return (
    <section
      className="flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-4 py-3"
      aria-label="The agent's plan"
      data-testid="decision-question-plan"
    >
      <h3 className="text-xs font-medium text-text-secondary">{planHeading(question.status)}</h3>
      <p className="whitespace-pre-wrap break-words text-sm text-text-primary [text-wrap:pretty]">
        {plan}
      </p>
    </section>
  );
}

/** Whether the person said it: their answers, follow-ups and declines read as their own side of the thread. */
function fromPerson(entry: DecisionThreadEntry): boolean {
  if (entry.type === "declined") return true;
  if (entry.type === "answer" || entry.type === "message") return entry.from === "person";
  return false;
}

/**
 * One turn of the thread, as the Decisions app draws it: the person's words
 * in a bubble on the right with where and when beneath, the agent's and the
 * relay's on the page at the left under who said them.
 */
function ThreadEntry({
  entry,
  options,
}: {
  entry: DecisionThreadEntry;
  options: DecisionQuestionContent["options"];
}) {
  const empty = emptyEntryText(entry);
  const choices = entry.type === "answer" && !entry.unreadable ? choiceLabels(entry, options) : [];
  const text =
    (entry.type === "answer" || entry.type === "message") &&
    entry.text !== null &&
    !entry.unreadable
      ? entry.text
      : null;
  const reason = entry.type === "answer" && !entry.unreadable ? entry.reason : null;
  const body = (
    <>
      {choices.length > 0 && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-text-primary [text-wrap:pretty]">
          <Check className="size-3.5 shrink-0 text-text-secondary" aria-hidden="true" />
          {choices.join(", ")}
        </p>
      )}
      {text !== null && <DecisionMarkdown text={text} size="sm" />}
      {reason !== null && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">Why: {reason}</p>
      )}
      {empty !== null && <p className="text-xs text-text-secondary">{empty}</p>}
    </>
  );
  const hasBody = choices.length > 0 || text !== null || reason !== null || empty !== null;
  const messageId = entry.type === "message" ? entry.messageId : undefined;

  if (fromPerson(entry)) {
    return (
      <li
        className="flex flex-col items-end gap-1"
        data-testid="decision-thread-entry"
        data-message-id={messageId}
      >
        {hasBody && (
          <div className="flex max-w-[85%] flex-col gap-1 rounded-[var(--radius-xl)] rounded-br-[var(--radius-xs)] bg-overlay-soft px-3.5 py-2.5">
            {body}
          </div>
        )}
        <p className="text-xs text-text-secondary">
          {threadEntryHeading(entry)} <FactSeparator /> <TimeAgo timestamp={entry.sentAt} />
        </p>
      </li>
    );
  }
  return (
    <li
      className="flex flex-col items-start gap-1"
      data-testid="decision-thread-entry"
      data-message-id={messageId}
    >
      <p className="text-xs text-text-secondary">
        <span className="font-medium text-text-primary">{threadEntryHeading(entry)}</span>{" "}
        <FactSeparator /> <TimeAgo timestamp={entry.sentAt} />
      </p>
      {hasBody && <div className="flex w-full flex-col gap-1">{body}</div>}
    </li>
  );
}

/**
 * The options the latest answer chose, by id. None when that answer can't be
 * read: an older one's choice may be the one it corrected.
 */
function chosenIds(thread: readonly DecisionThreadEntry[]): ReadonlySet<string> {
  for (let index = thread.length - 1; index >= 0; index -= 1) {
    const entry = thread[index]!;
    if (entry.type === "answer") {
      return entry.unreadable ? new Set() : new Set(entry.choices.map((choice) => choice.id));
    }
  }
  return new Set();
}

/**
 * The options a question offered, once it no longer takes an answer here: a
 * quiet list, not cards, since nothing in it can be pressed, with the one the
 * answer chose checked.
 */
function OfferedOptions({ question }: { question: DecisionQuestionContent }) {
  const chosen = chosenIds(question.thread);
  // Every option stays, the chosen one checked with its description: the answer above names only its label.
  const answered = question.thread.some((entry) => entry.type === "answer");
  // Words of one's own were never passed over, so they're only an option before an answer.
  const ownWords = question.allowText && !answered;
  return (
    <section className="flex flex-col gap-2" aria-label="Options">
      <h3 className="text-xs font-medium text-text-secondary">Options</h3>
      <ul className="flex flex-col gap-1.5">
        {question.options.map((option) => {
          const picked = chosen.has(option.id);
          return (
            <li key={option.id} className="flex items-start gap-2">
              <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                {picked ? (
                  <Check className="size-3.5 text-text-primary" aria-label="Chosen" />
                ) : (
                  <span className="size-1 rounded-full bg-text-secondary" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    "text-sm [text-wrap:pretty]",
                    picked ? "font-medium text-text-primary" : "text-text-secondary"
                  )}
                >
                  {option.label}
                </span>
                {option.description !== null && (
                  <DecisionMarkdown text={option.description} size="xs" tone="secondary" />
                )}
              </span>
            </li>
          );
        })}
        {ownWords && (
          <li className="flex items-start gap-2 text-sm text-text-secondary">
            <span className="flex h-5 w-4 shrink-0 items-center justify-center" aria-hidden="true">
              <span className="size-1 rounded-full bg-text-secondary" />
            </span>
            Or an answer in your own words
          </li>
        )}
      </ul>
    </section>
  );
}

/** What the line under the question says: only what isn't already plain from the view. */
function QuestionFacts({ question, nowMs }: { question: DecisionQuestionContent; nowMs: number }) {
  // An open question shows its composer, which says it waits; a person's
  // answer is what every question needs unless it says otherwise.
  const status = question.status === "open" ? null : questionStatusText(question);
  const requirement =
    question.requirement === "human-required" ? null : requirementText(question.requirement);
  const notice = closureNoticeText(question);
  const asking = question.status === "open" || question.status === "queued";
  return (
    <>
      {asking && <DeadlineLine question={question} nowMs={nowMs} />}
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
        {status !== null && (
          <>
            <span data-testid="decision-question-status">{status}</span>
            <FactSeparator />
          </>
        )}
        {requirement !== null && (
          <>
            <span data-testid="decision-question-requirement">{requirement}</span>
            <FactSeparator />
          </>
        )}
        <TimeAgo timestamp={question.askedAt} prefix="Asked " />
        {/* Only an expiry: a question still asking says its deadline above, and one closed another way is over. */}
        {question.expiresAt !== null && question.status === "expired" && (
          <>
            <FactSeparator />
            <ExpiredAt expiresAt={question.expiresAt} nowMs={nowMs} />
          </>
        )}
      </p>
      {notice !== null && (
        <p
          className="text-xs text-text-secondary [text-wrap:pretty]"
          data-testid="decision-question-notice"
        >
          {notice}
        </p>
      )}
    </>
  );
}

function QuestionBody({
  question,
  target,
  active,
  answerMode,
  followUps,
  stalled,
  onMoved,
  headingId,
  sendNote,
  eyebrow,
}: {
  question: DecisionQuestionContent;
  target: DecisionQuestionTarget;
  active: boolean;
  answerMode: AnswerComposerMode;
  followUps: boolean;
  stalled: boolean;
  onMoved: () => void;
  headingId: string | undefined;
  sendNote: string | null;
  eyebrow: React.ReactNode;
}) {
  // Moved on only when the deadline line would read differently, or the clock jumped.
  const nowMs = useDecisionsClock(
    question.status === "open" || question.status === "queued" || question.status === "expired"
      ? [question.expiresAt]
      : [],
    active
  );
  return (
    <div className="flex flex-col gap-6" data-testid="decision-question-content">
      <div className="flex flex-col gap-2">
        {eyebrow}
        {/* The ask, focusable from script alone so stepping to the next question lands on its
            words. No heading role: an agent's markdown can carry headings of its own. */}
        <div
          id={headingId}
          tabIndex={-1}
          className="rounded-[var(--radius-sm)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
        >
          <DecisionMarkdown
            text={question.question}
            size="lg"
            className="font-medium leading-snug"
          />
        </div>
        <QuestionFacts question={question} nowMs={nowMs} />
      </div>
      <PlannedFallback question={question} />
      {question.context !== null && (
        <section
          className="flex flex-col gap-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-4 py-3"
          aria-label="Notes"
        >
          <h3 className="text-xs font-medium text-text-secondary">Notes</h3>
          <DecisionMarkdown text={question.context} size="sm" tone="secondary" />
        </section>
      )}
      {question.attachments.length > 0 && (
        // Keyed by the images it lists, so a read again every few seconds keeps what's loaded.
        <DecisionQuestionImages
          key={imagesKey(target, question.attachments)}
          question={target}
          attachments={question.attachments}
          active={active}
        />
      )}
      {/* After the images: an approval waits until each has been opened. */}
      <DecisionAnswerComposer
        question={question}
        target={target}
        onMoved={onMoved}
        sendNote={sendNote}
      />
      {question.thread.length > 0 && (
        <section
          className="flex flex-col gap-3"
          aria-label="Answers and follow-ups"
          data-testid="decision-question-thread"
        >
          <h3 className="text-xs font-medium text-text-secondary">Answers and follow-ups</h3>
          <ul className="flex flex-col gap-4">
            {question.thread.map((entry) => (
              <ThreadEntry
                key={entry.type === "message" ? entry.messageId : entry.entryId}
                entry={entry}
                options={question.options}
              />
            ))}
          </ul>
        </section>
      )}
      {/* After the thread, which it adds to. */}
      {followUps && (
        <DecisionFollowUpComposer
          question={question}
          target={target}
          primary={answerMode !== "form"}
          onMoved={onMoved}
          stalled={stalled}
          active={active}
        />
      )}
      {/* While it takes an answer here, the composer offers the options instead. */}
      {question.options.length > 0 && answerMode !== "form" && (
        <OfferedOptions question={question} />
      )}
    </div>
  );
}

function QuestionSkeleton() {
  return (
    <Skeleton label="Loading the question" className="flex flex-col gap-3">
      <SkeletonBone className="h-3 w-1/2" />
      <SkeletonBone className="h-4 w-full" />
      <SkeletonBone className="h-4 w-4/5" />
      <SkeletonBone className="h-12 w-full" />
    </Skeleton>
  );
}

/**
 * A Decisions question, read in full (#17098): its words, notes, options,
 * requirement, times, images, the composer while it takes an answer here,
 * and the answers and follow-ups so far; or why it can't be shown, with a
 * Retry where reading again could help. Shared by the question view and the
 * inbox (#17231), each of which reads it through `useDecisionQuestionReader`.
 */
export function DecisionQuestionReadView({
  reader,
  target,
  active,
  followUps = false,
  listed = null,
  headingId,
  sendNote = null,
  eyebrow = null,
}: {
  reader: DecisionQuestionReader;
  target: DecisionQuestionTarget | null;
  /** Whether the surface is open; its closing closes the image viewer too. */
  active: boolean;
  /** Whether the person can add to the question's thread from here (#17238). */
  followUps?: boolean;
  /**
   * The question as this computer's list names it, when the surface has it:
   * where its delivery stands, which its content alone can't say (#18028).
   */
  listed?: Pick<DecisionQuestionListItem, "reference" | "standing"> | null;
  /** Given to the question's own words, so a surface can send the keyboard to them. */
  headingId?: string;
  /** What happens to an answer sent now, when that isn't simply "it goes": shown beside Send. */
  sendNote?: string | null;
  /** Who asked, over the question, when the surface knows it. */
  eyebrow?: React.ReactNode;
}) {
  const { current } = reader;
  return (
    <>
      {current === null && reader.showSkeleton && <QuestionSkeleton />}
      {current?.result === "read" && target !== null && (
        <QuestionBody
          question={current.question}
          target={target}
          active={active}
          answerMode={reader.answerMode}
          followUps={followUps}
          stalled={deliveryStalled(current.question, listed)}
          onMoved={reader.reread}
          headingId={headingId}
          sendNote={sendNote}
          eyebrow={eyebrow}
        />
      )}
      {current !== null && current.result !== "read" && (
        <Callout
          severity={current.result === "failed" ? "warning" : "neutral"}
          size="compact"
          action={
            current.result === "failed" ||
            current.result === "not-running" ||
            current.result === "host-not-connected" ? (
              <Button variant="outline" size="xs" onClick={reader.reread}>
                Retry
              </Button>
            ) : undefined
          }
          data-testid="decision-question-unavailable"
        >
          {current.result === "host-not-connected"
            ? [UNAVAILABLE[current.result], hostAwayNote(current.lastRead)]
                .filter((text) => text !== null)
                .join(" ")
            : UNAVAILABLE[current.result]}
        </Callout>
      )}
    </>
  );
}
