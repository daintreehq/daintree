import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { CalendarClock, Play } from "@/components/icons";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWallClock } from "@/hooks/useWallClock";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { usePanelStore } from "@/store/panelStore";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import { useScheduleLaunchOptions } from "./useScheduleLaunchOptions";
import { schedulesClient } from "@/clients/schedulesClient";
import { useFirstAgentOptions } from "@/components/Worktree/hooks/useFirstAgentOptions";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { ScheduleRunNowOutcome, SchedulesSnapshot } from "@shared/types/ipc/schedules";
import { actionService } from "@/services/ActionService";
import { revealRunTerminal } from "@/services/scheduledRunLanding";
import { logError } from "@/utils/logger";
import { ScheduleList, scheduleRowSelector, NEW_SCHEDULE_SELECTOR } from "./ScheduleList";
import { ScheduleEditor, type EditorLeaveState, type WorktreeChoice } from "./ScheduleEditor";
import { useProjectSchedules } from "./useProjectSchedules";
import { useLastRuns } from "./useLastRuns";
import { ScheduleRuns } from "./ScheduleRuns";
import { useScheduleRuns } from "./useScheduleRuns";

type Page =
  | { kind: "list" }
  | { kind: "schedule"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "new" };

/** Where focus goes once a page has rendered. */
type FocusTarget =
  | { kind: "row"; id: string }
  | { kind: "new-button" }
  | { kind: "name" }
  | { kind: "title" }
  | { kind: "edit-button" };

/** A leave that waits on "Discard changes?", with what the question names. */
interface DiscardPrompt {
  then: () => void;
  isNew: boolean;
  name: string;
  open: boolean;
  /** Confirmed: the leave runs once the confirm has finished closing. */
  accepted: boolean;
}

interface SchedulesDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Re-read on each minute boundary, so "in 3 minutes" counts down with the clock. */
function untilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

function pageFor(scheduleId: string | null): Page {
  return scheduleId ? { kind: "schedule", id: scheduleId } : { kind: "list" };
}

function focusTargetFor(page: Page): FocusTarget {
  if (page.kind === "new") return { kind: "name" };
  if (page.kind === "list") return { kind: "new-button" };
  return { kind: "title" };
}

/** A run's resume snapshot as the session record every resume surface takes. */
function sessionRecordFor(run: ScheduledRun, schedule: Schedule): AgentSessionRecord | null {
  const resume = run.resume;
  if (!resume?.agentSessionId) return null;
  return {
    sessionId: resume.agentSessionId,
    agentId: resume.agentId,
    worktreeId: resume.worktreeId,
    title: schedule.name,
    projectId: run.projectId,
    savedAt: run.settlement.state === "settled" ? run.settlement.settledAt : run.createdAt,
    agentLaunchFlags: resume.agentLaunchFlags,
    ...(resume.agentModelId ? { agentModelId: resume.agentModelId } : {}),
    cwd: resume.cwd,
    scheduledRun: { scheduleId: run.scheduleId, runId: run.id },
  };
}

