import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRendererLoggerForTesting, logDebug, logError, logInfo, logWarn } from "../logger";

const LOG_BATCH_MS = 16;

type LevelOverridesCallback = (overrides: Record<string, string>) => void;

interface MockLogsApi {
  writeBatch: ReturnType<typeof vi.fn>;
  getLevelOverrides: ReturnType<typeof vi.fn>;
  onLevelOverridesChanged: ReturnType<typeof vi.fn>;
}

let logsApi: MockLogsApi;
let overridesCallback: LevelOverridesCallback | null;

function installElectron(initialOverrides: Record<string, string> = {}): void {
  overridesCallback = null;
  logsApi = {
    writeBatch: vi.fn().mockResolvedValue(undefined),
    getLevelOverrides: vi.fn().mockResolvedValue(initialOverrides),
    onLevelOverridesChanged: vi.fn((cb: LevelOverridesCallback) => {
      overridesCallback = cb;
      return () => {};
    }),
  };
  (globalThis as unknown as { window: unknown }).window = { electron: { logs: logsApi } };
}

function removeElectron(): void {
  delete (globalThis as unknown as { window?: unknown }).window;
}

/** Let the init's getLevelOverrides().then() microtask settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * First electron-backed call wires the subscription/fetch. Drain its queued
 * entry + timer and reset the writeBatch spy so subsequent assertions start
 * from a clean slate.
 */
async function triggerInitAndDrain(): Promise<void> {
  logInfo("trigger init");
  await flushMicrotasks();
  vi.advanceTimersByTime(LOG_BATCH_MS);
  logsApi.writeBatch.mockClear();
}

beforeEach(() => {
  vi.useFakeTimers();
  installElectron();
  _resetRendererLoggerForTesting();
});

afterEach(() => {
  _resetRendererLoggerForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeElectron();
});

describe("renderer logger gating", () => {
  it("drops below-floor debug calls before any IPC at the default info floor", () => {
    logDebug("noise");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).not.toHaveBeenCalled();
  });

  it("lets info and above cross at the default floor", () => {
    logInfo("hello");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
  });

  it("raises the floor when a '*' override arrives via the push subscription", async () => {
    await triggerInitAndDrain();
    expect(overridesCallback).toBeTypeOf("function");

    overridesCallback?.({ "*": "warn" });

    logInfo("now gated");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).not.toHaveBeenCalled();

    logWarn("still delivered");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
  });

  it("lowers the floor to debug when overrides resolve from the initial fetch", async () => {
    removeElectron();
    installElectron({ "*": "debug" });
    _resetRendererLoggerForTesting();

    await triggerInitAndDrain();

    logDebug("now allowed");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
  });
});

describe("renderer logger batching", () => {
  it("coalesces multiple same-tick info writes into one batched invoke", () => {
    logInfo("a");
    logInfo("b");
    logInfo("c");
    expect(logsApi.writeBatch).not.toHaveBeenCalled(); // nothing before the timer fires

    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
    const entries = logsApi.writeBatch.mock.calls[0][0];
    expect(entries.map((e: { message: string }) => e.message)).toEqual(["a", "b", "c"]);
  });

  it("only opens one timer window per burst", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    logInfo("a");
    logInfo("b");
    logInfo("c");
    const timerCalls = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === LOG_BATCH_MS);
    expect(timerCalls).toHaveLength(1);
  });

  it("splits oversized batches into <=60-entry chunks", () => {
    for (let i = 0; i < 130; i++) logInfo(`m${i}`);
    vi.advanceTimersByTime(LOG_BATCH_MS);

    expect(logsApi.writeBatch).toHaveBeenCalledTimes(3);
    const sizes = logsApi.writeBatch.mock.calls.map((c) => c[0].length);
    expect(sizes).toEqual([60, 60, 10]);
  });
});

describe("renderer logger warn/error bypass", () => {
  it("flushes warn synchronously without waiting for the timer", () => {
    logWarn("urgent");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
  });

  it("flushes error synchronously and serializes the Error", () => {
    logError("boom", new Error("kaboom"));
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
    const entry = logsApi.writeBatch.mock.calls[0][0][0];
    expect(entry.level).toBe("error");
    expect(entry.context.error).toMatchObject({ name: "Error", message: "kaboom" });
  });

  it("flushes pending info ahead of an error, preserving order, in one batch", () => {
    logInfo("before");
    expect(logsApi.writeBatch).not.toHaveBeenCalled();

    logError("after");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
    const entries = logsApi.writeBatch.mock.calls[0][0];
    expect(entries.map((e: { message: string }) => e.message)).toEqual(["before", "after"]);
    expect(entries.map((e: { level: string }) => e.level)).toEqual(["info", "error"]);
  });

  it("does not re-send the flushed entries when the timer later fires", () => {
    logInfo("queued");
    logError("flush-now");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1); // no duplicate flush
  });
});

describe("renderer logger fallback", () => {
  it("logs to console (without gating) when electron is unavailable", () => {
    removeElectron();
    _resetRendererLoggerForTesting();
    const debugSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    logDebug("d");
    logError("e");

    expect(debugSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});
