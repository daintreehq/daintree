import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import {
  executeViewlessAction,
  hasViewlessImplementation,
  type ViewlessActionRequest,
  type ViewlessDeps,
} from "./ViewlessActionExecutor.js";

export { hasViewlessImplementation, VIEWLESS_ACTION_IDS } from "./ViewlessActionExecutor.js";
export type { ViewlessActionRequest, ViewlessDeps } from "./ViewlessActionExecutor.js";

/**
 * The live services, loaded on first use. The MCP bridge is the only caller and
 * sits behind its own lazy import, so pulling the project store and the IPC
 * dispatcher in eagerly here would only widen what every bridge import drags
 * along for a path most dispatches never take.
 */
async function loadLiveDeps(): Promise<ViewlessDeps> {
  const [
    { projectStore },
    { getPtyClient, getWorkspaceClientRef, getCliAvailabilityServiceRef },
    { invokeHostChannel, sendHostChannel },
    { store },
    { CcrConfigService },
    { handleTerminalGetStatusViewless },
    os,
  ] = await Promise.all([
    import("../ProjectStore.js"),
    import("../../window/serviceRefs.js"),
    import("./viewlessInvoke.js"),
    import("../../store.js"),
    import("../CcrConfigService.js"),
    import("../mcp-server/terminalStatus.js"),
    import("node:os"),
  ]);

  const agents: ViewlessDeps["agents"] = {
    getSettings: async () => store.get("agentSettings") ?? null,
    // Discovered presets exist for Claude only; a view's store holds them under
    // that agent once a read finds any, and nothing for every other agent.
    getCcrPresets: async (agentId) => {
      if (agentId !== "claude") return undefined;
      const presets = await CcrConfigService.getInstance().loadAndApply();
      return presets.length > 0 ? presets : undefined;
    },
    getProjectPresets: (projectPath) => projectStore.readInRepoPresets(projectPath),
    // A launchable probe with a resolved path is reused, as the view's
    // launcher reuses it; anything else is probed again first.
    getCliDetail: async (agentId) => {
      const service = getCliAvailabilityServiceRef();
      if (!service) return undefined;
      const current = service.getDetails()?.[agentId];
      if (
        (current?.state === "ready" || current?.state === "unauthenticated") &&
        current.resolvedPath?.trim()
      ) {
        return current;
      }
      try {
        await service.refresh();
      } catch {
        // The registry command still launches; availability reports its own failure.
      }
      return service.getDetails()?.[agentId];
    },
    getAvailability: async () => {
      const service = getCliAvailabilityServiceRef();
      if (!service) return { availability: {}, live: false };
      const availability = service.getAvailability() ?? (await service.checkAvailability());
      return { availability, live: true };
    },
  };

  return {
    getProject: (projectId) => projectStore.getProjectById(projectId),
    getLaunchEnvLayers: async (projectId) => ({
      global: store.get("globalEnvironmentVariables") ?? {},
      project: (await projectStore.getProjectSettings(projectId))?.environmentVariables ?? {},
    }),
    getProjectState: (projectId) => projectStore.getProjectState(projectId),
    stateWriter: projectStore,
    getPtyReader: () => getPtyClient(),
    getWorkspaceHosts: () => getWorkspaceClientRef(),
    invoke: (projectId, channel, args) => invokeHostChannel(projectId, channel, args),
    send: (projectId, channel, args) => sendHostChannel(projectId, channel, args),
    agents,
    readTerminalStatus: (args, projectId) => handleTerminalGetStatusViewless(args, projectId),
    hostPlatform: {
      shellDialect: process.platform === "win32" ? "windows" : "posix",
      tmpDir: os.tmpdir(),
      totalMemoryBytes: os.totalmem(),
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * Run an agent-facing action in main for a workspace with no frontend
 * attached. Resolves `null` when the host cannot act for it on its own.
 */
export async function runViewlessAction(
  request: ViewlessActionRequest,
  deps?: ViewlessDeps
): Promise<ActionDispatchResult | null> {
  if (!hasViewlessImplementation(request.actionId)) return null;
  return executeViewlessAction(request, deps ?? (await loadLiveDeps()));
}

/** The workspace identity a viewless result is stamped with, when it is a project. */
export async function describeViewlessWorkspace(
  workspaceId: string
): Promise<{ kind: "project"; workspaceId: string; workspacePath: string } | undefined> {
  const { projectStore } = await import("../ProjectStore.js");
  const project = projectStore.getProjectById(workspaceId);
  return project ? { kind: "project", workspaceId, workspacePath: project.path } : undefined;
}
