import { useCallback, useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DecisionsIcon } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import {
  useDecisionsQuestionViewStore,
  type DecisionsQuestionViewRequest,
} from "@/store/decisionsQuestionViewStore";
import { DecisionCancelDialog } from "./DecisionCancelDialog";
import { DecisionQuestionReadView } from "./DecisionQuestionReader";
import { targetKey } from "./decisionQuestionTarget";
import { positionText } from "./decisionQuestionModel";
import {
  useDecisionQuestionReader,
  useDecisionsReaderRetention,
  useQuestionCancel,
  type TaggedRead,
} from "./useDecisionQuestionReader";
import { useDecisionQuestionSeen, useListedQuestion } from "./useDecisionQuestionSeen";

/** A pane's Decisions chip, where the close returns while it still shows. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** This view's surface, which a stepping key has to come from. */
const DIALOG = '[data-testid="decision-question-dialog"]';

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
 * A Decisions question, read in full (#17098): its words, notes, options,
 * requirement, times, and the answers and follow-ups so far. One of a pane's
 * is read on demand from the machine that owns the pane; one opened by its
 * reference (#17229), from this computer for any of its windows. Held in
 * memory only; it steps through the questions it was opened with without
 * closing, and a question still waiting can be answered (#17102) or
 * dismissed (#17239) from here. The person can add to its thread before or
 * after its answer (#17238).
 */
export function DecisionQuestionDialog() {
  const isOpen = useDecisionsQuestionViewStore((state) => state.isOpen);
  const request = useDecisionsQuestionViewStore((state) => state.request);
  const step = useDecisionsQuestionViewStore((state) => state.step);
  const close = useDecisionsQuestionViewStore((state) => state.close);
  const announce = useAnnouncerStore((state) => state.announce);
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const target = request?.questions[request.index] ?? null;
  const terminalId = target?.scope === "pane" ? target.terminalId : null;
  const count = request?.questions.length ?? 0;
  const index = request?.index ?? 0;
  const key = target !== null ? targetKey(target) : null;

  useDecisionsReaderRetention(isOpen, close);
  const reader = useDecisionQuestionReader(target, isOpen);
  const cancel = useQuestionCancel(target, reader, isOpen);
  const { dismissal } = cancel;

  // A follow-up's notification opens its question at that follow-up (#17235),
  // once per opening, so a read again stays put. A read already on screen as
  // it opens can predate the follow-up: without it there, the thread is shown
  // once a read made for this opening lands.
  const bodyRef = useRef<HTMLDivElement>(null);
  const threadScroll = useRef<{
    request: DecisionsQuestionViewRequest;
    stale: TaggedRead | null;
    done: boolean;
  } | null>(null);
  const { shownRead } = reader;
  // Read here counts as seen on this computer (#17895), as in the inbox.
  const shownQuestion = reader.current?.result === "read" ? reader.current.question : null;
  const listed = useListedQuestion(shownQuestion, isOpen);
  useDecisionQuestionSeen(listed, shownQuestion, isOpen, bodyRef);
  useEffect(() => {
    // Content is never kept past the close, nor once it has been scrolled to.
    if (!isOpen || request?.threadMessageId === undefined) {
      threadScroll.current = null;
      return;
    }
    let pending = threadScroll.current;
    if (pending?.request !== request) {
      pending = { request, stale: shownRead, done: false };
      threadScroll.current = pending;
    }
    if (pending.done || shownRead?.read.result !== "read") return;
    const body = bodyRef.current;
    const entry = body?.querySelector(`[data-message-id="${CSS.escape(request.threadMessageId)}"]`);
    if (entry == null && shownRead === pending.stale) return;
    threadScroll.current = { request, stale: null, done: true };
    (entry ?? body?.querySelector('[data-testid="decision-question-thread"]'))?.scrollIntoView({
      block: "nearest",
    });
  }, [isOpen, request, shownRead]);

  const hasPrevious = index > 0;
  const hasNext = index < count - 1;

  const goTo = useCallback(
    (delta: number) => {
      if (request === null) return;
      const next = request.index + delta;
      if (next < 0 || next >= request.questions.length) return;
      // A Retry or a link in the content goes with the step; keep focus in the dialog.
      const active = document.activeElement;
      const stepper = delta < 0 ? previousRef.current : nextRef.current;
      // The cancel footer goes with the question it was for, so focus leaves it the same way.
      if (
        active instanceof HTMLElement &&
        active !== previousRef.current &&
        active !== nextRef.current &&
        (active === cancelRef.current ||
          active.closest('[data-testid="decision-question-body"]') !== null)
      ) {
        stepper?.focus({ preventScroll: true });
      }
      step(delta);
      announce(`Question ${(next + 1).toLocaleString()} of ${count.toLocaleString()}`);
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
  // goes once the pane's last question settles. One opened by reference goes
  // back to whatever opened it.
  const restoreFocusTo = useCallback((): HTMLElement | null => {
    if (terminalId === null) return null;
    const escaped = CSS.escape(terminalId);
    const pane =
      document.querySelector<HTMLElement>(
        `[data-panel-id="${escaped}"][data-panel-location="grid"]`
      ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`);
    return pane?.querySelector<HTMLElement>(PANE_CHIP) ?? pane;
  }, [terminalId]);

  const position = positionText(index, count);

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={close}
        size="4xl"
        maxHeight="max-h-[min(48rem,85vh)]"
        initialFocus="surface"
        restoreFocusTo={restoreFocusTo}
        // Content is never kept past the close.
        onCloseComplete={reader.release}
        data-testid="decision-question-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<DecisionsIcon size={16} />}>
            {reader.alias !== null ? `Question ${reader.alias}` : "Question"}
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
              <StepButton
                ref={nextRef}
                direction="next"
                available={hasNext}
                onStep={() => goTo(1)}
              />
            </div>
          )}
          <AppDialog.CloseButton />
        </AppDialog.Header>
        <AppDialog.Body resetScrollKey={key ?? undefined}>
          <div ref={bodyRef} data-testid="decision-question-body">
            <DecisionQuestionReadView reader={reader} target={target} active={isOpen} followUps />
          </div>
        </AppDialog.Body>
        {reader.cancellable && (
          <AppDialog.Footer
            hint={
              dismissal.progress !== null ? (
                <span role="status" data-testid="decision-question-dismiss-status">
                  {dismissal.progress}
                </span>
              ) : dismissal.fallback !== null ? (
                <span
                  className="[text-wrap:pretty]"
                  data-testid="decision-question-dismiss-fallback"
                >
                  {dismissal.fallback}
                </span>
              ) : dismissal.outcome !== null ? (
                <span
                  role="status"
                  className="[text-wrap:pretty]"
                  data-testid="decision-question-dismiss-outcome"
                >
                  {dismissal.outcome}
                </span>
              ) : undefined
            }
          >
            {dismissal.progress !== null ? (
              dismissal.phase?.kind === "lost" && (
                <Button
                  ref={cancelRef}
                  variant="outline"
                  onClick={dismissal.retry}
                  data-testid="decision-question-dismiss-retry"
                >
                  Retry
                </Button>
              )
            ) : dismissal.fallback !== null ? (
              <Button
                ref={cancelRef}
                variant="ghost-danger"
                onClick={cancel.askToWithdraw}
                data-testid="decision-question-withdraw"
              >
                Withdraw question
              </Button>
            ) : (
              <Button
                ref={cancelRef}
                variant="ghost-danger"
                onClick={cancel.ask}
                data-testid="decision-question-dismiss"
              >
                Dismiss question
              </Button>
            )}
          </AppDialog.Footer>
        )}
      </AppDialog>
      <DecisionCancelDialog
        {...cancel.dialog}
        // The footer's button, or the view's own surface once the footer shows the dismissal's progress.
        restoreFocusTo={() =>
          cancelRef.current ?? document.querySelector<HTMLElement>(`${DIALOG} > [tabindex="-1"]`)
        }
      />
    </>
  );
}
