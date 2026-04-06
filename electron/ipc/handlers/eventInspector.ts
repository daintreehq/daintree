import { ipcMain, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import type { HandlerDependencies } from "../types.js";
import type { FilterOptions as EventFilterOptions } from "../../services/EventBuffer.js";
import type { EventRecord } from "../../../shared/types/index.js";

const subscribedWebContents = new Map<WebContents, () => void>();
let eventBufferUnsubscribe: (() => void) | null = null;
let pendingBatch: EventRecord[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 200;

export function registerEventInspectorHandlers(deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleEventInspectorGetEvents = async () => {
    if (!deps.eventBuffer) {
      return [];
    }
    return deps.eventBuffer.getAll();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_EVENTS, handleEventInspectorGetEvents);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_EVENTS));

  const handleEventInspectorGetFiltered = async (
    _event: Electron.IpcMainInvokeEvent,
    filters: EventFilterOptions
  ) => {
    if (!deps.eventBuffer) {
      return [];
    }
    return deps.eventBuffer.getFiltered(filters);
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_GET_FILTERED, handleEventInspectorGetFiltered);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_GET_FILTERED));

  const handleEventInspectorClear = async () => {
    if (!deps.eventBuffer) {
      return;
    }
    deps.eventBuffer.clear();
  };
  ipcMain.handle(CHANNELS.EVENT_INSPECTOR_CLEAR, handleEventInspectorClear);
  handlers.push(() => ipcMain.removeHandler(CHANNELS.EVENT_INSPECTOR_CLEAR));

  const flushBatch = () => {
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }

    if (pendingBatch.length === 0) return;

    const batch = pendingBatch;
    pendingBatch = [];

    for (const [webContents, destroyListener] of subscribedWebContents.entries()) {
      if (webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
        subscribedWebContents.delete(webContents);
        continue;
      }
      try {
        for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
          const chunk = batch.slice(i, i + MAX_BATCH_SIZE);
          webContents.send(CHANNELS.EVENT_INSPECTOR_EVENT_BATCH, chunk);
        }
      } catch (error) {
        console.warn(
          "[EventInspector] Failed to send event batch to renderer, keeping subscription:",
          error
        );
      }
    }

    if (subscribedWebContents.size === 0 && eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };

  const queueEvent = (record: EventRecord) => {
    pendingBatch.push(record);
    if (!batchTimeout) {
      batchTimeout = setTimeout(flushBatch, BATCH_WINDOW_MS);
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

    if (!eventBufferUnsubscribe && deps.eventBuffer) {
      eventBufferUnsubscribe = deps.eventBuffer.onRecord(queueEvent);
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

    flushBatch();

    for (const [webContents, destroyListener] of subscribedWebContents.entries()) {
      if (!webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
      }
    }
    subscribedWebContents.clear();

    pendingBatch = [];
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }

    if (eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };
}
