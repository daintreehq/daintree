import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { CanopyEventMap } from "../../services/events.js";

const ALLOWED_RENDERER_EVENTS: ReadonlySet<keyof CanopyEventMap> = new Set(["action:dispatched"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeJsonSize(value: unknown): number | null {
  try {
    return JSON.stringify(value).length;
  } catch {
    return null;
  }
}

function normalizeActionDispatchedPayload(
  payload: unknown
): CanopyEventMap["action:dispatched"] | null {
  if (!isPlainObject(payload)) return null;

  const actionId = payload.actionId;
  if (typeof actionId !== "string" || !actionId.trim() || actionId.length > 200) return null;

  const source = payload.source;
  if (
    source !== "user" &&
    source !== "keybinding" &&
    source !== "menu" &&
    source !== "agent" &&
    source !== "context-menu"
  ) {
    return null;
  }

  const timestampRaw = payload.timestamp;
  const timestamp =
    typeof timestampRaw === "number" && Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

  const contextRaw = payload.context;
  const context: CanopyEventMap["action:dispatched"]["context"] = {};
  if (isPlainObject(contextRaw)) {
    if (typeof contextRaw.projectId === "string") context.projectId = contextRaw.projectId;
    if (typeof contextRaw.activeWorktreeId === "string") {
      context.activeWorktreeId = contextRaw.activeWorktreeId;
    }
    if (typeof contextRaw.focusedTerminalId === "string") {
      context.focusedTerminalId = contextRaw.focusedTerminalId;
    }
  }

  const args = payload.args;
  const argsSize = args === undefined ? 0 : safeJsonSize(args);
  const safeArgs =
    args === undefined
      ? undefined
      : argsSize === null
        ? { _redacted: "unserializable" }
        : argsSize > 2048
          ? { _redacted: "payload_too_large", size: argsSize }
          : args;

  return {
    actionId,
    args: safeArgs,
    source,
    context,
    timestamp,
  };
}

export function registerEventsHandlers(deps: HandlerDependencies): () => void {
  const { events } = deps;
  const handlers: Array<() => void> = [];

  const handleEventsEmit = async (
    _event: Electron.IpcMainInvokeEvent,
    eventType: string,
    payload: unknown
  ) => {
    if (!events) {
      console.warn("[IPC] Event bus not available, cannot emit event:", eventType);
      return;
    }

    if (!ALLOWED_RENDERER_EVENTS.has(eventType as keyof CanopyEventMap)) {
      console.warn("[IPC] Renderer attempted to emit disallowed event:", eventType);
      return;
    }

    if (eventType === "action:dispatched") {
      const normalized = normalizeActionDispatchedPayload(payload);
      if (!normalized) {
        console.warn("[IPC] Invalid action:dispatched payload from renderer");
        return;
      }
      events.emit("action:dispatched", normalized);
      return;
    }

    events.emit(eventType as keyof CanopyEventMap, payload as CanopyEventMap[keyof CanopyEventMap]);
  };
  ipcMain.handle(CHANNELS.EVENTS_EMIT, handleEventsEmit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENTS_EMIT));

  return () => handlers.forEach((cleanup) => cleanup());
}
