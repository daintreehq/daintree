import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tracing = vi.hoisted(() => ({
  startRecording: vi.fn(async () => {}),
  stopRecording: vi.fn(async (_file?: string) => "trace.json"),
}));

vi.mock("electron", () => ({
  contentTracing: tracing,
}));

// Fresh module per test so the module-level trace state machine resets.
async function loadModule() {
  vi.resetModules();
  return import("../performanceTrace.js");
}

const ORIGINAL_ENV = { ...process.env };

describe("performanceTrace", () => {
  beforeEach(() => {
    tracing.startRecording.mockClear();
    tracing.stopRecording.mockClear();
    delete process.env.DAINTREE_PERF_TRACE;
    delete process.env.DAINTREE_PERF_TRACE_FILE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("does nothing when the env gate is unset", async () => {
    const mod = await loadModule();
    await mod.startPerformanceTraceIfEnabled();
    await mod.stopPerformanceTraceIfActive();
    expect(tracing.startRecording).not.toHaveBeenCalled();
    expect(tracing.stopRecording).not.toHaveBeenCalled();
  });

  it("does not start when the flag is set but no output file is given", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    const mod = await loadModule();
    await mod.startPerformanceTraceIfEnabled();
    expect(tracing.startRecording).not.toHaveBeenCalled();
  });

  it("starts recording with the compositor categories when fully enabled", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    process.env.DAINTREE_PERF_TRACE_FILE = "/tmp/trace-run-1.json";
    const mod = await loadModule();
    await mod.startPerformanceTraceIfEnabled();

    expect(tracing.startRecording).toHaveBeenCalledTimes(1);
    const config = tracing.startRecording.mock.calls[0][0] as {
      recording_mode: string;
      included_categories: string[];
      excluded_categories: string[];
    };
    // Lock the config shape: exactly the first-frame categories, nothing else,
    // and the deny-everything-else wildcard so no noisy category leaks in.
    expect(config.recording_mode).toBe("record-until-full");
    expect(config.included_categories).toEqual(["viz", "gpu", "cc", "blink", "toplevel", "startup"]);
    expect(config.excluded_categories).toEqual(["*"]);
  });

  it("stops recording to the configured file and is idempotent", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    process.env.DAINTREE_PERF_TRACE_FILE = "/tmp/trace-run-1.json";
    const mod = await loadModule();
    await mod.startPerformanceTraceIfEnabled();
    await mod.stopPerformanceTraceIfActive();
    await mod.stopPerformanceTraceIfActive();

    expect(tracing.stopRecording).toHaveBeenCalledTimes(1);
    expect(tracing.stopRecording).toHaveBeenCalledWith("/tmp/trace-run-1.json");
  });

  it("does not stop when tracing was never started", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    process.env.DAINTREE_PERF_TRACE_FILE = "/tmp/trace-run-1.json";
    const mod = await loadModule();
    await mod.stopPerformanceTraceIfActive();
    expect(tracing.stopRecording).not.toHaveBeenCalled();
  });

  it("swallows a startRecording rejection without throwing", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    process.env.DAINTREE_PERF_TRACE_FILE = "/tmp/trace-run-1.json";
    tracing.startRecording.mockRejectedValueOnce(new Error("boom"));
    const mod = await loadModule();
    await expect(mod.startPerformanceTraceIfEnabled()).resolves.toBeUndefined();
    // A failed start must not leave the machine in a state that later tries to
    // stop a recording that never began.
    await mod.stopPerformanceTraceIfActive();
    expect(tracing.stopRecording).not.toHaveBeenCalled();
  });

  it("swallows a stopRecording rejection without throwing", async () => {
    process.env.DAINTREE_PERF_TRACE = "1";
    process.env.DAINTREE_PERF_TRACE_FILE = "/tmp/trace-run-1.json";
    tracing.stopRecording.mockRejectedValueOnce(new Error("boom"));
    const mod = await loadModule();
    await mod.startPerformanceTraceIfEnabled();
    await expect(mod.stopPerformanceTraceIfActive()).resolves.toBeUndefined();
    // Prove the swallowed-error path actually attempted the stop, not that it
    // short-circuited before calling stopRecording.
    expect(tracing.stopRecording).toHaveBeenCalledTimes(1);
    expect(tracing.stopRecording).toHaveBeenCalledWith("/tmp/trace-run-1.json");
  });
});
