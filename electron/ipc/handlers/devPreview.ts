import { CHANNELS } from "../channels.js";
import { broadcastToRenderer, typedHandle } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewStateChangedPayload,
} from "../../../shared/types/ipc/devPreview.js";
import { DevPreviewSessionService } from "../../services/DevPreviewSessionService.js";
import { getHibernationService } from "../../services/HibernationService.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const sessionService = new DevPreviewSessionService(deps.ptyClient!, (state) => {
    const payload: DevPreviewStateChangedPayload = { state };
    broadcastToRenderer(CHANNELS.DEV_PREVIEW_STATE_CHANGED, payload);
  });

  const handleEnsure = async (request: DevPreviewEnsureRequest) => {
    return sessionService.ensure(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_ENSURE, handleEnsure));

  const handleRestart = async (request: DevPreviewSessionRequest) => {
    return sessionService.restart(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_RESTART, handleRestart));

  const handleStop = async (request: DevPreviewSessionRequest) => {
    return sessionService.stop(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_STOP, handleStop));

  const handleStopByPanel = async (request: DevPreviewStopByPanelRequest) => {
    await sessionService.stopByPanel(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_STOP_BY_PANEL, handleStopByPanel));

  const handleGetState = async (request: DevPreviewSessionRequest) => {
    return sessionService.getState(request);
  };
  handlers.push(typedHandle(CHANNELS.DEV_PREVIEW_GET_STATE, handleGetState));

  const unsubHibernation = getHibernationService().onProjectHibernated((projectId) => {
    sessionService.stopByProject(projectId).catch((err) => {
      console.error("[DevPreview] Failed to stop sessions during hibernation:", err);
    });
  });

  return () => {
    unsubHibernation();
    sessionService.dispose();
    handlers.forEach((dispose) => dispose());
  };
}
