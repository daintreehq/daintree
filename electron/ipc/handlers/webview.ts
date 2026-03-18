import { ipcMain, webContents } from "electron";
import { CHANNELS } from "../channels.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { sendToRenderer } from "../utils.js";
import type { HandlerDependencies } from "../types.js";
import type {
  CdpRemoteArg,
  CdpStackTrace,
  CdpConsoleType,
  SerializedConsoleRow,
  CdpPropertyDescriptor,
} from "../../../shared/types/ipc/webviewConsole.js";

interface CdpSession {
  runtimeEnabled: boolean;
  paneIds: Set<string>;
  navigationGeneration: number;
  groupDepthByPane: Map<string, number>;
  objectIdsByPane: Map<string, Set<string>>;
  messageListener: ((event: Electron.Event, method: string, params: unknown) => void) | null;
  detachListener: ((event: Electron.Event, reason: string) => void) | null;
}

const sessions = new Map<number, CdpSession>();
let _nextMessageId = 0;

function getOrCreateSession(wcId: number): CdpSession {
  let session = sessions.get(wcId);
  if (!session) {
    session = {
      runtimeEnabled: false,
      paneIds: new Set(),
      navigationGeneration: 0,
      groupDepthByPane: new Map(),
      objectIdsByPane: new Map(),
      messageListener: null,
      detachListener: null,
    };
    sessions.set(wcId, session);
  }
  return session;
}

function ensureAttached(wc: Electron.WebContents): void {
  if (!wc.debugger.isAttached()) {
    wc.debugger.attach("1.3");
  }
}

