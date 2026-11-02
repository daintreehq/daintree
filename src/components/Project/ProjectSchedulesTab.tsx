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
import { useResumeAgentSession } from "@/hooks/useResumeAgentSession";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { usePanelStore } from "@/store/panelStore";
import { schedulesClient } from "@/clients/schedulesClient";
import { actionService } from "@/services/ActionService";
import { revealRunTerminal } from "@/services/scheduledRunLanding";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Schedule, ScheduledRun } from "@shared/types/scheduledRuns";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import type { ScheduleRunNowOutcome } from "@shared/types/ipc/schedules";
import {
  NEW_SCHEDULE_SELECTOR,
  RUN_NOW_FAILURE_SELECTOR,
  ScheduleList,
  scheduleActionSelector,
} from "@/components/Schedules/ScheduleList";
import { ScheduleOsJobStatus } from "@/components/Schedules/ScheduleOsJobStatus";
import { ScheduleSwitches } from "@/components/Schedules/ScheduleSwitches";
import { HISTORY_RUN_NOW_SELECTOR, ScheduleRuns } from "@/components/Schedules/ScheduleRuns";
import { useProjectSchedules } from "@/components/Schedules/useProjectSchedules";
import { useScheduleOsJob } from "@/components/Schedules/useScheduleOsJob";
import { useLastRuns } from "@/components/Schedules/useLastRuns";
import { useScheduleRuns } from "@/components/Schedules/useScheduleRuns";
import { ASSISTANT_RESUMABLE_AGENTS } from "@/components/Schedules/runWords";
import { useScheduleLaunchOptions } from "@/components/Schedules/useScheduleLaunchOptions";
import { useWorktreeChoices } from "@/components/Schedules/useWorktreeChoices";

type Page = { kind: "list" } | { kind: "history"; id: string };

/** Where focus goes once a page has rendered; `visible` rings it, for the keyboard. */
type FocusTarget =
  | { kind: "back"; visible: boolean }
  | { kind: "row"; id: string; visible: boolean }
  | { kind: "add" }
  | { kind: "run-now"; id: string };

/** A Run now failure the history couldn't record, so the page says it instead. */
interface RunNowFailure {
  scheduleId: string;
  name: string;
  message: string;
}