export function SchedulesDialog({ isOpen, onClose }: SchedulesDialogProps) {
  const request = useSchedulesViewStore((s) => s.request);
  const [page, setPage] = useState<Page>(() => pageFor(request.scheduleId));
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(() =>
    focusTargetFor(pageFor(request.scheduleId))
  );
  const [seenSeq, setSeenSeq] = useState(request.seq);
  const [discardPrompt, setDiscardPrompt] = useState<DiscardPrompt | null>(null);
  const leaveStateRef = useRef<EditorLeaveState | null>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  const go = useCallback((next: Page, focus: FocusTarget) => {
    setPage(next);
    setFocusTarget(focus);
  }, []);

  if (request.seq !== seenSeq) {
    // Each opening lands where it asked to, even on the page already showing.
    setSeenSeq(request.seq);
    const next = pageFor(request.scheduleId);
    setPage(next);
    setFocusTarget(focusTargetFor(next));
  }

  const { state, retry, accept } = useProjectSchedules(isOpen);
  const { lastRuns, retryLastRuns } = useLastRuns(
    isOpen ? (state.snapshot?.projectId ?? null) : null
  );
  const { runsState, retryRuns } = useScheduleRuns(
    isOpen && page.kind === "schedule" ? (state.snapshot?.projectId ?? null) : null,
    page.kind === "schedule" ? page.id : null
  );
  // Re-read on a schedule change and on fresh run history too, so a run that just
  // landed is never timed against an older clock reading.
  const now = useWallClock(
    `${state.snapshot?.revision ?? -1}:${lastRuns.version}:${runsState.version}`,
    untilNextMinute
  );
  const { worktrees } = useWorktrees();
  const agents = useFirstAgentOptions();
  const [pendingEnabled, setPendingEnabled] = useState<ReadonlySet<string>>(() => new Set());
  const [enabledError, setEnabledError] = useState<string | null>(null);

  const schedules = state.snapshot?.schedules ?? [];
  const shown =
    page.kind === "schedule" || page.kind === "edit"
      ? schedules.find((s) => s.id === page.id)
      : undefined;

  const runTerminalIds = runsState.runs.flatMap((run) => (run.terminalId ? [run.terminalId] : []));
  // Only the runs' own panes, compared by value, so other panes coming and going
  // don't re-render the history.
  const liveTerminalIdList = usePanelStore(
    useShallow((s) =>
      runTerminalIds.filter((id) => {
        const panel = s.panelsById[id];
        return panel !== undefined && panel.location !== "dialog";
      })
    )
  );
  const liveTerminalIds = useMemo(() => new Set(liveTerminalIdList), [liveTerminalIdList]);
  const worktreeIds = useMemo(() => new Set(worktrees.map((worktree) => worktree.id)), [worktrees]);
  const { preset: shownPreset, stopsAtPrompts: shownSettingsRead } = useScheduleLaunchOptions(
    shown?.launch.agentId ?? "",
    shown?.launch.presetId ?? null
  );
  // Claimed missing only once agent settings have been read, so a cold open never flashes it.
  const presetMissing =
    shown?.launch.presetId != null && shownSettingsRead !== null && shownPreset === undefined;
  const resumeSession = useResumeAgentSession();

  const [runNowPending, setRunNowPending] = useState(false);
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [requestedRunIds, setRequestedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [runNowFor, setRunNowFor] = useState<string | null>(null);
  const shownId = shown?.id ?? null;
  if (runNowFor !== shownId) {
    // A Run now outcome belongs to the schedule it was asked of.
    setRunNowFor(shownId);
    setRunNowError(null);
    setRequestedRunIds(new Set());
  }

  // Through the action, so the overlap policy's confirmation (#15980) asks first.
  // The history announces a run starting, skipping or failing, and shows a
  // recorded one as its newest row; the page speaks only for a failure the
  // history couldn't record. Backing out of the confirmation runs nothing.
  const runNow = async (schedule: Schedule) => {
    if (runNowPending) return;
    setRunNowPending(true);
    try {
      const dispatched = await actionService.dispatch<ScheduleRunNowOutcome>(
        "schedules.runNow",
        { scheduleId: schedule.id },
        { source: "user" }
      );
      if (!dispatched.ok) {
        setRunNowError(dispatched.error.message);
        return;
      }
      const outcome = dispatched.result;
      const runId =
        outcome.status === "started" || outcome.status === "skipped" || outcome.status === "failed"
          ? outcome.runId
          : null;
      if (runId !== null) setRequestedRunIds((prev) => new Set(prev).add(runId));
      setRunNowError(
        outcome.status === "failed" && outcome.runId === null ? outcome.message : null
      );
    } catch (error) {
      logError("Failed to run a schedule now", error);
      setRunNowError(formatErrorMessage(error, "Try again."));
    } finally {
      setRunNowPending(false);
    }
  };

  // Open and Resume take the keyboard into the grid, so they wait until the dialog
  // has closed and handed focus back to its opener; done earlier, that restore
  // would pull focus straight back out of the terminal.
  const afterCloseRef = useRef<(() => void) | null>(null);
  const closeThen = (then: () => void) => {
    afterCloseRef.current = then;
    onClose();
  };

  const openRun = (run: ScheduledRun) => {
    const terminalId = run.terminalId;
    if (!terminalId) return;
    closeThen(() => revealRunTerminal(terminalId));
  };

  const resumeRun = (run: ScheduledRun, schedule: Schedule) => {
    const record = sessionRecordFor(run, schedule);
    if (!record) return;
    closeThen(() => void resumeSession(record));
  };

  // Focus moves with the page, deliberately: to the field a new schedule starts
  // with, to the page title of an existing one, and back to the row it came from.
  // Never to Back, where a programmatic focus would ring it and open its tooltip.
  useEffect(() => {
    if (!isOpen || focusTarget === null) return;
    const frame = requestAnimationFrame(() => {
      const root = headerRef.current?.closest<HTMLElement>('[role="dialog"]');
      if (!root) return;
      let target: HTMLElement | null = null;
      if (focusTarget.kind === "title") target = titleRef.current;
      else if (focusTarget.kind === "name")
        target = root.querySelector<HTMLElement>('[data-schedule-focus="name"]');
      else if (focusTarget.kind === "row")
        target = root.querySelector<HTMLElement>(scheduleRowSelector(focusTarget.id));
      else if (focusTarget.kind === "edit-button")
        target = root.querySelector<HTMLElement>("[data-schedule-edit]");
      target ??= root.querySelector<HTMLElement>(NEW_SCHEDULE_SELECTOR);
      if (!target) return;
      target.focus({ preventScroll: false });
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, focusTarget, page, state.status]);

  const worktreeChoices = useMemo<WorktreeChoice[]>(() => {
    const main = worktrees.find((worktree) => worktree.isMainWorktree);
    const others = worktrees.filter((worktree) => !worktree.isMainWorktree);
    const mainBranch = main?.branch ? ` · ${main.branch}` : "";
    return [
      { id: null, label: `Main checkout${mainBranch}` },
      ...others.map((worktree) => ({
        id: worktree.id,
        label: worktreeDisplayName(worktree) ?? worktree.path,
      })),
    ];
  }, [worktrees]);
  const worktreeLabels = useMemo(
    () =>
      new Map(
        worktreeChoices.flatMap((choice) => (choice.id ? [[choice.id, choice.label] as const] : []))
      ),
    [worktreeChoices]
  );

  const setEnabled = useCallback(
    async (schedule: Schedule, enabled: boolean) => {
      setEnabledError(null);
      setPendingEnabled((prev) => new Set(prev).add(schedule.id));
      try {
        const outcome = await schedulesClient.setEnabled(schedule.id, enabled);
        accept(outcome.snapshot);
      } catch (error) {
        logError("Failed to switch a schedule", error);
        setEnabledError(
          `Couldn't turn ${enabled ? "on" : "off"} ${schedule.name}. ${formatErrorMessage(error, "Try again.")}`
        );
      } finally {
        setPendingEnabled((prev) => {
          const next = new Set(prev);
          next.delete(schedule.id);
          return next;
        });
      }
    },
    [accept]
  );

  const returnFocus = (): FocusTarget =>
    page.kind === "schedule" ? { kind: "row", id: page.id } : { kind: "new-button" };
  const backToSchedule = (id: string) =>
    leave(() => go({ kind: "schedule", id }, { kind: "edit-button" }));

  /** Leaving a page with unsaved edits asks first; a save in flight holds the page. */
  const leave = (then: () => void) => {
    const editor = leaveStateRef.current;
    if (page.kind === "list" || !editor) return then();
    if (editor.saving) return;
    if (editor.dirty) {
      setDiscardPrompt({
        then,
        isNew: editor.isNew,
        name: editor.name,
        open: true,
        accepted: false,
      });
      return;
    }
    then();
  };
  const backToList = () => leave(() => go({ kind: "list" }, returnFocus()));
  const back = () => (page.kind === "edit" ? backToSchedule(page.id) : backToList());

  const handleBeforeClose = () => {
    const editor = leaveStateRef.current;
    if (page.kind === "list" || !editor) return true;
    if (editor.saving) return false;
    if (!editor.dirty) return true;
    setDiscardPrompt({
      then: onClose,
      isNew: editor.isNew,
      name: editor.name,
      open: true,
      accepted: false,
    });
    return false;
  };

  const handleSaved = (snapshot: SchedulesSnapshot, scheduleId: string) => {
    accept(snapshot);
    if (page.kind === "edit") go({ kind: "schedule", id: scheduleId }, { kind: "edit-button" });
    else go({ kind: "list" }, { kind: "row", id: scheduleId });
  };

  const handleDeleted = (snapshot: SchedulesSnapshot, deletedId: string) => {
    // Focus goes to the row that slides into the deleted one's place, or the one above it.
    const index = schedules.findIndex((s) => s.id === deletedId);
    const remaining = snapshot.schedules;
    const neighbour = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
    accept(snapshot);
    go({ kind: "list" }, neighbour ? { kind: "row", id: neighbour.id } : { kind: "new-button" });
  };

  const title =
    page.kind === "list"
      ? "Schedules"
      : page.kind === "new"
        ? "New schedule"
        : page.kind === "edit"
          ? "Edit schedule"
          : (shown?.name ?? "Schedule");
  const backLabel = page.kind === "edit" ? "Back to schedule" : "Back to schedules";

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      onBeforeClose={handleBeforeClose}
      size="4xl"
      maxHeight="h-[min(48rem,85vh)]"
      initialFocus="none"
      onCloseComplete={() => {
        const then = afterCloseRef.current;
        afterCloseRef.current = null;
        then?.();
      }}
      data-testid="schedules-dialog"
    >
      <AppDialog.Header>
        <div ref={headerRef} className="flex min-w-0 flex-1 items-center">
          {page.kind !== "list" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-ml-2 mr-1.5 shrink-0"
                  aria-label={backLabel}
                  onClick={back}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{backLabel}</TooltipContent>
            </Tooltip>
          )}
          <AppDialog.Title icon={page.kind === "list" ? <CalendarClock /> : undefined}>
            {/* The page's focus landing when it opens on a schedule: announced, and
                ringed only when the keyboard brought it here. */}
            <span
              ref={titleRef}
              tabIndex={-1}
              className="-mx-1 truncate rounded-[var(--radius-sm)] px-1 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary"
            >
              {title}
            </span>
          </AppDialog.Title>
        </div>
        {page.kind === "schedule" && shown && (
          <Button
            variant="outline"
            size="sm"
            className="mr-2 shrink-0"
            onClick={() => void runNow(shown)}
            loading={runNowPending}
          >
            <Play />
            Run now
          </Button>
        )}
        <AppDialog.CloseButton />
      </AppDialog.Header>

      {page.kind === "list" && (
        <AppDialog.Body>
          <ScheduleList
            state={state}
            now={now}
            worktreeLabels={worktreeLabels}
            pendingEnabled={pendingEnabled}
            enabledError={enabledError}
            lastRuns={lastRuns}
            onRetryLastRuns={retryLastRuns}
            onOpenSchedule={(id) => go({ kind: "schedule", id }, { kind: "title" })}
            onCreate={() => go({ kind: "new" }, { kind: "name" })}
            onSetEnabled={(schedule, enabled) => void setEnabled(schedule, enabled)}
            onRetry={retry}
          />
        </AppDialog.Body>
      )}

      {page.kind === "new" && (
        <ScheduleEditor
          key="new"
          schedule={null}
          defaultAgentId={agents[0]?.id ?? ""}
          worktrees={worktreeChoices}
          now={now}
          leaveStateRef={leaveStateRef}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onCancel={backToList}
        />
      )}

      {page.kind === "schedule" && shown && (
        <AppDialog.Body>
          <ScheduleRuns
            schedule={shown}
            now={now}
            worktreeLabel={
              shown.launch.worktreeId === null
                ? null
                : (worktreeLabels.get(shown.launch.worktreeId) ?? "Missing worktree")
            }
            presetName={shown.launch.presetId === null ? null : (shownPreset?.name ?? null)}
            presetMissing={presetMissing}
            runsState={runsState}
            onRetryRuns={retryRuns}
            liveTerminalIds={liveTerminalIds}
            worktreeIds={worktreeIds}
            runNowError={runNowError}
            runNowRetrying={runNowPending}
            requestedRunIds={requestedRunIds}
            onRetryRunNow={() => void runNow(shown)}
            onEdit={() => go({ kind: "edit", id: shown.id }, { kind: "title" })}
            onOpenRun={openRun}
            onResumeRun={(run) => resumeRun(run, shown)}
          />
        </AppDialog.Body>
      )}

      {page.kind === "edit" && shown && (
        <ScheduleEditor
          key={shown.id}
          schedule={shown}
          defaultAgentId={shown.launch.agentId}
          worktrees={worktreeChoices}
          now={now}
          leaveStateRef={leaveStateRef}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onCancel={() => backToSchedule(shown.id)}
        />
      )}

      {(page.kind === "schedule" || page.kind === "edit") &&
        (shown ? null : (
          <AppDialog.Body>
            {state.status === "loading" ? (
              <Skeleton label="Loading schedule" className="space-y-3">
                <SkeletonBone className="h-40 w-full" />
                <SkeletonBone className="h-28 w-full" />
              </Skeleton>
            ) : state.status === "error" ? (
              <Callout
                severity="error"
                title="Couldn't load this schedule"
                action={
                  <Button variant="outline" size="sm" onClick={retry}>
                    <RefreshCw />
                    Retry
                  </Button>
                }
              >
                {state.message}
              </Callout>
            ) : (
              <Callout
                severity="info"
                title="This schedule no longer exists"
                action={
                  <Button variant="outline" size="sm" onClick={backToList}>
                    Back to schedules
                  </Button>
                }
              >
                It was deleted, here or in another window.
              </Callout>
            )}
          </AppDialog.Body>
        ))}

      <ConfirmDialog
        isOpen={discardPrompt?.open ?? false}
        variant="destructive"
        title={
          discardPrompt?.isNew
            ? "Discard this new schedule?"
            : `Discard changes to '${discardPrompt?.name ?? ""}'?`
        }
        description={
          discardPrompt?.isNew
            ? "It hasn't been created, so nothing will run."
            : "Your edits aren't saved. The saved schedule is unchanged."
        }
        cancelLabel="Keep editing"
        confirmLabel="Discard changes"
        onConfirm={() =>
          setDiscardPrompt((prev) => prev && { ...prev, open: false, accepted: true })
        }
        onClose={() => setDiscardPrompt((prev) => prev && { ...prev, open: false })}
        // The leave runs once the confirm has handed focus back, so its restore
        // can't land after the destination row has taken focus.
        onCloseComplete={() => {
          const done = discardPrompt;
          setDiscardPrompt(null);
          if (done?.accepted) done.then();
        }}
      />
    </AppDialog>
  );
}
