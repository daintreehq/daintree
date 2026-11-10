import type { Project } from "../../shared/types/project.js";
import type { WorkspaceClient } from "../services/WorkspaceClient.js";
import type { WindowContext } from "./WindowRegistry.js";
import { getPendingActivationProjectIds } from "./projectActivationClaims.js";
import { onProjectPresenceChanged } from "./projectPresenceChanges.js";
import { getWorkspaceClientRef, getWorktreePortBrokerRef } from "./serviceRefs.js";
import { getWindowRegistry } from "./windowRef.js";

/** How long a window's in-flight switch may hold the reconciliation back. */
const SETTLE_TIMEOUT_MS = 60_000;
/** Reconciliations a window may need when switches keep overtaking its load. */
const MAX_RECONCILE_ATTEMPTS = 3;

function hasActivationInFlight(ctx: WindowContext): boolean {
  return getPendingActivationProjectIds(ctx.windowId).length > 0;
}

/**
 * Load the project's workspace for a window still showing it once that
 * window's in-flight switch has settled, and hand the view its ports: its
 * reload into the ready project has usually happened by then, and it found no
 * workspace to take them from. A switch that went elsewhere leaves nothing to
 * do. A load that a newer switch overtook is tried again once that switch
 * settles: the window can end up attached to the workspace (a failed swap's
 * rollback re-points it) without this view's port ever being registered.
 */
function reconcileWhenSettled(
  ctx: WindowContext,
  project: Project,
  workspace: WorkspaceClient,
  attempt = 1
) {
  let done = false;
  const finish = () => {
    done = true;
    unsubscribe();
    clearTimeout(timer);
  };
  const check = () => {
    if (done || hasActivationInFlight(ctx)) return;
    finish();
    const pvm = ctx.services.projectViewManager;
    if (ctx.browserWindow.isDestroyed() || pvm?.getActiveProjectId() !== project.id) return;
    void workspace
      .loadProject(project.path, ctx.windowId)
      .then(() => {
        if (pvm.getActiveProjectId() !== project.id) return;
        if (hasActivationInFlight(ctx) || !workspace.isWindowAttached(ctx.windowId, project.path)) {
          if (attempt < MAX_RECONCILE_ATTEMPTS) {
            reconcileWhenSettled(ctx, project, workspace, attempt + 1);
          }
          return;
        }
        const webContents = pvm.getActiveView()?.webContents;
        if (!webContents || webContents.isDestroyed()) return;
        workspace.attachDirectPort(ctx.windowId, webContents);
        const host = workspace.getHostForProject(project.path);
        const broker = getWorktreePortBrokerRef();
        if (host && broker) broker.brokerPort(host, webContents);
      })
      .catch((error: unknown) => {
        console.warn("[ProjectClone] Couldn't load the cloned project's workspace:", error);
      });
  };
  const unsubscribe = onProjectPresenceChanged(check);
  const timer = setTimeout(finish, SETTLE_TIMEOUT_MS);
  timer.unref?.();
  // A retry may arm after the overtaking switch has already settled, and a
  // rollback re-attaching the window announces nothing.
  check();
}

/**
 * A clone has just become a checkout (#16352). Every window showing the project
 * attached to no workspace while it cloned, so each gets the project's
 * workspace now; its view then reloads into a normal project and takes its
 * ports on ready, as any reloaded view does. A cached view still holding the
 * cloning page is let go, so the project opens fresh next time.
 *
 * A window with an activation in flight is not loaded now: that switch may
 * already have asked for its own workspace, and a load issued here would
 * supersede it. It is reconciled once the switch settles. Any switch that
 * starts after the load below asks for its workspace later, so it owns the
 * window's mapping.
 */
export async function loadClonedProjectInWindows(project: Project): Promise<void> {
  const registry = getWindowRegistry();
  if (!registry) return;
  const workspace = getWorkspaceClientRef();

  await Promise.all(
    registry.all().map(async (ctx) => {
      const pvm = ctx.services.projectViewManager;
      if (!pvm) return;
      if (hasActivationInFlight(ctx)) {
        if (workspace) reconcileWhenSettled(ctx, project, workspace);
        return;
      }
      if (pvm.getActiveProjectId() !== project.id) {
        pvm.releaseCachedView(project.id);
        return;
      }
      if (!workspace) return;
      try {
        await workspace.loadProject(project.path, ctx.windowId);
      } catch (error) {
        console.warn("[ProjectClone] Couldn't load the cloned project's workspace:", error);
      }
    })
  );
}
