import { BrowserWindow, webContents } from "electron";
import { getWindowForWebContents } from "../../window/webContentsRegistry.js";
import { CHANNELS } from "../channels.js";
import { getWebviewDialogService } from "../../services/WebviewDialogService.js";
import { broadcastToRenderer, sendToRenderer, typedHandle } from "../utils.js";
import { startOAuthLoopback } from "../../services/OAuthLoopbackService.js";
import type { HandlerDependencies } from "../types.js";
import type {
  CdpRemoteArg,
  CdpStackTrace,
  CdpConsoleType,
  CdpLogEntrySource,
  SerializedConsoleRow,
  CdpPropertyDescriptor,
} from "../../../shared/types/ipc/webviewConsole.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError } from "../../utils/errorTypes.js";
import { logError, logWarn } from "../../utils/logger.js";
import { freezeWebContents, unfreezeWebContents } from "../../utils/webContentsLifecycle.js";
import { MAX_CONSOLE_ROWS } from "../../../shared/config/devPreviewConsole.js";

interface CdpSession {
  runtimeEnabled: boolean;
  logEnabled: boolean;
  paneIds: Set<string>;
  navigationGeneration: number;
  groupDepthByPane: Map<string, number>;
  /**
   * CDP remote-object handles, owned per console row rather than per pane, so
   * evicting a row can release exactly its handles. Insertion order is the
   * emission order, which makes the inner map the eviction FIFO.
   */
  rowObjectIdsByPane: Map<string, Map<number, Set<string>>>;
  /**
   * Replay reconciliation, one watermark per event stream. `Runtime.enable` and
   * `Log.enable` both re-deliver their guest-side buffer, so a stop/start cycle
   * would duplicate everything the renderer still has on screen. Each stream
   * gets its own watermark because one stream's progress says nothing about
   * what another has delivered.
   */
  consoleWatermark: ReplayWatermark;
  exceptionWatermark: ReplayWatermark;
  logEntryWatermark: ReplayWatermark;
  /**
   * Guest URL as of the last enable. A navigation while capture is stopped
   * empties the guest's console buffer without an `executionContextsCleared`
   * anyone is listening for, so the replay bookkeeping has to be checked
   * against the document it was collected on.
   */
  lastKnownUrl: string | null;
  /** `destroyed` cleanup hook, held so teardown can detach it with the rest. */
  destroyListener: (() => void) | null;
  /**
   * Capture starts and stops for one guest run one at a time. Both mutate pane
   * membership either side of an await and then decide the domain state from
   * it, so interleaving them lets a stop disable domains a start just adopted,
   * or delete a registration a restart just made.
   */
  transitionQueue: Promise<void>;
  // Per-session throttle for `Log.entryAdded` — browser-emitted entries
  // (CSP, network, deprecation) can flood. Keyed by source:level:url:line.
  logRateLimit: Map<string, { count: number; resetAt: number }>;
  ownerWindow: BrowserWindow | null;
  messageListener: ((event: Electron.Event, method: string, params: unknown) => void) | null;
  detachListener: ((event: Electron.Event, reason: string) => void) | null;
}

const sessions = new Map<number, CdpSession>();
let _nextMessageId = 0;

// Keep in sync with rendererConsoleCapture.ts (RATE_WINDOW_MS / RATE_MAX_PER_WINDOW).
// Same throttle algorithm; the rate state lives on CdpSession (keyed by wcId)
// rather than a WeakMap<WebContents>, so the helper is not shared.
const LOG_RATE_WINDOW_MS = 5_000;
const LOG_RATE_MAX_PER_WINDOW = 5;

const LOG_ENTRY_SOURCES: ReadonlySet<string> = new Set<CdpLogEntrySource>([
  "javascript",
  "network",
  "deprecation",
  "security",
  "violation",
  "intervention",
  "recommendation",
  "worker",
  "other",
]);

function normalizeLogEntrySource(source: unknown): CdpLogEntrySource {
  return typeof source === "string" && LOG_ENTRY_SOURCES.has(source)
    ? (source as CdpLogEntrySource)
    : "other";
}

function logEntryLevelToLevel(level: unknown): "log" | "info" | "warning" | "error" {
  switch (level) {
    case "error":
      return "error";
    case "warning":
      return "warning";
    case "info":
      return "info";
    // "verbose" and anything unexpected collapse to "log"
    default:
      return "log";
  }
}

// Above this size, expired entries are swept before inserting. Keys embed
// guest-page URLs, so without a sweep the map grows monotonically for the
// pane's whole capture lifetime (one entry per distinct failing URL/line).
const LOG_RATE_SWEEP_THRESHOLD = 256;

