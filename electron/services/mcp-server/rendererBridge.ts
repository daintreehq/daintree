import { ipcMain, webContents as electronWebContents } from "electron";
import { randomUUID } from "node:crypto";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { getProjectViewManager } from "../../window/windowRef.js";
import type { ActionContext, ActionManifestEntry } from "../../../shared/types/actions.js";
import { CHANNELS } from "../../ipc/channels.js";
import type { PendingRequest, DispatchEnvelope } from "./shared.js";
import { MCP_MANIFEST_REQUEST_TIMEOUT_MS, MCP_DISPATCH_TIMEOUT_MS } from "./shared.js";

export class SessionBindingError extends Error {
  readonly code = "SESSION_BINDING_GONE";
  readonly webContentsId: number;

  constructor(webContentsId: number) {
    super(
      `MCP pinned view ${webContentsId} no longer available — the renderer session this MCP session was bound to has been destroyed. Do not retry.`
    );
    this.name = "SessionBindingError";
    this.webContentsId = webContentsId;
  }
}

export function createRendererBridge(
  pendingManifests: Map<string, PendingRequest<ActionManifestEntry[]>>,
  pendingDispatches: Map<string, PendingRequest<DispatchEnvelope>>,
  getRegistry: () => WindowRegistry | null
) {
  let cachedManifest: ActionManifestEntry[] | null = null;

  function getActiveProjectWebContents(): Electron.WebContents {
    const registry = getRegistry();
    if (registry) {
      for (const ctx of registry.all()) {
        if (ctx.browserWindow.isDestroyed()) continue;
        const view = ctx.services.projectViewManager?.getActiveView();
        const webContents = view?.webContents;
        if (webContents && !webContents.isDestroyed()) {
          return webContents;
        }
      }
    }

    const fallback = getProjectViewManager()?.getActiveView()?.webContents;
    if (fallback && !fallback.isDestroyed()) {
      return fallback;
    }

    throw new Error("MCP renderer bridge unavailable");
  }

  /**
   * Resolves a renderer WebContents by id, throwing if the view is missing or
   * destroyed. Used by per-session pinned dispatch (#7002) so an MCP tool
   * call from window A's assistant fails closed rather than silently routing
   * to window B when window A's view has been torn down.
   */
  function getPinnedWebContents(id: number): Electron.WebContents {
    const wc = electronWebContents.fromId(id);
    if (!wc || wc.isDestroyed()) {
      throw new SessionBindingError(id);
    }
    return wc;
  }

  function normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  function sendManifestRequest(
    resolveWebContents: () => Electron.WebContents,
    onResolved: (manifest: ActionManifestEntry[]) => void
  ): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = resolveWebContents();
      } catch (err) {
        reject(normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = pendingManifests.get(requestId);
        pending?.destroyedCleanup?.();
        pendingManifests.delete(requestId);
        reject(new Error("Manifest request timed out"));
      }, MCP_MANIFEST_REQUEST_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingManifests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingManifests.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      pendingManifests.set(requestId, {
        resolve: (manifest) => {
          onResolved(manifest);
          resolve(manifest);
        },
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.MCP_SERVER_GET_MANIFEST_REQUEST, { requestId });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingManifests.delete(requestId);
        reject(normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  function sendDispatchRequest(
    resolveWebContents: () => Electron.WebContents,
    actionId: string,
    args: unknown,
    confirmed: boolean,
    contextOverride?: ActionContext
  ): Promise<DispatchEnvelope> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = resolveWebContents();
      } catch (err) {
        reject(normalizeError(err, "MCP renderer bridge unavailable"));
        return;
      }

      const requestId = randomUUID();
      const webContentsId = webContents.id;
      const timer = setTimeout(() => {
        const pending = pendingDispatches.get(requestId);
        pending?.destroyedCleanup?.();
        pendingDispatches.delete(requestId);
        reject(new Error(`Action dispatch timed out: ${actionId}`));
      }, MCP_DISPATCH_TIMEOUT_MS);

      const onDestroyed = () => {
        const pending = pendingDispatches.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDispatches.delete(requestId);
        pending.reject(new Error("MCP renderer bridge destroyed"));
      };
      webContents.once("destroyed", onDestroyed);
      const destroyedCleanup = () => {
        try {
          webContents.removeListener("destroyed", onDestroyed);
        } catch {
          // best-effort cleanup; webContents may already be gone
        }
      };

      pendingDispatches.set(requestId, {
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send(CHANNELS.MCP_SERVER_DISPATCH_ACTION_REQUEST, {
          requestId,
          actionId,
          args,
          confirmed,
          // Only pinned help-session dispatch passes a contextOverride; the
          // unpinned external/api-key path leaves this undefined so the
          // renderer keeps its live focused-window context (#8317).
          context: contextOverride,
        });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingDispatches.delete(requestId);
        reject(normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
  }

  function requestManifest(): Promise<ActionManifestEntry[]> {
    return sendManifestRequest(
      () => getActiveProjectWebContents(),
      (manifest) => {
        cachedManifest = manifest;
      }
    );
  }

  function dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(() => getActiveProjectWebContents(), actionId, args, confirmed);
  }

  /**
   * Manifest fetch pinned to a specific renderer WebContents (per-session
   * routing for #7002). Bypasses `cachedManifest` because that cache is
   * shared across all callers — caching window A's manifest and serving it
   * to a session pinned to window B would re-introduce the cross-window
   * leak this routing is meant to prevent.
   */
  function requestManifestForWebContents(id: number): Promise<ActionManifestEntry[]> {
    return sendManifestRequest(
      () => getPinnedWebContents(id),
      () => {
        // Intentionally do not write the shared cachedManifest.
      }
    );
  }

  /**
   * Action dispatch pinned to a specific renderer WebContents (#7002).
   * Throws fail-closed when the pinned view is destroyed so the assistant
   * sees an explicit error rather than silently re-routing to the focused
   * window.
   */
  function dispatchActionForWebContents(
    id: number,
    actionId: string,
    args: unknown,
    confirmed = false,
    contextOverride?: ActionContext
  ): Promise<DispatchEnvelope> {
    return sendDispatchRequest(
      () => getPinnedWebContents(id),
      actionId,
      args,
      confirmed,
      contextOverride
    );
  }

  const manifestHandler = (
    event: Electron.IpcMainEvent,
    payload: { requestId: string; manifest: unknown }
  ) => {
    if (!payload || typeof payload.requestId !== "string") return;
    const pending = pendingManifests.get(payload.requestId);
    if (!pending) return;
    if (event.sender.id !== pending.webContentsId) {
      console.warn(
        `[MCP] Ignoring manifest response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
      );
      return;
    }
    clearTimeout(pending.timer);
    pending.destroyedCleanup?.();
    pendingManifests.delete(payload.requestId);
    const manifest = Array.isArray(payload.manifest)
      ? (payload.manifest as ActionManifestEntry[])
      : [];
    // The cache write happens inside the resolve wrapper attached at request
    // time — non-pinned helpers populate `cachedManifest`, pinned helpers
    // (#7002) deliberately do not, so window A's manifest can never be
    // served to a session pinned to window B.
    pending.resolve(manifest);
  };

  const dispatchHandler = (
    event: Electron.IpcMainEvent,
    payload: {
      requestId: string;
      result: import("../../../shared/types/actions.js").ActionDispatchResult;
      confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
    }
  ) => {
    if (!payload || typeof payload.requestId !== "string") return;
    const pending = pendingDispatches.get(payload.requestId);
    if (!pending) return;
    if (event.sender.id !== pending.webContentsId) {
      console.warn(
        `[MCP] Ignoring dispatch response from unexpected sender ${event.sender.id} (expected ${pending.webContentsId}, requestId=${payload.requestId})`
      );
      return;
    }
    clearTimeout(pending.timer);
    pending.destroyedCleanup?.();
    pendingDispatches.delete(payload.requestId);
    pending.resolve({
      result: payload.result,
      confirmationDecision: payload.confirmationDecision,
    });
  };

  function setupListeners(cleanupListeners: Array<() => void>): void {
    ipcMain.on(CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE, manifestHandler);
    ipcMain.on(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, dispatchHandler);

    cleanupListeners.push(
      () => ipcMain.removeListener(CHANNELS.MCP_SERVER_GET_MANIFEST_RESPONSE, manifestHandler),
      () => ipcMain.removeListener(CHANNELS.MCP_SERVER_DISPATCH_ACTION_RESPONSE, dispatchHandler)
    );
  }

  return {
    setupListeners,
    requestManifest,
    dispatchAction,
    requestManifestForWebContents,
    dispatchActionForWebContents,
    getCachedManifest: () => cachedManifest,
    clearCache: () => {
      cachedManifest = null;
    },
  };
}
