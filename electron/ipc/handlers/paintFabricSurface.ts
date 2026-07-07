/**
 * paintSurface IPC namespace — the primary renderer's control channel for
 * paint-fabric surface views (docs/architecture/terminal-paint-fabric.md,
 * Phase 1V substrate). Gated on DAINTREE_PAINT_FABRIC + _VIEWS in the main
 * process env; everything no-ops into an error when the fabric is off.
 *
 * Per-window state (SurfaceViewManager, SurfacePortBroker) lives on the
 * sender's WindowContext.services and is created lazily on first use, so
 * flag-off sessions never pay for it.
 */

import { z } from "zod";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, opValidated } from "../define.js";
import { PAINT_SURFACE_METHOD_CHANNELS } from "./paintFabricSurface.preload.js";
import { SurfaceViewManager } from "../../window/SurfaceViewManager.js";
import { SurfacePortBroker } from "../../window/SurfacePortBroker.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { WindowContext } from "../../window/WindowRegistry.js";
import type { CreateSurfaceViewResult } from "../../../shared/types/paintFabricSurface.js";

const surfaceIdSchema = z.string().min(1).max(128);

const createSchema = z.object({ surfaceId: surfaceIdSchema });

const destroySchema = z.object({ surfaceId: surfaceIdSchema });

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(0),
  height: z.number().finite().min(0),
});

const setBoundsSchema = z.object({
  surfaceId: surfaceIdSchema,
  bounds: boundsSchema,
});

const thresholdsSchema = z.object({
  surfaceId: surfaceIdSchema,
  upperThreshold: z.number().int().min(0).max(16),
  lowerThreshold: z.number().int().min(0).max(16),
});

function isViewHostingEnabled(): boolean {
  return (
    process.env.DAINTREE_PAINT_FABRIC === "1" && process.env.DAINTREE_PAINT_FABRIC_VIEWS === "1"
  );
}

