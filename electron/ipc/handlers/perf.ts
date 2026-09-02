import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isPerformanceCaptureEnabled,
  appendPayload,
  rebaseRendererElapsedMs,
} from "../../utils/performance.js";
import { PERF_MARKS } from "../../../shared/perf/marks.js";
import type { RendererPerfFlushPayload } from "../../../shared/perf/marks.js";
import type { HandlerDependencies } from "../types.js";

export function registerPerfHandlers(deps?: HandlerDependencies): () => void {
  const handleFlush = (event: Electron.IpcMainEvent, payload: RendererPerfFlushPayload): void => {
    if (!isPerformanceCaptureEnabled()) return;
    if (!payload || !Array.isArray(payload.marks)) return;

    const { marks, rendererTimeOrigin, rendererT0 } = payload;
    const webContentsId = event.sender.isDestroyed() ? undefined : event.sender.id;
    // Per-window manager first (IPC handlers register once with the first
    // window's deps), so a second window's views resolve to their own project.
    const projectViewManager =
      webContentsId !== undefined
        ? (deps?.windowRegistry?.getByWebContentsId(webContentsId)?.services.projectViewManager ??
          deps?.projectViewManager)
        : undefined;
    const projectId =
      webContentsId !== undefined
        ? (projectViewManager?.getProjectIdForWebContents?.(webContentsId) ?? undefined)
        : undefined;
    // A preload reports exactly one eval:end mark per flush; guard so a
    // malformed payload with duplicates forwards the cost only once (#9770).
    let preloadRecorded = false;

    for (const record of marks) {
      if (typeof record.elapsedMs !== "number") continue;

      const rebasedMs = rebaseRendererElapsedMs(rendererTimeOrigin, rendererT0, record.elapsedMs);

      appendPayload({
        mark: record.mark,
        timestamp: record.timestamp,
        elapsedMs: rebasedMs,
        meta: {
          ...record.meta,
          source: "renderer",
          originalElapsedMs: record.elapsedMs,
          webContentsId,
          ...(projectId !== undefined ? { projectId } : {}),
        },
      });

      // Correlate the per-view preload eval cost (#9770) with the originating
      // WebContentsView so ProjectViewManager can surface it alongside the
      // projectview.revival log. The duration is carried on the eval:end mark.
      // IPC handlers are registered once globally with the first window's deps,
      // so resolve the per-window ProjectViewManager via the registry (keyed by
      // the sender's webContents id) before falling back to the static dep —
      // otherwise a second window's preload flush would silently no-op.
      if (
        record.mark === PERF_MARKS.PRELOAD_EVAL_END &&
        webContentsId !== undefined &&
        !preloadRecorded
      ) {
        const durationMs = (record.meta as { durationMs?: unknown } | undefined)?.durationMs;
        if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
          projectViewManager?.recordPreloadDuration(webContentsId, durationMs);
          preloadRecorded = true;
        }
      }
    }
  };

  ipcMain.on(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);

  return () => {
    ipcMain.removeListener(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);
  };
}
