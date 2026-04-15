import { BrowserWindow, ipcMain, webContents } from "electron";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import { CHANNELS } from "../channels.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { broadcastToRenderer, sendToRenderer } from "../utils.js";
import { startOAuthLoopback } from "../../services/OAuthLoopbackService.js";
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
  ownerWindow: BrowserWindow | null;
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
      ownerWindow: null,
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

export function registerWebviewHandlers(_deps: HandlerDependencies): () => void {
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

    if (session.ownerWindow === null) {
      const hostWc = wc.hostWebContents;
      session.ownerWindow = hostWc ? getWindowForWebContents(hostWc) : null;
    }

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
              const payload = {
                paneId: pid,
                navigationGeneration: session.navigationGeneration,
              };
              if (session.ownerWindow && !session.ownerWindow.isDestroyed()) {
                sendToRenderer(
                  session.ownerWindow,
                  CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED,
                  payload
                );
              } else {
                broadcastToRenderer(CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, payload);
              }
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
            const payload = {
              paneId: pid,
              navigationGeneration: session.navigationGeneration,
            };
            if (session.ownerWindow && !session.ownerWindow.isDestroyed()) {
              sendToRenderer(
                session.ownerWindow,
                CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED,
                payload
              );
            } else {
              broadcastToRenderer(CHANNELS.WEBVIEW_CONSOLE_CONTEXT_CLEARED, payload);
            }
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

      if (session.ownerWindow && !session.ownerWindow.isDestroyed()) {
        sendToRenderer(session.ownerWindow, CHANNELS.WEBVIEW_CONSOLE_MESSAGE, row);
      } else {
        broadcastToRenderer(CHANNELS.WEBVIEW_CONSOLE_MESSAGE, row);
      }

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

  const handleOAuthLoopback = async (
    _event: Electron.IpcMainInvokeEvent,
    authUrl: unknown,
    panelId: unknown,
    webContentsId: unknown,
    providedSessionStorageSnapshot: unknown
  ): Promise<{ success: boolean; error?: string } | null> => {
    if (
      typeof authUrl !== "string" ||
      typeof panelId !== "string" ||
      typeof webContentsId !== "number" ||
      (providedSessionStorageSnapshot !== undefined &&
        (!Array.isArray(providedSessionStorageSnapshot) ||
          providedSessionStorageSnapshot.some(
            (entry) =>
              !Array.isArray(entry) ||
              entry.length !== 2 ||
              typeof entry[0] !== "string" ||
              typeof entry[1] !== "string"
          )))
    ) {
      throw new Error(
        "Invalid arguments: authUrl must be string, panelId must be string, webContentsId must be number, sessionStorageSnapshot must be string tuples"
      );
    }

    // Validate webContentsId is registered to this panelId
    const registeredPanel = getWebviewDialogService().getPanelId(webContentsId);
    if (registeredPanel !== panelId) {
      throw new Error("WebContents ID does not match the registered panel");
    }

    // Step 1: Get the webview's webContents for session capture + CDP + navigation
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      console.error("[OAuthLoopback] WebContents not found or destroyed:", webContentsId);
      return { success: false, error: "WebView no longer available" };
    }

    let sessionStorageSnapshot =
      (providedSessionStorageSnapshot as Array<[string, string]> | undefined) ??
      (await getWebviewDialogService().consumeOAuthSessionStorage(panelId));
    if (sessionStorageSnapshot.length === 0) {
      try {
        const snapshot = await wc.executeJavaScript(
          `(() => {
            try {
              return Object.entries(sessionStorage).filter(
                (entry) =>
                  Array.isArray(entry) &&
                  entry.length === 2 &&
                  typeof entry[0] === "string" &&
                  typeof entry[1] === "string"
              );
            } catch {
              return [];
            }
          })()`
        );
        if (Array.isArray(snapshot)) {
          sessionStorageSnapshot = snapshot.filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === "string" &&
              typeof entry[1] === "string"
          );
        }
      } catch (error) {
        console.warn("[OAuthLoopback] Failed to capture sessionStorage snapshot:", error);
      }
    }

    // Step 2: Start loopback server, open system browser, wait for callback
    const loopbackResult = await startOAuthLoopback(authUrl, panelId);
    if (!loopbackResult) return null;

    const { callbackUrl, loopbackRedirectUri, originalRedirectUri } = loopbackResult;

    // Step 3: Attach CDP Fetch interceptor BEFORE navigating.
    // This intercepts the token exchange POST and rewrites redirect_uri
    // so it matches what was sent in the authorization request (the loopback URI).
    const INTERCEPT_TIMEOUT_MS = 30_000;
    let fetchEnabled = false;
    let restoreScriptIdentifier: string | null = null;
    let interceptorListener:
      | ((event: Electron.Event, method: string, params: unknown) => void)
      | null = null;

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach("1.3");
      }

      await wc.debugger.sendCommand("Page.enable");

      // Enable Fetch interception for Fetch/XHR only — token endpoints always use
      // fetch() or XMLHttpRequest, so we skip Document/Script/Image/Font interception
      await wc.debugger.sendCommand("Fetch.enable", {
        patterns: [
          { urlPattern: "*", resourceType: "Fetch", requestStage: "Request" },
          { urlPattern: "*", resourceType: "XHR", requestStage: "Request" },
        ],
      });
      fetchEnabled = true;

      if (sessionStorageSnapshot.length > 0) {
        const callbackOrigin = new URL(callbackUrl).origin;
        const restoreScript = `
          (() => {
            if (window.__daintreeOAuthRestored) return;
            window.__daintreeOAuthRestored = true;
            const expectedOrigin = ${JSON.stringify(callbackOrigin)};
            const entries = ${JSON.stringify(sessionStorageSnapshot)};
            try {
              if (window.location.origin !== expectedOrigin) return;
              for (const [key, value] of entries) {
                if (typeof key === "string" && typeof value === "string") {
                  sessionStorage.setItem(key, value);
                }
              }
            } catch {
              // Ignore restoration failures
            }
          })();
        `;

        const result = (await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          source: restoreScript,
        })) as { identifier?: string };
        restoreScriptIdentifier = result.identifier ?? null;
      }

      // Set up the interceptor as a promise that resolves on first match or timeout
      await new Promise<void>((resolveIntercept) => {
        let interceptDone = false;
        const finishIntercept = () => {
          if (interceptDone) return;
          interceptDone = true;
          resolveIntercept();
        };

        const timeout = setTimeout(() => {
          console.log(
            "[OAuthLoopback] CDP intercept timeout — token exchange may not need rewriting"
          );
          finishIntercept();
        }, INTERCEPT_TIMEOUT_MS);

        interceptorListener = (_event: Electron.Event, method: string, params: unknown) => {
          if (method !== "Fetch.requestPaused") return;

          const p = params as {
            requestId: string;
            request: { url: string; method: string; postData?: string };
          };

          // Only intercept POST requests that contain grant_type=authorization_code
          const isTokenExchange =
            p.request.method === "POST" &&
            p.request.postData?.includes("grant_type=authorization_code");

          if (!isTokenExchange) {
            // Not the token exchange — let it through
            wc.debugger
              .sendCommand("Fetch.continueRequest", { requestId: p.requestId })
              .catch(() => {});
            return;
          }

          // Rewrite redirect_uri in the POST body
          const originalBody = p.request.postData ?? "";
          const encodedOriginal = encodeURIComponent(originalRedirectUri);
          const encodedLoopback = encodeURIComponent(loopbackRedirectUri);
          const rewrittenBody = originalBody.replace(
            `redirect_uri=${encodedOriginal}`,
            `redirect_uri=${encodedLoopback}`
          );

          const didRewrite = rewrittenBody !== originalBody;
          console.log(
            `[OAuthLoopback] CDP intercepted token exchange POST to ${p.request.url}. ` +
              `Redirect_uri rewrite: ${didRewrite ? "applied" : "not needed"}`
          );

          // Continue the request with the modified body (base64-encoded)
          wc.debugger
            .sendCommand("Fetch.continueRequest", {
              requestId: p.requestId,
              postData: Buffer.from(rewrittenBody).toString("base64"),
            })
            .catch((err) => {
              console.error("[OAuthLoopback] CDP continueRequest failed:", err);
            });

          clearTimeout(timeout);
          finishIntercept();
        };

        wc.debugger.on("message", interceptorListener);

        // Step 4: Navigate the webview to the callback URL
        // The page will load, the app's JS will fire the token exchange fetch,
        // and our CDP listener will intercept and rewrite it.
        wc.loadURL(callbackUrl).catch((err) => {
          console.error("[OAuthLoopback] Failed to navigate webview:", err);
          clearTimeout(timeout);
          finishIntercept();
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[OAuthLoopback] CDP setup failed:", msg);
      // Still try to navigate even without interception — might work for providers
      // that don't enforce strict redirect_uri matching at token exchange
      wc.loadURL(callbackUrl).catch(() => {});
      return { success: false, error: `CDP interception failed: ${msg}` };
    } finally {
      // Clean up CDP Fetch — remove listener and disable
      if (interceptorListener) {
        wc.debugger.removeListener("message", interceptorListener);
      }
      if (restoreScriptIdentifier && !wc.isDestroyed()) {
        wc.debugger
          .sendCommand("Page.removeScriptToEvaluateOnNewDocument", {
            identifier: restoreScriptIdentifier,
          })
          .catch(() => {});
      }
      if (fetchEnabled && !wc.isDestroyed()) {
        wc.debugger.sendCommand("Fetch.disable").catch(() => {});
      }
    }

    return { success: true };
  };

  ipcMain.handle(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, handleSetLifecycleState);
  ipcMain.handle(CHANNELS.WEBVIEW_REGISTER_PANEL, handleRegisterPanel);
  ipcMain.handle(CHANNELS.WEBVIEW_DIALOG_RESPONSE, handleDialogResponse);
  ipcMain.handle(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE, handleStartConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE, handleStopConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE, handleClearConsoleCapture);
  ipcMain.handle(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES, handleGetConsoleProperties);
  ipcMain.handle(CHANNELS.WEBVIEW_OAUTH_LOOPBACK, handleOAuthLoopback);

  return () => {
    ipcMain.removeHandler(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_REGISTER_PANEL);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_DIALOG_RESPONSE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES);
    ipcMain.removeHandler(CHANNELS.WEBVIEW_OAUTH_LOOPBACK);

    // Clean up all sessions
    for (const wcId of sessions.keys()) {
      cleanupSession(wcId);
    }
  };
}
