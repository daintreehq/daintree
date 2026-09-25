import { getIpcDispatcher } from "../../ipc/dispatcher.js";
import { getEndpointRegistry } from "../../ipc/endpointRegistry.js";
import { projectStore } from "../../services/ProjectStore.js";
import { setAttachedFrontendCount } from "../../services/PowerSaveBlockerService.js";
import { registerRemoteService } from "../runtime.js";
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
    describeProject: (projectId) => {
      const project = projectStore.getProjectById(projectId);
      return project ? { projectId: project.id, path: project.path, name: project.name } : null;
    },
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
