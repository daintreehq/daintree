import type { Project } from "../../shared/types/project.js";
import { projectStore } from "../services/ProjectStore.js";
import { getWorkspaceClientRef } from "./serviceRefs.js";
import { getWindowRegistry } from "./windowRef.js";

/**
 * A clone has just become a checkout (#16352). Every window showing the project
 * attached to no workspace while it cloned, so each gets the project's
 * workspace now; its view then reloads into a normal project and takes its
 * ports on ready, as any reloaded view does. A cached view still holding the
 * cloning page is let go, so the project opens fresh next time.
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
      try {
        await workspace.loadProject(project.path, ctx.windowId);
      } catch (error) {
        console.warn("[ProjectClone] Couldn't load the cloned project's workspace:", error);
        return;
      }
      // The window moved on while the host loaded. The load just attached it to
      // this project's workspace, so hand it back to whatever it shows now.
      const nowActive = pvm.getActiveProjectId();
      if (nowActive === project.id) return;
      const nowPath = nowActive ? projectStore.getProjectById(nowActive)?.path : undefined;
      if (nowPath) {
        await workspace.loadProject(nowPath, ctx.windowId).catch(() => {});
      } else {
        workspace.unregisterWindow(ctx.windowId);
      }
    })
  );
}
