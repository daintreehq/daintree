// Main-process cache of each renderer's terminal-rendering state (WebGL mode +
// terminal counts by refresh tier), keyed by webContents id. Populated by
// event-driven pushes from TerminalInstanceService — never live-pulled, because
// webContents.executeJavaScript hangs exactly under the slowdown this feature
// exists to diagnose (#10910, lesson #6354). Read synchronously by
// DiagnosticsCollector.collectWhySlowSnapshot. Entries are cleared on view
// eviction via forgetRendererTerminalDiagnostics (wired into ProjectViewManager),
// mirroring the Blink/ELU sample maps in ProcessMemoryMonitor.

import type {
  WhySlowRendererTerminalReport,
  WhySlowRendererTerminalSample,
} from "../../shared/types/whySlow.js";

/**
 * Age past which a cached sample is flagged `stale`. Pushes are event-driven, so
 * an old sample is still accurate (nothing changed) — this only surfaces "no
 * update in a while" as an FYI, it does not invalidate the data.
 */
export const RENDERER_TERMINAL_STALE_MS = 5 * 60 * 1000;

interface StoredSample {
  report: WhySlowRendererTerminalReport;
  timestamp: number;
}

const samples = new Map<number, StoredSample>();

/** Called by the IPC handler when a renderer pushes its terminal-rendering state. */
export function recordRendererTerminalDiagnostics(
  webContentsId: number,
  report: WhySlowRendererTerminalReport
): void {
  samples.set(webContentsId, { report, timestamp: Date.now() });
}

/** Drop a renderer's last sample (call from ProjectViewManager on view eviction). */
export function forgetRendererTerminalDiagnostics(webContentsId: number): void {
  samples.delete(webContentsId);
}

/** Read-only projection for the diagnostics snapshot / tests. */
export function getRendererTerminalDiagnosticsSamples(
  now = Date.now()
): WhySlowRendererTerminalSample[] {
  const out: WhySlowRendererTerminalSample[] = [];
  for (const [webContentsId, stored] of samples) {
    const ageMs = Math.max(0, now - stored.timestamp);
    out.push({
      webContentsId,
      webglMode: stored.report.webglMode,
      wantsWebgl: stored.report.wantsWebgl,
      terminalCount: stored.report.terminalCount,
      // Copy the nested map so callers can't mutate the cached sample.
      countsByTier: { ...stored.report.countsByTier },
      timestamp: stored.timestamp,
      ageMs,
      stale: ageMs > RENDERER_TERMINAL_STALE_MS,
    });
  }
  return out;
}

/** Test seam: clear all cached samples. */
export function _clearRendererTerminalDiagnosticsForTesting(): void {
  samples.clear();
}
