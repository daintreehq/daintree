import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InlineError } from "@/components/ui/field";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import type { SettingsTabClose } from "@/components/Settings/settingsTabClose";
import { useWallClock } from "@/hooks/useWallClock";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { usePanelStore } from "@/store/panelStore";
import { schedulesClient } from "@/clients/schedulesClient";
import { actionService } from "@/services/ActionService";
import { revealRunTerminal } from "@/services/scheduledRunLanding";
import { useFirstAgentOptions } from "@/components/Worktree/hooks/useFirstAgentOptions";
import { worktreeDisplayName } from "@/utils/recipeScope";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { ScheduleRunNowOutcome, SchedulesSnapshot } from "@shared/types/ipc/schedules";
import {
  NEW_SCHEDULE_SELECTOR,
  ScheduleList,
  scheduleActionSelector,
} from "@/components/Schedules/ScheduleList";
import type { WorktreeChoice } from "@/components/Schedules/ScheduleEditor";
import { ScheduleEditorDialog } from "@/components/Schedules/ScheduleEditorDialog";
import { ScheduleOsJobStatus } from "@/components/Schedules/ScheduleOsJobStatus";
import { ScheduleRuns } from "@/components/Schedules/ScheduleRuns";
import { useProjectSchedules } from "@/components/Schedules/useProjectSchedules";
import { useScheduleOsJob } from "@/components/Schedules/useScheduleOsJob";
import { useLastRuns } from "@/components/Schedules/useLastRuns";
import { useScheduleRuns } from "@/components/Schedules/useScheduleRuns";
import { useScheduleLaunchOptions } from "@/components/Schedules/useScheduleLaunchOptions";

type Page = { kind: "list" } | { kind: "history"; id: string };

/** An editor opening: a new schedule, or the saved schedule it was opened on. */
interface EditorOpening {
  schedule: Schedule | null;
  open: boolean;
  key: number;
}

/** A Run now failure the history couldn't record, so the page says it instead. */
interface RunNowFailure {
  scheduleId: string;
  name: string;
  message: string;
}

interface ProjectSchedulesTabProps {
  projectId: string;
  isOpen: boolean;
  isActive: boolean;
  /** Closes Project settings, for a run's terminal to come forward behind it. */
  onClose?: SettingsTabClose;
}

/** Re-read on each minute boundary, so "in 3 minutes" counts down with the clock. */
function untilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

/** Out of sight, nothing times against the clock, so it isn't re-read. */
function never(): null {
  return null;
}

