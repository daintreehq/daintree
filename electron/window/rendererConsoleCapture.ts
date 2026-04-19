import type { WebContents } from "electron";
import { logError, logWarn } from "../utils/logger.js";

// Electron 41 console-message event details shape (string `level` since v35).
interface ConsoleMessageDetails {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  lineNumber: number;
  sourceId: string;
}

const RATE_WINDOW_MS = 5_000;
const RATE_MAX_PER_WINDOW = 5;

const attached = new WeakSet<WebContents>();
const rateState = new WeakMap<WebContents, Map<string, { count: number; resetAt: number }>>();

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
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count < RATE_MAX_PER_WINDOW) {
    entry.count++;
    return true;
  }
  return false;
}

export function attachRendererConsoleCapture(wc: WebContents): void {
  if (attached.has(wc)) return;

  wc.on("console-message", (_event, ...args: unknown[]) => {
    if (wc.isDestroyed()) return;

    const details = args[0] as ConsoleMessageDetails | undefined;
    if (!details || typeof details !== "object") return;

    const { level, message, lineNumber, sourceId } = details;
    if (level !== "warning" && level !== "error") return;

    const safeSourceId = typeof sourceId === "string" ? sourceId : "";
    const safeLineNumber = typeof lineNumber === "number" ? lineNumber : 0;

    if (!shouldAllow(wc, level, safeSourceId, safeLineNumber)) return;

    const context = {
      source: "Renderer",
      sourceId: safeSourceId,
      lineNumber: safeLineNumber,
      webContentsId: wc.id,
    };

    if (level === "error") {
      logError(message ?? "", undefined, context);
    } else {
      logWarn(message ?? "", context);
    }
  });

  attached.add(wc);
}

export function __resetRendererConsoleCaptureForTests(wc: WebContents): void {
  attached.delete(wc);
  rateState.delete(wc);
}
