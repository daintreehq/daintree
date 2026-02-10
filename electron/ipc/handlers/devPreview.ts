import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import { UrlDetector } from "../../services/UrlDetector.js";
import type {
  DevPreviewUrlDetectedPayload,
  DevPreviewErrorDetectedPayload,
} from "../../../shared/types/ipc/devPreview.js";

export function registerDevPreviewHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];
  const detector = new UrlDetector();
  const subscriptions = new Map<
    string,
    {
      buffer: string;
      lastUrl: string | null;
      lastError: string | null;
      listener: (id: string, data: string | Uint8Array) => void;
    }
  >();

  const sendToRenderer = (channel: string, data: unknown) => {
    if (
      deps.mainWindow &&
      !deps.mainWindow.isDestroyed() &&
      !deps.mainWindow.webContents.isDestroyed()
    ) {
      try {
        deps.mainWindow.webContents.send(channel, data);
      } catch {
        // Silently ignore send failures during window disposal.
      }
    }
  };

  const handleUrlDetected = (url: string, terminalId: string, worktreeId?: string) => {
    const payload: DevPreviewUrlDetectedPayload = {
      terminalId,
      url,
      worktreeId,
    };
    sendToRenderer(CHANNELS.DEV_PREVIEW_URL_DETECTED, payload);
  };

  const handleErrorDetected = (
    error: import("../../../shared/utils/devServerErrors.js").DevServerError,
    terminalId: string,
    worktreeId?: string
  ) => {
    const payload: DevPreviewErrorDetectedPayload = {
      terminalId,
      error,
      worktreeId,
    };
    sendToRenderer(CHANNELS.DEV_PREVIEW_ERROR_DETECTED, payload);
  };

  const handleSubscribe = async (_event: Electron.IpcMainInvokeEvent, terminalId: string) => {
    if (!terminalId || typeof terminalId !== "string") {
      throw new Error("terminalId is required");
    }

    if (subscriptions.has(terminalId)) {
      // Resubscribe is treated as a fresh session to avoid stale URL/error dedupe
      // when renderer restarts a dev server quickly with the same terminal ID.
      const existing = subscriptions.get(terminalId);
      if (existing) {
        existing.buffer = "";
        existing.lastUrl = null;
        existing.lastError = null;
      }
      deps.ptyClient.setIpcDataMirror(terminalId, true);
      return;
    }

    const listener = (id: string, data: string | Uint8Array) => {
      if (id !== terminalId) return;

      const sub = subscriptions.get(terminalId);
      if (!sub) return;

      const dataString = typeof data === "string" ? data : new TextDecoder().decode(data);
      const result = detector.scanOutput(dataString, sub.buffer);
      sub.buffer = result.buffer;

      if (result.url && result.url !== sub.lastUrl) {
        sub.lastUrl = result.url;
        handleUrlDetected(result.url, terminalId, undefined);
      }

      if (result.error) {
        const errorKey = `${result.error.type}:${result.error.message}`;
        if (errorKey !== sub.lastError) {
          sub.lastError = errorKey;
          handleErrorDetected(result.error, terminalId, undefined);
        }
      }
    };

    deps.ptyClient.on("data", listener);
    deps.ptyClient.setIpcDataMirror(terminalId, true);

    subscriptions.set(terminalId, {
      buffer: "",
      lastUrl: null,
      lastError: null,
      listener,
    });
  };

  ipcMain.handle(CHANNELS.DEV_PREVIEW_SUBSCRIBE, handleSubscribe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_SUBSCRIBE));

  const handleUnsubscribe = async (_event: Electron.IpcMainInvokeEvent, terminalId: string) => {
    if (!terminalId || typeof terminalId !== "string") {
      throw new Error("terminalId is required");
    }

    const sub = subscriptions.get(terminalId);
    if (!sub) {
      // Idempotent cleanup in case local map was already cleared.
      deps.ptyClient.setIpcDataMirror(terminalId, false);
      return;
    }

    deps.ptyClient.off("data", sub.listener);
    deps.ptyClient.setIpcDataMirror(terminalId, false);
    subscriptions.delete(terminalId);
  };

  ipcMain.handle(CHANNELS.DEV_PREVIEW_UNSUBSCRIBE, handleUnsubscribe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_UNSUBSCRIBE));

  return () => {
    for (const [terminalId, sub] of subscriptions.entries()) {
      deps.ptyClient.off("data", sub.listener);
      deps.ptyClient.setIpcDataMirror(terminalId, false);
    }
    subscriptions.clear();
    handlers.forEach((dispose) => dispose());
  };
}
