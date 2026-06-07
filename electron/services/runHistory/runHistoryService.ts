// eager-import-allow: reads/writes the runHistory store key via store.get/set inside the persistence callbacks, invoked from runHistory IPC handlers (not at boot)
import type { RunHistoryRecord } from "../../../shared/types/ipc/runHistory.js";
import { CHANNELS } from "../../ipc/channels.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { store } from "../../store.js";
import { RunHistoryLog } from "./runHistoryLog.js";

/**
 * Process-global run-history singleton. Recipe and fleet runs originate from any
 * window's renderer, so the ring accumulates cross-window — a module-level
 * singleton, never per-window. The pure {@link RunHistoryLog} class lives in
 * `runHistoryLog.ts` (store-free, unit-testable); this thin wrapper wires it to
 * the `runHistory` store key, mirroring `forgeAuditService`.
 */
function readRecords(): unknown {
  // Defensive `?? {}`: the store default always supplies `runHistory`, but a
  // test harness mocking the store may not — readRecords must never throw.
  const config = (store.get("runHistory") as { records?: unknown } | undefined) ?? {};
  return config.records;
}

function saveRecords(records: RunHistoryRecord[]): void {
  store.set("runHistory", { records });
}

export const runHistoryLog = new RunHistoryLog(saveRecords, readRecords);

/**
 * Broadcast the current run-history snapshot to every live renderer via the
 * multiplexed `events:push` bus. Called after append/clear so all open windows
 * (and project views) update without a reload — the renderer subscribes through
 * `window.electron.events.on("run-history:update", ...)`.
 */
export function broadcastRunHistory(): void {
  broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
    name: "run-history:update",
    payload: runHistoryLog.getRecords(),
  });
}

/**
 * Replay the run-history snapshot to a single freshly-loaded view (cold start,
 * LRU restore, crash reload, DevTools refresh) so its renderer store is current
 * even if every prior push fired while a previous V8 context was alive. Wired
 * into `onViewReady` in `main.ts`, mirroring `PluginService.pushSnapshotTo`.
 */
export function pushRunHistorySnapshotTo(webContents: Electron.WebContents): void {
  if (webContents.isDestroyed()) return;
  try {
    webContents.send(CHANNELS.EVENTS_PUSH, {
      name: "run-history:update",
      payload: runHistoryLog.getRecords(),
    });
  } catch {
    // Silently ignore send failures during window initialization/disposal.
  }
}
