import { app, ipcMain, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { isTrustedRendererUrl } from "../../shared/utils/trustedRenderer.js";
import { classifyPartition } from "../utils/webviewCsp.js";
import {
  wrapSuccess,
  wrapError,
  serializeError,
} from "../../shared/utils/ipcErrorSerialization.js";
import { FAULT_MODE_ENABLED, applyInvokeFault, initFaultRegistry } from "../ipc/faultRegistry.js";

function sanitizePaths(msg: string): string {
  return msg
    .replace(/\/(?:Users|home|tmp|private|var)\/[^\s:]+/gi, "<path>")
    .replace(/[A-Z]:[/\\](?:Users|Program Files|Windows|ProgramData)[^\s:]*/gi, "<path>")
    .replace(/\\\\(?:[^\s\\]+)\\(?:[^\s:]+)/g, "<path>");
}

// Wrap ipcMain.handle globally to enforce sender validation on ALL IPC handlers
// This must run before any handlers are registered
export function enforceIpcSenderValidation(): void {
  if (FAULT_MODE_ENABLED) initFaultRegistry();

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalHandleOnce = ipcMain.handleOnce?.bind(ipcMain);

  ipcMain.handle = function (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown> | unknown
  ) {
    return originalHandle(channel, async (event, ...args) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        return wrapError(
          new Error(
            `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
          )
        );
      }
      try {
        if (FAULT_MODE_ENABLED) await applyInvokeFault(channel);
        const result = await listener(event, ...args);
        return wrapSuccess(result);
      } catch (error) {
        if (app.isPackaged) {
          console.error(`[IPC] Error on channel ${channel}:`, error);
          const serialized = serializeError(error);
          serialized.message = sanitizePaths(serialized.message);
          serialized.stack = undefined;
          serialized.path = undefined;
          serialized.context = undefined;
          serialized.cause = undefined;
          serialized.properties = undefined;
          return { __canopyIpcEnvelope: true as const, ok: false as const, error: serialized };
        }
        return wrapError(error);
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
          return wrapError(
            new Error(
              `IPC call from untrusted origin rejected: channel=${channel}, url=${senderUrl || "unknown"}`
            )
          );
        }
        try {
          if (FAULT_MODE_ENABLED) await applyInvokeFault(channel);
          const result = await listener(event, ...args);
          return wrapSuccess(result);
        } catch (error) {
          if (app.isPackaged) {
            console.error(`[IPC] Error on channel ${channel}:`, error);
            const serialized = serializeError(error);
            serialized.message = sanitizePaths(serialized.message);
            serialized.stack = undefined;
            serialized.path = undefined;
            serialized.context = undefined;
            serialized.cause = undefined;
            serialized.properties = undefined;
            return { __canopyIpcEnvelope: true as const, ok: false as const, error: serialized };
          }
          return wrapError(error);
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

/**
 * Log a permission denial for debugging.
 * Uses [SECURITY] prefix to distinguish from general [MAIN] logs.
 */
function logPermissionDenial(
  sessionLabel: string,
  handler: "request" | "check",
  permission: string,
  requestingUrl?: string
): void {
  const url = requestingUrl || "unknown";
  console.warn(
    `[SECURITY] Permission denied: ${permission} (session=${sessionLabel}, handler=${handler}, url=${url})`
  );
}

// Electron 40 permission types (from electron.d.ts) — kept as reference for auditing.
// setPermissionRequestHandler: clipboard-read, clipboard-sanitized-write, display-capture,
//   fullscreen, geolocation, idle-detection, media, mediaKeySystem, midi, midiSysex,
//   notifications, pointerLock, keyboardLock, openExternal, speaker-selection,
//   storage-access, top-level-storage-access, window-management, unknown, fileSystem
// setPermissionCheckHandler: clipboard-read, clipboard-sanitized-write, geolocation,
//   fullscreen, hid, idle-detection, media, mediaKeySystem, midi, midiSysex,
//   notifications, openExternal, pointerLock, serial, storage-access,
//   top-level-storage-access, usb, deprecated-sync-clipboard-read, fileSystem

const TRUSTED_SESSION_PERMISSIONS = new Set([
  "clipboard-sanitized-write",
  "clipboard-read",
  "media",
]);

const SIDECAR_SESSION_PERMISSIONS = new Set(["clipboard-sanitized-write"]);

let permissionLockdownInitialized = false;

export function setupPermissionLockdown(): void {
  function lockdownUntrustedPermissions(ses: Electron.Session, label: string): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      logPermissionDenial(label, "request", permission, details?.requestingUrl);
      callback(false);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      logPermissionDenial(label, "check", permission, requestingOrigin);
      return false;
    });
  }

  function lockdownTrustedPermissions(
    ses: Electron.Session,
    label: string,
    allowed: Set<string>
  ): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const granted = allowed.has(permission);
      if (!granted) {
        logPermissionDenial(label, "request", permission, details?.requestingUrl);
      }
      callback(granted);
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const granted = allowed.has(permission);
      if (!granted) {
        logPermissionDenial(label, "check", permission, requestingOrigin);
      }
      return granted;
    });
  }

  // Lock down default session (trusted app renderer) with clipboard + media allowlist
  lockdownTrustedPermissions(session.defaultSession, "default", TRUSTED_SESSION_PERMISSIONS);

  // Lock down browser session — fully untrusted
  lockdownUntrustedPermissions(session.fromPartition("persist:browser"), "browser");

  // Sidecar needs clipboard access for AI chat copy buttons (navigator.clipboard.writeText)
  // but all other permissions (camera, mic, geolocation, etc.) remain denied
  lockdownTrustedPermissions(
    session.fromPartition("persist:sidecar"),
    "sidecar",
    SIDECAR_SESSION_PERMISSIONS
  );

  // Catch all dynamically created sessions (e.g., persist:dev-preview-*)
  // Guard against duplicate listeners when createWindow is called multiple times (macOS dock)
  if (!permissionLockdownInitialized) {
    permissionLockdownInitialized = true;
    app.on("session-created", (ses) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron typing gap: Session.partition is not exposed
      const partition: string = (ses as any).partition ?? "";
      const type = classifyPartition(partition);
      if (type === "dev-preview" || type === "browser") {
        lockdownUntrustedPermissions(ses, partition);
      }
    });
  }
}

/** @internal Reset idempotency guard for testing only. */
export function _resetPermissionLockdownForTesting(): void {
  permissionLockdownInitialized = false;
}
