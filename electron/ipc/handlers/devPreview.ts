import { app } from "electron";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { defineIpcNamespace, op } from "../define.js";
import { DEV_PREVIEW_METHOD_CHANNELS } from "./devPreview.preload.js";
import type { HandlerDependencies } from "../types.js";
import { getCrashRecoveryService } from "../../services/CrashRecoveryService.js";
import {
  readAndClearDevPreviewManifest,
  writeDevPreviewManifest,
  type DevPreviewManifestEntry,
} from "../../services/DevPreviewManifestService.js";
import type {
  DevPreviewEnsureRequest,
  DevPreviewSessionRequest,
  DevPreviewStopByPanelRequest,
  DevPreviewStateChangedPayload,
  DevPreviewGetByWorktreeRequest,
  DevPreviewDestructivePreviewSizesRequest,
  DevPreviewStopByWorktreeRequest,
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
          // Read (and clear) the restore manifest the previous session left
          // behind. The in-memory copy owns restore state for this launch, so
          // a corrupt or stale file degrades to "no restore" rather than
          // re-prompting forever.
          let restoredEntries: DevPreviewManifestEntry[] = [];
          try {
            restoredEntries = readAndClearDevPreviewManifest(app.getPath("userData"));
          } catch (err) {
            console.warn("[DevPreview] Failed to read restore manifest:", err);
          }
          sessionService = new mod.DevPreviewSessionService(
            deps.ptyClient!,
            (state) => {
              const payload: DevPreviewStateChangedPayload = { state };
              broadcastToRenderer(CHANNELS.DEV_PREVIEW_STATE_CHANGED, payload);
            },
            restoredEntries
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
    },
  });

  const cleanups: Array<() => void> = [namespace.register()];

  // Persist the running-session manifest on every backup tick. The eager
  // quit-intent takeBackup() in shutdown.ts fires this BEFORE the PTYs are
  // killed, so a clean exit captures sessions while they're still running; the
  // periodic ticks cover the crash (SIGKILL/OOM) path. After dispose() the
  // sessions map is empty and captureManifest() would write [] (deleting the
  // good capture from quit-intent), so the isDisposed guard makes the
  // post-dispose cleanupOnExit tick a no-op.
  const unsubPreBackup = getCrashRecoveryService().registerPreBackupCallback(() => {
    if (!sessionService || sessionService.isDisposed) return;
    writeDevPreviewManifest(app.getPath("userData"), sessionService.captureManifest());
  });

  const unsubHibernation = getHibernationService().onProjectHibernated((projectId) => {
    // Skip if the session service was never created — no sessions exist to stop.
    if (!sessionService) return;
    sessionService.stopByProject(projectId).catch((err) => {
      console.error("[DevPreview] Failed to stop sessions during hibernation:", err);
    });
  });

  return () => {
    unsubPreBackup();
    unsubHibernation();
    if (sessionService) {
      sessionService.dispose();
    }
    cleanups.forEach((dispose) => dispose());
  };
}
