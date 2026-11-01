import { schedulesClient } from "@/clients/schedulesClient";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useSchedulesViewStore } from "@/store/schedulesViewStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";
import { isPtyPanel } from "@shared/types/panel";

/**
 * Bring a run's terminal forward: out of the trash or the background, into its
 * worktree, and focused. A pane in the trash still holds the run's agent, so it's
 * restored rather than resumed beside itself.
 */
export function revealRunTerminal(terminalId: string): boolean {
  const panels = usePanelStore.getState();
  const panel = panels.panelsById[terminalId];
  if (!panel) return false;
  if (panel.location === "trash") panels.restoreTerminal(terminalId);
  const worktreeId = usePanelStore.getState().panelsById[terminalId]?.worktreeId ?? null;
  const selection = useWorktreeSelectionStore.getState();
  if (worktreeId && worktreeId !== selection.activeWorktreeId) {
    selection.selectWorktree(worktreeId, { source: "user" });
  }
  if (usePanelStore.getState().panelsById[terminalId]?.location === "background") {
    usePanelStore.getState().restoreBackgroundTerminal(terminalId);
  }
  usePanelStore.getState().activateTerminal(terminalId);
  return true;
}

/** The run's pane in this view, if it still has one: a pane carrying the run, out of any dialog. */
function holdsRunPane(panelId: string | null, runId: string): panelId is string {
  if (!panelId) return false;
  const panel = usePanelStore.getState().panelsById[panelId];
  return (
    panel !== undefined &&
    isPtyPanel(panel) &&
    panel.location !== "dialog" &&
    panel.scheduledRun?.runId === runId
  );
}

export interface ScheduledRunLandingTarget {
  runId: string;
  scheduleId: string;
  panelId: string | null;
}

/**
 * Where a click on a scheduled run's banner lands in this view (#15988): the
 * run's pane, trashed or backgrounded panes included, whatever its terminal
 * did since, since its output is what the user came for. With no pane left,
 * the schedule's history opens, where the run's outcome and its Resume are;
 * a schedule deleted since opens the list. A Schedules view already open is
 * left as it is: moving it to another page would drop an edit in progress
 * without asking, and focusing a pane would put it under the dialog.
 * `isSuperseded` says a newer landing took over while the schedules were read.
 */
export async function landOnScheduledRun(
  target: ScheduledRunLandingTarget,
  isSuperseded: () => boolean
): Promise<void> {
  if (useSchedulesViewStore.getState().isOpen) return;
  if (holdsRunPane(target.panelId, target.runId)) {
    revealRunTerminal(target.panelId);
    await actionService.dispatch("panel.focus", { panelId: target.panelId });
    return;
  }
  const snapshot = await schedulesClient.list().catch((error: unknown) => {
    logWarn("Couldn't read the project's schedules for a run's notification", { error });
    return null;
  });
  if (isSuperseded()) return;
  // Unreadable, the schedule is asked for anyway: its page says what it can.
  const scheduleExists =
    snapshot === null || snapshot.schedules.some((schedule) => schedule.id === target.scheduleId);
  const result = await actionService.dispatch(
    "schedules.open",
    scheduleExists ? { scheduleId: target.scheduleId } : undefined,
    { source: "user" }
  );
  if (!result.ok) {
    logWarn("Couldn't open a run's schedule from its notification", { error: result.error });
  }
}
