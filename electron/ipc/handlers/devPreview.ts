import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewStateChangedPayload,
  DevPreviewGetByWorktreeRequest,
} from "../../../shared/types/ipc/devPreview.js";
import type { DevPreviewSessionService as DevPreviewSessionServiceType } from "../../services/DevPreviewSessionService.js";
import { getHibernationService } from "../../services/HibernationService.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  let sessionService: DevPreviewSessionServiceType | null = null;
  let sessionServicePromise: Promise<DevPreviewSessionServiceType> | null = null;

  async function getSessionService(): Promise<DevPreviewSessionServiceType> {
    if (sessionService) return sessionService;
    if (!sessionServicePromise) {
      sessionServicePromise = import("../../services/DevPreviewSessionService.js")
        .then((mod) => {
          sessionService = new mod.DevPreviewSessionService(deps.ptyClient!, (state) => {
            const payload: DevPreviewStateChangedPayload = { state };
            broadcastToRenderer(CHANNELS.DEV_PREVIEW_STATE_CHANGED, payload);
          });
          return sessionService;
        })
        .catch((err) => {
          // Reset cached promise on failure so the next call can retry instead
          // of returning a permanently-rejected promise.
          sessionServicePromise = null;
          throw err;
        });
    }
    return sessionServicePromise;
  }

  const handleEnsure = async (request: DevPreviewEnsureRequest) => {
    const svc = await getSessionService();
    return svc.ensure(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_ENSURE, handleEnsure));

  const handleRestart = async (request: DevPreviewSessionRequest) => {
    const svc = await getSessionService();
    return svc.restart(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_RESTART, handleRestart));

  const handleStop = async (request: DevPreviewSessionRequest) => {
    const svc = await getSessionService();
    return svc.stop(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_STOP, handleStop));

  const handleStopByPanel = async (request: DevPreviewStopByPanelRequest) => {
    const svc = await getSessionService();
    await svc.stopByPanel(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_STOP_BY_PANEL, handleStopByPanel));

  const handleGetState = async (request: DevPreviewSessionRequest) => {
    const svc = await getSessionService();
    return svc.getState(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_GET_STATE, handleGetState));

  const handleGetByWorktree = async (request: DevPreviewGetByWorktreeRequest) => {
    if (!request || typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
      throw new Error("worktreeId is required");
    }
    const svc = await getSessionService();
    return svc.getByWorktree(request.worktreeId);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_GET_BY_WORKTREE, handleGetByWorktree));

  const unsubHibernation = getHibernationService().onProjectHibernated((projectId) => {
    // Skip if the session service was never created — no sessions exist to stop.
    if (!sessionService) return;
    sessionService.stopByProject(projectId).catch((err) => {
      console.error("[DevPreview] Failed to stop sessions during hibernation:", err);
    });
  });

  return () => {
    unsubHibernation();
    if (sessionService) {
      sessionService.dispose();
    }
    handlers.forEach((dispose) => dispose());
  };
}
