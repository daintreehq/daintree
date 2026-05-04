import { ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { getProjectViewManager } from "../../window/windowRef.js";
import type { ActionManifestEntry } from "../../../shared/types/actions.js";
import type { PendingRequest, DispatchEnvelope } from "./shared.js";

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

  function normalizeError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(fallback);
  }

  function requestManifest(): Promise<ActionManifestEntry[]> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = getActiveProjectWebContents();
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
      }, 5000);

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
        resolve,
        reject,
        timer,
        webContentsId,
        destroyedCleanup,
      });

      try {
        webContents.send("mcp:get-manifest-request", { requestId });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingManifests.delete(requestId);
        reject(normalizeError(err, "Failed to request action manifest"));
      }
    });
  }

  function dispatchAction(
    actionId: string,
    args: unknown,
    confirmed = false
  ): Promise<DispatchEnvelope> {
    return new Promise((resolve, reject) => {
      let webContents: Electron.WebContents;
      try {
        webContents = getActiveProjectWebContents();
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
      }, 30000);

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
        webContents.send("mcp:dispatch-action-request", {
          requestId,
          actionId,
          args,
          confirmed,
        });
      } catch (err) {
        clearTimeout(timer);
        destroyedCleanup();
        pendingDispatches.delete(requestId);
        reject(normalizeError(err, `Failed to dispatch action: ${actionId}`));
      }
    });
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
    cachedManifest = manifest;
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
    ipcMain.on("mcp:get-manifest-response", manifestHandler);
    ipcMain.on("mcp:dispatch-action-response", dispatchHandler);

    cleanupListeners.push(
      () => ipcMain.removeListener("mcp:get-manifest-response", manifestHandler),
      () => ipcMain.removeListener("mcp:dispatch-action-response", dispatchHandler)
    );
  }

  return {
    setupListeners,
    requestManifest,
    dispatchAction,
    getCachedManifest: () => cachedManifest,
    clearCache: () => {
      cachedManifest = null;
    },
    getActiveProjectWebContents,
    normalizeError,
  };
}
