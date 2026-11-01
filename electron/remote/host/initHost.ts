import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { isProjectFrontendAttached } from "../../services/mcp-server/frontendAttachment.js";
import { isWorkspaceKeepResident } from "../../services/workspaceResidency.js";
import { events } from "../../services/events.js";
import { setAttachedFrontendCount } from "../../services/PowerSaveBlockerService.js";
import { getMcpServerServiceRef, getPtyClient } from "../../window/serviceRefs.js";
import { registerRemoteService } from "../runtime.js";
import { MAX_PROJECT_EMOJI_LENGTH } from "./linkMethods.js";
import { ProjectAgentActivityCache } from "./ProjectAgentActivityCache.js";
import type { RemoteViewEndpoint } from "./RemoteViewEndpoint.js";
import { SessionHost, type SessionHostOptions, type SessionHostServer } from "./SessionHost.js";

declare module "../runtime.js" {
  interface RemoteServices {
    sessionHost: SessionHost;
  }
}

/** How often the host re-reads its views' answers, beside the events that change them. */
export const ASSISTANT_SWEEP_MS = 30_000;

/**
 * The same conditions a local view's eviction floor checks (#11157, #12108),
 * read here where the assistant runs: an unrevoked help session pinned to this
 * endpoint's handle, whose PTY is still alive, both for the same lane.
 */
function assistantLiveFor(endpoint: RemoteViewEndpoint): boolean {
  if (endpoint.projectId === null) return false;
  const pty = getPtyClient();
  if (!pty) return false;
  return helpSessionService
    .getAssistantBackends(endpoint.projectId)
    .some(
      (backend) => backend.webContentsId === endpoint.handle && pty.hasTerminal(backend.terminalId)
    );
}

/**
 * Serve Shells that attach through `server`: their views become endpoints in
 * this process's registry and their calls run through its dispatcher. Call
 * once per listening host server; dispose before the server closes for good.
 */
export function initRemoteHostsHost(
  server: SessionHostServer,
  overrides: Partial<SessionHostOptions> = {}
): { sessionHost: SessionHost; dispose(): void } {
  const sessionHost = new SessionHost(server, {
    dispatcher: getIpcDispatcher(),
    registry: getEndpointRegistry(),
    setAttachedFrontendCount,
    // A scratch is a workspace a view can show like a project, with no project row.
    describeProject: (projectId) => {
      const workspace =
        projectStore.getProjectById(projectId) ?? scratchStore.getScratchById(projectId);
      return workspace
        ? { projectId: workspace.id, path: workspace.path, name: workspace.name }
        : null;
    },
    // An emoji the Shell's schema would refuse is dropped, not the whole list.
    listProjects: () =>
      projectStore.getProjectSummaries().map(({ id, name, path, emoji }) => ({
        id,
        name,
        path,
        ...(emoji && emoji.length <= MAX_PROJECT_EMOJI_LENGTH ? { emoji } : {}),
        frontendAttached: isProjectFrontendAttached(id),
      })),
    assistantLive: assistantLiveFor,
    agentActive: (endpoint) =>
      endpoint.projectId !== null && agents.isProjectActive(endpoint.projectId),
    keepResident: (endpoint) =>
      endpoint.projectId !== null && isWorkspaceKeepResident(endpoint.projectId),
    // The same reading a local view's eviction pass takes (#11790), here where
    // the session runs. Before the MCP service loads there are no sessions.
    mcpBindingLive: (endpoint) =>
      endpoint.projectId !== null &&
      getMcpServerServiceRef()?.getWorkspaceViewActivity(endpoint.projectId, endpoint.handle)
        .liveBinding === true,
    ...overrides,
  });
  const unregister = registerRemoteService("sessionHost", sessionHost);
  // Read by `agentActive` above, which no endpoint can reach before this exists.
  // Its inventory is read only while a Shell has a view open here, the only
  // time an answer is read: Host mode often runs around the clock with nobody
  // attached (#15907).
  const agents = new ProjectAgentActivityCache(
    () => sessionHost.refreshAgentActivity(),
    () => sessionHost.servesViews
  );
  // An assistant's help binding is made before its PTY spawns, and every
  // revoke or displacement kills the PTY, so its spawn and its exit are the
  // moments its view's protection changes. The client may not exist yet when
  // this runs, and no view can launch an assistant without it, so each
  // endpoint that opens tries again.
  const refresh = () => sessionHost.refreshAssistants();
  let watched: PtyClient | null = null;
  const watchPty = () => {
    if (watched) return;
    watched = getPtyClient();
    watched?.on("spawn-result", refresh);
    watched?.on("exit", refresh);
    if (watched) agents.attach(watched);
  };
  const offAgentState = events.on("agent:state-changed", ({ terminalId, state }) => {
    if (terminalId) agents.noteState(terminalId, state);
  });
  // A view opening, or a Shell coming back to its views, may be the first
  // reader since the inventory was last read: its answer is read fresh, and
  // whatever changed since is told as it lands. A PTY client attached now
  // seeds itself.
  const readAgents = () => {
    if (watched) agents.reconcile();
    else watchPty();
  };
  watchPty();
  const offOpened = sessionHost.onEndpointOpened(readAgents);
  const offTransport = sessionHost.onTransportChange((_, attached) => {
    if (attached) readAgents();
  });
  // Not every end is an exit: a pty-host that dies mid-capture emits none, and
  // a revoke before the kill client is wired kills nothing. A slow sweep stops
  // the view those leave protected from staying so until something else changes.
  // The agent cache reads the inventory again on the same beat, while a view
  // is open to read it: a failed or partial read, or a pty-host that restarted
  // without a crash event, is repaired there, and any change it finds is
  // announced as it lands. An MCP session binding or dropping against a view
  // already open is only seen here: its liveness spans the session's routing
  // and transport records, which change at different moments, and the sweep
  // reads them settled.
  const sweep = setInterval(() => {
    refresh();
    agents.reconcile();
    sessionHost.refreshAgentActivity();
    sessionHost.refreshResidency();
    sessionHost.refreshMcpBindings();
  }, ASSISTANT_SWEEP_MS);
  sweep.unref?.();
  return {
    sessionHost,
    dispose() {
      clearInterval(sweep);
      offOpened();
      offTransport();
      offAgentState();
      agents.dispose();
      watched?.off("spawn-result", refresh);
      watched?.off("exit", refresh);
      watched = null;
      unregister();
      sessionHost.dispose();
    },
  };
}
