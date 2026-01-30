import { ipcMain, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { FilterOptions as EventFilterOptions } from "../../services/EventBuffer.js";
import type { EventRecord } from "../../../shared/types/index.js";

const subscribedWebContents = new Map<WebContents, () => void>();
let eventBufferUnsubscribe: (() => void) | null = null;

export function registerEventInspectorHandlers(deps: HandlerDependencies): () => void {
  const { eventBuffer } = deps;
  const handlers: Array<() => void> = [];

  const handleEventInspectorGetEvents = async () => {
    if (!eventBuffer) {
      return [];
    }
    return eventBuffer.getAll();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_EVENTS, handleEventInspectorGetEvents);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_EVENTS));

  const handleEventInspectorGetFiltered = async (
    _event: Electron.IpcMainInvokeEvent,
    filters: EventFilterOptions
  ) => {
    if (!eventBuffer) {
      return [];
    }
    return eventBuffer.getFiltered(filters);
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_FILTERED, handleEventInspectorGetFiltered);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_FILTERED));

  const handleEventInspectorClear = async () => {
    if (!eventBuffer) {
      return;
    }
    eventBuffer.clear();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_CLEAR, handleEventInspectorClear);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_CLEAR));

  const broadcastEvent = (record: EventRecord) => {
    for (const [webContents, destroyListener] of subscribedWebContents.entries()) {
      if (webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
        subscribedWebContents.delete(webContents);
        continue;
      }
      try {
        webContents.send(CHANNELS.EVENT_INSPECTOR_EVENT, record);
      } catch (error) {
        console.warn(
          "[EventInspector] Failed to send event to renderer, keeping subscription:",
          error
        );
      }
    }

    if (subscribedWebContents.size === 0 && eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };

  const handleSubscribe = (event: Electron.IpcMainEvent) => {
    const sender = event.sender;
    if (sender.isDestroyed()) return;

    if (subscribedWebContents.has(sender)) {
      return;
    }

    const destroyListener = () => {
      subscribedWebContents.delete(sender);
      if (subscribedWebContents.size === 0 && eventBufferUnsubscribe) {
        eventBufferUnsubscribe();
        eventBufferUnsubscribe = null;
      }
    };

    subscribedWebContents.set(sender, destroyListener);
    sender.once("destroyed", destroyListener);

    if (!eventBufferUnsubscribe && eventBuffer) {
      eventBufferUnsubscribe = eventBuffer.onRecord(broadcastEvent);
    }
  };
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, handleSubscribe);
  handlers.push(() => ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, handleSubscribe));

  const handleUnsubscribe = (event: Electron.IpcMainEvent) => {
    const sender = event.sender;
    const destroyListener = subscribedWebContents.get(sender);

    if (destroyListener) {
      sender.removeListener("destroyed", destroyListener);
      subscribedWebContents.delete(sender);
    }

    if (subscribedWebContents.size === 0 && eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, handleUnsubscribe);
  handlers.push(() =>
    ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, handleUnsubscribe)
  );

  return () => {
    handlers.forEach((cleanup) => cleanup());

    for (const [webContents, destroyListener] of subscribedWebContents.entries()) {
      if (!webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
      }
    }
    subscribedWebContents.clear();

    if (eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };
}
