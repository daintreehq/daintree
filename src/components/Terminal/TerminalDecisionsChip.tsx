import { useEffect, useId, useRef, useState } from "react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { Button } from "@/components/ui/button";
import { decisionsClient } from "@/clients/decisionsClient";
import { useDecisionsAnswerStore } from "@/store/decisionsAnswerStore";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { useDecisionsInboxStore } from "@/store/decisionsInboxStore";
import { useDecisionsQuestionViewStore } from "@/store/decisionsQuestionViewStore";
import { useOverlayFocusRestore } from "@/components/ui/overlay-focus-restore";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { hasDraftText } from "@/lib/draftKey";
import { getRuntimeOrBootAgentId } from "@/utils/terminalType";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isPtyPanel } from "@shared/types/panel";
import { useDecisionsOn } from "@/hooks/useDecisionsOn";
import { usePaneClearedQuestions } from "@/hooks/useDecisionsWaitingCount";
import { isRemoteWindow } from "@/hooks/useHostPlatform";
import { cn } from "@/lib/utils";
import {
  HEADER_CHIP_CLASS,
  HEADER_CHIP_FOCUS_CLASS,
  HEADER_CHIP_SURFACE,
  HEADER_CHIP_TRIGGER_CLASS,
  holdPaneSelection,
} from "./terminalHeaderChip";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { pluralize } from "@/lib/pluralize";
import { DecisionCancelDialog } from "@/components/Decisions/DecisionCancelDialog";
import { dismissingQuestionIds } from "@/components/Decisions/decisionDeclineSend";
import type { DecisionCancelTarget } from "@/components/Decisions/decisionCancelModel";
import { paneQuestion, questionOf } from "@/components/Decisions/decisionQuestionTarget";
import { useDecisionsClock } from "@/components/Decisions/useDecisionsClock";
import { REVIEW_ATTENTION_LABEL } from "@/components/Decisions/decisionsAttentionModel";
import type { PaneDecisionState } from "@shared/types/decisions";
import {
  answerNote,
  cancelNote,
  chipLabel,
  chipSummary,
  deadlineNote,
  deadlinePassed,
  decisionItems,
  deliveryNotes,
  isCancellable,
  itemSentence,
  needsAttention,
  paneWaitOf,
  questionCount,
  readsPaneWait,
  setAsideOf,
  sharedWaitingStatus,
  type DecisionItem,
} from "./decisionsChipModel";

/**
 * One pane's Decisions state, as main last reported it — and only while
 * Decisions is on: off, nothing is subscribed and nothing is read.
 */
export function usePaneDecisionState(terminalId: string, on: boolean): PaneDecisionState | null {
  const [state, setState] = useState<PaneDecisionState | null>(null);

  useEffect(() => {
    if (!on) return;
    // An ambient chip must never take the pane header down with it: a bridge
    // that is missing or throws leaves the chip hidden.
    try {
      return decisionsClient.watchPaneState(terminalId, setState);
    } catch {
      return undefined;
    }
  }, [terminalId, on]);

  return on && state?.terminalId === terminalId ? state : null;
}

const ATTENTION_KINDS = new Set<DecisionItem["kind"]>(["attention", "uncertain"]);

/** The IPC read takes at most this many ids at once. */
const SUMMARY_BATCH = 64;

/**
 * The opening line of each listed question, read while the dropdown is open
 * and held only in memory. A line that can't be read leaves its row named by
 * alias alone.
 */
export function useQuestionLines(
  terminalId: string,
  questionIds: readonly string[],
  active: boolean
): ReadonlyMap<string, string> {
  const [lines, setLines] = useState<{ key: string; lines: ReadonlyMap<string, string> } | null>(
    null
  );
  // Sorted: a row moving down the list (#18053) is no reason to read every line again.
  const key = [terminalId, ...[...new Set(questionIds)].sort()].join("\u0000");

  useEffect(() => {
    // The key is the pane and its ids, so the read runs again only when either changes.
    const ids = key.split("\u0000").slice(1);
    if (!active || ids.length === 0) return;
    let live = true;
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += SUMMARY_BATCH) {
      batches.push(ids.slice(i, i + SUMMARY_BATCH));
    }
    Promise.all(
      batches.map((batch) => decisionsClient.getQuestionSummaries(terminalId, batch))
    ).then(
      (results) => {
        if (!live) return;
        const found = new Map<string, string>();
        for (const result of results) {
          if (result.result !== "read") continue;
          for (const summary of result.summaries) {
            if (summary.result === "read" && summary.line !== null) {
              found.set(summary.questionId, summary.line);
            }
          }
        }
        setLines({ key, lines: found });
      },
      // The rows still name each question by alias.
      () => {}
    );
    return () => {
      live = false;
    };
  }, [active, key, terminalId]);

  return active && lines?.key === key ? lines.lines : NO_LINES;
}