function pageFor(scheduleId: string | null): Page {
  return scheduleId ? { kind: "history", id: scheduleId } : { kind: "list" };
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

/** What a list row's Run now did, said for a screen reader; failures show as callouts. */
function runNowWords(outcome: ScheduleRunNowOutcome, name: string): string {
  switch (outcome.status) {
    case "started":
      return `Started a run of ${name}`;
    case "skipped":
      return `A run of ${name} was skipped`;
    case "failed":
      return outcome.runId === null ? "" : `A run of ${name} failed`;
    default:
      return "";
  }
}

/**
 * Project settings → Schedules: the project's schedules listed the way the
 * Recipes tab lists recipes, each schedule's run history a page of its own,
 * and its editor opened over Project settings from its row.
 */
export function ProjectSchedulesTab({
  projectId,
  isOpen,
  isActive,
  onClose,
}: ProjectSchedulesTabProps) {
  const request = useSchedulesViewStore((s) => s.request);
  const markLanded = useSchedulesViewStore((s) => s.markLanded);
  const setShowing = useSchedulesViewStore((s) => s.setShowing);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [editor, setEditor] = useState<EditorOpening | null>(null);
  // Mounted again after leaving project scope, the tab starts from the openings
  // it already landed on, so it never acts on one twice.
  const [seenSeq, setSeenSeq] = useState(() => useSchedulesViewStore.getState().landedSeq);
  const [backFocus, setBackFocus] = useState<{ viaKeyboard: boolean } | null>(null);
  const [rowFocus, setRowFocus] = useState<{ id: string; viaKeyboard: boolean } | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = isOpen && isActive;
  const [pendingRunNow, setPendingRunNow] = useState<ReadonlySet<string>>(() => new Set());
  const [runNowFailure, setRunNowFailure] = useState<RunNowFailure | null>(null);
  const [runNowStatus, setRunNowStatus] = useState("");
  const [requestedRunIds, setRequestedRunIds] = useState<ReadonlySet<string>>(() => new Set());

  const go = (next: Page) => {
    setPage(next);
    setRunNowFailure(null);
    setRequestedRunIds(new Set());
  };

  // Each opening lands where it asked to, even on the page already showing; one
  // arriving mid-edit waits for the editor to close, so it never drops an edit.
  if (active && editor === null && request.seq > seenSeq) {
    setSeenSeq(request.seq);
    setPage(pageFor(request.scheduleId));
    setRunNowFailure(null);
    setRequestedRunIds(new Set());
  }
  useEffect(() => {
    markLanded(seenSeq);
  }, [seenSeq, markLanded]);

  // A run notification leaves the tab alone while it's in front or an edit is open.
  const showing = active || editor !== null;
  useEffect(() => {
    setShowing(showing);
  }, [showing, setShowing]);
  useEffect(() => () => setShowing(false), [setShowing]);

  const { state, retry, accept } = useProjectSchedules(showing);
  const osJob = useScheduleOsJob(showing, state.snapshot?.revision ?? null);
  const { lastRuns, retryLastRuns } = useLastRuns(
    showing ? (state.snapshot?.projectId ?? null) : null
  );
  const { runsState, retryRuns } = useScheduleRuns(
    showing && page.kind === "history" ? (state.snapshot?.projectId ?? null) : null,
    page.kind === "history" ? page.id : null
  );
  // Re-read on a schedule change and on fresh run history too, so a run that just
  // landed is never timed against an older clock reading.
  const now = useWallClock(
    `${showing}:${state.snapshot?.revision ?? -1}:${lastRuns.version}:${runsState.version}`,
    showing ? untilNextMinute : never
  );
  const { worktrees } = useWorktrees();
  const agents = useFirstAgentOptions();
  const [pendingEnabled, setPendingEnabled] = useState<ReadonlySet<string>>(() => new Set());
  const [enabledError, setEnabledError] = useState<string | null>(null);

  const schedules = state.snapshot?.schedules ?? [];
  const shown = page.kind === "history" ? schedules.find((s) => s.id === page.id) : undefined;

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

  // The history's way back takes focus when the page opens, ringed only when the
  // keyboard brought it here; the list's way in takes it back on return.
  useEffect(() => {
    if (backFocus === null) return;
    const frame = requestAnimationFrame(() => {
      backButtonRef.current?.focus({ focusVisible: backFocus.viaKeyboard });
      setBackFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [backFocus]);
  useEffect(() => {
    if (rowFocus === null) return;
    const frame = requestAnimationFrame(() => {
      const target =
        containerRef.current?.querySelector<HTMLElement>(
          scheduleActionSelector(rowFocus.id, "history")
        ) ?? containerRef.current?.querySelector<HTMLElement>(NEW_SCHEDULE_SELECTOR);
      target?.focus({ focusVisible: rowFocus.viaKeyboard });
      setRowFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [rowFocus]);

  const openHistory = (schedule: Schedule, viaKeyboard: boolean) => {
    go({ kind: "history", id: schedule.id });
    setBackFocus({ viaKeyboard });
  };
  const backToList = (viaKeyboard: boolean) => {
    const from = page.kind === "history" ? page.id : null;
    go({ kind: "list" });
    if (from) setRowFocus({ id: from, viaKeyboard });
  };

  const setEnabled = async (schedule: Schedule, enabled: boolean) => {
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
  };

  // Through the action, so the overlap policy's confirmation (#15980) asks first.
  // The history announces a run starting, skipping or failing, and shows a
  // recorded one as its newest row, as the list's Last run does; the page speaks
  // only for a failure the history couldn't record. Backing out runs nothing.
  const runNow = async (schedule: Schedule) => {
    if (pendingRunNow.has(schedule.id)) return;
    setPendingRunNow((prev) => new Set(prev).add(schedule.id));
    setRunNowFailure(null);
    setRunNowStatus("");
    const fail = (message: string) =>
      setRunNowFailure({ scheduleId: schedule.id, name: schedule.name, message });
    try {
      const dispatched = await actionService.dispatch<ScheduleRunNowOutcome>(
        "schedules.runNow",
        { scheduleId: schedule.id },
        { source: "user" }
      );
      if (!dispatched.ok) {
        fail(dispatched.error.message);
        return;
      }
      const outcome = dispatched.result;
      const runId =
        outcome.status === "started" || outcome.status === "skipped" || outcome.status === "failed"
          ? outcome.runId
          : null;
      if (runId !== null) setRequestedRunIds((prev) => new Set(prev).add(runId));
      if (outcome.status === "failed" && outcome.runId === null) fail(outcome.message);
      else setRunNowStatus(runNowWords(outcome, schedule.name));
    } catch (error) {
      logError("Failed to run a schedule now", error);
      fail(formatErrorMessage(error, "Try again."));
    } finally {
      setPendingRunNow((prev) => {
        const next = new Set(prev);
        next.delete(schedule.id);
        return next;
      });
    }
  };

  // Open and Resume take the keyboard into the grid, so they wait until Project
  // settings has closed and handed focus back; done earlier, that restore would
  // pull focus straight back out of the terminal. A close a page holds runs nothing.
  const closeThen = (then: () => void) => {
    if (!onClose) return then();
    void onClose((closed) => {
      if (closed) then();
    });
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

  // ── Editor ──
  const editorKeyRef = useRef(0);
  // Where focus goes once the editor closes, when its opener is no longer the right place.
  const editorFocusRef = useRef<(() => HTMLElement | null) | null>(null);
  const openEditor = (schedule: Schedule | null) => {
    editorFocusRef.current = null;
    editorKeyRef.current += 1;
    setEditor({ schedule, open: true, key: editorKeyRef.current });
  };
  const closeEditor = () => setEditor((prev) => prev && { ...prev, open: false });
  const rowControl = (id: string, action: "edit" | "delete") => () =>
    containerRef.current?.querySelector<HTMLElement>(scheduleActionSelector(id, action)) ??
    addButtonRef.current;

  const handleSaved = (snapshot: SchedulesSnapshot, scheduleId: string) => {
    accept(snapshot);
    // A new schedule's row is where the user goes next; an edit returns to its opener.
    if (editor?.schedule === null) editorFocusRef.current = rowControl(scheduleId, "edit");
    closeEditor();
  };

  /** The row that slides into a deleted one's place, or the one above it. */
  const successorOf = (deletedId: string): string | null => {
    const index = schedules.findIndex((s) => s.id === deletedId);
    if (index === -1) return null;
    return schedules[index + 1]?.id ?? schedules[index - 1]?.id ?? null;
  };

  const handleEditorDeleted = (snapshot: SchedulesSnapshot, deletedId: string) => {
    const successor = successorOf(deletedId);
    accept(snapshot);
    if (page.kind === "history" && page.id === deletedId) go({ kind: "list" });
    editorFocusRef.current = successor
      ? rowControl(successor, "delete")
      : () => addButtonRef.current;
    closeEditor();
  };

  const openAgentSettings = () => {
    window.dispatchEvent(
      new CustomEvent("daintree:open-settings-tab", { detail: { tab: "agents" } })
    );
  };

  // ── Delete from a row ──
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteSuccessorRef = useRef<string | null>(null);
  const requestDelete = (schedule: Schedule) => {
    deleteSuccessorRef.current = successorOf(schedule.id);
    setDeleteError(null);
    setToDelete(schedule);
  };
  const confirmDelete = async () => {
    if (!toDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const outcome = await schedulesClient.remove(toDelete.id);
      accept(outcome.snapshot);
      setToDelete(null);
    } catch (error) {
      logError("Failed to delete schedule", error);
      setDeleteError(formatErrorMessage(error, "Couldn't delete the schedule"));
    } finally {
      setDeleting(false);
    }
  };
  const deleteFocusSuccessor = (): HTMLElement | null => {
    const id = deleteSuccessorRef.current;
    return id ? rowControl(id, "delete")() : addButtonRef.current;
  };

  const historyRunNowError =
    shown && runNowFailure?.scheduleId === shown.id ? runNowFailure.message : null;

  return (
    <div ref={containerRef} data-testid="project-schedules-tab">
      <p role="status" className="sr-only">
        {runNowStatus}
      </p>

      {page.kind === "list" && (
        <>
          <ScheduleOsJobStatus
            status={osJob.status}
            schedules={schedules}
            repairing={osJob.repairing}
            error={osJob.error}
            onRepair={osJob.repair}
          />
          <ScheduleList
            state={state}
            now={now}
            worktreeLabels={worktreeLabels}
            pendingEnabled={pendingEnabled}
            enabledError={enabledError}
            pendingRunNow={pendingRunNow}
            runNowError={runNowFailure ? `${runNowFailure.name}: ${runNowFailure.message}` : null}
            runNowRetrying={runNowFailure !== null && pendingRunNow.has(runNowFailure.scheduleId)}
            onRetryRunNow={() => {
              const failed = schedules.find((s) => s.id === runNowFailure?.scheduleId);
              if (failed) void runNow(failed);
            }}
            lastRuns={lastRuns}
            addButtonRef={addButtonRef}
            onRetryLastRuns={retryLastRuns}
            onCreate={() => openEditor(null)}
            onSetEnabled={(schedule, enabled) => void setEnabled(schedule, enabled)}
            onRunNow={(schedule) => void runNow(schedule)}
            onOpenHistory={openHistory}
            onEdit={(schedule) => openEditor(schedule)}
            onDelete={requestDelete}
            onRetry={retry}
          />
        </>
      )}

      {page.kind === "history" && (
        <div className="space-y-6">
          <div>
            <Button
              ref={backButtonRef}
              variant="ghost"
              size="sm"
              onClick={(event) => backToList(event.detail === 0)}
              data-testid="schedules-back"
            >
              <ChevronLeft aria-hidden="true" />
              All schedules
            </Button>
          </div>
          {shown ? (
            <SettingsSection title={shown.name}>
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
                runNowError={historyRunNowError}
                runNowPending={pendingRunNow.has(shown.id)}
                requestedRunIds={requestedRunIds}
                onRunNow={() => void runNow(shown)}
                onEdit={() => openEditor(shown)}
                onOpenRun={openRun}
                onResumeRun={(run) => resumeRun(run, shown)}
              />
            </SettingsSection>
          ) : state.status === "loading" ? (
            <Skeleton label="Loading schedule" className="space-y-3">
              <SkeletonBone className="h-40 w-full" />
              <SkeletonBone className="h-28 w-full" />
            </Skeleton>
          ) : state.status === "error" && state.snapshot === null ? (
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
            <Callout severity="info" title="This schedule no longer exists">
              It was deleted, here or in another window.
            </Callout>
          )}
        </div>
      )}

      {editor && (
        <ScheduleEditorDialog
          isOpen={editor.open}
          schedule={editor.schedule}
          openingKey={editor.key}
          defaultAgentId={editor.schedule?.launch.agentId ?? agents[0]?.id ?? ""}
          worktrees={worktreeChoices}
          now={now}
          osJobContext={osJob.status?.context ?? null}
          restoreFocusTo={() => editorFocusRef.current?.() ?? null}
          onSaved={handleSaved}
          onDeleted={handleEditorDeleted}
          onClose={closeEditor}
          onCloseComplete={() => setEditor(null)}
          onOpenAgentSettings={openAgentSettings}
        />
      )}

      <ConfirmDialog
        isOpen={toDelete !== null}
        variant="destructive"
        title={`Delete '${toDelete?.name ?? "schedule"}'?`}
        description="It stops running, and its settings and prompt are gone from this machine. Terminals its past runs opened stay open."
        confirmLabel={deleteError ? "Retry delete" : "Delete schedule"}
        isBusy={deleting}
        restoreFocusTo={deleteFocusSuccessor}
        onConfirm={() => void confirmDelete()}
        onClose={() => {
          setToDelete(null);
          setDeleteError(null);
        }}
      >
        {deleteError && <InlineError role="alert">{deleteError}</InlineError>}
      </ConfirmDialog>
    </div>
  );
}
