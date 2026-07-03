import { app } from "electron";
import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { broadcastToRenderer } from "../utils.js";
import { defineIpcNamespace, op, opValidated } from "../define.js";
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
  DevPreviewAllSessionsPayload,
  DevPreviewGetByWorktreeRequest,
  DevPreviewDestructivePreviewSizesRequest,
  DevPreviewStopByWorktreeRequest,
  DevPreviewRestartByWorktreeRequest,
  DevPreviewStopDevServerByWorktreeRequest,
  DevPreviewSessionState,
  DevPreviewProxyInfo,
  DevPreviewMintBrowserTokenResult,
  DevPreviewDiagnosticsResult,
} from "../../../shared/types/ipc/devPreview.js";
import type { DevPreviewSessionService as DevPreviewSessionServiceType } from "../../services/DevPreviewSessionService.js";
import type { DevPreviewProxyService as DevPreviewProxyServiceType } from "../../services/DevPreviewProxyService.js";
import { getHibernationService } from "../../services/HibernationService.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  let sessionService: DevPreviewSessionServiceType | null = null;
  let sessionServicePromise: Promise<DevPreviewSessionServiceType> | null = null;
  let proxyService: DevPreviewProxyServiceType | null = null;
  let proxyServicePromise: Promise<DevPreviewProxyServiceType> | null = null;

  // The reverse proxy (#9100) gives each dev-preview panel a stable `*.localhost` origin.
  // It starts lazily on the first getProxyPort call (renderer mount) and resolves each
  // request's subdomain to the live upstream port via the session service — which may not
  // exist yet, in which case there is no upstream and the proxy returns a 502.
  async function getProxyService(): Promise<DevPreviewProxyServiceType> {
    if (proxyService) return proxyService;
    if (!proxyServicePromise) {
      proxyServicePromise = import("../../services/DevPreviewProxyService.js")
        .then(async (mod) => {
          const svc = new mod.DevPreviewProxyService(
            // Classified resolution (#9100 follow-up): the proxy can 502 with an
            // accurate cause instead of collapsing "stopped" into "unregistered".
            (subdomain) => (sessionService ? sessionService.resolveUpstream(subdomain) : null),
            // Failure reports land on the owning session's diagnostics timeline.
            // The session service may not exist yet — drop the report then; the
            // 502 body is the receipt for that case.
            (event) => sessionService?.recordProxyDiagnostic(event)
          );
          await svc.start();
          proxyService = svc;
          return svc;
        })
        .catch((err) => {
          proxyServicePromise = null;
          throw err;
        });
    }
    return proxyServicePromise;
  }

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
            (entries) => manifestMod.writeDevPreviewManifest(app.getPath("userData"), entries),
            (sessions) => {
              const payload: DevPreviewAllSessionsPayload = { sessions };
              broadcastToRenderer(CHANNELS.DEV_PREVIEW_ALL_SESSIONS_CHANGED, payload);
            }
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
      getAllSessions: op(
        DEV_PREVIEW_METHOD_CHANNELS.getAllSessions,
        async (): Promise<DevPreviewSessionState[]> => {
          // Lazy-init guard: with no session service yet, there are no sessions.
          // Skip the import so the dashboard hydration call doesn't spin up the
          // service just to return an empty snapshot.
          if (!sessionService) return [];
          return sessionService.getAllSessions();
        }
      ),
      getDiagnostics: opValidated(
        DEV_PREVIEW_METHOD_CHANNELS.getDiagnostics,
        z.object({ panelId: z.string().min(1), projectId: z.string().min(1) }),
        async ({ panelId, projectId }): Promise<DevPreviewDiagnosticsResult> => {
          // Pure read: report on whatever exists. Never spins up the session
          // service or the proxy just to answer with an empty timeline.
          const session = sessionService
            ? sessionService.getDiagnostics({ panelId, projectId })
            : null;
          const proxy = proxyService
            ? { port: proxyService.port, usedPortFallback: proxyService.usedPortFallback }
            : null;
          return { session, proxy };
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
      getProxyPort: op(
        DEV_PREVIEW_METHOD_CHANNELS.getProxyPort,
        async (): Promise<DevPreviewProxyInfo> => {
          const proxy = await getProxyService();
          return { port: proxy.port };
        }
      ),
      mintBrowserToken: opValidated(
        DEV_PREVIEW_METHOD_CHANNELS.mintBrowserToken,
        z.object({
          panelId: z.string().min(1),
          projectId: z.string().min(1),
          redirectPath: z.string(),
        }),
        async ({ panelId, projectId, redirectPath }): Promise<DevPreviewMintBrowserTokenResult> => {
          const proxy = await getProxyService();
          const bootstrapUrl = proxy.mintBrowserToken(panelId, projectId, redirectPath);
          return { bootstrapUrl };
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
    if (proxyService) {
      proxyService.dispose();
    }
    cleanups.forEach((dispose) => dispose());
  };
}