const NO_LINES: ReadonlyMap<string, string> = new Map();

// A component of its own because only something under the Popover root can reach its focus policy.
function ReviewAnswersButton({ onReview }: { onReview: () => void }) {
  const focusRestore = useOverlayFocusRestore();
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        // The attention dialog takes focus; the popover mustn't take it back.
        focusRestore?.expectHandoff();
        onReview();
      }}
      data-testid="terminal-decisions-review"
    >
      {REVIEW_ATTENTION_LABEL}
    </Button>
  );
}

// Under the Popover root for its focus policy, as `ReviewAnswersButton` is.
function OpenInboxButton({ onOpen }: { onOpen: () => void }) {
  const focusRestore = useOverlayFocusRestore();
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={() => {
        // The inbox takes focus; the popover mustn't take it back.
        focusRestore?.expectHandoff();
        onOpen();
      }}
      data-testid="terminal-decisions-inbox"
    >
      Open inbox
    </Button>
  );
}

function DecisionRow({
  item,
  line,
  nowMs,
  showStatus,
  sharedStatusId,
  onOpen,
  onDismiss,
}: {
  item: DecisionItem;
  line: string | null;
  nowMs: number;
  /** False when the list says it once above every row. */
  showStatus: boolean;
  /** The line that says it once, when the row doesn't. */
  sharedStatusId: string;
  onOpen: () => void;
  /** Null for a question that can't be dismissed now. */
  onDismiss: (() => void) | null;
}) {
  const attention = ATTENTION_KINDS.has(item.kind);
  const deadline = deadlineNote(item, nowMs);
  // No longer waiting on the person (#18053): listed, a step quieter.
  const quiet = setAsideOf(item) !== null;
  const ink = quiet ? "text-text-secondary" : "text-text-primary";
  // Past its deadline the row says that, not that it can still be answered: a
  // row set aside for it already says so in its status.
  const statusShown = showStatus && !(deadlinePassed(item, nowMs) && !quiet);
  const focusRestore = useOverlayFocusRestore();
  return (
    // Two sibling controls, never one inside the other: the row opens the
    // question, and Dismiss asks before declining it.
    <li className="flex items-start hover:bg-overlay-subtle">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left outline-hidden focus-visible:bg-overlay-subtle focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
        onClick={() => {
          // The question view takes focus; the popover mustn't take it back.
          focusRestore?.expectHandoff();
          onOpen();
        }}
        // The status isn't in the row's name when the list says it once, so a focused row says it.
        aria-describedby={showStatus ? undefined : sharedStatusId}
        data-question-id={item.questionId}
        data-testid="terminal-decisions-row"
      >
        <span className={cn("w-9 shrink-0 font-mono text-xs leading-5 tabular-nums", ink)}>
          {item.label}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {line !== null && (
            <span
              className={cn("truncate text-xs leading-5 font-medium", ink)}
              data-testid="terminal-decisions-row-line"
            >
              {line}
            </span>
          )}
          {/* The glyph marks the status's first line, however many it wraps to. */}
          {statusShown && (
            <span
              className={cn(
                "flex items-start gap-1 [text-wrap:pretty]",
                line !== null
                  ? "text-2xs leading-4 text-text-secondary"
                  : cn("text-xs leading-5", ink)
              )}
            >
              {attention && (
                <TriangleAlert
                  className={cn(
                    "size-3 shrink-0 text-status-warning",
                    line !== null ? "mt-0.5" : "mt-1"
                  )}
                  aria-hidden="true"
                />
              )}
              {item.status}
            </span>
          )}
          {item.reason !== null && (
            <span className="text-2xs text-text-secondary [text-wrap:balance]">{item.reason}</span>
          )}
          {deadline !== null && (
            <span
              className="text-2xs text-text-secondary tabular-nums"
              data-testid="terminal-decisions-deadline"
            >
              {deadline}
            </span>
          )}
        </span>
        {item.askedAt !== null && (
          <TimeAgo
            timestamp={item.askedAt}
            prefix="asked "
            className="shrink-0 text-3xs leading-5 text-text-secondary"
          />
        )}
      </button>
      {onDismiss !== null && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1.5 mr-2 shrink-0"
          aria-label={`Dismiss question ${item.label}…`}
          onClick={() => {
            // The confirmation takes focus; the popover mustn't take it back.
            focusRestore?.expectHandoff();
            onDismiss();
          }}
          data-testid="terminal-decisions-dismiss"
        >
          Dismiss…
        </Button>
      )}
    </li>
  );
}

