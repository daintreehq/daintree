import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DecisionsIcon } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useDecisionsOn } from "@/hooks/useDecisionsOn";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import type {
  DecisionQuestionContent,
  DecisionQuestionContentResult,
  DecisionThreadEntry,
} from "@shared/types/decisionsQuestion";
import { DecisionMarkdown } from "./DecisionMarkdown";
import {
  aliasLabel,
  choiceLabels,
  emptyEntryText,
  positionText,
  questionStatusText,
  requirementText,
  threadEntryHeading,
} from "./decisionQuestionModel";

/** A pane's Decisions chip, where the close returns while it still shows. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** This view's surface, which a stepping key has to come from. */
const DIALOG = '[data-testid="decision-question-dialog"]';

/** While open, how often the question is read again for follow-ups the pane's state doesn't show. */
const REREAD_MS = 15_000;

type Read = DecisionQuestionContentResult | { result: "failed" };

/** One read, tagged with what it was for, so a late answer never shows under another question. */
interface TaggedRead {
  key: string;
  read: Read;
}

function readKey(terminalId: string, questionId: string): string {
  return `${terminalId}\u0000${questionId}`;
}

const UNAVAILABLE: Record<Exclude<Read["result"], "read">, string> = {
  off: "Decisions is off on the computer that owns this terminal, so the question can't be read.",
  "not-running":
    "Decisions isn't connected to its relay right now, so the question can't be opened. Reconnect it in Settings → Decisions.",
  "not-found": "This question is no longer kept for this terminal.",
  unreadable: "This question couldn't be opened on this computer.",
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
    >
      <p className="text-2xs text-text-secondary">
        {threadEntryHeading(entry)} <FactSeparator /> <TimeAgo timestamp={entry.sentAt} />
      </p>
      {choices.length > 0 && (
        <p className="text-xs font-semibold text-text-primary [text-wrap:pretty]">
          {choices.join(", ")}
        </p>
      )}
      {entry.type !== "expired" && entry.text !== null && !entry.unreadable && (
        <DecisionMarkdown text={entry.text} className="text-xs" />
      )}
      {entry.type === "answer" && entry.reason !== null && !entry.unreadable && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">Why: {entry.reason}</p>
      )}
      {empty !== null && <p className="text-xs text-text-secondary">{empty}</p>}
    </li>
  );
}

