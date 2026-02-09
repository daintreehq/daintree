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
      urlListener: (url: string) => void;
      errorListener: (
        error: import("../../../shared/utils/devServerErrors.js").DevServerError
      ) => void;
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
      return;
    }

    const listener = (id: string, data: string | Uint8Array) => {
      if (id !== terminalId) return;

      const sub = subscriptions.get(terminalId);
      if (!sub) return;

      const dataString = typeof data === "string" ? data : new TextDecoder().decode(data);
      const result = detector.scanOutput(dataString, sub.buffer);
      sub.buffer = result.buffer;
    };

    const urlListener = (url: string) => {
      const sub = subscriptions.get(terminalId);
      if (!sub) return;
      if (sub.lastUrl === url) return;
      sub.lastUrl = url;
      handleUrlDetected(url, terminalId, undefined);
    };

    const errorListener = (
      error: import("../../../shared/utils/devServerErrors.js").DevServerError
    ) => {
      const sub = subscriptions.get(terminalId);
      if (!sub) return;
      const errorKey = `${error.type}:${error.message}`;
      if (sub.lastError === errorKey) return;
      sub.lastError = errorKey;
      handleErrorDetected(error, terminalId, undefined);
    };

    detector.on("url-detected", urlListener);
    detector.on("error-detected", errorListener);

    deps.ptyClient.on("data", listener);
    deps.ptyClient.setIpcDataMirror(terminalId, true);

    subscriptions.set(terminalId, {
      buffer: "",
      lastUrl: null,
      lastError: null,
      listener,
      urlListener,
      errorListener,
    });
  };

  ipcMain.handle(CHANNELS.DEV_PREVIEW_SUBSCRIBE, handleSubscribe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_SUBSCRIBE));

  const handleUnsubscribe = async (_event: Electron.IpcMainInvokeEvent, terminalId: string) => {
    if (!terminalId || typeof terminalId !== "string") {
      throw new Error("terminalId is required");
    }

    const sub = subscriptions.get(terminalId);
    if (!sub) return;

    deps.ptyClient.off("data", sub.listener);
    detector.off("url-detected", sub.urlListener);
    detector.off("error-detected", sub.errorListener);
    deps.ptyClient.setIpcDataMirror(terminalId, false);
    subscriptions.delete(terminalId);
  };

  ipcMain.handle(CHANNELS.DEV_PREVIEW_UNSUBSCRIBE, handleUnsubscribe);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.DEV_PREVIEW_UNSUBSCRIBE));

  return () => {
    for (const [terminalId, sub] of subscriptions.entries()) {
      deps.ptyClient.off("data", sub.listener);
      detector.off("url-detected", sub.urlListener);
      detector.off("error-detected", sub.errorListener);
      deps.ptyClient.setIpcDataMirror(terminalId, false);
    }
    subscriptions.clear();
    handlers.forEach((dispose) => dispose());
  };
}