// Map CDP consoleAPICalled type to our ConsoleLevel
function cdpTypeToLevel(cdpType: string): "log" | "info" | "warning" | "error" {
  switch (cdpType) {
    case "error":
    case "assert":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    default:
      return "log";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeRemoteObject(obj: any): CdpRemoteArg {
  if (!obj || typeof obj !== "object") {
    return { type: "primitive", kind: "undefined", value: null };
  }

  const cdpType = obj.type as string;

  if (cdpType === "undefined") {
    return { type: "primitive", kind: "undefined", value: null };
  }

  if (cdpType === "string" || cdpType === "boolean") {
    return { type: "primitive", kind: cdpType, value: obj.value ?? null };
  }

  if (cdpType === "number") {
    // CDP uses unserializableValue for NaN, Infinity, -Infinity, -0
    const val = obj.unserializableValue ?? obj.value ?? null;
    return { type: "primitive", kind: "number", value: val };
  }

  if (cdpType === "symbol") {
    return { type: "primitive", kind: "symbol", value: obj.description ?? "Symbol()" };
  }

  if (cdpType === "bigint") {
    return { type: "primitive", kind: "bigint", value: obj.description ?? "0n" };
  }

  if (cdpType === "function") {
    return {
      type: "function",
      objectId: obj.objectId ?? "",
      description: obj.description ?? "function()",
    };
  }

  // object type
  if (obj.subtype === "null") {
    return { type: "primitive", kind: "null", value: null };
  }

  // Build preview string from preview properties if available
  let preview: string | undefined;
  if (obj.preview && obj.preview.properties) {
    const props = obj.preview.properties as Array<{ name: string; value?: string; type?: string }>;
    const parts = props.map((p) => `${p.name}: ${p.value ?? p.type ?? "…"}`);
    const overflow = obj.preview.overflow ? ", …" : "";
    if (obj.subtype === "array") {
      preview = `[${parts.map((p) => p.split(": ")[1]).join(", ")}${overflow}]`;
    } else {
      preview = `{${parts.join(", ")}${overflow}}`;
    }
  }

  return {
    type: "object",
    objectId: obj.objectId ?? "",
    className: obj.className,
    subtype: obj.subtype,
    description: obj.description,
    preview,
  };
}

function buildSummaryText(args: CdpRemoteArg[]): string {
  return args
    .map((arg) => {
      if (arg.type === "primitive") {
        if (arg.kind === "string") return String(arg.value);
        if (arg.kind === "null") return "null";
        if (arg.kind === "undefined") return "undefined";
        return String(arg.value);
      }
      if (arg.type === "function") {
        return `ƒ ${arg.description}`;
      }
      // object
      if (arg.preview) return arg.preview;
      return arg.description ?? arg.className ?? "Object";
    })
    .join(" ");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeStackTrace(st: any): CdpStackTrace | undefined {
  if (!st || !Array.isArray(st.callFrames) || st.callFrames.length === 0) return undefined;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callFrames: st.callFrames.map((f: any) => ({
      functionName: f.functionName ?? "",
      url: f.url ?? "",
      lineNumber: f.lineNumber ?? 0,
      columnNumber: f.columnNumber ?? 0,
    })),
  };
}

function trackObjectIds(session: CdpSession, paneId: string, args: CdpRemoteArg[]): void {
  let ids = session.objectIdsByPane.get(paneId);
  if (!ids) {
    ids = new Set();
    session.objectIdsByPane.set(paneId, ids);
  }
  for (const arg of args) {
    if ((arg.type === "object" || arg.type === "function") && arg.objectId) {
      ids.add(arg.objectId);
    }
  }
}

async function releaseObjectsForPane(
  wc: Electron.WebContents,
  session: CdpSession,
  paneId: string
): Promise<void> {
  const ids = session.objectIdsByPane.get(paneId);
  if (!ids || ids.size === 0) return;

  const releasePromises: Promise<void>[] = [];
  for (const objectId of ids) {
    releasePromises.push(
      wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {
        // Ignore release failures (object may already be GC'd)
      })
    );
  }
  await Promise.allSettled(releasePromises);
  ids.clear();
}

function cleanupSession(wcId: number): void {
  const session = sessions.get(wcId);
  if (!session) return;

  const wc = webContents.fromId(wcId);
  if (wc && !wc.isDestroyed()) {
    if (session.messageListener) {
      wc.debugger.off("message", session.messageListener);
    }
    if (session.detachListener) {
      wc.debugger.off("detach", session.detachListener);
    }
  }

  sessions.delete(wcId);
}

export function registerWebviewHandlers(deps: HandlerDependencies): () => void {
  const handleSetLifecycleState = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    frozen: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof frozen !== "boolean") {
      throw new Error("Invalid arguments: webContentsId must be number, frozen must be boolean");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    try {
      ensureAttached(wc);
      await wc.debugger.sendCommand("Page.enable");
      await wc.debugger.sendCommand("Page.setWebLifecycleState", {
        state: frozen ? "frozen" : "active",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExpected =
        message.includes("Target closed") ||
        message.includes("Inspected target navigated") ||
        message.includes("Cannot attach") ||
        message.includes("debugger is already attached");
      if (!isExpected) {
        console.warn(`[webview] CDP lifecycle state failed for id=${webContentsId}:`, message);
      }
    }
  };

  const handleStartConsoleCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    paneId: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof paneId !== "string") {
      throw new Error("Invalid arguments: webContentsId must be number, paneId must be string");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    const session = getOrCreateSession(webContentsId);
    session.paneIds.add(paneId);
    session.groupDepthByPane.set(paneId, 0);

    if (!session.objectIdsByPane.has(paneId)) {
      session.objectIdsByPane.set(paneId, new Set());
    }

    try {
      ensureAttached(wc);

      if (!session.runtimeEnabled) {
        await wc.debugger.sendCommand("Runtime.enable");
        session.runtimeEnabled = true;
      }

      // Bind CDP message listener once per webContents
      if (!session.messageListener) {
        const listener = (_event: Electron.Event, method: string, params: unknown) => {
          if (method === "Runtime.consoleAPICalled") {
            handleConsoleApiCalled(webContentsId, session, params);
          } else if (method === "Runtime.executionContextsCleared") {
            session.navigationGeneration++;
            // Reset group depth and clear stale objectIds for all panes
            for (const pid of session.paneIds) {
              session.groupDepthByPane.set(pid, 0);
              session.objectIdsByPane.get(pid)?.clear();
              sendToRenderer(deps.mainWindow, CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, {
                paneId: pid,
                navigationGeneration: session.navigationGeneration,
              });
            }
          }
        };
        session.messageListener = listener;
        wc.debugger.on("message", listener);
      }

      if (!session.detachListener) {
        const detachListener = (_event: Electron.Event, _reason: string) => {
          session.runtimeEnabled = false;
          // Debugger detach automatically removes all listeners, so just null our refs
          session.messageListener = null;
          session.detachListener = null;
          session.navigationGeneration++;
          for (const pid of session.paneIds) {
            session.groupDepthByPane.set(pid, 0);
            session.objectIdsByPane.get(pid)?.clear();
            sendToRenderer(deps.mainWindow, CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, {
              paneId: pid,
              navigationGeneration: session.navigationGeneration,
            });
          }
        };
        session.detachListener = detachListener;
        wc.debugger.on("detach", detachListener);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isExpected =
        message.includes("Target closed") ||
        message.includes("Cannot attach") ||
        message.includes("debugger is already attached");
      if (!isExpected) {
        console.warn(
          `[webview] CDP console capture start failed for id=${webContentsId}:`,
          message
        );
      }
    }
  };

  function handleConsoleApiCalled(_wcId: number, session: CdpSession, params: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any;
    if (!p) return;

    const cdpType = (p.type ?? "log") as CdpConsoleType;

    for (const paneId of session.paneIds) {
      let groupDepth = session.groupDepthByPane.get(paneId) ?? 0;

      if (cdpType === "endGroup") {
        groupDepth = Math.max(0, groupDepth - 1);
        session.groupDepthByPane.set(paneId, groupDepth);
        // Don't emit a row for endGroup, just adjust depth
        continue;
      }

      const args: CdpRemoteArg[] = Array.isArray(p.args)
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          p.args.map((a: any) => normalizeRemoteObject(a))
        : [];

      const level = cdpTypeToLevel(cdpType);
      const summaryText = buildSummaryText(args);
      const stackTrace = normalizeStackTrace(p.stackTrace);

      trackObjectIds(session, paneId, args);

      const row: SerializedConsoleRow = {
        id: _nextMessageId++,
        paneId,
        level,
        cdpType,
        args,
        summaryText,
        stackTrace,
        groupDepth,
        timestamp: p.timestamp ? Math.floor(p.timestamp) : Date.now(),
        navigationGeneration: session.navigationGeneration,
      };

      sendToRenderer(deps.mainWindow, CHANNELS.WEBVIEW_CONSOLE_MESSAGE, row);

      // Adjust depth AFTER emitting the group header row
      if (cdpType === "startGroup" || cdpType === "startGroupCollapsed") {
        session.groupDepthByPane.set(paneId, groupDepth + 1);
      }
    }
  }

  const handleStopConsoleCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    paneId: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof paneId !== "string") return;

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const session = sessions.get(webContentsId);
    if (!session) return;

    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) {
      await releaseObjectsForPane(wc, session, paneId);
    }

    session.paneIds.delete(paneId);
    session.groupDepthByPane.delete(paneId);
    session.objectIdsByPane.delete(paneId);

    // If no more panes are capturing, clean up the session
    if (session.paneIds.size === 0) {
      if (wc && !wc.isDestroyed() && session.runtimeEnabled) {
        try {
          await wc.debugger.sendCommand("Runtime.disable");
        } catch {
          // Ignore
        }
      }
      cleanupSession(webContentsId);
    }
  };

  const handleClearConsoleCapture = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    paneId: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof paneId !== "string") return;

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const session = sessions.get(webContentsId);
    if (!session) return;

    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) {
      await releaseObjectsForPane(wc, session, paneId);
    }

    session.groupDepthByPane.set(paneId, 0);
  };

  const handleGetConsoleProperties = async (
    _event: Electron.IpcMainInvokeEvent,
    webContentsId: unknown,
    objectId: unknown
  ): Promise<{ properties: CdpPropertyDescriptor[] }> => {
    if (typeof webContentsId !== "number" || typeof objectId !== "string") {
      throw new Error("Invalid arguments");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) {
      return { properties: [] };
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      return { properties: [] };
    }

    try {
      const result = await wc.debugger.sendCommand("Runtime.getProperties", {
        objectId,
        ownProperties: true,
        generatePreview: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = result as any;
      const properties: CdpPropertyDescriptor[] = [];

      if (Array.isArray(raw.result)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const prop of raw.result as any[]) {
          properties.push({
            name: prop.name ?? "",
            value: prop.value ? normalizeRemoteObject(prop.value) : undefined,
            configurable: prop.configurable ?? false,
            enumerable: prop.enumerable ?? false,
            writable: prop.writable,
            isOwn: prop.isOwn,
          });
        }
      }

      return { properties };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Could not find object")) {
        return { properties: [] };
      }
      throw err;
    }
  };

  const handleRegisterPanel = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<void> => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { webContentsId?: unknown }).webContentsId !== "number" ||
      typeof (payload as { panelId?: unknown }).panelId !== "string"
    ) {
      throw new Error("Invalid arguments: webContentsId must be number, panelId must be string");
    }
    const { webContentsId, panelId } = payload as { webContentsId: number; panelId: string };
    getWebviewDialogService().registerPanel(webContentsId, panelId);
  };

  const handleDialogResponse = async (
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<void> => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { dialogId?: unknown }).dialogId !== "string" ||
      typeof (payload as { confirmed?: unknown }).confirmed !== "boolean"
    ) {
      throw new Error("Invalid arguments: dialogId must be string, confirmed must be boolean");
    }
    const { dialogId, confirmed, response } = payload as {
      dialogId: string;
      confirmed: boolean;
      response?: string;
    };
    getWebviewDialogService().resolveDialog(dialogId, confirmed, response);
  };

  ipcMain.handle(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, handleSetLifecycleState);
  ipcMain.handle(CHANNELS.WEBVIEW_REGISTER_PANEL, handleRegisterPanel);
  ipcMain.handle(CHANNELS.WEBVIEW_DIALOG_RESPONSE, handleDialogResponse);
  ipcMain.handle(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE, handleStartConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE, handleStopConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE, handleClearConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES, handleGetConsoleProperties);

  return () => {
    ipcMain.removeHandler(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_REGISTER_PANEL);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_DIALOG_RESPONSE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES);

    // Clean up all sessions
    for (const wcId of sessions.keys()) {
      cleanupSession(wcId);
    }
  };
}
