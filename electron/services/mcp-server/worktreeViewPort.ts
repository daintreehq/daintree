import type { WorktreePortHost } from "../WorktreePortBroker.js";
import { getWorkspaceClientRef, getWorktreePortBrokerRef } from "../../window/serviceRefs.js";
import { isCachedViewWebContents } from "../../window/webContentsRegistry.js";
import type { DispatchedWorkspaceRef } from "./shared.js";

/**
 * The worktree port of a cached view that routed MCP dispatch reaches (#13348).
 *
 * Caching closes a view's worktree port so a frozen renderer never queues host
 * updates (#6273), but a pinned or workspace-bound session — and in Host mode
 * the Shell view holding the drive lease — keeps dispatching into that view.
 * Without a port its worktree store stops at the moment it was cached: a
 * worktree the session just created on the workspace host never reaches it, so
 * launching into it by id, listing it, or resolving its path all fail.
 */
export interface RoutedViewWorktreePort {
  /**
   * Give a cached view its worktree port back and resolve once the renderer
   * confirms it — the renderer starts its snapshot fetch before confirming.
   * True when the port is live or the view is not cached (its port is the
   * activation path's to manage); false when it could not be restored.
   */
  prepare(
    webContents: Electron.WebContents,
    workspace: DispatchedWorkspaceRef | undefined
  ): Promise<boolean>;
  /**
   * Close the port again once nothing is dispatching into the view. A view
   * that is no longer cached keeps it: reactivation made it the foreground's.
   */
  release(webContentsId: number): void;
}

/** Inside the bridge's dispatch deadline; a thawed renderer confirms in milliseconds. */
const PORT_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Passed when no local workspace host serves the view's path. The broker's host
 * override still swaps in a remote view's relay; a local view with no host
 * refuses here rather than reaching some other project's host.
 */
const NO_LOCAL_HOST: WorktreePortHost = {
  projectPath: "mcp-dispatch:no-local-host",
  attachWorktreePort: () => false,
};

export const routedViewWorktreePort: RoutedViewWorktreePort = {
  async prepare(webContents, workspace) {
    const webContentsId = webContents.id;
    if (!isCachedViewWebContents(webContentsId)) return true;
    // A scratch workspace has no worktree store to keep current.
    if (workspace?.kind === "scratch") return true;
    const broker = getWorktreePortBrokerRef();
    if (!broker) return false;
    // A port another in-flight dispatch restored is joined, never re-posted:
    // replacing an unconfirmed port fails the confirmation that one awaits.
    if (!broker.hasPort(webContentsId)) {
      const host =
        (workspace && getWorkspaceClientRef()?.getHostForProject(workspace.workspacePath)) ||
        NO_LOCAL_HOST;
      if (!broker.brokerPort(host, webContents)) return false;
    }
    return broker.waitForConfirmation(webContentsId, PORT_CONFIRM_TIMEOUT_MS);
  },

  release(webContentsId) {
    if (!isCachedViewWebContents(webContentsId)) return;
    getWorktreePortBrokerRef()?.closePortsForView(webContentsId);
  },
};
