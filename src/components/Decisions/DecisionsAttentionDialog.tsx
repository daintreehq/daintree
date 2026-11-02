import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { DecisionsIcon, TriangleAlert } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { decisionsClient } from "@/clients/decisionsClient";
import { useSkeletonGate } from "@/hooks/useDeferredLoading";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDecisionsAttentionStore } from "@/store/decisionsAttentionStore";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { pluralize } from "@/lib/pluralize";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type {
  DecisionsAnswerDestination,
  DecisionsAnswerDestinations,
  DecisionsAnswerOutcome,
  DecisionsAttentionItem,
  DecisionsAttentionList,
} from "@shared/types/decisionsAttention";
import {
  EMPTY_DESCRIPTION,
  LIST_DESCRIPTION,
  RESUME_PENDING,
  STILL_WORKING,
  agentLabel,
  aliasLabel,
  destinationDetail,
  fromLines,
  leavesList,
  missingAnswerText,
  originParts,
  outcomeSeverity,
  outcomeText,
  paneName,
  reasonText,
  remainingText,
  statusText,
  toLines,
  type PaneLines,
} from "./decisionsAttentionModel";

type Busy = "resume" | "reassign" | "handled";

interface PendingMove {
  item: DecisionsAttentionItem;
  destination: DecisionsAnswerDestination;
}

interface Outcome {
  message: string;
  severity: "success" | "warning";
}

/** A question's actions, so focus can land on the next one when its item leaves. */
const ITEM_ACTIONS = "[data-attention-action]";

/** A pane's Decisions chip, where the close returns when the list was opened from it. */
const PANE_CHIP = '[data-testid="terminal-decisions-chip"]';

/** Pushes for panes arrive in bursts; one read after they settle. */
const REFRESH_DEBOUNCE_MS = 300;

/** Past this, a resume's wait says it is still going. */
const STILL_WORKING_MS = 5_000;

type WorktreeName = (id: string, fallback: string | null) => string | null;

function useWorktreeNames(): WorktreeName {
  const { worktrees } = useWorktrees();
  return useCallback(
    (id: string, fallback: string | null) => {
      const known = worktrees.find((worktree) => worktree.id === id);
      return worktreeDisplayName(known) ?? fallback;
    },
    [worktrees]
  );
}

/** True once `active` has held for `ms`; false again as soon as it ends. */
function useHeldFor(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return held;
}