function shouldAllowLogEntry(session: CdpSession, key: string): boolean {
  const now = Date.now();
  const entry = session.logRateLimit.get(key);
  if (!entry || now >= entry.resetAt) {
    if (session.logRateLimit.size >= LOG_RATE_SWEEP_THRESHOLD) {
      for (const [k, v] of session.logRateLimit) {
        if (now >= v.resetAt) session.logRateLimit.delete(k);
      }
    }
    session.logRateLimit.set(key, { count: 1, resetAt: now + LOG_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count < LOG_RATE_MAX_PER_WINDOW) {
    entry.count++;
    return true;
  }
  return false;
}

function getOrCreateSession(wcId: number): CdpSession {
  let session = sessions.get(wcId);
  if (!session) {
    session = {
      runtimeEnabled: false,
      logEnabled: false,
      paneIds: new Set(),
      navigationGeneration: 0,
      groupDepthByPane: new Map(),
      rowObjectIdsByPane: new Map(),
      consoleWatermark: createReplayWatermark(),
      exceptionWatermark: createReplayWatermark(),
      logEntryWatermark: createReplayWatermark(),
      lastKnownUrl: null,
      destroyListener: null,
      transitionQueue: Promise.resolve(),
      logRateLimit: new Map(),
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
      // CDP `Runtime.CallFrame` line/column are zero-based; every consumer of
      // a serialized frame (display, clipboard) wants the one-based file
      // location developers expect, so convert once here rather than at each
      // render site where the two could drift apart (#12298).
      lineNumber: (f.lineNumber ?? 0) + 1,
      columnNumber: (f.columnNumber ?? 0) + 1,
    })),
  };
}

/**
 * Best-effort release of CDP remote-object handles. Releasing an id that the
 * guest already invalidated (navigation, GC) is a benign CDP rejection, so
 * every failure is swallowed.
 */
function releaseObjectIds(wcId: number, objectIds: Iterable<string>): void {
  const wc = webContents.fromId(wcId);
  if (!wc || wc.isDestroyed()) return;
  for (const objectId of objectIds) {
    try {
      wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {});
    } catch {
      // Debugger detached between the destroyed check and the send.
    }
  }
}

/**
 * How much of one CDP event stream the renderer has already been given.
 *
 * Reconciliation is positional, not timestamp-based. The guest's console buffer
 * is append-only and replays in emission order, so "how many we already took"
 * identifies the already-delivered prefix exactly. Timestamps cannot: CDP
 * timestamps are epoch milliseconds that are neither unique (a burst shares a
 * millisecond) nor guaranteed to increase (a clock step can move them
 * backwards), and either property alone loses real rows.
 *
 * Known limit: V8's message storage is bounded and evicts from the front, so a
 * page that logs more than its capacity while capture is stopped breaks the
 * prefix assumption and the oldest of the new messages are skipped. Aligning
 * through that needs per-event identity, which CDP does not give us; the
 * alternative — admitting on doubt — duplicates visible rows instead. Both
 * remain far better than the previous behaviour, which dropped every replayed
 * message unconditionally.
 */
interface ReplayWatermark {
  /** Events admitted from this stream since the buffer was last cleared. */
  delivered: number;
  /** Events still to skip in the current replay window. */
  skipRemaining: number;
  replaying: boolean;
}

function createReplayWatermark(): ReplayWatermark {
  return { delivered: 0, skipRemaining: 0, replaying: false };
}

function openReplayWindow(...watermarks: ReplayWatermark[]): void {
  for (const w of watermarks) {
    w.replaying = true;
    w.skipRemaining = w.delivered;
  }
}

function closeReplayWindow(...watermarks: ReplayWatermark[]): void {
  for (const w of watermarks) {
    w.replaying = false;
    w.skipRemaining = 0;
  }
}

/**
 * Reset after the guest's buffer is genuinely gone. Only an execution-context
 * clear does that — a debugger detach leaves the buffer intact, so resetting
 * there would re-admit everything on the next attach.
 */
function resetReplayWatermark(w: ReplayWatermark): void {
  w.delivered = 0;
  w.skipRemaining = 0;
}

/** Whether to deliver this event, counting it against the stream when we do. */
function admitEvent(w: ReplayWatermark): boolean {
  if (w.replaying && w.skipRemaining > 0) {
    w.skipRemaining -= 1;
    return false;
  }
  w.delivered += 1;
  return true;
}

function objectIdsFromArgs(args: CdpRemoteArg[]): string[] {
  const ids: string[] = [];
  for (const arg of args) {
    if ((arg.type === "object" || arg.type === "function") && arg.objectId) {
      ids.push(arg.objectId);
    }
  }
  return ids;
}

/**
 * Record a row's handle ownership and evict past the renderer's row cap.
 *
 * Every emitted row gets a record, including rows carrying no handles, because
 * the renderer's cap counts rows, not handles — mirroring it here is what keeps
 * main's eviction boundary identical to the store's without an extra IPC round
 * trip per eviction. See MAX_CONSOLE_ROWS.
 */