function QuestionBody({ question }: { question: DecisionQuestionContent }) {
  return (
    <div className="flex flex-col gap-4" data-testid="decision-question-content">
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-secondary">
        <span>{questionStatusText(question.status)}</span>
        <FactSeparator />
        <span data-testid="decision-question-requirement">
          {requirementText(question.requirement)}
        </span>
        <FactSeparator />
        <TimeAgo timestamp={question.askedAt} prefix="Asked " />
        {question.expiresAt !== null && (
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
      {question.options.length > 0 && (
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
        <p className="text-2xs text-text-secondary">Asked with images; they aren't shown here.</p>
      )}
      <section className="flex flex-col gap-1.5" aria-label="Answers and follow-ups">
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

function StepButton({
  ref,
  direction,
  available,
  onStep,
}: {
  ref: React.Ref<HTMLButtonElement>;
  direction: "previous" | "next";
  available: boolean;
  onStep: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  // Always rendered: removing the button that holds focus at either end would
  // drop focus out of the dialog. At the ends it says it's unavailable instead.
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      aria-label={direction === "previous" ? "Previous question" : "Next question"}
      aria-disabled={!available || undefined}
      onClick={() => {
        if (available) onStep();
      }}
      className="shrink-0 aria-disabled:opacity-50 aria-disabled:pointer-events-none"
      data-testid={`decision-question-${direction}`}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

/**
 * A pane's Decisions question, read in full (#17098): its words, notes,
 * options, requirement, times, and the answers and follow-ups so far. Read on
 * demand from the machine that owns the pane and held in memory only; it
 * steps through the questions the dropdown listed without closing.
 */
export function DecisionQuestionDialog() {
  const isOpen = useDecisionsQuestionViewStore((state) => state.isOpen);
  const request = useDecisionsQuestionViewStore((state) => state.request);
  const step = useDecisionsQuestionViewStore((state) => state.step);
  const close = useDecisionsQuestionViewStore((state) => state.close);
  const announce = useAnnouncerStore((state) => state.announce);
  const on = useDecisionsOn();
  const [tagged, setTagged] = useState<TaggedRead | null>(null);
  const [attempt, setAttempt] = useState(0);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const terminalId = request?.terminalId ?? null;
  const questionId = request?.questionIds[request.index] ?? null;
  const count = request?.questionIds.length ?? 0;
  const index = request?.index ?? 0;
  const key = terminalId !== null && questionId !== null ? readKey(terminalId, questionId) : null;

  // Turning Decisions off takes the question off screen at once.
  useEffect(() => {
    if (!on && isOpen) close();
  }, [on, isOpen, close]);

  useEffect(() => {
    if (!isOpen || !on || terminalId === null || questionId === null) return;
    const thisKey = readKey(terminalId, questionId);
    let live = true;
    // Reads can land out of order; only the newest one started may paint.
    let latest = 0;
    const read = () => {
      latest += 1;
      const seq = latest;
      const accept = (result: Read) => {
        if (live && seq === latest) setTagged({ key: thisKey, read: result });
      };
      decisionsClient.getQuestionContent(terminalId, questionId).then(accept, () =>
        // Never the error itself: it could carry what the question says.
        accept({ result: "failed" })
      );
    };
    read();
    // An answer or its delivery moves the pane's state; read again so the thread keeps up.
    const off = decisionsClient.onPaneState((state) => {
      if (state.terminalId === terminalId) read();
    });
    // A follow-up can change the thread without moving the pane's state.
    const timer = setInterval(read, REREAD_MS);
    return () => {
      live = false;
      off();
      clearInterval(timer);
    };
  }, [isOpen, on, terminalId, questionId, attempt]);

  const current = tagged !== null && tagged.key === key ? tagged.read : null;
  const showSkeleton = useSkeletonGate(isOpen && current === null);

  const hasPrevious = index > 0;
  const hasNext = index < count - 1;

  const goTo = useCallback(
    (delta: number) => {
      if (request === null) return;
      const target = request.index + delta;
      if (target < 0 || target >= request.questionIds.length) return;
      // A Retry or a link in the content goes with the step; keep focus in the dialog.
      const active = document.activeElement;
      const stepper = delta < 0 ? previousRef.current : nextRef.current;
      if (
        active instanceof HTMLElement &&
        active !== previousRef.current &&
        active !== nextRef.current &&
        active.closest('[data-testid="decision-question-body"]') !== null
      ) {
        stepper?.focus({ preventScroll: true });
      }
      step(delta);
      announce(`Question ${(target + 1).toLocaleString()} of ${count.toLocaleString()}`);
    },
    [request, step, announce, count]
  );

  useEffect(() => {
    if (!isOpen || count < 2) return;
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      // Only while focus is in this dialog: another modal over it keeps its own arrows.
      if (!(target instanceof HTMLElement) || target.closest(DIALOG) === null) return;
      if (target.isContentEditable || target.closest("input, textarea, select, pre")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      goTo(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, count, goTo]);

  // Back to the pane's chip while it shows, else the pane itself: the chip
  // goes once the pane's last question settles.
  const restoreFocusTo = useCallback((): HTMLElement | null => {
    if (terminalId === null) return null;
    const escaped = CSS.escape(terminalId);
    const pane =
      document.querySelector<HTMLElement>(
        `[data-panel-id="${escaped}"][data-panel-location="grid"]`
      ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`);
    return pane?.querySelector<HTMLElement>(PANE_CHIP) ?? pane;
  }, [terminalId]);

  const alias = current?.result === "read" ? aliasLabel(current.question.alias) : null;
  const position = positionText(index, count);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={close}
      size="4xl"
      maxHeight="max-h-[min(48rem,85vh)]"
      initialFocus="surface"
      restoreFocusTo={restoreFocusTo}
      // Content is never kept past the close.
      onCloseComplete={() => setTagged(null)}
      data-testid="decision-question-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<DecisionsIcon size={16} />}>
          {alias !== null ? `Question ${alias}` : "Question"}
        </AppDialog.Title>
        {count > 1 && (
          <div className="ml-auto flex items-center gap-1">
            <StepButton
              ref={previousRef}
              direction="previous"
              available={hasPrevious}
              onStep={() => goTo(-1)}
            />
            <span
              className="min-w-12 text-center text-xs text-text-secondary tabular-nums"
              data-testid="decision-question-position"
            >
              {position}
            </span>
            <StepButton ref={nextRef} direction="next" available={hasNext} onStep={() => goTo(1)} />
          </div>
        )}
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body resetScrollKey={key ?? undefined}>
        <div data-testid="decision-question-body">
          {current === null && showSkeleton && <QuestionSkeleton />}
          {current?.result === "read" && <QuestionBody question={current.question} />}
          {current !== null && current.result !== "read" && (
            <Callout
              severity={current.result === "failed" ? "warning" : "neutral"}
              size="compact"
              action={
                current.result === "failed" || current.result === "not-running" ? (
                  <Button variant="outline" size="xs" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </Button>
                ) : undefined
              }
              data-testid="decision-question-unavailable"
            >
              {UNAVAILABLE[current.result]}
            </Callout>
          )}
        </div>
      </AppDialog.Body>
    </AppDialog>
  );
}
