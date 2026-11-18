import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { CircleDashed, CircleStop } from "@/components/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { ScrollShadow } from "@/components/ui/ScrollShadow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  POPOVER_HEADER_CLASS,
  POPOVER_HEADER_META_CLASS,
  POPOVER_ROW_HOVER_CLASS,
  POPOVER_TITLE_CLASS,
} from "@/components/ui/popoverHeader";
import { ARIA_DISABLED_CLASSES } from "@/components/ui/ariaDisabled";
import { cn } from "@/lib/utils";
import { pluralize } from "@/lib/pluralize";
import { SEVERITY_VISUAL } from "@/lib/statusSeverity";
import { useBulkWorktreeRunStore } from "@/store/bulkWorktreeRunStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { bulkWorktreeRunsClient } from "@/clients/bulkWorktreeRunsClient";
import { logError } from "@/utils/logger";
import {
  isBulkWorktreeRunLive,
  type BulkWorktreeRunItem,
  type BulkWorktreeRunSnapshot,
} from "@shared/types/ipc/bulkWorktreeRuns";
import {
  bulkRunItemNoun,
  bulkRunItemStep,
  bulkRunMilestone,
  canOpenBulkRunItem,
  defaultBulkRunId,
  isItemInProgress,
  nextBulkRunRetireAt,
  orderBulkRunItems,
  shownBulkRuns,
  summarizeBulkRun,
  summarizeBulkRunChip,
  type BulkRunTone,
} from "@/lib/bulkWorktreeRuns";

/**
 * Bulk worktree creation, wherever it runs (#17086). The dialog only sets a
 * batch up; once Create is pressed the run lives here, in every project view:
 * a chip in the toolbar with the overall count, and a non-modal popover with
 * each item's step, its retries and its error, plus Cancel remaining, Retry
 * failed and a way into every worktree that landed.
 *
 * Fixed chrome rather than a registry button: it exists only while a batch is
 * worth showing, so there is nothing to pin, hide or overflow. A clean finish
 * lingers, then retires to the notification center (the view that ran it files
 * the entry); a failure stays until it is retried or dismissed.
 */
