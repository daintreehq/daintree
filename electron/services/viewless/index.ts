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
    { getPtyClient, getWorkspaceClientRef },
    { invokeHostChannel },
    { store },
  ] = await Promise.all([
    import("../ProjectStore.js"),
    import("../../window/serviceRefs.js"),
    import("./viewlessInvoke.js"),
    import("../../store.js"),
  ]);
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
