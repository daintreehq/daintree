import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { DEV_PREVIEW_METHOD_CHANNELS } from "./devPreview.preload.js";
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

  const namespace = defineIpcNamespace({
    name: "devPreview",
    ops: {
      ensure: op(DEV_PREVIEW_METHOD_CHANNELS.ensure, async (request: DevPreviewEnsureRequest) => {
        const svc = await getSessionService();
        return svc.ensure(request);
      }),
      restart: op(
        DEV_PREVIEW_METHOD_CHANNELS.restart,
        async (request: DevPreviewSessionRequest) => {
          const svc = await getSessionService();
          return svc.restart(request);
        }
      ),
      restartAndClearCache: op(
        DEV_PREVIEW_METHOD_CHANNELS.restartAndClearCache,
        async (request: DevPreviewSessionRequest) => {
          const svc = await getSessionService();
          return svc.restartAndClearCache(request);
        }
      ),
      reinstallAndRestart: op(
        DEV_PREVIEW_METHOD_CHANNELS.reinstallAndRestart,
        async (request: DevPreviewSessionRequest) => {
          const svc = await getSessionService();
          return svc.reinstallAndRestart(request);
        }
      ),
      stop: op(DEV_PREVIEW_METHOD_CHANNELS.stop, async (request: DevPreviewSessionRequest) => {
        const svc = await getSessionService();
        return svc.stop(request);
      }),
      stopByPanel: op(
        DEV_PREVIEW_METHOD_CHANNELS.stopByPanel,
        async (request: DevPreviewStopByPanelRequest) => {
          const svc = await getSessionService();
          await svc.stopByPanel(request);
        }
      ),
      getState: op(
        DEV_PREVIEW_METHOD_CHANNELS.getState,
        async (request: DevPreviewSessionRequest) => {
          const svc = await getSessionService();
          return svc.getState(request);
        }
      ),
      getByWorktree: op(
        DEV_PREVIEW_METHOD_CHANNELS.getByWorktree,
        async (request: DevPreviewGetByWorktreeRequest) => {
          if (!request || typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
            throw new Error("worktreeId is required");
          }
          const svc = await getSessionService();
          return svc.getByWorktree(request.worktreeId);
        }
      ),
    },
  });

  const cleanups: Array<() => void> = [namespace.register()];

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
    cleanups.forEach((dispose) => dispose());
  };
}
