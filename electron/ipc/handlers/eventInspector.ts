import type { WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { EVENT_INSPECTOR_METHOD_CHANNELS } from "./eventInspector.preload.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { ClientEndpoint, Disposable } from "../endpoint.js";
import { onWithContext } from "../utils.js";
import type { FilterOptions } from "../../services/EventBuffer.js";
import type { EventFilterOptions, EventRecord } from "../../../shared/types/index.js";

const subscribedWebContents = new Map<WebContents, () => void>();
// Views attached over a link have no WebContents here; they are keyed by
// their endpoint and dropped when it closes.
const subscribedEndpoints = new Map<ClientEndpoint, Disposable>();
let eventBufferUnsubscribe: (() => void) | null = null;
let pendingBatch: EventRecord[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 200;

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

    for (const [endpoint, closeListener] of subscribedEndpoints.entries()) {
      if (endpoint.isClosed()) {
        closeListener.dispose();
        subscribedEndpoints.delete(endpoint);
        continue;
      }
      try {
        for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
          const chunk = batch.slice(i, i + MAX_BATCH_SIZE);
          endpoint.send({
            type: "event",
            channel: CHANNELS.EVENT_INSPECTOR_EVENT_BATCH,
            args: [chunk],
          });
        }
      } catch (error) {
        console.warn(
          "[EventInspector] Failed to send event batch to endpoint, keeping subscription:",
          error
        );
      }
    }

    releaseBufferIfIdle();
  };

  const hasSubscribers = () => subscribedWebContents.size > 0 || subscribedEndpoints.size > 0;

  const releaseBufferIfIdle = () => {
    if (!hasSubscribers() && eventBufferUnsubscribe) {
      eventBufferUnsubscribe();
      eventBufferUnsubscribe = null;
    }
  };

  const ensureBufferSubscription = () => {
    if (!eventBufferUnsubscribe && deps.eventBuffer) {
      eventBufferUnsubscribe = deps.eventBuffer.onRecord(queueEvent);
    }
  };

  const subscribeEndpoint = (endpoint: ClientEndpoint) => {
    if (endpoint.isClosed() || subscribedEndpoints.has(endpoint)) return;
    subscribedEndpoints.set(
      endpoint,
      endpoint.onClose(() => {
        subscribedEndpoints.delete(endpoint);
        releaseBufferIfIdle();
      })
    );
    ensureBufferSubscription();
  };

  const unsubscribeEndpoint = (endpoint: ClientEndpoint) => {
    const closeListener = subscribedEndpoints.get(endpoint);
    if (closeListener) {
      closeListener.dispose();
      subscribedEndpoints.delete(endpoint);
    }
    releaseBufferIfIdle();
  };

  const queueEvent = (record: EventRecord) => {
    pendingBatch.push(record);
    if (!batchTimeout) {
      batchTimeout = setTimeout(flushBatch, BATCH_WINDOW_MS);
    }
  };

  const handleSubscribe = (ctx: IpcContext) => {
    if (ctx.event === null) {
      subscribeEndpoint(ctx.endpoint);
      return;
    }
    const sender = ctx.event.sender;
    if (sender.isDestroyed()) return;

    if (subscribedWebContents.has(sender)) {
      return;
    }

    const destroyListener = () => {
      subscribedWebContents.delete(sender);
      releaseBufferIfIdle();
    };

    subscribedWebContents.set(sender, destroyListener);
    sender.once("destroyed", destroyListener);

    ensureBufferSubscription();
  };
  cleanups.push(onWithContext(CHANNELS.EVENT_INSPECTOR_SUBSCRIBE, handleSubscribe));

  const handleUnsubscribe = (ctx: IpcContext) => {
    if (ctx.event === null) {
      unsubscribeEndpoint(ctx.endpoint);
      return;
    }
    const sender = ctx.event.sender;
    const destroyListener = subscribedWebContents.get(sender);

    if (destroyListener) {
      sender.removeListener("destroyed", destroyListener);
      subscribedWebContents.delete(sender);
    }

    releaseBufferIfIdle();
  };
  cleanups.push(onWithContext(CHANNELS.EVENT_INSPECTOR_UNSUBSCRIBE, handleUnsubscribe));

  return () => {
    cleanups.forEach((cleanup) => cleanup());

    flushBatch();

    for (const [webContents, destroyListener] of subscribedWebContents.entries()) {
      if (!webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
      }
    }
    subscribedWebContents.clear();
    for (const closeListener of subscribedEndpoints.values()) closeListener.dispose();
    subscribedEndpoints.clear();

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
