import { app } from "electron";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { DEV_PREVIEW_METHOD_CHANNELS } from "./devPreview.preload.js";
import type { HandlerDependencies } from "../types.js";
// Type-only import: the manifest service does sync fs work, so its runtime
// module is loaded lazily alongside DevPreviewSessionService (below) to keep it
// off the eager main-process boot path.
import type { DevPreviewManifestEntry } from "../../services/DevPreviewManifestService.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewStateChangedPayload,
  DevPreviewGetByWorktreeRequest,
  DevPreviewDestructivePreviewSizesRequest,
  DevPreviewStopByWorktreeRequest,
  DevPreviewRestartByWorktreeRequest,
  DevPreviewStopDevServerByWorktreeRequest,
} from "../../../shared/types/ipc/devPreview.js";
import type { DevPreviewSessionService as DevPreviewSessionServiceType } from "../../services/DevPreviewSessionService.js";
import { getHibernationService } from "../../services/HibernationService.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  let sessionService: DevPreviewSessionServiceType | null = null;
  let sessionServicePromise: Promise<DevPreviewSessionServiceType> | null = null;

  async function getSessionService(): Promise<DevPreviewSessionServiceType> {
    if (sessionService) return sessionService;
    if (!sessionServicePromise) {
      sessionServicePromise = Promise.all([
        import("../../services/DevPreviewSessionService.js"),
        import("../../services/DevPreviewManifestService.js"),
      ])
        .then(([sessionMod, manifestMod]) => {
          // Read (and clear) the restore manifest the previous session left
          // behind. The in-memory copy owns restore state for this launch, so
          // a corrupt or stale file degrades to "no restore" rather than
          // re-prompting forever.
          let restoredEntries: DevPreviewManifestEntry[] = [];
          try {
            restoredEntries = manifestMod.readAndClearDevPreviewManifest(app.getPath("userData"));
          } catch (err) {
            console.warn("[DevPreview] Failed to read restore manifest:", err);
          }
          sessionService = new sessionMod.DevPreviewSessionService(
            deps.ptyClient!,
            (state) => {
              const payload: DevPreviewStateChangedPayload = { state };
              broadcastToRenderer(CHANNELS.DEV_PREVIEW_STATE_CHANGED, payload);
            },
            restoredEntries,
            (entries) => manifestMod.writeDevPreviewManifest(app.getPath("userData"), entries)
          );
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
      getDestructivePreviewMeta: op(
        DEV_PREVIEW_METHOD_CHANNELS.getDestructivePreviewMeta,
        async (request: DevPreviewSessionRequest) => {
          const svc = await getSessionService();
          return svc.getDestructivePreviewMeta(request);
        }
      ),
      getDestructivePreviewSizes: op(
        DEV_PREVIEW_METHOD_CHANNELS.getDestructivePreviewSizes,
        async (request: DevPreviewDestructivePreviewSizesRequest) => {
          const svc = await getSessionService();
          return svc.getDestructivePreviewSizes(request);
        }
      ),
      stopByWorktree: op(
        DEV_PREVIEW_METHOD_CHANNELS.stopByWorktree,
        async (request: DevPreviewStopByWorktreeRequest) => {
          if (!request || typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
            throw new Error("worktreeId is required");
          }
          // Lazy-init guard: if no session service has been created, there
          // are no sessions to stop. Skip the import to avoid spinning up
          // the service just to no-op.
          if (!sessionService) return;
          await sessionService.stopByWorktree(request.worktreeId);
        }
      ),
      restartByWorktree: op(
        DEV_PREVIEW_METHOD_CHANNELS.restartByWorktree,
        async (request: DevPreviewRestartByWorktreeRequest) => {
          if (!request || typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
            throw new Error("worktreeId is required");
          }
          const svc = await getSessionService();
          return svc.restartByWorktree(request.worktreeId);
        }
      ),
      stopDevServerByWorktree: op(
        DEV_PREVIEW_METHOD_CHANNELS.stopDevServerByWorktree,
        async (request: DevPreviewStopDevServerByWorktreeRequest) => {
          if (!request || typeof request.worktreeId !== "string" || !request.worktreeId.trim()) {
            throw new Error("worktreeId is required");
          }
          const svc = await getSessionService();
          return svc.stopDevServerByWorktree(request.worktreeId);
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