/** The answer as the phone sent it; a long one opens in place rather than being cut for good. */
function AnswerPreview({ item }: { item: DecisionsAttentionItem }) {
  const { answer } = item;
  const alias = aliasLabel(item.alias);
  const textRef = useRef<HTMLQuoteElement>(null);
  const textId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el === null || expanded) return;
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [answer?.text, expanded]);

  if (answer === null) {
    return (
      <p className="text-xs text-text-secondary [text-wrap:pretty]">
        {missingAnswerText(item.answerUnavailable)}
      </p>
    );
  }
  const source = answer.source === "proxy" ? "Decision model's answer" : "Your answer";
  return (
    <figure className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2">
      <figcaption className="text-2xs text-text-secondary">
        {source}
        {answer.correction && ", correcting an earlier one"}
        {" · "}
        <TimeAgo timestamp={answer.answeredAt} />
      </figcaption>
      {answer.choices.length > 0 && (
        <p className="text-xs font-semibold text-text-primary [text-wrap:pretty]">
          {answer.choices.join(", ")}
        </p>
      )}
      {answer.text !== null && (
        <blockquote
          ref={textRef}
          id={textId}
          className={
            expanded
              ? "whitespace-pre-wrap text-xs text-text-primary [text-wrap:pretty]"
              : "line-clamp-4 whitespace-pre-wrap text-xs text-text-primary [text-wrap:pretty]"
          }
        >
          {answer.text}
        </blockquote>
      )}
      {(clamped || expanded) && (
        <Button
          variant="link"
          size="xs"
          className="self-start px-0"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={expanded ? `Show less for ${alias}` : `Show full answer for ${alias}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full answer"}
        </Button>
      )}
    </figure>
  );
}

interface ItemProps {
  item: DecisionsAttentionItem;
  worktreeName: WorktreeName;
  busy: Busy | null;
  onResume: () => void;
  onChoose: (destination: DecisionsAnswerDestination) => void;
  onHandled: () => void;
}

function AttentionItem({ item, worktreeName, busy, onResume, onChoose, onHandled }: ItemProps) {
  const headingId = useId();
  const alias = aliasLabel(item.alias);
  const { pane, place } = originParts(
    item,
    worktreeName(item.origin.worktreeId, item.origin.worktreeName)
  );
  const reason = reasonText(item.reason);
  const [destinations, setDestinations] = useState<DecisionsAnswerDestinations | null>(null);
  const [destinationsError, setDestinationsError] = useState<string | null>(null);
  const locked = busy !== null;
  const stillWorking = useHeldFor(busy === "resume", STILL_WORKING_MS);
  const announce = useAnnouncerStore((state) => state.announce);
  // The wait's reassurance reaches a screen reader too, once, outside the busy item.
  useEffect(() => {
    if (stillWorking) announce(`${alias}: ${STILL_WORKING}`);
  }, [stillWorking, alias, announce]);

  const loadDestinations = (open: boolean) => {
    if (!open) return;
    setDestinations(null);
    setDestinationsError(null);
    decisionsClient
      .listAnswerDestinations(item.questionId)
      .then(setDestinations, (error) =>
        setDestinationsError(formatErrorMessage(error, "Couldn't list the running agents"))
      );
  };

  return (
    <li
      className="flex flex-col gap-2 py-4"
      aria-labelledby={headingId}
      aria-busy={locked || undefined}
      data-question-id={item.questionId}
      data-terminal-id={item.origin.paneId}
      data-testid="decisions-attention-item"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-text-secondary tabular-nums">{alias}</span>
        <h3
          id={headingId}
          className={
            item.question !== null
              ? "min-w-0 flex-1 text-sm font-medium text-text-primary [text-wrap:pretty]"
              : "min-w-0 flex-1 text-sm text-text-secondary [text-wrap:pretty]"
          }
        >
          {item.question ?? "Question couldn't be opened"}
        </h3>
        <TimeAgo
          timestamp={item.askedAt}
          prefix="asked "
          className="shrink-0 text-xs text-text-secondary"
        />
      </div>
      <p className="text-xs text-text-secondary [text-wrap:pretty]">
        {pane}
        {place !== null && ` · ${place}`}
      </p>
      <p className="flex items-start gap-1.5 text-xs text-text-primary [text-wrap:pretty]">
        <TriangleAlert className="mt-0.5 size-3 shrink-0 text-status-warning" aria-hidden="true" />
        <span>
          <span className="font-medium">{statusText(item)}.</span>
          {reason !== null && ` ${reason}`}
        </span>
      </p>
      <AnswerPreview item={item} />
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {item.canResume && (
          <Button
            variant="outline"
            size="xs"
            aria-label={`Try resume for ${alias}`}
            aria-busy={busy === "resume" || undefined}
            aria-disabled={busy === "resume" || undefined}
            data-attention-action=""
            disabled={locked && busy !== "resume"}
            // Busy keeps its focus and its width: the glyph turns while it runs.
            onClick={busy === "resume" ? undefined : onResume}
          >
            <SpinningIcon icon={RefreshCw} active={busy === "resume"} aria-hidden="true" />
            Try resume
          </Button>
        )}
        {item.canReassign && (
          <DropdownMenu onOpenChange={loadDestinations}>
            <DropdownMenuTrigger asChild>
              <Button
                variant={item.canResume ? "ghost" : "outline"}
                size="xs"
                aria-label={`Choose destination for ${alias}`}
                className="data-[state=open]:bg-overlay-soft"
                data-attention-action=""
                loading={busy === "reassign"}
                disabled={locked && busy !== "reassign"}
              >
                Choose destination
                <ChevronDown aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-80">
              <DropdownMenuLabel>Agents running here</DropdownMenuLabel>
              {destinations === null && destinationsError === null && (
                <DropdownMenuItem disabled>Looking…</DropdownMenuItem>
              )}
              {destinationsError !== null && (
                <DropdownMenuItem disabled>{destinationsError}</DropdownMenuItem>
              )}
              {destinations !== null && destinations.result !== "listed" && (
                <DropdownMenuItem disabled>
                  {destinations.result === "not-running"
                    ? "Decisions isn't running"
                    : "This answer can't be moved now"}
                </DropdownMenuItem>
              )}
              {destinations?.result === "listed" && destinations.destinations.length === 0 && (
                <DropdownMenuItem disabled>No agents are running here</DropdownMenuItem>
              )}
              {destinations?.result === "listed" &&
                destinations.destinations.map((destination) => (
                  <DropdownMenuItem
                    key={destination.terminalId}
                    onSelect={() => onChoose(destination)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="flex w-full items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-text-primary">
                        {destination.title}
                      </span>
                      {destination.askedHere && (
                        <span className="shrink-0 text-2xs text-text-secondary">asked here</span>
                      )}
                    </span>
                    <span className="w-full truncate text-2xs text-text-secondary">
                      {destinationDetail(
                        destination,
                        worktreeName(destination.worktreeId, destination.worktreeName)
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {item.answer !== null && (
          <CopyButton
            label="Copy answer"
            aria-label={`Copy answer to ${alias}`}
            variant={item.canResume || item.canReassign ? "ghost" : "outline"}
            size="xs"
            data-attention-action=""
            disabled={locked}
            text={() => decisionsClient.copyAnswer(item.questionId)}
          />
        )}
        {/* Pulled out by its own padding, so its words end on the column's edge. */}
        <Button
          variant="ghost"
          size="xs"
          className="-mr-2.5 ml-auto"
          aria-label={`Mark ${alias} handled`}
          data-attention-action=""
          loading={busy === "handled"}
          disabled={locked && busy !== "handled"}
          onClick={onHandled}
        >
          Mark handled
        </Button>
      </div>
      {busy === "resume" && (
        <p className="text-xs text-text-secondary [text-wrap:pretty]">
          {stillWorking ? `${RESUME_PENDING} ${STILL_WORKING}` : RESUME_PENDING}
        </p>
      )}
    </li>
  );
}

/** A pane in the move confirmation: what it's called, then its agent and place. */
function PaneLinesValue({ lines }: { lines: PaneLines }) {
  return (
    <dd className="flex min-w-0 flex-col">
      <span className="text-text-primary [text-wrap:pretty]">{lines.primary}</span>
      <span className="text-text-secondary [text-wrap:pretty]">{lines.detail}</span>
    </dd>
  );
}

/** The list's shape while its first read is out, past the skeleton gate. */
function AttentionSkeleton() {
  return (
    <Skeleton label="Loading answers" className="flex flex-col gap-2 py-4">
      <SkeletonBone className="h-4 w-3/4" />
      <SkeletonBone className="h-3 w-1/2" />
      <SkeletonBone className="h-3 w-2/3" />
      <SkeletonBone className="h-14 w-full rounded-[var(--radius-md)]" />
    </Skeleton>
  );
}

interface DecisionsAttentionDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The answers Daintree couldn't type in on its own (#16020): the pane that
 * asked was relaunched or closed, its worktree removed, resuming it failed,
 * or a crash left it unknown whether the answer went in. Each can be copied,
 * resumed into its agent, sent to another running agent after a
 * confirmation naming both panes, or marked handled. Nothing here is typed
 * in until the person chooses.
 */
export function DecisionsAttentionDialog({ isOpen, onClose }: DecisionsAttentionDialogProps) {
  const request = useDecisionsAttentionStore((state) => state.request);
  const announce = useAnnouncerStore((state) => state.announce);
  const worktreeName = useWorktreeNames();
  const [list, setList] = useState<DecisionsAttentionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlyMap<string, Busy>>(new Map());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [move, setMove] = useState<PendingMove | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** The row a move was confirmed from, for the confirmation's close to land after it. */
  const moveFrom = useRef<{ questionId: string; index: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** The place in the list of an item whose action may take it off, for focus to land after. */
  const focusAfter = useRef<{ questionId: string; index: number } | null>(null);
  const reading = useRef(0);
  const showSkeleton = useSkeletonGate(isOpen && list === null && loadError === null);

  const items = useMemo(() => (list?.result === "listed" ? list.items : []), [list]);

  const refresh = useCallback(async () => {
    const ticket = ++reading.current;
    try {
      const next = await decisionsClient.listAttention();
      if (ticket !== reading.current) return;
      setList(next);
      setLoadError(null);
    } catch (error) {
      if (ticket !== reading.current) return;
      setLoadError(formatErrorMessage(error, "Couldn't read the answers"));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setOutcome(null);
    void refresh();
  }, [isOpen, request.seq, refresh]);

  // Panes' Decisions state changes whenever an answer moves; read again once a burst settles.
  useEffect(() => {
    if (!isOpen) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let off: (() => void) | null = null;
    try {
      off = decisionsClient.onPaneState(() => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
      });
    } catch {
      off = null;
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
      off?.();
    };
  }, [isOpen, refresh]);

  // Opened from a pane's chip: its first answer's first action takes the
  // focus once listed, ringed when the keyboard brought the person here.
  // With none listed for that pane, the list itself holds it.
  const focusedFor = useRef(0);
  useEffect(() => {
    if (!isOpen || request.terminalId === null || focusedFor.current === request.seq) return;
    if (list === null && loadError === null) return;
    focusedFor.current = request.seq;
    const target = listRef.current?.querySelector<HTMLElement>(
      `[data-terminal-id="${CSS.escape(request.terminalId)}"] ${ITEM_ACTIONS}`
    );
    if (target) target.focus();
    else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
  }, [isOpen, list, loadError, request]);

  // An item that left took the focus with it: the next one's first action
  // gets it, else the one before, else the list's own place in the dialog.
  useEffect(() => {
    const pending = focusAfter.current;
    if (pending === null || list === null) return;
    if (items.some((item) => item.questionId === pending.questionId)) return;
    focusAfter.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && document.contains(active)) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [];
    const row = rows[Math.min(pending.index, rows.length - 1)];
    const next = row?.querySelector<HTMLElement>(ITEM_ACTIONS);
    if (next) next.focus();
    else bodyRef.current?.focus({ focusVisible: false } as FocusOptions);
  }, [items, list]);

  const run = async (
    item: DecisionsAttentionItem,
    kind: Busy,
    action: () => Promise<DecisionsAnswerOutcome>
  ) => {
    setBusy((current) => new Map(current).set(item.questionId, kind));
    if (kind === "resume")
      announce(`Resuming the agent for ${aliasLabel(item.alias)}. ${RESUME_PENDING}`);
    focusAfter.current = {
      questionId: item.questionId,
      index: items.findIndex((candidate) => candidate.questionId === item.questionId),
    };
    let next: Outcome;
    try {
      const result = await action();
      next = { message: outcomeText(item.alias, result), severity: outcomeSeverity(result) };
      if (!leavesList(result)) focusAfter.current = null;
    } catch (error) {
      focusAfter.current = null;
      next = {
        message: formatErrorMessage(error, `Couldn't change ${aliasLabel(item.alias)}'s answer`),
        severity: "warning",
      };
    }
    setBusy((current) => {
      const remaining = new Map(current);
      remaining.delete(item.questionId);
      return remaining;
    });
    setOutcome(next);
    announce(next.message);
    await refresh();
  };

  const confirmMove = () => {
    if (move === null) return;
    const { item, destination } = move;
    setMove(null);
    void run(item, "reassign", () =>
      decisionsClient.reassignAnswer(item.questionId, destination.terminalId)
    );
  };

  // Opened from a chip, the close returns to that pane: its chip while it
  // shows, else the pane itself, since the chip goes with its last answer.
  const restoreFocusTo = useCallback((): HTMLElement | null => {
    const id = request.terminalId;
    if (id === null) return null;
    const escaped = CSS.escape(id);
    const pane =
      document.querySelector<HTMLElement>(
        `[data-panel-id="${escaped}"][data-panel-location="grid"]`
      ) ?? document.querySelector<HTMLElement>(`[data-panel-id="${escaped}"]`);
    return pane?.querySelector<HTMLElement>(PANE_CHIP) ?? pane;
  }, [request.terminalId]);

  const restoreAfterMove = useCallback((): HTMLElement | null => {
    const from = moveFrom.current;
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-question-id]") ?? [])];
    if (from !== null && rows.length > 0) {
      const row =
        rows.find((candidate) => candidate.dataset.questionId === from.questionId) ??
        rows[Math.min(Math.max(from.index, 0), rows.length - 1)];
      const target = row?.querySelector<HTMLElement>(ITEM_ACTIONS);
      if (target) return target;
    }
    return bodyRef.current;
  }, []);

  const count = items.length;
  const empty = list?.result === "listed" && count === 0;

  return (
    <>
      <AppDialog
        isOpen={isOpen}
        onClose={onClose}
        size="lg"
        maxHeight="max-h-[min(44rem,85vh)]"
        initialFocus="surface"
        restoreFocusTo={restoreFocusTo}
        data-testid="decisions-attention-dialog"
      >
        <AppDialog.Header>
          <AppDialog.Title icon={<DecisionsIcon size={16} />}>
            Answers needing attention
          </AppDialog.Title>
          <AppDialog.CloseButton />
        </AppDialog.Header>
        {/* What the last action did stays in view, however far the list scrolled. */}
        {outcome !== null && (
          <div className="px-6 pt-1" data-testid="decisions-attention-outcome">
            <Callout severity={outcome.severity} size="compact">
              {outcome.message}
            </Callout>
          </div>
        )}
        <AppDialog.Body>
          {/* Focus lands here only when no row is left to take it; ringed when
              the keyboard brought it, like any other stop. */}
          <div
            ref={bodyRef}
            tabIndex={-1}
            className="flex flex-col rounded-[var(--radius-sm)] outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
          >
            <AppDialog.Description className="text-xs text-text-secondary [text-wrap:pretty]">
              {empty ? EMPTY_DESCRIPTION : LIST_DESCRIPTION}
            </AppDialog.Description>
            {loadError !== null && (
              <Callout
                severity="warning"
                size="compact"
                className="mt-3"
                action={
                  <Button variant="outline" size="xs" onClick={() => void refresh()}>
                    Retry
                  </Button>
                }
              >
                {loadError}
              </Callout>
            )}
            {list === null && loadError === null && showSkeleton && <AttentionSkeleton />}
            {list?.result === "not-running" && (
              <p className="py-4 text-xs text-text-secondary [text-wrap:pretty]">
                Decisions isn't delivering answers on this computer right now, so none can be read.
                Set up or reconnect the relay in Settings → Decisions.
              </p>
            )}
            {count > 0 && (
              <ul
                ref={listRef}
                aria-label={`${pluralize(count, "answer")} needing attention`}
                className="flex flex-col divide-y divide-divider"
              >
                {items.map((item) => (
                  <AttentionItem
                    key={item.questionId}
                    item={item}
                    worktreeName={worktreeName}
                    busy={busy.get(item.questionId) ?? null}
                    onResume={() =>
                      void run(item, "resume", () => decisionsClient.resumeAnswer(item.questionId))
                    }
                    onChoose={(destination) => {
                      moveFrom.current = {
                        questionId: item.questionId,
                        index: items.findIndex(
                          (candidate) => candidate.questionId === item.questionId
                        ),
                      };
                      setMove({ item, destination });
                    }}
                    onHandled={() =>
                      void run(item, "handled", () =>
                        decisionsClient.markAnswerHandled(item.questionId)
                      )
                    }
                  />
                ))}
              </ul>
            )}
          </div>
        </AppDialog.Body>
        {/* How many are left, and a rule that marks more below when the list scrolls. */}
        {count > 0 && <AppDialog.Footer hint={remainingText(count)} />}
      </AppDialog>
      <ConfirmDialog
        isOpen={move !== null}
        onClose={() => setMove(null)}
        zIndex="nested"
        variant="default"
        title={
          move === null
            ? ""
            : `Send ${aliasLabel(move.item.alias)}'s answer to ${paneName(
                move.destination.title,
                agentLabel(move.destination)
              )}?`
        }
        description={
          <span className="[text-wrap:pretty]">
            Daintree waits until it sees that agent at its prompt, types the answer in once, and
            records the move in the Decisions audit trail.
          </span>
        }
        // The menu that opened it is its row's; when a fast move has already
        // taken that row away, the close lands on the next row, else the one
        // before, else the list's own place.
        restoreFocusTo={restoreAfterMove}
        confirmLabel="Send answer"
        onConfirm={confirmMove}
      >
        {move !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-[var(--radius-md)] bg-overlay-subtle px-3 py-2 text-xs">
            {move.item.question !== null && (
              <>
                <dt className="text-text-secondary">Question</dt>
                <dd className="text-text-primary [text-wrap:pretty]">{move.item.question}</dd>
              </>
            )}
            <dt className="text-text-secondary">From</dt>
            <PaneLinesValue
              lines={fromLines(
                move.item,
                worktreeName(move.item.origin.worktreeId, move.item.origin.worktreeName)
              )}
            />
            <dt className="text-text-secondary">To</dt>
            <PaneLinesValue
              lines={toLines(
                move.destination,
                worktreeName(move.destination.worktreeId, move.destination.worktreeName)
              )}
            />
          </dl>
        )}
      </ConfirmDialog>
    </>
  );
}