function recordRowObjects(
  wcId: number,
  session: CdpSession,
  paneId: string,
  rowId: number,
  objectIds: string[]
): void {
  let rows = session.rowObjectIdsByPane.get(paneId);
  if (!rows) {
    rows = new Map();
    session.rowObjectIdsByPane.set(paneId, rows);
  }
  rows.set(rowId, new Set(objectIds));

  while (rows.size > MAX_CONSOLE_ROWS) {
    const oldest = rows.keys().next();
    if (oldest.done) break;
    const evictedIds = rows.get(oldest.value);
    rows.delete(oldest.value);
    if (evictedIds && evictedIds.size > 0) releaseObjectIds(wcId, evictedIds);
  }
}

async function releaseObjectsForPane(
  wc: Electron.WebContents,
  session: CdpSession,
  paneId: string
): Promise<void> {
  const rows = session.rowObjectIdsByPane.get(paneId);
  if (!rows || rows.size === 0) return;

  const ids: string[] = [];
  for (const rowIds of rows.values()) {
    for (const objectId of rowIds) ids.push(objectId);
  }
  // Drop ownership before awaiting: an expansion result landing mid-release
  // must not attach new handles to a record that is about to disappear, and
  // must not read a released row as still owning anything.
  rows.clear();
  if (ids.length === 0) return;

  await Promise.allSettled(
    ids.map((objectId) =>
      wc.debugger.sendCommand("Runtime.releaseObject", { objectId }).catch(() => {
        // Ignore release failures (object may already be GC'd)
      })
    )
  );
}

/**
 * Unbind a session's debugger listeners without discarding the session.
 * Nulling the references matters: the start handler treats a non-null
 * `messageListener` as "already bound", so leaving a stale reference behind
 * would make the next start skip rebinding and capture silently nothing.
 */
function detachSessionListeners(wcId: number): void {
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
    // Without this, a guest that survives repeated failed starts accumulates
    // one dead `destroyed` callback per attempt.
    if (session.destroyListener && typeof wc.off === "function") {
      wc.off("destroyed", session.destroyListener);
    }
  }

  session.messageListener = null;
  session.detachListener = null;
  session.destroyListener = null;
  session.runtimeEnabled = false;
  session.logEnabled = false;
}

function cleanupSession(wcId: number): void {
  detachSessionListeners(wcId);
  sessions.delete(wcId);
}

