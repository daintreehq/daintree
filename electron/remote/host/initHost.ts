import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { setAttachedFrontendCount } from "../../services/PowerSaveBlockerService.js";
import { registerRemoteService } from "../runtime.js";
import { MAX_PROJECT_EMOJI_LENGTH } from "./linkMethods.js";
import { SessionHost, type SessionHostOptions, type SessionHostServer } from "./SessionHost.js";

declare module "../runtime.js" {
  interface RemoteServices {
    sessionHost: SessionHost;
  }
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
      projectStore.getAllProjects().map(({ id, name, path, emoji }) => ({
        id,
        name,
        path,
        ...(emoji && emoji.length <= MAX_PROJECT_EMOJI_LENGTH ? { emoji } : {}),
      })),
    ...overrides,
  });
  const unregister = registerRemoteService("sessionHost", sessionHost);
  return {
    sessionHost,
    dispose() {
      unregister();
      sessionHost.dispose();
    },
  };
}