export function registerPaintFabricSurfaceHandlers(deps: HandlerDependencies): () => void {
  function resolveWindowContext(ctx: IpcContext): WindowContext {
    if (!isViewHostingEnabled()) {
      throw new Error("Paint fabric view hosting is disabled");
    }
    const win = ctx.senderWindow;
    if (!win) {
      throw new Error("paintSurface: request has no owning window");
    }
    const wctx = deps.windowRegistry?.getByWindowId(win.id);
    if (!wctx) {
      throw new Error("paintSurface: window is not registered");
    }
    return wctx;
  }

  function ensureManager(wctx: WindowContext): SurfaceViewManager {
    if (!wctx.services.surfaceViewManager) {
      const dirname = wctx.services.preloadDirname;
      if (!dirname) {
        throw new Error("paintSurface: preload dirname unavailable for this window");
      }
      wctx.services.surfaceViewManager = new SurfaceViewManager({
        win: wctx.browserWindow,
        dirname,
        onCrash: (report) => {
          // Substrate scope: crash reports log; the renderer-facing
          // notification (crash-loop → compositor retireSurface) lands with
          // the live wiring front. A crash-looped view stays parked (no
          // reload) until destroyed.
          console.warn(
            `[paintSurface] surface ${report.surfaceId} ${report.disposition} (${report.reason})`
          );
        },
        onSurfaceReady: (surfaceId) => {
          // A reload replaced the renderer context that held the surface's
          // pty-host port (the navigation released it) — re-broker with the
          // context of the last successful broker.
          const wc = wctx.services.surfaceViewManager?.getWebContents(surfaceId);
          if (!wc) return;
          try {
            wctx.services.surfacePortBroker?.rebrokerFromLast(surfaceId, wc);
          } catch (error) {
            console.warn(`[paintSurface] re-broker after reload failed for ${surfaceId}:`, error);
          }
        },
      });
    }
    return wctx.services.surfaceViewManager;
  }

  function ensureBroker(wctx: WindowContext): SurfacePortBroker {
    if (!wctx.services.surfacePortBroker) {
      wctx.services.surfacePortBroker = new SurfacePortBroker(() => deps.ptyClient ?? null);
    }
    return wctx.services.surfacePortBroker;
  }

  const namespace = defineIpcNamespace({
    name: "paintSurface",
    ops: {
      createSurface: opValidated(
        PAINT_SURFACE_METHOD_CHANNELS.createSurface,
        createSchema,
        async (ctx, payload): Promise<CreateSurfaceViewResult> => {
          const wctx = resolveWindowContext(ctx);
          const manager = ensureManager(wctx);
          const result = await manager.createSurface(payload.surfaceId);

          // Direct pty-host port for the new surface: bytes flow pty-host ↔
          // surface view under a synthetic connection id, never through the
          // compositor or the primary view. Resolve projectPath from the
          // sender's CURRENT project — WindowContext.projectPath is only
          // seeded at window registration and goes stale across project
          // switches.
          const wc = manager.getWebContents(payload.surfaceId);
          if (wc && deps.ptyClient) {
            // Lazy import: the projectStore singleton does sync fs work at
            // module load and must stay off this module's eager import graph.
            const { projectStore } = await import("../../services/ProjectStore.js");
            const projectPath = ctx.projectId
              ? (projectStore.getProjectById(ctx.projectId)?.path ??
                wctx.projectPath ??
                undefined)
              : (wctx.projectPath ?? undefined);
            try {
              ensureBroker(wctx).brokerSurfacePort({
                surfaceId: payload.surfaceId,
                wc,
                projectId: ctx.projectId,
                projectPath,
              });
            } catch (error) {
              // Creation is atomic: a surface without a deliverable port is
              // useless, so tear the view down rather than hand back a
              // half-alive surface.
              await manager.destroySurface(payload.surfaceId);
              throw error;
            }
          }
          return result;
        },
        { withContext: true }
      ),
      destroySurface: opValidated(
        PAINT_SURFACE_METHOD_CHANNELS.destroySurface,
        destroySchema,
        async (ctx, payload): Promise<void> => {
          const wctx = resolveWindowContext(ctx);
          wctx.services.surfacePortBroker?.releaseSurfacePort(payload.surfaceId, {
            forgetContext: true,
          });
          await wctx.services.surfaceViewManager?.destroySurface(payload.surfaceId);
        },
        { withContext: true }
      ),
      setSurfaceBounds: opValidated(
        PAINT_SURFACE_METHOD_CHANNELS.setSurfaceBounds,
        setBoundsSchema,
        async (ctx, payload): Promise<void> => {
          const wctx = resolveWindowContext(ctx);
          const manager = wctx.services.surfaceViewManager;
          if (!manager) {
            throw new Error(`Unknown surface view: ${payload.surfaceId}`);
          }
          manager.setSurfaceBounds(payload.surfaceId, payload.bounds);
        },
        { withContext: true }
      ),
      applyWebglThresholds: opValidated(
        PAINT_SURFACE_METHOD_CHANNELS.applyWebglThresholds,
        thresholdsSchema,
        async (ctx, payload): Promise<void> => {
          const wctx = resolveWindowContext(ctx);
          const wc = wctx.services.surfaceViewManager?.getWebContents(payload.surfaceId);
          if (!wc) {
            throw new Error(`Unknown surface view: ${payload.surfaceId}`);
          }
          // The webglBudget waterfill's apply step: push the granted
          // thresholds into the surface view's renderer, where the
          // surface-side TerminalWebGLManager applies them. send can race
          // view destruction between the isDestroyed check and the call.
          try {
            wc.send(CHANNELS.PAINT_SURFACE_WEBGL_THRESHOLDS, payload);
          } catch {
            throw new Error(`Surface view unavailable: ${payload.surfaceId}`);
          }
        },
        { withContext: true }
      ),
    },
  });

  return namespace.register();
}
