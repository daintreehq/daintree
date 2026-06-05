import { contentTracing } from "electron";

/**
 * Optional GPU/compositor trace capture for the cold-start perf harness.
 *
 * `contentTracing` only runs inside the app's own main process — the harness
 * subprocess cannot drive it remotely — so tracing self-starts here, gated by
 * `DAINTREE_PERF_TRACE=1` plus a `DAINTREE_PERF_TRACE_FILE` output path. Both
 * are injected by `packagedLaunch.ts` when the cold-start harness runs with
 * `--trace`. Tracing adds measurable overhead, so it is deliberately kept
 * orthogonal to (and off for) normal `DAINTREE_PERF_CAPTURE` runs.
 *
 * Output is Chromium's JSON Trace Event Format, written to the `.json` path —
 * directly droppable into https://ui.perfetto.dev with no conversion.
 */

// First-frame compositor pipeline: blink builds the layer tree, cc rasterizes
// and commits, viz aggregates/swaps, gpu drives the hardware, toplevel/startup
// capture event-loop tasks and browser/renderer launch phases.
const TRACE_CATEGORIES = ["viz", "gpu", "cc", "blink", "toplevel", "startup"];

type TraceState = "idle" | "recording" | "stopped";
let state: TraceState = "idle";

function isTraceEnabled(): string | null {
  if (process.env.DAINTREE_PERF_TRACE !== "1") return null;
  const file = process.env.DAINTREE_PERF_TRACE_FILE;
  return file && file.length > 0 ? file : null;
}

/**
 * Starts `contentTracing` when enabled. Must be called after `app.ready`
 * (child processes are only traceable once bootstrapped). No-op when the env
 * gate is unset. Never throws — tracing must not be able to fail app startup.
 */
export async function startPerformanceTraceIfEnabled(): Promise<void> {
  if (state !== "idle") return;
  if (!isTraceEnabled()) return;

  try {
    await contentTracing.startRecording({
      recording_mode: "record-until-full",
      included_categories: TRACE_CATEGORIES,
      excluded_categories: ["*"],
    });
    state = "recording";
  } catch (error) {
    state = "stopped";
    console.warn("[perf-trace] startRecording failed:", error);
  }
}

/**
 * Stops `contentTracing` and writes the trace to `DAINTREE_PERF_TRACE_FILE`.
 * Idempotent — safe to call from `will-quit` even if tracing never started or
 * was already stopped. Awaits `stopRecording` to completion so the trace file
 * is fully flushed before the app exits (the file truncates otherwise). Never
 * throws.
 */
export async function stopPerformanceTraceIfActive(): Promise<void> {
  if (state !== "recording") return;
  state = "stopped";

  const file = isTraceEnabled();
  if (!file) return;

  try {
    await contentTracing.stopRecording(file);
    console.log(`[perf-trace] trace written to ${file}`);
  } catch (error) {
    console.warn("[perf-trace] stopRecording failed:", error);
  }
}
