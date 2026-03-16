import { app, ipcMain, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";

// Wrap ipcMain.handle globally to enforce sender validation on ALL IPC handlers
// This must run before any handlers are registered
export function enforceIpcSenderValidation(): void {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce?.bind(ipcMain);

  ipcMain.handle = function (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
  ) {
    return originalHandle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        throw new Error(
          `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
        );
      }
      try {
        return await listener(event, ...args);
      } catch (error) {
        if (app.isPackaged) {
          console.error(`[IPC] Error on channel ${channel}:`, error);
          const msg = (error instanceof Error ? error.message : String(error))
            .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
            .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
            .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
          const safe = new Error(msg);
          safe.stack = undefined;
          throw safe;
        }
        throw error;
      }
    });
  } as typeof ipcMain.handle;

  if (originalHandleOnce) {
    ipcMain.handleOnce = function (
      channel: string,
      listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
    ) {
      return originalHandleOnce(channel, async (event, ...args) => {
        const senderUrl = event.senderFrame?.url;
        if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
          throw new Error(
            `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
          );
        }
        try {
          return await listener(event, ...args);
        } catch (error) {
          if (app.isPackaged) {
            console.error(`[IPC] Error on channel ${channel}:`, error);
            const msg = (error instanceof Error ? error.message : String(error))
              .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
              .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
              .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
            const safe = new Error(msg);
            safe.stack = undefined;
            throw safe;
          }
          throw error;
        }
      });
    } as typeof ipcMain.handleOnce;
  }

  // Extend validation to ipcMain.on (fire-and-forget channels like terminal:input).
  // Unlike handle channels which can throw, on channels silently drop untrusted messages.
  // We maintain a listener map so removeListener/off can find wrapped versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC listeners have heterogeneous signatures
  type IpcOnListener = (...args: any[]) => void;
  const onListenerMap = new Map<string, Map<IpcOnListener, IpcOnListener>>();

  const originalOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = function (channel: string, listener: IpcOnListener) {
    const wrapped = (event: Electron.IpcMainEvent, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        console.warn(
          `[IPC] Rejected ipcMain.on message from untrusted origin: channel=${channel}, url=${senderUrl || "unknown"}`
        );
        return;
      }
      return listener(event, ...args);
    };

    if (!onListenerMap.has(channel)) onListenerMap.set(channel, new Map());
    onListenerMap.get(channel)!.set(listener, wrapped);

    return originalOn(channel, wrapped);
  } as typeof ipcMain.on;

  const originalRemoveListener = ipcMain.removeListener.bind(ipcMain);
  ipcMain.removeListener = function (channel: string, listener: IpcOnListener) {
    const channelMap = onListenerMap.get(channel);
    const wrapped = channelMap?.get(listener);
    if (wrapped) {
      channelMap!.delete(listener);
      if (channelMap!.size === 0) onListenerMap.delete(channel);
      return originalRemoveListener(channel, wrapped as IpcOnListener);
    }
    return originalRemoveListener(channel, listener);
  } as typeof ipcMain.removeListener;

  ipcMain.off = ipcMain.removeListener;

  const originalRemoveAllListeners = ipcMain.removeAllListeners.bind(ipcMain);
  ipcMain.removeAllListeners = function (channel?: string) {
    if (channel !== undefined) {
      onListenerMap.delete(channel);
    } else {
      onListenerMap.clear();
    }
    return originalRemoveAllListeners(channel);
  } as typeof ipcMain.removeAllListeners;

  console.log("[MAIN] IPC sender validation enforced globally (handle + on)");
}

export function setupPermissionLockdown(): void {
  // Lock down permissions on untrusted sessions to prevent OS permission prompts
  function lockdownUntrustedPermissions(ses: Electron.Session): void {
    ses.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
  }

  function lockdownTrustedPermissions(ses: Electron.Session): void {
    const trustedPermissions = new Set(["clipboard-sanitized-write", "clipboard-read", "media"]);
    ses.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(trustedPermissions.has(permission));
    });
    ses.setPermissionCheckHandler((_wc, permission) => {
      return trustedPermissions.has(permission);
    });
  }

  // Lock down default session (trusted app renderer) with clipboard allowlist
  lockdownTrustedPermissions(session.defaultSession);

  // Lock down known untrusted sessions
  lockdownUntrustedPermissions(session.fromPartition("persist:browser"));

  // Sidecar needs clipboard access for AI chat copy buttons (navigator.clipboard.writeText)
  // but all other permissions (camera, mic, geolocation, etc.) remain denied
  const sidecarSession = session.fromPartition("persist:sidecar");
  sidecarSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });
  sidecarSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === "clipboard-sanitized-write";
  });

  // Catch all dynamically created sessions (e.g., persist:dev-preview-*)
  app.on("session-created", (ses) => {
    const partition = (ses as any).partition ?? "";
    // Dev-preview and any other dynamic partitions are untrusted
    if (partition.startsWith("persist:dev-preview") || partition.startsWith("persist:browser")) {
      lockdownUntrustedPermissions(ses);
    }
  });
}