export function registerWebviewHandlers(_deps: HandlerDependencies): () => void {
  const handleSetLifecycleState = async (
    webContentsId: unknown,
    frozen: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof frozen !== "boolean") {
      throw new Error("Invalid arguments: webContentsId must be number, frozen must be boolean");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    await (frozen ? freezeWebContents(wc) : unfreezeWebContents(wc));
  };

  /**
   * Run a capture transition after every earlier one for the same guest.
   * A rejection is contained so one failed transition cannot wedge the queue.
   */
  function enqueueTransition(session: CdpSession, work: () => Promise<void>): Promise<void> {
    const running = session.transitionQueue.then(work);
    session.transitionQueue = running.catch(() => {});
    return running;
  }

  /**
   * Enable the console domains for a session whose listeners are already bound.
   * Ordering matters: both enables replay their guest-side buffer, so the
   * listener has to be live first, and each enable opens its stream's replay
   * window so already-delivered events are reconciled away.
   */
  async function enableConsoleDomains(
    webContentsId: number,
    wc: Electron.WebContents,
    session: CdpSession
  ): Promise<void> {
    // The guest may have navigated while capture was stopped, which empties its
    // console buffer. Without this the replay bookkeeping from the old document
    // would skip the new one's startup messages — the exact loss this issue is
    // about, just moved.
    let currentUrl: string | null = null;
    try {
      currentUrl = wc.getURL();
    } catch {
      // Guest torn down mid-transition; leave the bookkeeping alone.
    }
    if (
      currentUrl !== null &&
      session.lastKnownUrl !== null &&
      currentUrl !== session.lastKnownUrl
    ) {
      resetReplayWatermark(session.consoleWatermark);
      resetReplayWatermark(session.exceptionWatermark);
      resetReplayWatermark(session.logEntryWatermark);
    }
    if (currentUrl !== null) session.lastKnownUrl = currentUrl;

    if (!session.runtimeEnabled) {
      openReplayWindow(session.consoleWatermark, session.exceptionWatermark);
      try {
        await wc.debugger.sendCommand("Runtime.enable");
        session.runtimeEnabled = true;
      } finally {
        closeReplayWindow(session.consoleWatermark, session.exceptionWatermark);
      }
    }

    // Log surfaces browser-emitted entries (CSP violations, network failures,
    // deprecations) that never reach Runtime.consoleAPICalled. Its own
    // try/catch so a Log.enable failure degrades to "no log-entry rows" rather
    // than silently breaking the already-working consoleAPICalled capture.
    if (!session.logEnabled) {
      try {
        openReplayWindow(session.logEntryWatermark);
        await wc.debugger.sendCommand("Log.enable");
        session.logEnabled = true;
      } catch (logErr) {
        console.warn(
          `[webview] CDP Log.enable failed for id=${webContentsId}:`,
          formatErrorMessage(logErr, "Log.enable failed")
        );
      } finally {
        closeReplayWindow(session.logEntryWatermark);
      }
    }
  }

  const handleStartConsoleCapture = async (
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
    return enqueueTransition(session, () => startCapture(webContentsId, wc, session, paneId));
  };

  async function startCapture(
    webContentsId: number,
    wc: Electron.WebContents,
    session: CdpSession,
    paneId: string
  ): Promise<void> {
    if (wc.isDestroyed()) return;

    session.paneIds.add(paneId);
    session.groupDepthByPane.set(paneId, 0);

    if (session.ownerWindow === null) {
      const hostWc = wc.hostWebContents;
      session.ownerWindow = hostWc ? getWindowForWebContents(hostWc) : null;
    }

    if (!session.rowObjectIdsByPane.has(paneId)) {
      session.rowObjectIdsByPane.set(paneId, new Map());
    }

    // Sessions outlive capture (see handleStopConsoleCapture), so tie their
    // lifetime to the guest rather than to the last pane that stopped.
    if (!session.destroyListener && typeof wc.once === "function") {
      const destroyListener = () => cleanupSession(webContentsId);
      session.destroyListener = destroyListener;
      wc.once("destroyed", destroyListener);
    }

    let boundListenersHere = false;
    try {
      ensureAttached(wc);

      // Bind CDP message listener once per webContents
      if (!session.messageListener) {
        boundListenersHere = true;
        const listener = (_event: Electron.Event, method: string, params: unknown) => {
          // CDP events can arrive synchronously mid-teardown (the renderer's
          // detach hasn't flushed the buffered emit). Guard the whole body so a
          // teardown-race access never escapes as an uncaught main-process crash.
          try {
            if (method === "Runtime.consoleAPICalled") {
              handleConsoleApiCalled(webContentsId, session, params);
            } else if (method === "Runtime.exceptionThrown") {
              handleExceptionThrown(webContentsId, session, params);
            } else if (method === "Log.entryAdded") {
              handleLogEntryAdded(webContentsId, session, params);
            } else if (method === "Runtime.executionContextsCleared") {
              session.navigationGeneration++;
              // Rate state from the previous page is meaningless after
              // navigation, and its keys embed that page's URLs.
              session.logRateLimit.clear();
              // The new document has not delivered anything yet, so nothing is
              // a duplicate of what the renderer already holds.
              resetReplayWatermark(session.consoleWatermark);
              resetReplayWatermark(session.exceptionWatermark);
              resetReplayWatermark(session.logEntryWatermark);
              try {
                session.lastKnownUrl = wc.getURL();
              } catch {
                session.lastKnownUrl = null;
              }
              // Reset group depth and drop stale handle ownership for all
              // panes. No release call: the guest already invalidated every
              // handle when the execution context went away.
              for (const pid of session.paneIds) {
                session.groupDepthByPane.set(pid, 0);
                session.rowObjectIdsByPane.get(pid)?.clear();
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
          } catch (err) {
            logWarn("CDP message listener failed mid-teardown", {
              webContentsId,
              method,
              error: formatErrorMessage(err, "CDP message listener failed"),
            });
          }
        };
        session.messageListener = listener;
        wc.debugger.on("message", listener);
      }

      if (!session.detachListener) {
        const detachListener = (_event: Electron.Event, _reason: string) => {
          try {
            session.runtimeEnabled = false;
            session.logEnabled = false;
            // Debugger detach automatically removes all listeners, so just null our refs
            session.messageListener = null;
            session.detachListener = null;
            session.navigationGeneration++;
            // Deliberately NOT resetting the replay watermarks: a debugger
            // detach leaves the guest's console buffer intact, so the next
            // attach replays it and everything already delivered would arrive
            // a second time.
            for (const pid of session.paneIds) {
              session.groupDepthByPane.set(pid, 0);
              session.rowObjectIdsByPane.get(pid)?.clear();
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
          } catch (err) {
            logWarn("CDP detach listener failed mid-teardown", {
              webContentsId,
              error: formatErrorMessage(err, "CDP detach listener failed"),
            });
          }
        };
        session.detachListener = detachListener;
        wc.debugger.on("detach", detachListener);
      }

      // Enabled AFTER the message listener is wired: Runtime.enable replays the
      // guest's buffered console messages as a side effect, and that replay
      // lands before this await resolves. Enabling first — as this handler used
      // to — dropped everything the page logged before capture attached, which
      // is every startup log for a page that had already booted (#12298).
      await enableConsoleDomains(webContentsId, wc, session);
    } catch (err) {
      // Setup failed after the listeners were bound. Unwind them when this call
      // is the only thing holding the session, so a guest that can never be
      // instrumented is not left with dangling debugger listeners. The session
      // object itself stays: another start may already be queued behind this
      // one and holds a reference to it.
      if (boundListenersHere && !session.runtimeEnabled && session.paneIds.size <= 1) {
        detachSessionListeners(webContentsId);
      }
      const message = formatErrorMessage(err, "CDP console capture start failed");
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
  }

  function handleConsoleApiCalled(wcId: number, session: CdpSession, params: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any;
    if (!p) return;

    // Runtime.enable re-delivers the guest's whole console buffer, so a
    // stop/start cycle (a dev-preview tab switch unmounts the pane while the
    // store keeps its rows) would duplicate everything still on screen. Only
    // the enable window is reconciled, so messages logged while capture was
    // stopped still arrive.
    if (!admitEvent(session.consoleWatermark)) return;

    // Read the raw protocol type for this check: `clear` is not part of
    // CdpConsoleType, so the cast below would hide it. console.clear() empties
    // the guest's message storage and leaves only this event in it, so the
    // replay prefix is now exactly one event long.
    if (p.type === "clear") {
      session.consoleWatermark.delivered = 1;
      resetReplayWatermark(session.exceptionWatermark);
    }

    const cdpType = (p.type ?? "log") as CdpConsoleType;

    if (cdpType === "endGroup") {
      // Don't emit a row for endGroup, just adjust depth per pane
      for (const paneId of session.paneIds) {
        const groupDepth = session.groupDepthByPane.get(paneId) ?? 0;
        session.groupDepthByPane.set(paneId, Math.max(0, groupDepth - 1));
      }
      return;
    }

    // Normalization is pane-independent — hoisted so multi-pane sessions
    // don't repeat the recursive remote-object walks per pane.
    const args: CdpRemoteArg[] = Array.isArray(p.args)
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        p.args.map((a: any) => normalizeRemoteObject(a))
      : [];

    const level = cdpTypeToLevel(cdpType);
    const summaryText = buildSummaryText(args);
    const stackTrace = normalizeStackTrace(p.stackTrace);

    const rootObjectIds = objectIdsFromArgs(args);

    for (const paneId of session.paneIds) {
      const groupDepth = session.groupDepthByPane.get(paneId) ?? 0;

      const rowId = _nextMessageId++;
      recordRowObjects(wcId, session, paneId, rowId, rootObjectIds);

      const row: SerializedConsoleRow = {
        id: rowId,
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

  function emitConsoleRow(session: CdpSession, row: SerializedConsoleRow): void {
    if (session.ownerWindow && !session.ownerWindow.isDestroyed()) {
      sendToRenderer(session.ownerWindow, CHANNELS.WEBVIEW_CONSOLE_MESSAGE, row);
    } else {
      broadcastToRenderer(CHANNELS.WEBVIEW_CONSOLE_MESSAGE, row);
    }
  }

  function handleExceptionThrown(wcId: number, session: CdpSession, params: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any;
    const details = p?.exceptionDetails;
    if (!details) return;

    // Runtime.enable replays buffered exceptions alongside console calls, so
    // these need their own reconciliation — the console watermark's progress
    // says nothing about which exceptions the renderer already has.
    if (!admitEvent(session.exceptionWatermark)) return;

    const summaryText: string =
      details.exception?.description ?? details.text ?? "Uncaught (unknown exception)";
    const stackTrace = normalizeStackTrace(details.stackTrace);
    const timestamp = typeof p.timestamp === "number" ? Math.floor(p.timestamp) : Date.now();

    for (const paneId of session.paneIds) {
      const rowId = _nextMessageId++;
      recordRowObjects(wcId, session, paneId, rowId, []);
      const row: SerializedConsoleRow = {
        id: rowId,
        paneId,
        level: "error",
        cdpType: "error",
        args: [],
        summaryText,
        stackTrace,
        groupDepth: session.groupDepthByPane.get(paneId) ?? 0,
        timestamp,
        navigationGeneration: session.navigationGeneration,
      };
      emitConsoleRow(session, row);
    }
  }

  function handleLogEntryAdded(wcId: number, session: CdpSession, params: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (params as any)?.entry;
    if (!entry) return;

    // `Log.enable` replays the guest's stored entries just like Runtime does,
    // so a stop/start cycle would duplicate CSP, network and deprecation rows
    // the renderer still displays. Reconciled before the rate limiter, so a
    // replay can't consume the allowance a live failure needs.
    if (!admitEvent(session.logEntryWatermark)) return;

    const source = normalizeLogEntrySource(entry.source);
    const level = logEntryLevelToLevel(entry.level);
    const rateKey = `${source}:${level}:${entry.url ?? ""}:${entry.lineNumber ?? 0}`;
    if (!shouldAllowLogEntry(session, rateKey)) return;

    const summaryText: string = typeof entry.text === "string" ? entry.text : "";
    const stackTrace = normalizeStackTrace(entry.stackTrace);
    const timestamp =
      typeof entry.timestamp === "number" ? Math.floor(entry.timestamp) : Date.now();

    for (const paneId of session.paneIds) {
      const rowId = _nextMessageId++;
      recordRowObjects(wcId, session, paneId, rowId, []);
      const row: SerializedConsoleRow = {
        id: rowId,
        paneId,
        level,
        cdpType: "log-entry",
        args: [],
        summaryText,
        stackTrace,
        groupDepth: session.groupDepthByPane.get(paneId) ?? 0,
        timestamp,
        navigationGeneration: session.navigationGeneration,
        category: source,
      };
      emitConsoleRow(session, row);
    }
  }

  const handleStopConsoleCapture = async (
    webContentsId: unknown,
    paneId: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof paneId !== "string") return;

    if (!getWebviewDialogService().getPanelId(webContentsId)) return;

    const session = sessions.get(webContentsId);
    if (!session) return;

    return enqueueTransition(session, () => stopCapture(webContentsId, session, paneId));
  };

  async function stopCapture(
    webContentsId: number,
    session: CdpSession,
    paneId: string
  ): Promise<void> {
    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) {
      await releaseObjectsForPane(wc, session, paneId);
    }

    session.paneIds.delete(paneId);
    session.groupDepthByPane.delete(paneId);
    session.rowObjectIdsByPane.delete(paneId);

    // If no more panes are capturing, disable the domains but keep the session.
    // Its listeners are inert while the domains are off, and holding it keeps
    // the replay bookkeeping so the replay a later Runtime.enable triggers can
    // be reconciled against what the renderer already displays. The session is
    // disposed by the guest's `destroyed` hook or by handler teardown. No start
    // can interleave here — transitions are serialized per guest.
    if (session.paneIds.size === 0 && wc && !wc.isDestroyed()) {
      if (session.runtimeEnabled) {
        try {
          await wc.debugger.sendCommand("Runtime.disable");
        } catch {
          // Ignore
        }
        session.runtimeEnabled = false;
      }
      if (session.logEnabled) {
        try {
          await wc.debugger.sendCommand("Log.disable");
        } catch {
          // Ignore
        }
        session.logEnabled = false;
      }
    }
  }

  const handleClearConsoleCapture = async (
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
    webContentsId: unknown,
    paneId: unknown,
    rowId: unknown,
    objectId: unknown
  ): Promise<{ properties: CdpPropertyDescriptor[] }> => {
    if (
      typeof webContentsId !== "number" ||
      typeof paneId !== "string" ||
      typeof rowId !== "number" ||
      typeof objectId !== "string"
    ) {
      throw new Error("Invalid arguments");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) {
      return { properties: [] };
    }

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) {
      return { properties: [] };
    }

    // Expansion is only meaningful for a handle the named row still owns. A row
    // that was evicted, cleared or invalidated by navigation is gone from the
    // renderer too, and inspecting it would mint descendants nothing can own.
    // Checking the handle itself — not just that the row exists — keeps a
    // caller from inspecting an arbitrary objectId through a live row.
    const session = sessions.get(webContentsId);
    if (!session?.rowObjectIdsByPane.get(paneId)?.get(rowId)?.has(objectId)) {
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
      const descendantIds: string[] = [];

      // Handles come off the raw descriptors, not the normalized ones:
      // normalizeRemoteObject drops accessors and symbols, and CDP hands back
      // mirrors in three sibling arrays. A Map, a Promise or an object with
      // private fields allocates handles in the latter two, and anything not
      // collected here can never be released.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const collectHandles = (prop: any): void => {
        for (const mirror of [prop?.value, prop?.get, prop?.set, prop?.symbol]) {
          if (mirror && typeof mirror.objectId === "string") descendantIds.push(mirror.objectId);
        }
      };

      if (Array.isArray(raw.result)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const prop of raw.result as any[]) {
          collectHandles(prop);
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
      // Not surfaced in the UI, but CDP retains their mirrors all the same.
      for (const list of [raw.internalProperties, raw.privateProperties]) {
        if (!Array.isArray(list)) continue;
        for (const prop of list) collectHandles(prop);
      }

      // Re-check ownership after the await. If the row lost it while the
      // request was in flight, these descendants belong to nobody — release
      // them rather than letting a late result resurrect released ownership.
      const rowIds = sessions.get(webContentsId)?.rowObjectIdsByPane.get(paneId)?.get(rowId);
      if (rowIds) {
        for (const id of descendantIds) rowIds.add(id);
      } else if (descendantIds.length > 0) {
        releaseObjectIds(webContentsId, descendantIds);
      }

      return { properties };
    } catch (err) {
      const message = formatErrorMessage(err, "Failed to get object properties");
      if (message.includes("Could not find object")) {
        return { properties: [] };
      }
      throw err;
    }
  };

  const handleRegisterPanel = async (payload: unknown): Promise<void> => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { webContentsId?: unknown }).webContentsId !== "number" ||
      typeof (payload as { panelId?: unknown }).panelId !== "string"
    ) {
      throw new Error("Invalid arguments: webContentsId must be number, panelId must be string");
    }
    const { webContentsId, panelId, kind } = payload as {
      webContentsId: number;
      panelId: string;
      kind?: unknown;
    };
    getWebviewDialogService().registerPanel(
      webContentsId,
      panelId,
      typeof kind === "string" ? kind : undefined
    );
  };

  const handleDialogResponse = async (payload: unknown): Promise<void> => {
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

  const handleCancelOAuthLoopback = async (payload: unknown): Promise<void> => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { panelId?: unknown }).panelId !== "string"
    ) {
      throw new Error("Invalid arguments: panelId must be string");
    }
    const { panelId } = payload as { panelId: string };
    const { cancelOAuthLoopback } = await import("../../services/OAuthLoopbackService.js");
    cancelOAuthLoopback(panelId);
  };

  const handleOAuthLoopback = async (
    authUrl: unknown,
    panelId: unknown,
    webContentsId: unknown,
    providedSessionStorageSnapshot: unknown
  ): Promise<import("../../../shared/types/oauth.js").OAuthLoopbackResult> => {
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
      throw new AppError({
        code: "NOT_FOUND",
        message: "WebView no longer available",
        context: { webContentsId, panelId },
      });
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

    // Resolve owner window once — used for status event broadcasts.
    const ownerWindow = getWindowForWebContents(wc);

    // Step 2: Start loopback server, open system browser, wait for callback
    const loopbackResult = await startOAuthLoopback(authUrl, panelId);
    if (!loopbackResult.success) {
      // Suppress status event for cancelled flows — the renderer already
      // dismissed the banner via the Cancel button, and a second "Sign in"
      // preempting a first would flash a misleading "error" phase.
      if (loopbackResult.cause !== "cancelled" && ownerWindow) {
        sendToRenderer(ownerWindow, CHANNELS.WEBVIEW_OAUTH_LOOPBACK_STATUS, {
          panelId,
          phase: loopbackResult.cause === "timed-out" ? "timed-out" : "error",
          message: loopbackResult.cause === "timed-out" ? "Sign-in timed out" : undefined,
        });
      }
      return loopbackResult;
    }

    const { callbackUrl, loopbackRedirectUri, originalRedirectUri } = loopbackResult;

    // Step 3: Attach CDP Fetch interceptor BEFORE navigating.
    // This intercepts the token exchange POST and rewrites redirect_uri
    // so it matches what was sent in the authorization request (the loopback URI).
    const INTERCEPT_TIMEOUT_MS = 30_000;
    let fetchEnabled = false;
    let restoreScriptIdentifier: string | null = null;
    let interceptorListener:
      ((event: Electron.Event, method: string, params: unknown) => void) | null = null;
    let navigationError: Error | null = null;

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
            // Not the token exchange — let it through. Failure here is usually
            // a teardown race (debugger detached, request superseded). Surface
            // at warn so it's visible in logs without polluting error metrics.
            wc.debugger
              .sendCommand("Fetch.continueRequest", { requestId: p.requestId })
              .catch((err) => {
                logWarn("OAuth CDP non-token continueRequest failed", {
                  panelId,
                  url: p.request.url,
                  error: formatErrorMessage(err, "CDP continueRequest failed"),
                });
              });
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
              logError("OAuth CDP token-exchange continueRequest failed", err, { panelId });
            });

          clearTimeout(timeout);
          // Broadcast token-exchange-intercepted status to the renderer
          if (ownerWindow) {
            sendToRenderer(ownerWindow, CHANNELS.WEBVIEW_OAUTH_LOOPBACK_STATUS, {
              panelId,
              phase: "token-exchange-intercepted",
            });
          }
          finishIntercept();
        };

        wc.debugger.on("message", interceptorListener);

        // Step 4: Navigate the webview to the callback URL
        // The page will load, the app's JS will fire the token exchange fetch,
        // and our CDP listener will intercept and rewrite it.
        wc.loadURL(callbackUrl).catch((err) => {
          // Capture so the outer scope can throw after CDP cleanup runs;
          // resolving the promise here lets the `finally` block tear down
          // listeners and Fetch.disable cleanly before the error propagates.
          navigationError = err instanceof Error ? err : new Error(String(err));
          logError("OAuth callback webview navigation failed", err, { panelId });
          clearTimeout(timeout);
          finishIntercept();
        });
      });
    } catch (err) {
      const msg = formatErrorMessage(err, "CDP setup failed");
      console.error("[OAuthLoopback] CDP setup failed:", msg);
      // Still try to navigate even without interception — might work for providers
      // that don't enforce strict redirect_uri matching at token exchange.
      // Intentional: the primary CDP failure was already logged + rethrown above;
      // this fallback navigation's failure adds no actionable signal.
      wc.loadURL(callbackUrl).catch(() => {});
      throw new AppError({
        code: "INTERNAL",
        message: `CDP interception failed: ${msg}`,
        context: { panelId },
        cause: err instanceof Error ? err : undefined,
      });
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
          .catch(() => {
            // Intentional: post-flow CDP cleanup. Any primary failure was
            // already surfaced; cleanup race conditions add no signal.
          });
      }
      if (fetchEnabled && !wc.isDestroyed()) {
        wc.debugger.sendCommand("Fetch.disable").catch(() => {
          // Intentional: post-flow CDP cleanup (see above).
        });
      }
    }

    if (navigationError) {
      if (ownerWindow) {
        sendToRenderer(ownerWindow, CHANNELS.WEBVIEW_OAUTH_LOOPBACK_STATUS, {
          panelId,
          phase: "error",
          message: `Navigation failed: ${(navigationError as Error).message}`,
        });
      }
      throw new AppError({
        code: "INTERNAL",
        message: `OAuth callback navigation failed: ${(navigationError as Error).message}`,
        context: { panelId },
        cause: navigationError,
      });
    }

    // Broadcast completion status
    if (ownerWindow) {
      sendToRenderer(ownerWindow, CHANNELS.WEBVIEW_OAUTH_LOOPBACK_STATUS, {
        panelId,
        phase: "completed",
      });
    }

    return { success: true, callbackUrl, loopbackRedirectUri, originalRedirectUri };
  };

  const handleReloadIgnoringCache = async (
    webContentsId: unknown,
    panelId: unknown
  ): Promise<void> => {
    if (typeof webContentsId !== "number" || typeof panelId !== "string") {
      throw new Error("Invalid arguments: webContentsId must be number, panelId must be string");
    }

    if (getWebviewDialogService().getPanelId(webContentsId) !== panelId) return;

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return;

    wc.reloadIgnoringCache();
  };

  /**
   * Current scroll offset, or `null` when it could not be read.
   *
   * The sentinel matters: a failed read and a page genuinely scrolled to the
   * top both used to answer `0`, so callers could not persist a real return-to-
   * top without also persisting every CDP failure (#12298).
   */
  const handleGetScrollPosition = async (webContentsId: unknown): Promise<number | null> => {
    if (typeof webContentsId !== "number") {
      throw new Error("Invalid arguments: webContentsId must be number");
    }

    if (!getWebviewDialogService().getPanelId(webContentsId)) return null;

    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return null;

    try {
      ensureAttached(wc);
      // Reads scroll position directly from Blink's layout tree without
      // touching the JS task queue — works on frozen pages where
      // executeJavaScript("window.scrollY") would hang indefinitely.
      const result = (await wc.debugger.sendCommand("Page.getLayoutMetrics")) as {
        cssLayoutViewport?: { pageY?: number };
      };
      const pageY = result?.cssLayoutViewport?.pageY;
      return typeof pageY === "number" && Number.isFinite(pageY) ? Math.round(pageY) : null;
    } catch (err) {
      const message = formatErrorMessage(err, "CDP getLayoutMetrics failed");
      const isExpected =
        message.includes("Target closed") ||
        message.includes("Inspected target navigated") ||
        message.includes("Cannot attach") ||
        message.includes("debugger is already attached");
      if (!isExpected) {
        console.warn(`[webview] getScrollPosition failed for id=${webContentsId}:`, message);
      }
      return null;
    }
  };

  const cleanups: Array<() => void> = [
    typedHandle(CHANNELS.WEBVIEW_SET_LIFECYCLE_STATE, handleSetLifecycleState),
    typedHandle(CHANNELS.WEBVIEW_REGISTER_PANEL, handleRegisterPanel),
    typedHandle(CHANNELS.WEBVIEW_DIALOG_RESPONSE, handleDialogResponse),
    typedHandle(CHANNELS.WEBVIEW_START_CONSOLE_CAPTURE, handleStartConsoleCapture),
    typedHandle(CHANNELS.WEBVIEW_STOP_CONSOLE_CAPTURE, handleStopConsoleCapture),
    typedHandle(CHANNELS.WEBVIEW_CLEAR_CONSOLE_CAPTURE, handleClearConsoleCapture),
    typedHandle(CHANNELS.WEBVIEW_GET_CONSOLE_PROPERTIES, handleGetConsoleProperties),
    // @ts-expect-error: result type contains {success} | null — pending migration to throw AppError. See #6020.
    typedHandle(CHANNELS.WEBVIEW_OAUTH_LOOPBACK, handleOAuthLoopback),
    typedHandle(CHANNELS.WEBVIEW_CANCEL_OAUTH_LOOPBACK, handleCancelOAuthLoopback),
    typedHandle(CHANNELS.WEBVIEW_RELOAD_IGNORING_CACHE, handleReloadIgnoringCache),
    typedHandle(CHANNELS.WEBVIEW_GET_SCROLL_POSITION, handleGetScrollPosition),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();

    // Clean up all sessions
    for (const wcId of sessions.keys()) {
      cleanupSession(wcId);
    }
  };
}
