import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import {
  isPerformanceCaptureEnabled,
  appendPayload,
  rebaseRendererElapsedMs,
} from "../../utils/performance.js";
import type { RendererPerfFlushPayload } from "../../../shared/perf/marks.js";

export function registerPerfHandlers(): () => void {
  const handleFlush = (_event: Electron.IpcMainEvent, payload: RendererPerfFlushPayload): void => {
    if (!isPerformanceCaptureEnabled()) return;
    if (!payload || !Array.isArray(payload.marks)) return;

    const { marks, rendererTimeOrigin, rendererT0 } = payload;

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
        },
      });
    }
  };

  ipcMain.on(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);

  return () => {
    ipcMain.removeListener(CHANNELS.PERF_FLUSH_RENDERER_MARKS, handleFlush);
  };
}
