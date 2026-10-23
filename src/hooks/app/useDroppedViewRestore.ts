import { useEffect } from "react";
import { projectClient } from "@/clients/projectClient";
import { claimDroppedViewRestore, runDroppedViewRestore } from "@/store/projectStore";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { restoreViewState } from "@/utils/stateHydration/restoreViewState";

/**
 * Restore the saved layout when this view comes back onto the project it
 * dropped to the picker from (Sleep, here or in another window).
 *
 * Main keeps a dropped view bound to its project, so reopening it — from the
 * picker in this window, or by switching back to it from another project —
 * reuses this renderer rather than cold-starting one. Boot hydration has
 * already run here and the drop cleared the panels, so without this the
 * project reopened with an empty grid and its terminals left unrestored.
 */
export function useDroppedViewRestore(): void {
  useEffect(() => {
    return projectClient.onSwitch((payload) => {
      const project = payload?.project;
      if (!project || !claimDroppedViewRestore(project.id)) return;
      const restore = () => restoreViewState(undefined, project.id);
      void runDroppedViewRestore(project.id, restore).catch((error: unknown) => {
        logError("Failed to restore a reopened project", error);
        notify({
          type: "error",
          title: "Couldn't restore project",
          message: `"${project.name}" reopened, but its terminals and layout couldn't be restored. Restarting it loads them again.`,
          context: { eventKind: "recovery", projectId: project.id },
          actions: [
            {
              label: "Restart project",
              variant: "primary",
              onClick: () =>
                void actionService.dispatch(
                  "project.restart",
                  { projectId: project.id },
                  { source: "user" }
                ),
            },
          ],
        });
      });
    });
  }, []);
}
