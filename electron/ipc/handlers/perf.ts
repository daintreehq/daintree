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
        },
      });

      // Correlate the per-view preload eval cost (#9770) with the originating
      // WebContentsView so ProjectViewManager can surface it alongside the
      // projectview.revival log. The duration is carried on the eval:end mark.
      if (record.mark === PERF_MARKS.PRELOAD_EVAL_END && webContentsId !== undefined) {
        const durationMs = (record.meta as { durationMs?: unknown } | undefined)?.durationMs;
        if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
          deps?.projectViewManager?.recordPreloadDuration(webContentsId, durationMs);
        }
      }
    }
  };

  ipcMain.on(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);

  return () => {
    ipcMain.removeListener(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);
  };
}