/**
 * Visible on a pane whose agent asked a question through Daintree Decisions,
 * while the question is out, its answer is waiting to be typed in, or the
 * answer needs a person. Self-gating: with Decisions off it renders nothing
 * and watches nothing.
 */
export function TerminalDecisionsChip({ terminalId }: { terminalId: string }) {
  const on = useDecisionsOn();
  const state = usePaneDecisionState(terminalId, on);
  const headingId = useId();
  const sharedStatusId = useId();
  const [open, setOpen] = useState(false);
  const openAttention = useDecisionsAttentionStore((s) => s.open);
  const openInbox = useDecisionsInboxStore((s) => s.open);
  // A question steps down as its deadline passes, popover open or not (#18053);
  // closed, only a deadline passing is waited for, never the minutes ticking down.
  const deadlines = state?.openQuestions.map((question) => question.expiresAt) ?? [];
  const nowMs = useDecisionsClock(
    deadlines,
    open || deadlines.some((deadline) => deadline !== null),
    open
  );
  // Only a pane with a question still out joins the list that says which were cleared.
  const cleared = usePaneClearedQuestions(terminalId, (state?.openQuestions.length ?? 0) > 0);
  // Every pane header mounts this chip, so only one with something to say reads the drafts.
  const watchDrafts = readsPaneWait(state, nowMs);
  const hasDraft = useTerminalInputStore(
    (s) => watchDrafts && hasDraftText(s.draftInputs, terminalId)
  );
  const queuesInput = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    const agentId = panel && isPtyPanel(panel) ? getRuntimeOrBootAgentId(panel) : undefined;
    return (
      agentId !== undefined &&
      getEffectiveAgentConfig(agentId)?.capabilities?.queuesInputWhileWorking === true
    );
  });
  const wait = paneWaitOf({ hasDraft, queuesInput });
  const openQuestion = useDecisionsQuestionViewStore((s) => s.open);
  // Withdrawals main committed and the relay hasn't confirmed, held in memory
  // for as long as this view shows the pane; each shows until the pane's state drops it.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  // The pane's questions dismissed from this computer (#17239), here or in the
  // question view: each shows as dismissing while its decline is under way or
  // taken, and as waiting again if it couldn't be. Joined, so the chip renders
  // again only when the set changes, not on every draft keystroke.
  const dismissingIds = useDecisionsAnswerStore((store) =>
    dismissingQuestionIds(store.records, terminalId)
  );
  const dismissing = new Set(dismissingIds === "" ? [] : dismissingIds.split("\u0000"));
  const [cancel, setCancel] = useState<{ target: DecisionCancelTarget; open: boolean } | null>(
    null
  );
  const chipRef = useRef<HTMLButtonElement>(null);
  const items =
    state === null ? [] : decisionItems(state, wait, cancelling, dismissing, { nowMs, cleared });
  const questionIds = items.map((item) => item.questionId);
  const lines = useQuestionLines(terminalId, questionIds, open);

  // Outside the popover and the chip, so neither closing nor the last row going takes it away.
  const askedId = cancel === null ? null : questionOf(cancel.target.question).questionId;
  const asked = askedId === null ? undefined : (id: string) => id === askedId;
  const openIds = new Set(state?.openQuestions.map((question) => question.questionId));
  const cancelDialog = (
    <DecisionCancelDialog
      target={cancel?.target ?? null}
      isOpen={cancel?.open === true}
      // A question being dismissed from here still waits until it closes.
      waiting={items.some(
        (item) =>
          asked?.(item.questionId) === true && (isCancellable(item) || item.kind === "dismissing")
      )}
      queued={items.some((item) => asked?.(item.questionId) === true && item.kind === "queued")}
      onClose={() =>
        setCancel((current) => (current === null ? null : { ...current, open: false }))
      }
      // Withdrawals of questions that have stopped waiting are let go as another is added.
      onCancelling={(questionId) =>
        setCancelling((current) =>
          new Set([...current].filter((id) => openIds.has(id))).add(questionId)
        )
      }
      restoreFocusTo={() => {
        const chip = chipRef.current;
        if (chip?.isConnected) return chip;
        const escaped = CSS.escape(terminalId);
        return (
          document.querySelector<HTMLElement>(
            `[data-panel-id="${escaped}"][data-panel-location="grid"]`
          ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`)
        );
      }}
    />
  );

  const attention = needsAttention(items);
  const summary = chipSummary(items);
  const label = chipLabel(items);
  // Several questions in the same state say it once, above the list.
  const sharedStatus = sharedWaitingStatus(items, nowMs);
  const answerable = sharedStatus === null ? answerNote(items, nowMs) : null;
  const notes = [...(answerable !== null ? [answerable] : []), ...deliveryNotes(items, wait)];
  const unavailable = cancelNote(items);
  if (unavailable !== null) notes.push(unavailable);

  // One shape whether or not the chip shows, so the dialog keeps its place,
  // and its state, when the last question goes while it is open.
  return (
    <>
      {items.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          {/* Selecting the pane would close the popover this opens. */}
          <span className="contents" onClick={holdPaneSelection} data-fit-priority="80">
            {/* Several questions make a sentence too long to read in the usual
            2.5 s, so this one stays while hovered or focused. */}
            <Tooltip autoDismiss={false} disableHoverableContent={false}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    ref={chipRef}
                    type="button"
                    className={cn(
                      HEADER_CHIP_CLASS,
                      HEADER_CHIP_SURFACE,
                      HEADER_CHIP_TRIGGER_CLASS,
                      HEADER_CHIP_FOCUS_CLASS,
                      "hover:text-text-primary"
                    )}
                    aria-label={summary}
                    data-testid="terminal-decisions-chip"
                  >
                    {/* The mark says whose chip this is in every state; the warning
                    glyph follows the alias or count, so a count never reads as
                    that many warnings, and comes before the delivering detail,
                    so it never reads as belonging to the answer being typed in.
                    Shape as well as hue, for forced colours. */}
                    <DecisionsIcon className="w-3 h-3 shrink-0" size={12} />
                    <span className="tabular-nums">{label.text}</span>
                    {attention && (
                      <TriangleAlert
                        className="w-3 h-3 shrink-0 text-status-warning"
                        aria-hidden="true"
                      />
                    )}
                    {/* A narrow header keeps the count and the warning; the
                    breakdown is in the tooltip and the popover. */}
                    {label.detail !== null && (
                      <span className="tabular-nums @max-[480px]/header:hidden">
                        {label.detail}
                      </span>
                    )}
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {items.length === 1 ? itemSentence(items[0]!) : summary}
              </TooltipContent>
            </Tooltip>
          </span>
          <PopoverContent
            side="bottom"
            align="end"
            className="w-96 p-0"
            aria-labelledby={headingId}
            data-testid="terminal-decisions-popover"
            // A click here must not select the pane underneath.
            onClick={(event) => event.preventDefault()}
          >
            <div className={POPOVER_HEADER_CLASS}>
              <span id={headingId} className={POPOVER_TITLE_CLASS}>
                Decisions
              </span>
              <span className={POPOVER_HEADER_META_CLASS}>
                {pluralize(questionCount(items), "question")}
              </span>
            </div>
            {sharedStatus !== null && (
              <p
                id={sharedStatusId}
                className="border-b border-divider px-3 py-2 text-xs text-text-primary [text-wrap:pretty]"
                data-testid="terminal-decisions-shared-status"
              >
                {sharedStatus}
              </p>
            )}
            <ul
              className="flex max-h-80 flex-col divide-y divide-divider overflow-y-auto"
              aria-label="Questions"
            >
              {items.map((item) => (
                <DecisionRow
                  key={item.questionId}
                  item={item}
                  line={lines.get(item.questionId) ?? null}
                  nowMs={nowMs}
                  showStatus={sharedStatus === null}
                  sharedStatusId={sharedStatusId}
                  onOpen={() => {
                    setOpen(false);
                    openQuestion(terminalId, questionIds, item.questionId);
                  }}
                  onDismiss={
                    isCancellable(item)
                      ? () => {
                          setOpen(false);
                          setCancel({
                            target: {
                              question: paneQuestion(terminalId, item.questionId),
                              label: item.label,
                              line: lines.get(item.questionId) ?? null,
                              // Named by alias alone: dismissed as it is open when confirmed.
                              revision: null,
                              setAside: setAsideOf(item) !== null,
                            },
                            open: true,
                          });
                        }
                      : null
                  }
                />
              ))}
            </ul>
            {notes.length > 0 && (
              <div className="flex flex-col gap-0.5 border-t border-divider px-3 py-2 text-2xs text-text-secondary">
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            )}
            {/* Both lists read this computer's questions; a Remote Host keeps its own panes'. */}
            {!isRemoteWindow() && (
              <div className="flex justify-end gap-2 border-t border-divider px-3 py-2">
                {/* Every question on this computer, this pane's first (#17231). */}
                <OpenInboxButton
                  onOpen={() => {
                    setOpen(false);
                    openInbox({ terminalId });
                  }}
                />
                {/* The answers that need a person are acted on in the list, which
                also holds those whose pane is gone. */}
                {attention && (
                  <ReviewAnswersButton
                    onReview={() => {
                      setOpen(false);
                      openAttention(terminalId);
                    }}
                  />
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
      {cancelDialog}
    </>
  );
}
