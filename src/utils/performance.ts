import type { PerfMarkName } from "@shared/perf/marks";
import { isDaintreeEnvEnabled } from "./env";

type PerfRecord = {
  mark: PerfMarkName | string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
};

declare global {
  interface Window {
    __DAINTREE_PERF_MARKS__?: PerfRecord[];
  }
}

export const RENDERER_T0 = typeof performance !== "undefined" ? performance.now() : Date.now();

// Steady-state marks (echo-latency samples, memory samples, CLS deltas) land
// in the window buffer for the whole session; without a cap a capture run
// left open for hours grows it unboundedly. Oldest entries drop first — the
// periodic flush below normally drains long before the cap matters.
const MAX_BUFFERED_PERF_MARKS = 2000;

export function isRendererPerfCaptureEnabled(): boolean {
  return isDaintreeEnvEnabled("DAINTREE_PERF_CAPTURE");
}

export function isRendererPerfCaptureActive(): boolean {
  return (
    isRendererPerfCaptureEnabled() ||
    (typeof window !== "undefined" && Array.isArray(window.__DAINTREE_PERF_MARKS__))
  );
}

export function markRendererPerformance(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): void {
  if (typeof window === "undefined") return;

  const captureEnabled = isRendererPerfCaptureEnabled();
  if (!isRendererPerfCaptureActive()) {
    return;
  }

  const elapsedMs =
    typeof performance !== "undefined" ? performance.now() - RENDERER_T0 : Date.now() - RENDERER_T0;

  const payload: PerfRecord = {
    mark,
    timestamp: new Date().toISOString(),
    elapsedMs,
    meta,
  };

  if (!window.__DAINTREE_PERF_MARKS__) {
    window.__DAINTREE_PERF_MARKS__ = [];
  }

  window.__DAINTREE_PERF_MARKS__.push(payload);
  if (window.__DAINTREE_PERF_MARKS__.length > MAX_BUFFERED_PERF_MARKS) {
    window.__DAINTREE_PERF_MARKS__.splice(
      0,
      window.__DAINTREE_PERF_MARKS__.length - MAX_BUFFERED_PERF_MARKS
    );
  }

  if (captureEnabled) {
    // Land the mark on the DevTools Performance timeline (User Timing track)
    // so capture-run events line up against frames and long tasks instead of
    // living only in the window buffer.
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      try {
        performance.mark(String(mark), meta ? { detail: meta } : undefined);
      } catch {
        // Non-cloneable meta — the buffer entry above still records it.
      }
    }
    // DevTools-only perf trail for `DAINTREE_PERF_CAPTURE`; intentionally
    // bypasses the IPC logger to keep the breadcrumb visible in-page.
    // eslint-disable-next-line no-console
    console.debug("[perf]", payload.mark, payload.meta ?? {});
  }
}

/**
 * Drain the in-renderer perf buffer to the main process.
 *
 * The buffer is filled by `markRendererPerformance` and flushed by callers at
 * known boundaries (today: `HYDRATE_COMPLETE` in `stateHydration/index.ts` and
 * the renderer-side first-interactive hand-off in `removeStartupSkeleton`).
 * Anything emitted between those boundaries — notably `renderer_cls_final` —
 * stays in the buffer otherwise, because `state hydration` clears the array
 * after its own flush and no subsequent flush exists.
 *
 * Safe to call without a capture run; returns early when `DAINTREE_PERF_CAPTURE`
 * is unset or the perf bridge is missing (preload not yet ready).
 */
export function flushPendingPerfMarks(): void {
  if (typeof window === "undefined") return;
  if (!isRendererPerfCaptureEnabled()) return;
  const bridge = window.electron?.perf;
  if (!bridge?.flushMarks) return;

  const marks = window.__DAINTREE_PERF_MARKS__ ?? [];
  bridge.flushMarks({
    marks,
    rendererTimeOrigin: typeof performance !== "undefined" ? performance.timeOrigin : 0,
    rendererT0: RENDERER_T0,
  });
  window.__DAINTREE_PERF_MARKS__ = [];
}

/**
 * Keep draining the perf buffer after first-interactive. Without this, the
 * boundary flushes (HYDRATE_COMPLETE, first-interactive) are the last drain
 * of the session — steady-state marks emitted afterwards never reach the
 * NDJSON capture and just accumulate in the window buffer. No-op unless
 * `DAINTREE_PERF_CAPTURE` is set; empty intervals skip the IPC round trip.
 */
export function startSteadyStatePerfFlush(intervalMs = 15000): () => void {
  if (typeof window === "undefined" || !isRendererPerfCaptureEnabled()) {
    return () => {};
  }
  const timer = window.setInterval(() => {
    if ((window.__DAINTREE_PERF_MARKS__?.length ?? 0) === 0) return;
    flushPendingPerfMarks();
  }, intervalMs);
  return () => {
    window.clearInterval(timer);
  };
}

// E2E-only mark injector so a Playwright spec can drop its own marks (e.g. the
// nonce-painted probes of the switch benchmark) into the same NDJSON stream as
// the app's. Gated on the preload-injected E2E flag exactly like the terminal
// introspection bridges in TerminalInstanceService, so it never attaches in a
// production session.
if (typeof window !== "undefined" && window.__DAINTREE_E2E_MODE__ === true) {
  window.__daintreeMarkPerf = (mark: string, meta?: Record<string, unknown>): void => {
    markRendererPerformance(mark, meta);
    // A probe mark is read by the harness right away; the steady-state flush
    // would hold it for up to 15 s.
    flushPendingPerfMarks();
  };
}

export function startRendererSpan(
  mark: PerfMarkName | string,
  meta?: Record<string, unknown>
): () => void {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  markRendererPerformance(`${mark}:start`, meta);

  return () => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    markRendererPerformance(`${mark}:end`, {
      ...(meta ?? {}),
      durationMs: now - startedAt,
    });
  };
}

export async function withRendererSpan<T>(
  mark: PerfMarkName | string,
  task: () => Promise<T>,
  meta?: Record<string, unknown>
): Promise<T> {
  const done = startRendererSpan(mark, meta);
  try {
    return await task();
  } finally {
    done();
  }
}

export function startRendererMemoryMonitor(intervalMs = 15000): () => void {
  if (typeof window === "undefined" || !isRendererPerfCaptureEnabled()) {
    return () => {};
  }

  const timer = window.setInterval(() => {
    const perfWithMemory = performance as Performance & {
      memory?: {
        usedJSHeapSize: number;
        totalJSHeapSize: number;
        jsHeapSizeLimit: number;
      };
    };
    const memory = perfWithMemory.memory;
    if (!memory) return;

    markRendererPerformance("renderer_memory_sample", {
      usedJsHeapBytes: memory.usedJSHeapSize,
      totalJsHeapBytes: memory.totalJSHeapSize,
      jsHeapLimitBytes: memory.jsHeapSizeLimit,
    });
  }, intervalMs);

  return () => {
    window.clearInterval(timer);
  };
}
