import { projectClient } from "@/clients/projectClient";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import {
  claimDroppedViewRestore,
  getProjectOpenErrorMessage,
  releaseDroppedViewRestore,
  runDroppedViewRestore,
  useProjectStore,
} from "@/store/projectStore";
import { logErrorWithContext } from "@/utils/errorContext";
import { restoreViewState } from "@/utils/stateHydration/restoreViewState";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { ProjectSwitchResult } from "@shared/types/ipc/project";

export type ProjectRestartOutcome =
  /** Slept, reopened in this window and its layout restored. */
  | "restarted"
  /** The sleep failed; the project is still open here. */
  | "sleep-failed"
  /** Slept, but the reopen failed; the project is asleep with its layout saved. */
  | "reopen-failed"
  /** Slept, then a newer navigation or another window took the reopen. */
  | "reopened-elsewhere"
  /** Reopened here, but the saved layout couldn't be restored. */
  | "restore-failed";

function retryRestart(projectId: string): void {
  void actionService.dispatch("project.restart", { projectId }, { source: "user" });
}

/**
 * Restart the project on screen without restarting the app: sleep it — which
 * stops its terminals with their sessions kept and disposes its workspace
 * host — then reopen it in this same window, so a fresh host lists the
 * worktrees from scratch and the saved layout comes back (#14179).
 *
 * `project:reopen` refuses a slept project, so the reopen goes through the
 * normal switch. Main keeps this window's view bound to the project, so the
 * switch reuses this renderer, and the restore runs here rather than at boot.
 *
 * Each failure says where the project was left: still open (the sleep
 * failed), asleep with its layout saved (the reopen failed), or open with
 * nothing restored (the restore failed).
 */
export async function restartProject(projectId: string): Promise<ProjectRestartOutcome> {
  const store = useProjectStore.getState();
  const name = store.projects.find((p) => p.id === projectId)?.name ?? "The project";

  try {
    await store.sleepProject(projectId);
  } catch (error) {
    notify({
      type: "error",
      title: "Couldn't restart project",
      message: `"${name}" couldn't be put to sleep, so it's still open in this window. ${formatErrorMessage(error, "The sleep failed.")}`,
      context: { eventKind: "recovery", projectId },
      actions: [{ label: "Try again", variant: "primary", onClick: () => retryRestart(projectId) }],
    });
    return "sleep-failed";
  }

  // The reopen below restores the layout itself, so the generic reopen listener
  // must not restore it a second time when `project:on-switch` lands first.
  claimDroppedViewRestore(projectId);
  useProjectStore.setState({ isLoading: true, isSwitching: true, switchingToProjectId: projectId });

  try {
    let result: ProjectSwitchResult;
    try {
      // No outgoing state: the sleep already saved the layout and wrote the
      // captured agent sessions into it, and the panel store is empty now.
      result = await projectClient.switch(projectId, undefined);
    } catch (error) {
      releaseDroppedViewRestore(projectId);
      logErrorWithContext(error, {
        operation: "restart_project_reopen",
        component: "projectRestart",
        details: { projectId },
      });
      notify({
        type: "error",
        title: "Couldn't reopen project",
        message: `"${name}" was put to sleep but didn't reopen: ${getProjectOpenErrorMessage(error)} Its layout and agent sessions are saved for when you open it.`,
        context: { eventKind: "recovery", projectId },
        actions: [
          {
            label: "Reopen project",
            variant: "primary",
            onClick: () => void useProjectStore.getState().switchProject(projectId),
          },
        ],
      });
      return "reopen-failed";
    }

    if (result.outcome !== "switched") {
      releaseDroppedViewRestore(projectId);
      if (result.outcome !== "superseded") {
        notify({
          type: "info",
          title: "Project reopened in another window",
          message: `"${name}" restarted and opened in the window that was already showing it.`,
          context: { eventKind: "recovery", projectId },
        });
      }
      return "reopened-elsewhere";
    }

    try {
      await runDroppedViewRestore(projectId, () => restoreViewState(undefined, projectId));
    } catch (error) {
      logErrorWithContext(error, {
        operation: "restart_project_restore",
        component: "projectRestart",
        details: { projectId },
      });
      notify({
        type: "error",
        title: "Couldn't restore project",
        message: `"${name}" reopened, but its terminals and layout couldn't be restored. Restarting it again loads them from the saved layout.`,
        context: { eventKind: "recovery", projectId },
        actions: [
          { label: "Try again", variant: "primary", onClick: () => retryRestart(projectId) },
        ],
      });
      return "restore-failed";
    }

    return "restarted";
  } finally {
    // A switch the user started meanwhile owns the busy flags now.
    if (useProjectStore.getState().switchingToProjectId === projectId) {
      useProjectStore.getState().clearSwitching();
    }
  }
}
