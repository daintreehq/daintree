import type { WebContents } from "electron";
import { logError, logWarn } from "../utils/logger.js";
import type { PluginConsoleEntry } from "../../shared/types/pluginPanelCapture.js";

// Electron 42 `console-message` details. They ride on the event object itself;
// the positional `(level, message, line, sourceId)` arguments that follow are
// the deprecated numeric form.
interface ConsoleMessageDetails {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  lineNumber: number;
  sourceId: string;
}

type ConsoleMessageHandler = (event: unknown, ...args: unknown[]) => void;

const RATE_WINDOW_MS = 5_000;
const RATE_MAX_PER_WINDOW = 5;
// Above this size, expired entries are swept before inserting — project-view
// WebContents live for days and the map is otherwise insert-only.
const RATE_SWEEP_THRESHOLD = 256;

/** Plugin warnings and errors kept per view for `plugin.capturePanel`. */
export const PLUGIN_CONSOLE_BUFFER_MAX = 100;
export const PLUGIN_CONSOLE_MESSAGE_MAX_CHARS = 2_000;
const PLUGIN_SOURCE_PREFIX = "plugin://";

const attached = new WeakSet<WebContents>();
const handlers = new WeakMap<WebContents, ConsoleMessageHandler>();
const navigationHandlers = new WeakMap<WebContents, () => void>();
const rateState = new WeakMap<WebContents, Map<string, { count: number; resetAt: number }>>();
const pluginBuffers = new WeakMap<WebContents, PluginConsoleEntry[]>();

function normalizeSourceId(sourceId: string): string {
  const queryIdx = sourceId.indexOf("?");
  return queryIdx >= 0 ? sourceId.slice(0, queryIdx) : sourceId;
}

function shouldAllow(
  wc: WebContents,
  level: string,
  sourceId: string,
  lineNumber: number
): boolean {
  let map = rateState.get(wc);
  if (!map) {
    map = new Map();
    rateState.set(wc, map);
  }
  const key = `${level}:${normalizeSourceId(sourceId)}:${lineNumber}`;
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now >= entry.resetAt) {
    if (map.size >= RATE_SWEEP_THRESHOLD) {
      for (const [k, v] of map) {
        if (now >= v.resetAt) map.delete(k);
      }
    }
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count < RATE_MAX_PER_WINDOW) {
    entry.count++;
    return true;
  }
  return false;
}

function isDetails(value: unknown): value is ConsoleMessageDetails {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { level?: unknown }).level === "string"
  );
}

function bufferPluginMessage(
  wc: WebContents,
  level: "warning" | "error",
  message: string,
  sourceId: string,
  lineNumber: number
): void {
  if (!sourceId.startsWith(PLUGIN_SOURCE_PREFIX)) return;
  let buffer = pluginBuffers.get(wc);
  if (!buffer) {
    buffer = [];
    pluginBuffers.set(wc, buffer);
  }
  buffer.push({
    level,
    message:
      message.length > PLUGIN_CONSOLE_MESSAGE_MAX_CHARS
        ? `${message.slice(0, PLUGIN_CONSOLE_MESSAGE_MAX_CHARS)}…`
        : message,
    sourceId,
    lineNumber,
    timestamp: Date.now(),
  });
  if (buffer.length > PLUGIN_CONSOLE_BUFFER_MAX)
    buffer.splice(0, buffer.length - PLUGIN_CONSOLE_BUFFER_MAX);
}

export function attachRendererConsoleCapture(wc: WebContents): void {
  if (attached.has(wc)) return;

  const handler: ConsoleMessageHandler = (event, ...args) => {
    if (wc.isDestroyed()) return;

    const details = isDetails(event) ? event : isDetails(args[0]) ? args[0] : undefined;
    if (!details) return;

    const { level, message, lineNumber, sourceId } = details;
    if (level !== "warning" && level !== "error") return;

    const safeMessage = typeof message === "string" ? message : "";
    const safeSourceId = typeof sourceId === "string" ? sourceId : "";
    const safeLineNumber = typeof lineNumber === "number" ? lineNumber : 0;

    // Kept before the log rate limit: an agent reading a view's errors needs
    // the newest ones, which a flood would otherwise be the first to lose.
    bufferPluginMessage(wc, level, safeMessage, safeSourceId, safeLineNumber);

    if (!shouldAllow(wc, level, safeSourceId, safeLineNumber)) return;

    const context = {
      source: "Renderer",
      sourceId: safeSourceId,
      lineNumber: safeLineNumber,
      webContentsId: wc.id,
    };

    if (level === "error") {
      logError(safeMessage, undefined, context);
    } else {
      logWarn(safeMessage, context);
    }
  };

  // A reload is a new document: the previous one's plugin errors are not the
  // views now on screen.
  const onNavigate = () => {
    pluginBuffers.delete(wc);
  };

  wc.on("console-message", handler);
  wc.on("did-navigate", onNavigate);

  attached.add(wc);
  handlers.set(wc, handler);
  navigationHandlers.set(wc, onNavigate);
}

/** The view's recent warnings and errors logged from `plugin://` sources, oldest first. */
export function getRecentPluginConsoleMessages(wc: WebContents): PluginConsoleEntry[] {
  return [...(pluginBuffers.get(wc) ?? [])];
}

export function detachRendererConsoleCapture(wc: WebContents): void {
  const handler = handlers.get(wc);
  if (handler) {
    try {
      wc.removeListener("console-message", handler);
    } catch {
      // wc may already be torn down — removeListener is best-effort
    }
    handlers.delete(wc);
  }
  const onNavigate = navigationHandlers.get(wc);
  if (onNavigate) {
    try {
      wc.removeListener("did-navigate", onNavigate);
    } catch {
      // same as above
    }
    navigationHandlers.delete(wc);
  }
  attached.delete(wc);
  rateState.delete(wc);
  pluginBuffers.delete(wc);
}

export function __resetRendererConsoleCaptureForTests(wc: WebContents): void {
  attached.delete(wc);
  handlers.delete(wc);
  navigationHandlers.delete(wc);
  rateState.delete(wc);
  pluginBuffers.delete(wc);
}
