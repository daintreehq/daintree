import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type { DecisionQuestionContent, DecisionThreadEntry } from "@shared/types/decisionsQuestion";
import { DecisionAnswerComposer, type AnswerComposerMode } from "./DecisionAnswerComposer";
import { DecisionFollowUpComposer } from "./DecisionFollowUpComposer";
import { DecisionMarkdown } from "./DecisionMarkdown";
import { DecisionQuestionImages } from "./DecisionQuestionImages";
import type { DecisionQuestionTarget } from "./decisionQuestionTarget";
import { imagesKey } from "./questionImageLoader";
import {
  choiceLabels,
  emptyEntryText,
  questionStatusText,
  requirementText,
  threadEntryHeading,
} from "./decisionQuestionModel";
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

function ExpiryText({ expiresAt }: { expiresAt: string }) {
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return null;
  const relative = formatRelativeTime(ms);
  return (
    <time dateTime={expiresAt} title={new Date(ms).toLocaleString()}>
      {ms > Date.now() ? `Expires ${relative}` : `Expired ${relative}`}
    </time>
  );
}

function ThreadEntry({
  entry,
  options,
}: {
  entry: DecisionThreadEntry;
  options: DecisionQuestionContent["options"];
}) {
  const empty = emptyEntryText(entry);
  const choices = entry.type === "answer" && !entry.unreadable ? choiceLabels(entry, options) : [];
  return (
    <li
      className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2"
      data-testid="decision-thread-entry"
      data-message-id={entry.type === "message" ? entry.messageId : undefined}
    >
      <p className="text-2xs text-text-secondary">
        {threadEntryHeading(entry)} <FactSeparator /> <TimeAgo timestamp={entry.sentAt} />
      </p>
      {choices.length > 0 && (
        <p className="text-xs font-semibold text-text-primary [text-wrap:pretty]">
          {choices.join(", ")}
        </p>
      )}
      {(entry.type === "answer" || entry.type === "message") &&
        entry.text !== null &&
        !entry.unreadable && <DecisionMarkdown text={entry.text} className="text-xs" />}
      {entry.type === "answer" && entry.reason !== null && !entry.unreadable && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">Why: {entry.reason}</p>
      )}
      {empty !== null && <p className="text-xs text-text-secondary">{empty}</p>}
    </li>
  );
}

function QuestionBody({
  question,
  target,
  active,
  answerMode,
  followUps,
  onMoved,
}: {
  question: DecisionQuestionContent;
  target: DecisionQuestionTarget;
  active: boolean;
  answerMode: AnswerComposerMode;
  followUps: boolean;
  onMoved: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="decision-question-content">
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
        <span data-testid="decision-question-status">{questionStatusText(question)}</span>
        <FactSeparator />
        <span data-testid="decision-question-requirement">
          {requirementText(question.requirement)}
        </span>
        <FactSeparator />
        <TimeAgo timestamp={question.askedAt} prefix="Asked " />
        {/* A declined question is over, whatever its deadline would have said. */}
        {question.expiresAt !== null && question.closedReason !== "declined" && (
          <>
            <FactSeparator />
            <ExpiryText expiresAt={question.expiresAt} />
          </>
        )}
      </p>
      <DecisionMarkdown text={question.question} className="text-sm" />
      {question.context !== null && (
        <section className="flex flex-col gap-1" aria-label="Notes">
          <h3 className="text-xs font-medium text-text-secondary">Notes</h3>
          <DecisionMarkdown text={question.context} className="text-xs" />
        </section>
      )}
      {/* While it takes an answer here, the composer offers the options instead. */}
      {question.options.length > 0 && answerMode !== "form" && (
        <section className="flex flex-col gap-1.5" aria-label="Options">
          <h3 className="text-xs font-medium text-text-secondary">Options</h3>
          <ul className="flex flex-col gap-1.5">
            {question.options.map((option) => (
              <li
                key={option.id}
                className="flex flex-col gap-0.5 rounded-[var(--radius-md)] border border-divider px-3 py-2"
              >
                <span className="text-xs font-medium text-text-primary [text-wrap:pretty]">
                  {option.label}
                </span>
                {option.description !== null && (
                  <DecisionMarkdown text={option.description} className="text-xs" />
                )}
              </li>
            ))}
          </ul>
          {question.allowText && (
            <p className="text-2xs text-text-secondary">
              An answer may also be in their own words.
            </p>
          )}
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
      <DecisionAnswerComposer question={question} target={target} onMoved={onMoved} />
      <section
        className="flex flex-col gap-1.5"
        aria-label="Answers and follow-ups"
        data-testid="decision-question-thread"
      >
        <h3 className="text-xs font-medium text-text-secondary">Answers and follow-ups</h3>
        {question.thread.length === 0 ? (
          <p className="text-xs text-text-secondary">Nothing yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {question.thread.map((entry) => (
              <ThreadEntry
                key={entry.type === "message" ? entry.messageId : entry.entryId}
                entry={entry}
                options={question.options}
              />
            ))}
          </ul>
        )}
      </section>
      {/* After the thread, which it adds to. */}
      {followUps && (
        <DecisionFollowUpComposer
          question={question}
          target={target}
          primary={answerMode !== "form"}
          onMoved={onMoved}
        />
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
}: {
  reader: DecisionQuestionReader;
  target: DecisionQuestionTarget | null;
  /** Whether the surface is open; its closing closes the image viewer too. */
  active: boolean;
  /** Whether the person can add to the question's thread from here (#17238). */
  followUps?: boolean;
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
          onMoved={reader.reread}
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
          {UNAVAILABLE[current.result]}
        </Callout>
      )}
    </>
  );
}
