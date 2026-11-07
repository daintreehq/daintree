import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { Project } from "../../../shared/types/project.js";
import type { ScheduledRunRef } from "../../../shared/types/scheduledRunRef.js";
import { sanitizeAgentToolbarPins } from "../../../shared/types/ipc/agentToolbarPins.js";
import { PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS } from "../../../shared/config/pluginBudgets.js";
import {
  executeViewlessAction,
  hasViewlessImplementation,
  type ViewlessActionRequest,
  type ViewlessDeps,
} from "./ViewlessActionExecutor.js";

export { hasViewlessImplementation, VIEWLESS_ACTION_IDS } from "./ViewlessActionExecutor.js";
export type {
  ViewlessActionRequest,
  ViewlessApprovalAsk,
  ViewlessApprovalDecision,
  ViewlessDeps,
} from "./ViewlessActionExecutor.js";

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
    getToolbarPins: async () => sanitizeAgentToolbarPins(store.get("agentToolbarPins")),
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
      project:
        (
          await projectStore.getProjectSettings(projectId).catch((error: unknown) => {
            console.warn(
              "[viewless] Couldn't read project settings; launching without project env:",
              error
            );
            return null;
          })
        )?.environmentVariables ?? {},
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
    collectWorktreeDeleteNotes: async (projectId, worktreeId) => {
      const { pluginService } = await import("../PluginService.js");
      // One deadline for the whole wait, startup included, since the approval
      // isn't put to anyone until the notes are in.
      const expiresAt = Date.now() + PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS;
      await pluginService.waitForCatalogWithin(PLUGIN_WORKTREE_DELETE_NOTES_TIMEOUT_MS);
      return pluginService.collectWorktreeDeleteNotes(
        projectId,
        worktreeId,
        Math.max(0, expiresAt - Date.now())
      );
    },
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

/** Spawn the host's own assistant with no view (#13511); see `spawnHostAssistant`. */
export async function spawnHostAssistantLive(
  project: Parameters<typeof import("./viewlessAgents.js").spawnHostAssistant>[0],
  spec: Parameters<typeof import("./viewlessAgents.js").spawnHostAssistant>[1]
): Promise<boolean> {
  const [{ spawnHostAssistant }, deps] = await Promise.all([
    import("./viewlessAgents.js"),
    loadLiveDeps(),
  ]);
  return spawnHostAssistant(project, spec, deps);
}

/** Reopen a saved agent session as a pane of its worktree (#16000); see `resumeAgentSessionAsPane`. */
export async function resumeAgentSessionAsPaneLive(
  request: import("./viewlessAgentResume.js").AgentSessionPaneRequest
): Promise<import("./viewlessAgentResume.js").AgentSessionPaneResult> {
  const [{ resumeAgentSessionAsPane }, { spawnAndConfirm }, { getPtyClient }, { stat }, deps] =
    await Promise.all([
      import("./viewlessAgentResume.js"),
      import("../assistants/assistantLaunch.js"),
      import("../../window/serviceRefs.js"),
      import("node:fs/promises"),
      loadLiveDeps(),
    ]);
  return resumeAgentSessionAsPane(request, deps, {
    isDirectory: async (path) => (await stat(path)).isDirectory(),
    confirmSpawn: (terminalId, spawn) =>
      spawnAndConfirm(
        getPtyClient(),
        async () => {
          await spawn();
          return true;
        },
        terminalId
      ),
  });
}

/** Wait for an agent main launched or found to be at rest (#16000); see `waitForAgentAtPrompt`. */
export async function waitForAgentAtPromptLive(
  terminalId: string,
  options: { timeoutMs: number; signal?: AbortSignal; promptOnly?: boolean }
): Promise<import("./agentPromptWait.js").AgentPromptWaitResult> {
  const { waitForAgentAtPrompt } = await import("./agentPromptWait.js");
  return waitForAgentAtPrompt(terminalId, options);
}

/**
 * Launch a scheduled run's agent in a project no view shows (#15978): the
 * generic launch, with the run as provenance that only this entry can pass.
 */
export async function runScheduledAgentLaunchLive(
  project: Project,
  request: {
    args: object;
    scheduledRun: ScheduledRunRef;
  }
): Promise<ActionDispatchResult> {
  const [{ runAgentLaunch }, deps] = await Promise.all([
    import("./viewlessAgents.js"),
    loadLiveDeps(),
  ]);
  return runAgentLaunch(
    { workspaceId: project.id, actionId: "agent.launch", args: request.args, confirmed: true },
    project,
    deps,
    { scheduledRun: request.scheduledRun }
  );
}

/** Restart a terminal of a project no frontend is attached to (#14703); see `restartTerminalWithoutView`. */
export async function restartTerminalWithoutViewLive(
  projectId: string,
  terminalId: string,
  isCurrent: () => boolean,
  beforeChange?: () => void
): Promise<import("./viewlessTerminalRestart.js").ViewlessRestartOutcome> {
  const [{ restartTerminalWithoutView }, deps] = await Promise.all([
    import("./viewlessTerminalRestart.js"),
    loadLiveDeps(),
  ]);
  return restartTerminalWithoutView(projectId, terminalId, deps, isCurrent, beforeChange);
}

/** The workspace identity a viewless result is stamped with, when it is a project. */
export async function describeViewlessWorkspace(
  workspaceId: string
): Promise<{ kind: "project"; workspaceId: string; workspacePath: string } | undefined> {
  const { projectStore } = await import("../ProjectStore.js");
  const project = projectStore.getProjectById(workspaceId);
  return project ? { kind: "project", workspaceId, workspacePath: project.path } : undefined;
}
