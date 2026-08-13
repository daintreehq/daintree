import { useEffect } from "react";
import { getEffectiveAgentConfig, getEffectiveAgentIds } from "@shared/config/agentRegistry";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import {
  RemoteRendererRequestSchema,
  RemoteRendererResponseSchema,
  type RemoteRendererRequest,
  type RemoteRendererResponse,
} from "@shared/types/ipc/remoteRendererBridge";
import type { RemoteLaunchableAgents } from "@shared/types/remote";
import { isAgentLaunchable } from "@shared/utils/agentAvailability";
import { actionService } from "@/services/ActionService";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { getCurrentViewStore, panelStoreApi } from "@/store";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { buildRemotePanelProjection } from "./useRemotePanelProjection";

type LaunchDispatchResult = {
  launched: boolean;
  terminalId: string | null;
  worktreeId: string | null;
  location: "grid" | "dock" | null;
  spawnStatus: "missing-cli" | null;
};

interface RemoteRendererHandlerDeps {
  getProjectId(): string | null;
  hasWorktree(worktreeId: string): boolean;
  getPanelProjection(
    projectId: string
  ): Extract<RemoteRendererResponse, { method: "remote:getPanelProjection"; ok: true }>["result"];
  getLaunchableAgents(projectId: string, worktreeId: string): RemoteLaunchableAgents;
  dispatchAgentLaunch(
    request: Extract<RemoteRendererRequest, { method: "remote:launchAgent" }>
  ): Promise<{ ok: true; result: LaunchDispatchResult } | { ok: false; message: string }>;
  getLaunchGeneration(panelId: string): number | undefined;
  closeAgent(panelId: string, projectId: string, worktreeId: string): Promise<boolean>;
}

function errorResponse(
  request: RemoteRendererRequest,
  code: "PROJECT_CONTEXT_MISMATCH" | "WORKTREE_NOT_FOUND" | "ACTION_FAILED" | "UNAVAILABLE",
  message: string
): RemoteRendererResponse {
  return {
    requestId: request.requestId,
    projectId: request.projectId,
    webContentsId: request.webContentsId,
    rendererGeneration: request.rendererGeneration,
    method: request.method,
    ok: false,
    error: { code, message },
  };
}

export function createRemoteRendererRequestHandler(deps: RemoteRendererHandlerDeps) {
  return async (payload: unknown): Promise<RemoteRendererResponse> => {
    const parsed = RemoteRendererRequestSchema.safeParse(payload);
    if (!parsed.success) throw new Error("INVALID_REMOTE_RENDERER_REQUEST");
    const request = parsed.data;
    if (deps.getProjectId() !== request.projectId) {
      return errorResponse(request, "PROJECT_CONTEXT_MISMATCH", "Renderer project context changed");
    }
    if (request.method === "remote:getPanelProjection") {
      return {
        requestId: request.requestId,
        projectId: request.projectId,
        webContentsId: request.webContentsId,
        rendererGeneration: request.rendererGeneration,
        method: request.method,
        ok: true,
        result: deps.getPanelProjection(request.projectId),
      };
    }
    if (!deps.hasWorktree(request.worktreeId)) {
      return errorResponse(request, "WORKTREE_NOT_FOUND", "Worktree is unavailable");
    }
    if (request.method === "remote:getLaunchableAgents") {
      return {
        requestId: request.requestId,
        projectId: request.projectId,
        webContentsId: request.webContentsId,
        rendererGeneration: request.rendererGeneration,
        method: request.method,
        ok: true,
        result: deps.getLaunchableAgents(request.projectId, request.worktreeId),
      };
    }
    if (request.method === "remote:closeAgent") {
      if (deps.getLaunchGeneration(request.panelId) !== request.launchGeneration) {
        return errorResponse(request, "ACTION_FAILED", "Agent launch identity changed");
      }
      let closed = false;
      try {
        closed = await deps.closeAgent(request.panelId, request.projectId, request.worktreeId);
      } catch {
        return errorResponse(request, "ACTION_FAILED", "Agent panel close failed");
      }
      if (!closed) {
        return errorResponse(request, "ACTION_FAILED", "Agent panel could not be closed");
      }
      return {
        requestId: request.requestId,
        projectId: request.projectId,
        webContentsId: request.webContentsId,
        rendererGeneration: request.rendererGeneration,
        method: request.method,
        ok: true,
        result: {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          panelId: request.panelId,
          launchGeneration: request.launchGeneration,
          closed: true,
        },
      };
    }
    const dispatched = await deps.dispatchAgentLaunch(request);
    if (
      !dispatched.ok ||
      !dispatched.result.launched ||
      !dispatched.result.terminalId ||
      !dispatched.result.location ||
      dispatched.result.spawnStatus === "missing-cli"
    ) {
      return errorResponse(
        request,
        "ACTION_FAILED",
        dispatched.ok ? "Agent launch did not create a persistent panel" : dispatched.message
      );
    }
    if (dispatched.result.worktreeId !== request.worktreeId) {
      return errorResponse(request, "ACTION_FAILED", "Agent launch targeted a different worktree");
    }
    const launchGeneration = deps.getLaunchGeneration(dispatched.result.terminalId);
    if (launchGeneration === undefined || launchGeneration <= 0) {
      return errorResponse(request, "ACTION_FAILED", "Agent launch identity is unavailable");
    }
    return {
      requestId: request.requestId,
      projectId: request.projectId,
      webContentsId: request.webContentsId,
      rendererGeneration: request.rendererGeneration,
      method: request.method,
      ok: true,
      result: {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        requestedPanelId: request.requestedPanelId,
        panelId: dispatched.result.terminalId,
        launchGeneration,
        placement: dispatched.result.location,
        spawnStatus: "starting",
        source: "remote",
        persistent: true,
        focusPolicy: "preserve",
      },
    };
  };
}

