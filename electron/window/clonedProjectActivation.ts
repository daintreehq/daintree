import type { Project } from "../../shared/types/project.js";
import { getPendingActivationProjectIds } from "./projectActivationClaims.js";
import { getWorkspaceClientRef } from "./serviceRefs.js";
import { getWindowRegistry } from "./windowRef.js";

/**
 * A clone has just become a checkout (#16352). Every window showing the project
 * attached to no workspace while it cloned, so each gets the project's
 * workspace now; its view then reloads into a normal project and takes its
 * ports on ready, as any reloaded view does. A cached view still holding the
 * cloning page is let go, so the project opens fresh next time.
 *
 * A window with an activation in flight is left alone: that switch may already
 * have asked for its own workspace, and a load issued here would supersede it.
 * A switch landing on this project reconciles the load itself once its swap
 * settles (`activateProjectView`). Any switch that starts after the load below
 * asks for its workspace later, so it owns the window's mapping.
 */
export async function loadClonedProjectInWindows(project: Project): Promise<void> {
  const registry = getWindowRegistry();
  if (!registry) return;
  const workspace = getWorkspaceClientRef();

  await Promise.all(
    registry.all().map(async (ctx) => {
      const pvm = ctx.services.projectViewManager;
      if (!pvm) return;
      if (pvm.getActiveProjectId() !== project.id) {
        pvm.releaseCachedView(project.id);
        return;
      }
      if (!workspace) return;
      if (getPendingActivationProjectIds(ctx.windowId).length > 0) return;
      try {
        await workspace.loadProject(project.path, ctx.windowId);
      } catch (error) {
        console.warn("[ProjectClone] Couldn't load the cloned project's workspace:", error);
      }
    })
  );
}