export function BulkWorktreeRunIndicator() {
  const runs = useBulkWorktreeRunStore((s) => s.runs);
  const currentProjectId = useProjectStore((s) => s.currentProject?.id ?? null);
  const projects = useProjectStore((s) => s.projects);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Batches on screen when the popover opened, or shown while it was open,
  // stay until it closes: a clean finish retiring under the pointer would pull
  // the rows the user is reading out from under them.
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set());
  const lastSeen = useRef(new Map<string, BulkWorktreeRunSnapshot>());
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    useBulkWorktreeRunStore.getState().init();
  }, []);

  useEffect(() => {
    const current = Date.now();
    const at = nextBulkRunRetireAt(runs, current);
    if (at === null) return;
    const timer = setTimeout(() => setNow(Date.now()), at - current + 50);
    return () => clearTimeout(timer);
  }, [runs, now]);

  useMilestoneAnnouncements(runs);

  for (const run of runs) lastSeen.current.set(run.runId, run);
  const byId = new Map(runs.map((run) => [run.runId, run]));
  const shown = shownBulkRuns(runs, now);
  const shownSet = new Set(shown.map((run) => run.runId));
  for (const id of pinned) {
    if (shownSet.has(id)) continue;
    const run = byId.get(id) ?? lastSeen.current.get(id);
    if (run) shown.push(run);
  }
  shown.sort((a, b) => a.startedAt - b.startedAt);

  const shownIds = shown.map((run) => run.runId).join(",");
  useEffect(() => {
    if (!open) return;
    setPinned((prev) => {
      const ids = shownIds ? shownIds.split(",") : [];
      if (ids.every((id) => prev.has(id))) return prev;
      return new Set([...prev, ...ids]);
    });
  }, [open, shownIds]);

  const names = new Map(projects.map((p) => [p.id, p.name]));
  // Whose batches these are, for the accessible name, when none are this project's.
  const elsewhere =
    shown.length > 0 && shown.every((run) => run.projectId === shown[0]!.projectId)
      ? shown[0]!.projectId !== currentProjectId
        ? names.get(shown[0]!.projectId)
        : undefined
      : undefined;
  const chip = summarizeBulkRunChip(shown, elsewhere);
  if (!chip) return null;

  const fallbackId = defaultBulkRunId(shown);
  const selected =
    shown.find((run) => run.runId === selectedId) ??
    shown.find((run) => run.runId === fallbackId) ??
    shown[0]!;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setSelectedId(defaultBulkRunId(shown));
    } else {
      setPinned(new Set());
      setNow(Date.now());
    }
  };

  const handleDismissed = (runId: string) => {
    const remaining = shown.filter((run) => run.runId !== runId);
    setPinned((prev) => {
      if (!prev.has(runId)) return prev;
      const next = new Set(prev);
      next.delete(runId);
      return next;
    });
    if (remaining.length === 0) {
      handleOpenChange(false);
      return;
    }
    setSelectedId(defaultBulkRunId(remaining));
    // The dismissed batch's actions are gone; the next batch's title takes focus.
    requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
  };

  const showWarning = chip.tone === "live" && chip.attention > 0;

  return (
    // Fades in on mount (the shared 200ms entry tier, opacity only): the chip
    // is where the batch went when Create closed the dialog.
    <div className="app-no-drag flex min-w-0 shrink items-center animate-hint-fade-in">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-toolbar-item=""
            data-testid="bulk-worktree-run-indicator"
            data-tone={chip.tone}
            aria-label={chip.ariaLabel}
            className={cn(
              "flex h-7 min-w-0 max-w-80 shrink items-center gap-1.5 overflow-hidden rounded-[var(--radius-md)] border border-border-default px-2 text-xs",
              "text-text-primary transition-colors duration-150 ease-out hover:bg-overlay-subtle aria-expanded:bg-overlay-subtle",
              "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-selection-outline focus-visible:outline-offset-2"
            )}
          >
            <ToneGlyph tone={chip.tone} size="chip" />
            <span className="min-w-0 truncate">{chip.label}</span>
            {chip.count && (
              <span className="shrink-0 tabular-nums text-text-secondary">{chip.count}</span>
            )}
            {chip.gauge && (
              // The count says how far; this says it at a glance. A gauge of its
              // own beside the count, never under the label, where a thin line
              // reads as an underline. On a crowded toolbar it gives way before
              // the label does: gone outright on a narrow toolbar, and the first
              // to shrink on a crowded one. Drawn only: the count is in the
              // button's name.
              <ProgressBar
                decorative
                size="inline"
                value={chip.created}
                max={Math.max(1, chip.total)}
                className="w-10 min-w-0 shrink-[100] @max-6xl/toolbar:hidden"
              />
            )}
            {showWarning && (
              <span
                className="flex shrink-0 items-center gap-0.5 tabular-nums text-text-secondary"
                data-testid="bulk-worktree-run-attention"
              >
                <SeverityGlyph tone="warning" className="h-3 w-3" />
                {chip.attention}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          className="flex max-h-[min(80vh,42rem)] w-[28rem] max-w-[calc(100vw-1rem)] flex-col p-0"
          aria-label={shown.length > 1 ? "Worktree creation" : undefined}
          aria-labelledby={shown.length > 1 ? undefined : `${selected.runId}-title`}
          data-testid="bulk-worktree-run-popover"
          onOpenAutoFocus={(event) => {
            // Land on the batch's title, not its first button: a second Enter
            // must never dismiss a failed batch or jump to a worktree.
            event.preventDefault();
            titleRef.current?.focus({ preventScroll: true });
          }}
        >
          {shown.length > 1 && (
            <>
              <div className={POPOVER_HEADER_CLASS}>
                <span className={POPOVER_TITLE_CLASS}>Worktree creation</span>
                <span className={POPOVER_HEADER_META_CLASS}>
                  {pluralize(shown.length, "batch", "batches")}
                </span>
              </div>
              <BatchTabs
                runs={shown}
                selectedId={selected.runId}
                names={names}
                currentProjectId={currentProjectId}
                onSelect={setSelectedId}
              />
            </>
          )}
          <RunDetail
            key={selected.runId}
            run={selected}
            titleRef={titleRef}
            projectName={names.get(selected.projectId) ?? "another project"}
            isCurrentProject={selected.projectId === currentProjectId}
            inTabs={shown.length > 1}
            onDismissed={handleDismissed}
            onOpened={() => handleOpenChange(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Says when a batch starts and when it ends, never per step (WCAG 4.1.3). */
function useMilestoneAnnouncements(runs: readonly BulkWorktreeRunSnapshot[]): void {
  const previous = useRef<Map<string, BulkWorktreeRunSnapshot> | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = new Map(runs.map((run) => [run.runId, run]));
    const announce = useAnnouncerStore.getState().announce;
    for (const run of runs) {
      const prior = before?.get(run.runId);
      // A batch already going when this view first heard of it is not news.
      if (!prior && (before === null || Date.now() - run.startedAt > 5_000)) continue;
      const message = bulkRunMilestone(prior, run);
      if (message) announce(message, "polite");
    }
  }, [runs]);
}

function SeverityGlyph({
  tone,
  className,
}: {
  tone: "success" | "warning" | "error";
  className?: string;
}) {
  const { Icon, toneClass } = SEVERITY_VISUAL[tone];
  return <Icon aria-hidden="true" className={cn("shrink-0", toneClass, className)} />;
}

function ToneGlyph({ tone, size }: { tone: BulkRunTone; size: "chip" | "title" }) {
  const box = size === "chip" ? "h-3.5 w-3.5" : "h-4 w-4";
  if (tone === "live") {
    return <Spinner size={size === "chip" ? "sm" : "md"} className="text-text-secondary" />;
  }
  if (tone === "neutral") {
    return (
      <CircleStop
        aria-hidden="true"
        className={cn(box, "shrink-0 text-text-secondary forced-colors:text-[CanvasText]")}
      />
    );
  }
  return <SeverityGlyph tone={tone} className={box} />;
}

/**
 * Every batch at once, as a vertical tab list above the selected batch's
 * detail, so a second batch is never buried under the first one's rows.
 */
function BatchTabs({
  runs,
  selectedId,
  names,
  currentProjectId,
  onSelect,
}: {
  runs: readonly BulkWorktreeRunSnapshot[];
  selectedId: string;
  names: ReadonlyMap<string, string>;
  currentProjectId: string | null;
  onSelect: (runId: string) => void;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const summaries = runs.map(summarizeBulkRun);
  // Two batches in the same state would read as twins: lead with what differs.
  const sameTitles = summaries.every((s) => s.title === summaries[0]!.title);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = runs.findIndex((run) => run.runId === selectedId);
    const targets: Record<string, number> = {
      ArrowDown: Math.min(runs.length - 1, index + 1),
      ArrowUp: Math.max(0, index - 1),
      Home: 0,
      End: runs.length - 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const id = runs[next]!.runId;
    onSelect(id);
    refs.current.get(id)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Batches"
      className="flex shrink-0 flex-col gap-0.5 border-b border-divider p-1.5"
      onKeyDown={move}
    >
      {runs.map((run, index) => {
        const summary = summaries[index]!;
        const selected = run.runId === selectedId;
        const items = pluralize(summary.facts.total, bulkRunItemNoun(run));
        const scope =
          run.projectId === currentProjectId
            ? items
            : `${names.get(run.projectId) ?? "Another project"} · ${items}`;
        const [primary, secondary] = sameTitles ? [scope, summary.title] : [summary.title, scope];
        return (
          <button
            key={run.runId}
            ref={(node) => {
              if (node) refs.current.set(run.runId, node);
              else refs.current.delete(run.runId);
            }}
            type="button"
            role="tab"
            id={`${run.runId}-tab`}
            aria-selected={selected}
            aria-controls={`${run.runId}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(run.runId)}
            data-testid="bulk-worktree-run-tab"
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] px-2 py-1.5 text-left",
              selected
                ? // A step past the hover fill, and an outline where forced colours drop fills.
                  "bg-overlay-medium forced-colors:outline forced-colors:outline-1 forced-colors:outline-[CanvasText]"
                : POPOVER_ROW_HOVER_CLASS
            )}
          >
            <ToneGlyph tone={summary.tone} size="chip" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text-primary">
                {primary}
              </span>
              <span className="block truncate text-2xs text-text-secondary">{secondary}</span>
            </span>
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                selected ? "text-text-primary" : "text-text-secondary"
              )}
            >
              {summary.facts.created}/{summary.facts.total}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RunDetail({
  run,
  titleRef,
  projectName,
  isCurrentProject,
  inTabs,
  onDismissed,
  onOpened,
}: {
  run: BulkWorktreeRunSnapshot;
  titleRef: RefObject<HTMLHeadingElement | null>;
  projectName: string;
  isCurrentProject: boolean;
  inTabs: boolean;
  onDismissed: (runId: string) => void;
  onOpened: () => void;
}) {
  const summary = summarizeBulkRun(run);
  const { facts } = summary;
  const live = isBulkWorktreeRunLive(run.phase);
  const noun = bulkRunItemNoun(run);
  const [pending, setPending] = useState<"cancel" | "retry" | null>(null);
  const items = orderBulkRunItems(run.items);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  const actionHadFocus = useRef(false);

  // Retry and Cancel remove themselves once the batch changes phase, and a
  // batch ending removes Cancel. When the control that goes is the focused
  // one, focus would fall to the page; it goes to the batch title instead, so
  // a keyboard user stays in the popover and one Tab from the next action.
  useLayoutEffect(() => {
    if (!actionHadFocus.current) return;
    const active = document.activeElement;
    if (active && actionsRef.current?.contains(active)) return;
    actionHadFocus.current = false;
    if (!active || active === document.body) titleRef.current?.focus({ preventScroll: true });
  });

  const command = (kind: "cancel" | "retry") => {
    if (pending) return;
    setPending(kind);
    const request =
      kind === "cancel"
        ? bulkWorktreeRunsClient.cancel(run.runId)
        : bulkWorktreeRunsClient.retryFailed(run.runId);
    request
      .catch((error: unknown) => logError(`Failed to ${kind} bulk worktree run`, error))
      .finally(() => setPending(null));
  };

  const dismiss = () => {
    bulkWorktreeRunsClient
      .dismiss(run.runId)
      .catch((error: unknown) => logError("Failed to dismiss bulk worktree run", error));
    onDismissed(run.runId);
  };

  const openWorktree = (item: BulkWorktreeRunItem) => {
    if (!item.worktreeId) return;
    onOpened();
    if (isCurrentProject) {
      useWorktreeSelectionStore.getState().selectWorktree(item.worktreeId);
      return;
    }
    void useProjectStore
      .getState()
      .switchProject(run.projectId, {
        focusIntent: { intent: "focus-worktree", worktreeId: item.worktreeId },
      })
      .catch((error: unknown) => logError("Failed to open a worktree in another project", error));
  };

  const scope = isCurrentProject
    ? `For ${pluralize(facts.total, noun)}`
    : `In ${projectName} · ${pluralize(facts.total, noun)}`;
  const canRetry = !live && run.controllable && facts.failed > 0;
  // While cancelling, the title already says so; the button would only repeat it.
  const canCancel = run.phase === "running" && run.controllable;

  return (
    <section
      id={inTabs ? `${run.runId}-panel` : undefined}
      role={inTabs ? "tabpanel" : undefined}
      aria-labelledby={inTabs ? `${run.runId}-tab` : `${run.runId}-title`}
      data-testid="bulk-worktree-run-section"
      data-run-phase={run.phase}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 px-3 pt-3 pb-2.5">
        {/* Actions share the title's row, so they sit in the same place in
            every state, whatever the counts below say. */}
        <div className="flex min-w-0 items-center gap-2">
          <ToneGlyph tone={summary.tone} size="title" />
          <h3
            ref={titleRef}
            id={`${run.runId}-title`}
            tabIndex={-1}
            className="min-w-0 truncate rounded-[var(--radius-sm)] text-sm font-medium text-text-primary"
          >
            {summary.title}
          </h3>
          <span className="flex-1" />
          {/* Retry first in the tab order, drawn on the right. */}
          <div
            ref={actionsRef}
            onFocus={() => {
              actionHadFocus.current = true;
            }}
            onBlur={(event) => {
              if (!actionsRef.current?.contains(event.relatedTarget as Node | null)) {
                actionHadFocus.current = false;
              }
            }}
            className="-my-1 flex shrink-0 flex-row-reverse items-center gap-1"
          >
            {canRetry && (
              <Button
                variant="secondary"
                size="xs"
                aria-disabled={pending === "retry" || undefined}
                className={cn(pending === "retry" && ARIA_DISABLED_CLASSES)}
                onClick={() => command("retry")}
                data-testid="bulk-worktree-run-retry"
              >
                <RefreshCw aria-hidden="true" />
                Retry {facts.failed} failed
              </Button>
            )}
            {canCancel && (
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={pending === "cancel" || undefined}
                className={cn(pending === "cancel" && ARIA_DISABLED_CLASSES)}
                onClick={() => command("cancel")}
                data-testid="bulk-worktree-run-cancel"
              >
                Cancel remaining
              </Button>
            )}
            {!live && (
              <Button
                variant="ghost"
                size="xs"
                onClick={dismiss}
                data-testid="bulk-worktree-run-dismiss"
              >
                Dismiss
              </Button>
            )}
          </div>
        </div>
        <p className="mt-0.5 truncate pl-6 text-xs text-text-secondary">{scope}</p>
        {/* A clean finish is its title; a full bar and "20 of 20" would only repeat it.
            In the setup tail or a cancel the bar can no longer move while work
            goes on, so the detail line ("10 of 10 created · 4 setting up")
            says it alone. */}
        {summary.tone !== "success" && (
          <>
            {summary.activity !== "setting-up" && summary.activity !== "cancelling" && (
              <ProgressBar
                className="mt-2.5"
                value={facts.created}
                max={Math.max(1, facts.total)}
                label={`Worktrees created for ${isCurrentProject ? "this batch" : projectName}`}
                valueText={`${facts.created} of ${facts.total} created`}
              />
            )}
            <p className="mt-2 text-xs tabular-nums text-text-secondary">{summary.detail}</p>
          </>
        )}
        {summary.sharedFailure && (
          <p className="mt-1.5 break-words text-xs text-text-secondary">
            <span className="text-status-danger-text">{summary.sharedFailureLead} </span>
            {summary.sharedFailure}
          </p>
        )}
        {!run.controllable && (
          <p className="mt-1.5 text-xs text-text-secondary">
            The project view running this closed, so it can't be cancelled or retried.
          </p>
        )}
      </div>
      <ScrollShadow className="min-h-0 flex-1 border-t border-divider">
        <ul className="py-1" aria-label={pluralize(facts.total, noun)}>
          {items.map((item) => (
            <RunItemRow
              key={item.number}
              item={item}
              run={run}
              hideError={summary.sharedFailure !== null}
              openLabel={
                isCurrentProject
                  ? `Open the worktree for #${item.number}`
                  : `Open the worktree for #${item.number} in ${projectName}`
              }
              onOpen={canOpenBulkRunItem(item) ? () => openWorktree(item) : undefined}
            />
          ))}
        </ul>
      </ScrollShadow>
    </section>
  );
}

function RunItemRow({
  item,
  run,
  hideError,
  openLabel,
  onOpen,
}: {
  item: BulkWorktreeRunItem;
  run: BulkWorktreeRunSnapshot;
  hideError: boolean;
  openLabel: string;
  onOpen: (() => void) | undefined;
}) {
  const errorId = useId();
  const inProgress = isItemInProgress(item);
  const failed = item.stage === "failed";
  const step = bulkRunItemStep(item, run.mode, run.phase);
  const retried = (item.retried ?? 0) > 0 && (inProgress || item.stage === "pending");
  // One line when there is nothing to read past the title: finished, waiting,
  // or stopped before it began. The step rides at the end in place of an arrow.
  // A failure whose reason the header already says once (every failure the
  // same) has nothing of its own to add; its glyph marks it.
  const sharedFailure = failed && hideError;
  const oneLine =
    item.stage === "succeeded" ||
    sharedFailure ||
    (item.stage === "pending" && !retried) ||
    (item.stage === "cancelled" && !item.worktreeId);
  const trailingStep = oneLine && item.stage !== "succeeded" && !sharedFailure ? step : null;
  const error = failed && item.error && !hideError ? item.error : null;

  const body = (
    <>
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <ItemGlyph item={item} phase={run.phase} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-mono text-xs text-text-secondary">#{item.number}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{item.title}</span>
          {trailingStep && (
            <span className="shrink-0 text-xs text-text-secondary">{trailingStep}</span>
          )}
        </span>
        {!oneLine && (
          <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            <span className={cn("min-w-0 truncate", failed && "text-status-danger-text")}>
              {step}
            </span>
            {retried && (
              <Badge size="xs" tone="neutral">
                Retry {item.retried}
              </Badge>
            )}
            {inProgress && item.attempt > 1 && (
              <Badge size="xs" tone="neutral">
                Attempt {item.attempt}
              </Badge>
            )}
          </span>
        )}
        {error && (
          <span
            id={errorId}
            className="mt-0.5 block select-text break-words text-xs text-text-secondary"
          >
            {error}
          </span>
        )}
      </span>
    </>
  );

  if (!onOpen) {
    return (
      <li
        data-testid="bulk-worktree-run-item"
        data-stage={item.stage}
        className="flex items-start gap-2.5 px-3 py-1.5"
      >
        {body}
      </li>
    );
  }

  const outcome = item.stage === "succeeded" ? "" : ` (${step})`;
  const button = (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${openLabel}: ${item.title}${outcome}`}
      aria-describedby={error ? errorId : undefined}
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-[var(--radius-md)] px-2 py-1.5 text-left",
        POPOVER_ROW_HOVER_CLASS
      )}
    >
      {body}
      <ArrowRight
        aria-hidden="true"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-secondary transition-colors duration-150 ease-out group-hover:text-text-primary group-focus-visible:text-text-primary forced-colors:text-[ButtonText]"
      />
    </button>
  );

  return (
    <li data-testid="bulk-worktree-run-item" data-stage={item.stage} className="px-1">
      {item.stage === "succeeded" && item.branch ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="left" className="font-mono text-xs">
            {item.branch}
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </li>
  );
}

function ItemGlyph({
  item,
  phase,
}: {
  item: BulkWorktreeRunItem;
  phase: BulkWorktreeRunSnapshot["phase"];
}) {
  if (isItemInProgress(item)) return <Spinner size="sm" className="text-text-secondary" />;
  if (item.stage === "succeeded") return <SeverityGlyph tone="success" className="h-4 w-4" />;
  if (item.stage === "failed") return <SeverityGlyph tone="error" className="h-4 w-4" />;
  // Queued items a cancel will stop read as stopped already.
  if (
    item.stage === "cancelled" ||
    item.stage === "interrupted" ||
    (item.stage === "pending" && phase === "cancelling")
  ) {
    return (
      <CircleStop
        aria-hidden="true"
        className="h-4 w-4 text-text-secondary forced-colors:text-[CanvasText]"
      />
    );
  }
  return (
    <CircleDashed
      aria-hidden="true"
      className="h-4 w-4 text-text-secondary forced-colors:text-[CanvasText]"
    />
  );
}