function getLaunchableAgents(projectId: string, worktreeId: string): RemoteLaunchableAgents {
  const availability = useCliAvailabilityStore.getState();
  const agents = availability.hasRealData
    ? getEffectiveAgentIds()
        .filter((agentId) => !isAssistantOnlyAgentId(agentId))
        .filter((agentId) => isAgentLaunchable(availability.availability[agentId]))
        .map((agentId) => {
          const config = getEffectiveAgentConfig(agentId)!;
          return {
            agentId,
            displayName: config.name,
            iconId: config.iconId,
            brandColor: config.color,
            supportsPrompt: true,
            modelIds: config.models?.map((model) => model.id) ?? [],
          };
        })
    : [];
  return { projectId, worktreeId, agents };
}

const handleRequest = createRemoteRendererRequestHandler({
  getProjectId: getViewWorkspaceId,
  hasWorktree: (worktreeId) => getCurrentViewStore().getState().worktrees.has(worktreeId),
  getPanelProjection: buildRemotePanelProjection,
  getLaunchableAgents,
  getLaunchGeneration: (panelId) => agentLifecycleLedger.currentGeneration(panelId),
  closeAgent: async (panelId, projectId, worktreeId) => {
    const panel = panelStoreApi.getState().panelsById[panelId];
    if (!panel || panel.worktreeId !== worktreeId) return false;
    const dispatched = await actionService.dispatch(
      "terminal.close",
      { terminalId: panelId },
      {
        source: "agent",
        contextOverride: {
          projectId,
          activeWorktreeId: worktreeId,
          focusedWorktreeId: worktreeId,
        },
      }
    );
    return dispatched.ok;
  },
  dispatchAgentLaunch: async (request) => {
    const dispatch = buildRemoteAgentLaunchDispatch(request);
    const dispatched = await actionService.dispatch<LaunchDispatchResult>(
      dispatch.actionId,
      dispatch.args,
      dispatch.options
    );
    return dispatched.ok
      ? { ok: true, result: dispatched.result }
      : { ok: false, message: dispatched.error.message };
  },
});

export function buildRemoteAgentLaunchDispatch(
  request: Extract<RemoteRendererRequest, { method: "remote:launchAgent" }>
) {
  return {
    actionId: "agent.launch" as const,
    args: {
      agentId: request.agentId,
      worktreeId: request.worktreeId,
      requestedId: request.requestedPanelId,
      prompt: request.prompt,
      presetId: request.presetId,
      model: request.modelId,
      name: request.name,
      spawnedBy: "remote" as const,
      excludeFromPersistence: false,
      removeOnExit: false,
      activateDockOnCreate: false,
      focusPolicy: "preserve" as const,
    },
    options: {
      source: "agent" as const,
      contextOverride: {
        projectId: request.projectId,
        activeWorktreeId: request.worktreeId,
        focusedWorktreeId: request.worktreeId,
      },
    },
  };
}

export function useRemoteRendererBridge(): void {
  useEffect(() => {
    if (!window.electron?.remoteRendererBridge) return;
    let disposed = false;
    const cleanup = window.electron.remoteRendererBridge.onRequest((payload) => {
      safeFireAndForget(
        handleRequest(payload).then((response) => {
          if (disposed) return;
          const parsed = RemoteRendererResponseSchema.safeParse(response);
          if (parsed.success) window.electron.remoteRendererBridge.sendResponse(parsed.data);
        }),
        { context: "remote-renderer-bridge:request" }
      );
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
