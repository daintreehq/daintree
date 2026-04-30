import { ipcMain, type WebContents } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  hasTelemetryPromptBeenShown,
  markTelemetryPromptShown,
  getTelemetryLevel,
  trackEvent,
} from "../../services/TelemetryService.js";
import {
  isTelemetryPreviewActive,
  setTelemetryPreviewActive,
  setTelemetryPreviewEnqueue,
} from "../../services/TelemetryPreviewBroadcaster.js";
import { ANALYTICS_EVENTS } from "../../../shared/config/telemetry.js";
import type {
  SanitizedTelemetryEvent,
  TelemetryPreviewState,
} from "../../../shared/types/ipc/telemetryPreview.js";
import { typedBroadcast, typedHandle } from "../utils.js";

const ALLOWED_EVENTS = new Set<string>(ANALYTICS_EVENTS);

// Module-level so the session preview state outlives handler re-registration
// in hot-reload and preserves enabled state across a single Daintree launch.
const previewSubscribers = new Map<WebContents, () => void>();
let pendingBatch: SanitizedTelemetryEvent[] = [];
let batchTimeout: NodeJS.Timeout | null = null;
const BATCH_WINDOW_MS = 50;
const MAX_BATCH_SIZE = 200;

function flushPreviewBatch(): void {
  if (batchTimeout) {
    clearTimeout(batchTimeout);
    batchTimeout = null;
  }
  if (pendingBatch.length === 0) return;

  const batch = pendingBatch;
  pendingBatch = [];

  for (const [webContents, destroyListener] of previewSubscribers.entries()) {
    if (webContents.isDestroyed()) {
      webContents.removeListener("destroyed", destroyListener);
      previewSubscribers.delete(webContents);
      continue;
    }
    try {
      for (let i = 0; i < batch.length; i += MAX_BATCH_SIZE) {
        const chunk = batch.slice(i, i + MAX_BATCH_SIZE);
        webContents.send(CHANNELS.TELEMETRY_PREVIEW_EVENT_BATCH, chunk);
      }
    } catch (error) {
      // Preview is best-effort — the batch for this subscriber is dropped and
      // won't be retried, but we keep the subscription so the next flush
      // window delivers cleanly once the renderer recovers.
      console.warn("[TelemetryPreview] Dropped preview batch for subscriber:", error);
    }
  }
}

function queuePreviewEvent(event: SanitizedTelemetryEvent): void {
  if (!isTelemetryPreviewActive()) return;
  pendingBatch.push(event);
  if (!batchTimeout) {
    batchTimeout = setTimeout(flushPreviewBatch, BATCH_WINDOW_MS);
  }
}

function broadcastPreviewState(): void {
  const state: TelemetryPreviewState = { active: isTelemetryPreviewActive() };
  typedBroadcast("telemetry:preview-state-changed", state);
}

export function registerTelemetryHandlers(): () => void {
  const cleanups: Array<() => void> = [];

  // Wire the broadcaster's enqueue function at handler-register time. This
  // is the single point where the service gets a direct callback into the
  // IPC layer without needing to import IPC modules itself.
  setTelemetryPreviewEnqueue(queuePreviewEvent);

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_GET, () => ({
      enabled: isTelemetryEnabled(),
      hasSeenPrompt: hasTelemetryPromptBeenShown(),
    }))
  );

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_SET_ENABLED, async (enabled: unknown) => {
      if (typeof enabled !== "boolean") return;
      await setTelemetryEnabled(enabled);
      typedBroadcast("privacy:telemetry-consent-changed", {
        level: getTelemetryLevel(),
        hasSeenPrompt: hasTelemetryPromptBeenShown(),
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_MARK_PROMPT_SHOWN, () => {
      markTelemetryPromptShown();
      typedBroadcast("privacy:telemetry-consent-changed", {
        level: getTelemetryLevel(),
        hasSeenPrompt: true,
      });
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_TRACK, (eventName: unknown, properties: unknown) => {
      if (typeof eventName !== "string" || !ALLOWED_EVENTS.has(eventName)) return;
      if (typeof properties !== "object" || properties === null || Array.isArray(properties))
        return;
      trackEvent(eventName, properties as Record<string, unknown>);
    })
  );

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_PREVIEW_GET_STATE, () => ({
      active: isTelemetryPreviewActive(),
    }))
  );

  cleanups.push(
    typedHandle(CHANNELS.TELEMETRY_PREVIEW_TOGGLE, (active: unknown) => {
      // Match the strict-boolean guard used by TELEMETRY_SET_ENABLED so a
      // buggy caller sending `"false"` doesn't coerce to truthy and flip
      // preview on.
      if (typeof active !== "boolean") {
        return { active: isTelemetryPreviewActive() };
      }
      const prev = isTelemetryPreviewActive();
      setTelemetryPreviewActive(active);
      // Turning preview off flushes whatever is pending so the final batch
      // arrives in order; subsequent events are ignored by queuePreviewEvent.
      if (!active) flushPreviewBatch();
      if (prev !== active) broadcastPreviewState();
      return { active };
    })
  );

  const handleSubscribe = (event: Electron.IpcMainEvent) => {
    const sender = event.sender;
    if (sender.isDestroyed()) return;
    if (previewSubscribers.has(sender)) return;

    const destroyListener = () => {
      previewSubscribers.delete(sender);
    };
    previewSubscribers.set(sender, destroyListener);
    sender.once("destroyed", destroyListener);
  };
  ipcMain.on(CHANNELS.TELEMETRY_PREVIEW_SUBSCRIBE, handleSubscribe);
  cleanups.push(() =>
    ipcMain.removeListener(CHANNELS.TELEMETRY_PREVIEW_SUBSCRIBE, handleSubscribe)
  );

  const handleUnsubscribe = (event: Electron.IpcMainEvent) => {
    const sender = event.sender;
    const destroyListener = previewSubscribers.get(sender);
    if (destroyListener) {
      sender.removeListener("destroyed", destroyListener);
      previewSubscribers.delete(sender);
    }
  };
  ipcMain.on(CHANNELS.TELEMETRY_PREVIEW_UNSUBSCRIBE, handleUnsubscribe);
  cleanups.push(() =>
    ipcMain.removeListener(CHANNELS.TELEMETRY_PREVIEW_UNSUBSCRIBE, handleUnsubscribe)
  );

  return () => {
    cleanups.forEach((c) => c());
    flushPreviewBatch();
    for (const [webContents, destroyListener] of previewSubscribers.entries()) {
      if (!webContents.isDestroyed()) {
        webContents.removeListener("destroyed", destroyListener);
      }
    }
    previewSubscribers.clear();
    pendingBatch = [];
    if (batchTimeout) {
      clearTimeout(batchTimeout);
      batchTimeout = null;
    }
    setTelemetryPreviewEnqueue(null);
  };
}
