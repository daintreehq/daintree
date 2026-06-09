import { ipcMain, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { EVENT_INSPECTOR_METHOD_CHANNELS } from "./eventInspector.preload.js";
import type { HandlerDependencies } from "../types.js";
import type { FilterOptions } from "../../services/EventBuffer.js";
import type { EventFilterOptions, EventRecord } from "../../../shared/types/index.js";

const subscribedWebContents = new Map<WebContents, () => void>();
let eventBufferUnsubscribe: (() => void) | null = null;
let pendingBatch: EventRecord[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 200;

// Ring capacity while the inspector is open vs. idle. The buffer live-streams
// new events via onRecord, so a small idle ring is enough; we raise the cap to
// retain a fuller snapshot only while someone is watching.
const SUBSCRIBED_BUFFER_SIZE = 1000;
const IDLE_BUFFER_SIZE = 100;

export function registerEventInspectorHandlers(deps: HandlerDependencies): () => void {
  const namespace = defineIpcNamespace({
    name: "eventInspector",
    ops: {
      getEvents: op(EVENT_INSPECTOR_METHOD_CHANNELS.getEvents, async () => {
        if (!deps.eventBuffer) {
          return [];
        }
        return deps.eventBuffer.getAll();
      }),
      getFiltered: op(
        EVENT_INSPECTOR_METHOD_CHANNELS.getFiltered,
        async (filters: EventFilterOptions) => {
          if (!deps.eventBuffer) {
            return [];
          }
          // Handler accepts the broader shared type; EventBuffer enforces stricter typing internally.
          return deps.eventBuffer.getFiltered(filters as FilterOptions);
        }
      ),
      clear: op(EVENT_INSPECTOR_METHOD_CHANNELS.clear, async () => {
        if (!deps.eventBuffer) {
          return;
        }
        deps.eventBuffer.clear();
      }),
    },
  });

  const cleanups: Array<() => void> = [namespace.register()];

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
      deps.eventBuffer?.setMaxSize(IDLE_BUFFER_SIZE);
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
        deps.eventBuffer?.setMaxSize(IDLE_BUFFER_SIZE);
      }
    };

    subscribedWebContents.set(sender, destroyListener);
    sender.once("destroyed", destroyListener);

    if (!eventBufferUnsubscribe && deps.eventBuffer) {
      // First subscriber: retain a fuller snapshot while the inspector is open.
      deps.eventBuffer.setMaxSize(SUBSCRIBED_BUFFER_SIZE);
      eventBufferUnsubscribe = deps.eventBuffer.onRecord(queueEvent);
    }
  };
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, handleSubscribe);
  cleanups.push(() => ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, handleSubscribe));

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
      deps.eventBuffer?.setMaxSize(IDLE_BUFFER_SIZE);
    }
  };
  ipcMain.on(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, handleUnsubscribe);
  cleanups.push(() =>
    ipcMain.removeListener(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, handleUnsubscribe)
  );

  return () => {
    cleanups.forEach((cleanup) => cleanup());

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
