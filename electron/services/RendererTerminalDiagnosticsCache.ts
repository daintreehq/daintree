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
import type { RendererTerminalBufferCounts } from "../../shared/types/memoryAccounting.js";

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

/** A renderer's last buffer line counts, kept apart from the rendering state. */
export interface RendererTerminalBufferSample {
  /** When the renderer read the counts (not when main received them). */
  sampledAt: number;
  terminals: RendererTerminalBufferCounts[];
}

// Buffer counts are timestamped independently: a routine tier/WebGL push
// carries none and must not make an old buffer reading look current.
const bufferSamples = new Map<number, RendererTerminalBufferSample>();

// Callers waiting on a requested buffer report, by webContents id.
const bufferWaiters = new Map<number, Set<() => void>>();

/** Called by the IPC handler when a renderer pushes its terminal-rendering state. */
export function recordRendererTerminalDiagnostics(
  webContentsId: number,
  report: WhySlowRendererTerminalReport
): void {
  const { bufferMemory, ...rendering } = report;
  samples.set(webContentsId, { report: rendering, timestamp: Date.now() });
  if (!bufferMemory) return;
  // Replaced whole, so terminals the renderer no longer holds drop out.
  bufferSamples.set(webContentsId, {
    sampledAt: bufferMemory.sampledAt,
    terminals: bufferMemory.terminals.map((t) => ({ ...t })),
  });
  const waiters = bufferWaiters.get(webContentsId);
  if (waiters) {
    bufferWaiters.delete(webContentsId);
    for (const resolve of waiters) resolve();
  }
}

/** Drop a renderer's last sample (call from ProjectViewManager on view eviction). */
export function forgetRendererTerminalDiagnostics(webContentsId: number): void {
  samples.delete(webContentsId);
  bufferSamples.delete(webContentsId);
  const waiters = bufferWaiters.get(webContentsId);
  if (waiters) {
    bufferWaiters.delete(webContentsId);
    for (const resolve of waiters) resolve();
  }
}

/** The renderer's last buffer counts, or undefined when it never reported any. */
export function getRendererTerminalBufferSample(
  webContentsId: number
): RendererTerminalBufferSample | undefined {
  return bufferSamples.get(webContentsId);
}

/**
 * Resolve when `webContentsId` next reports buffer counts, is forgotten, or
 * `timeoutMs` passes — whichever comes first. Never rejects. Register before
 * sending the request, so a synchronous reply can't be missed.
 */
export function waitForRendererTerminalBufferSample(
  webContentsId: number,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve) => {
    let set = bufferWaiters.get(webContentsId);
    if (!set) {
      set = new Set();
      bufferWaiters.set(webContentsId, set);
    }
    const waiters = set;
    const timer = setTimeout(() => {
      waiters.delete(done);
      if (waiters.size === 0 && bufferWaiters.get(webContentsId) === waiters) {
        bufferWaiters.delete(webContentsId);
      }
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.add(done);
  });
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
  bufferSamples.clear();
  bufferWaiters.clear();
}