interface ProjectSchedulesTabProps {
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
 * and its editor opened over Project settings from its row. The editor itself
 * is hosted outside Settings (`ScheduleEditorHost`), so a draft outlives
 * anything Settings does.
 */
export function ProjectSchedulesTab({ isOpen, isActive, onClose }: ProjectSchedulesTabProps) {
  const request = useSchedulesViewStore((s) => s.request);
  const editing = useSchedulesViewStore((s) => s.editor !== null);
  const editorAnswer = useSchedulesViewStore((s) => s.editorAnswer);
  const markLanded = useSchedulesViewStore((s) => s.markLanded);
  const setShowing = useSchedulesViewStore((s) => s.setShowing);
  const openEditor = useSchedulesViewStore((s) => s.openEditor);
  const [page, setPage] = useState<Page>({ kind: "list" });
  // Mounted again after leaving project scope, the tab starts from the openings
  // it already landed on, so it never acts on one twice.
  const [seenSeq, setSeenSeq] = useState(() => useSchedulesViewStore.getState().landedSeq);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
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
  // A page it changes takes focus, since what had it may be gone.
  if (active && !editing && request.seq > seenSeq) {
    const next = pageFor(request.scheduleId);
    setSeenSeq(request.seq);
    go(next);
    if (next.kind === "history") setFocusTarget({ kind: "back", visible: false });
    else if (page.kind === "history") setFocusTarget({ kind: "add" });
  }
  useEffect(() => {
    markLanded(seenSeq);
  }, [seenSeq, markLanded]);

  // A run's notification leaves the tab alone while it's in front.
  useEffect(() => {
    setShowing(active);
  }, [active, setShowing]);
  useEffect(() => () => setShowing(false), [setShowing]);

  const { state, retry, accept } = useProjectSchedules(active);
  // The editor's save or delete answer, folded in so the list doesn't wait for the push.
  useEffect(() => {
    if (editorAnswer) accept(editorAnswer);
  }, [editorAnswer, accept]);
  // Each answer is shown against the snapshot it was asked about, so turning a
  // switch shows once main has written or removed the job, not before.
  const osJob = useScheduleOsJob(active, state.snapshot?.revision ?? null, state.snapshot);
  const { lastRuns, retryLastRuns } = useLastRuns(
    active ? (state.snapshot?.projectId ?? null) : null
  );
  const { runsState, retryRuns } = useScheduleRuns(
    active && page.kind === "history" ? (state.snapshot?.projectId ?? null) : null,
    page.kind === "history" ? page.id : null
  );
  // Re-read on a schedule change and on fresh run history too, so a run that just
  // landed is never timed against an older clock reading.
  const now = useWallClock(
    `${active}:${state.snapshot?.revision ?? -1}:${lastRuns.version}:${runsState.version}`,
    active ? untilNextMinute : never
  );
  const worktrees = useWorktreeChoices();
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
  const { preset: shownPreset, stopsAtPrompts: shownSettingsRead } = useScheduleLaunchOptions(
    shown?.launch.agentId ?? "",
    shown?.launch.presetId ?? null
  );
  // Claimed missing only once agent settings have been read, so a cold open never flashes it.
  const presetMissing =
    shown?.launch.presetId != null && shownSettingsRead !== null && shownPreset === undefined;
  const resumeSession = useResumeAgentSession();

  useEffect(() => {
    if (focusTarget === null) return;
    const frame = requestAnimationFrame(() => {
      const root = containerRef.current;
      let target: HTMLElement | null = null;
      let visible = false;
      if (focusTarget.kind === "back") {
        target = backButtonRef.current;
        visible = focusTarget.visible;
      } else if (focusTarget.kind === "row") {
        target =
          root?.querySelector<HTMLElement>(scheduleActionSelector(focusTarget.id, "history")) ??
          null;
        visible = focusTarget.visible;
      } else if (focusTarget.kind === "run-now") {
        target =
          root?.querySelector<HTMLElement>(scheduleActionSelector(focusTarget.id, "run")) ??
          root?.querySelector<HTMLElement>(HISTORY_RUN_NOW_SELECTOR) ??
          null;
        visible = true;
      }
      target ??= root?.querySelector<HTMLElement>(NEW_SCHEDULE_SELECTOR) ?? null;
      target?.focus({ focusVisible: visible });
      setFocusTarget(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget]);

  const openHistory = (schedule: Schedule, viaKeyboard: boolean) => {
    go({ kind: "history", id: schedule.id });
    setFocusTarget({ kind: "back", visible: viaKeyboard });
  };
  const backToList = (viaKeyboard: boolean) => {
    const from = page.kind === "history" ? page.id : null;
    go({ kind: "list" });
    setFocusTarget(from ? { kind: "row", id: from, visible: viaKeyboard } : { kind: "add" });
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
  // only for a failure the history couldn't record. Backing out runs nothing. A
  // failure stays up while its Retry is pending, so the focused Retry isn't pulled
  // out from under the keyboard; once a retry gets through, focus goes to Run now.
  const runNow = async (schedule: Schedule) => {
    if (pendingRunNow.has(schedule.id)) return;
    const retrying = document.activeElement?.closest(RUN_NOW_FAILURE_SELECTOR) != null;
    setPendingRunNow((prev) => new Set(prev).add(schedule.id));
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
      if (outcome.status === "failed" && outcome.runId === null) {
        fail(outcome.message);
        return;
      }
      setRunNowFailure((prev) => (prev?.scheduleId === schedule.id ? null : prev));
      setRunNowStatus(runNowWords(outcome, schedule.name));
      if (retrying) setFocusTarget({ kind: "run-now", id: schedule.id });
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
  // An Assistant's run lives in an Assistant tab (#16169): the tab holding its
  // conversation is brought forward, or the conversation reopens in one.
  const showAssistantRun = (run: ScheduledRun): boolean => {
    const resume = run.resume;
    if (run.assistant !== true || !resume?.agentSessionId) return false;
    if (!ASSISTANT_RESUMABLE_AGENTS.has(resume.agentId)) return false;
    const args = { agentId: resume.agentId, sessionId: resume.agentSessionId };
    closeThen(
      () => void actionService.dispatch("help.resumePastSession", args, { source: "user" })
    );
    return true;
  };
  const openRun = (run: ScheduledRun) => {
    const terminalId = run.terminalId;
    if (!terminalId || showAssistantRun(run)) return;
    closeThen(() => revealRunTerminal(terminalId));
  };
  const resumeRun = (run: ScheduledRun, schedule: Schedule) => {
    if (showAssistantRun(run)) return;
    const record = sessionRecordFor(run, schedule);
    if (!record) return;
    closeThen(() => void resumeSession(record));
  };

  // ── Delete from a row ──
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The row that slides into the deleted one's place, or the one above it.
  const deleteSuccessorRef = useRef<string | null>(null);
  const requestDelete = (schedule: Schedule) => {
    const index = schedules.findIndex((s) => s.id === schedule.id);
    deleteSuccessorRef.current = schedules[index + 1]?.id ?? schedules[index - 1]?.id ?? null;
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
    const row = id
      ? containerRef.current?.querySelector<HTMLElement>(scheduleActionSelector(id, "delete"))
      : null;
    return row ?? addButtonRef.current;
  };

  const historyRunNowError =
    shown && runNowFailure?.scheduleId === shown.id ? runNowFailure.message : null;

  return (
    <div ref={containerRef} data-testid="project-schedules-tab">
      <p role="status" className="sr-only">
        {runNowStatus}
      </p>

      {page.kind === "list" && (
        <ScheduleList
          state={state}
          now={now}
          switches={
            <ScheduleSwitches
              switches={state.snapshot?.switches ?? null}
              osJobStatus={osJob.status}
              onSaved={accept}
            >
              <ScheduleOsJobStatus
                status={osJob.status}
                basis={osJob.basis}
                switches={state.snapshot?.switches ?? null}
                checking={osJob.checking}
                repairing={osJob.repairing}
                error={osJob.error}
                onRepair={osJob.repair}
              />
            </ScheduleSwitches>
          }
          worktreeLabels={worktrees.labels}
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
                schedulesOn={state.snapshot?.switches.schedulesOn ?? false}
                worktreeLabel={
                  shown.launch.worktreeId === null
                    ? null
                    : (worktrees.labels.get(shown.launch.worktreeId) ?? "Missing worktree")
                }
                presetName={shown.launch.presetId === null ? null : (shownPreset?.name ?? null)}
                presetMissing={presetMissing}
                runsState={runsState}
                onRetryRuns={retryRuns}
                liveTerminalIds={liveTerminalIds}
                worktreeIds={worktrees.ids}
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
