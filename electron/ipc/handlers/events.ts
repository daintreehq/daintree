import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { CanopyEventMap } from "../../services/events.js";

const ALLOWED_RENDERER_EVENTS: ReadonlySet<keyof CanopyEventMap> = new Set(["action:dispatched"]);

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

    events.emit(eventType as keyof CanopyEventMap, payload as CanopyEventMap[keyof CanopyEventMap]);
  };
  ipcMain.handle(CHANNELS.EVENTS_EMIT, handleEventsEmit);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENTS_EMIT));

  return () => handlers.forEach((cleanup) => cleanup());
}
