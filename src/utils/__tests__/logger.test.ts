import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRendererLoggerForTesting, logDebug, logError, logInfo, logWarn } from "../logger";

const LOG_BATCH_MS = 16;

type LevelOverridesCallback = (overrides: Record<string, string>) => void;

interface MockLogsApi {
  writeBatch: ReturnType<typeof vi.fn>;
  getDefaultLevel: ReturnType<typeof vi.fn>;
  getLevelOverrides: ReturnType<typeof vi.fn>;
  onLevelOverridesChanged: ReturnType<typeof vi.fn>;
}

let logsApi: MockLogsApi;
let overridesCallback: LevelOverridesCallback | null;

function installElectron(
  initialOverrides: Record<string, string> = {},
  defaultLevel = "info"
): void {
  overridesCallback = null;
  logsApi = {
    writeBatch: vi.fn().mockResolvedValue(undefined),
    getDefaultLevel: vi.fn().mockResolvedValue(defaultLevel),
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

interface SentEntry {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

/** The entries array passed to the Nth writeBatch invoke, guarded for tsc. */
function sentBatch(callIndex = 0): SentEntry[] {
  const call = logsApi.writeBatch.mock.calls[callIndex];
  if (!call) throw new Error(`expected a writeBatch call at index ${callIndex}`);
  return call[0] as SentEntry[];
}

/** A single entry from a writeBatch invoke, guarded for tsc. */
function sentEntry(callIndex = 0, entryIndex = 0): SentEntry {
  const entry = sentBatch(callIndex)[entryIndex];
  if (!entry) throw new Error(`expected entry ${entryIndex} in writeBatch call ${callIndex}`);
  return entry;
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

  it("mirrors main's debug-boot default so renderer debug crosses when main would accept it", async () => {
    removeElectron();
    installElectron({}, "debug"); // no '*' override, but main's default is debug
    _resetRendererLoggerForTesting();

    await triggerInitAndDrain();

    logDebug("dev debug");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the newer pushed override when the initial fetch resolves afterward (stale-fetch race)", async () => {
    removeElectron();
    let resolveFetch: (v: Record<string, string>) => void = () => {};
    const fetchPromise = new Promise<Record<string, string>>((r) => {
      resolveFetch = r;
    });
    installElectron();
    logsApi.getLevelOverrides.mockReturnValue(fetchPromise);
    _resetRendererLoggerForTesting();

    logInfo("trigger init"); // starts the (still-pending) fetch + wires the push
    await flushMicrotasks();

    // A push raises the floor to warn before the fetch resolves.
    overridesCallback?.({ "*": "warn" });
    // The stale fetch now resolves with the older (empty) state.
    resolveFetch({});
    await flushMicrotasks();
    // Drain the "trigger init" entry (queued while the floor was still info).
    vi.advanceTimersByTime(LOG_BATCH_MS);
    logsApi.writeBatch.mockClear();

    logInfo("should be gated by the pushed warn floor");
    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).not.toHaveBeenCalled();
  });

  it("does not throw when the preload lacks onLevelOverridesChanged (version skew)", () => {
    removeElectron();
    logsApi = {
      writeBatch: vi.fn().mockResolvedValue(undefined),
      getDefaultLevel: vi.fn().mockResolvedValue("info"),
      getLevelOverrides: vi.fn().mockResolvedValue({}),
      onLevelOverridesChanged: undefined as unknown as ReturnType<typeof vi.fn>,
    };
    (globalThis as unknown as { window: unknown }).window = { electron: { logs: logsApi } };
    _resetRendererLoggerForTesting();

    expect(() => logWarn("urgent")).not.toThrow();
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
    expect(sentBatch().map((e) => e.message)).toEqual(["a", "b", "c"]);
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
    const error = new Error("kaboom");
    logError("boom", error);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
    const entry = sentEntry();
    expect(entry.level).toBe("error");
    expect(entry.context?.error).toMatchObject({ name: "Error", message: "kaboom" });
    // The stack has to survive too — it is the part the contextBridge drops.
    expect((entry.context?.error as { stack?: string }).stack).toBe(error.stack);
  });

  it("sends a non-Error error argument through unchanged", () => {
    logError("boom", "just a string");
    expect(sentEntry().context?.error).toBe("just a string");
  });

  it("flushes pending info ahead of an error, preserving order, in one batch", () => {
    logInfo("before");
    expect(logsApi.writeBatch).not.toHaveBeenCalled();

    logError("after");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);
    expect(sentBatch().map((e) => e.message)).toEqual(["before", "after"]);
    expect(sentBatch().map((e) => e.level)).toEqual(["info", "error"]);
  });

  it("does not re-send the flushed entries when the timer later fires", () => {
    logInfo("queued");
    logError("flush-now");
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LOG_BATCH_MS);
    expect(logsApi.writeBatch).toHaveBeenCalledTimes(1); // no duplicate flush
  });
});

describe("renderer logger error normalization", () => {
  it("flattens an Error passed inside a warn context, not just logError's argument", () => {
    const error = new Error("wake failed");
    logWarn("[wakeActiveWorktreeTerminals] wake failed", { id: "terminal-1", error });

    const context = sentEntry().context ?? {};
    // Before the fix this crossed the bridge as `{}` — the reported bug.
    expect(context.error).toMatchObject({ name: error.name, message: error.message });
    expect((context.error as { stack?: string }).stack).toBe(error.stack);
    expect(context.id).toBe("terminal-1");
  });

  it("flattens Errors nested in objects and arrays at every level", () => {
    const nested = new Error("nested");
    const listed = new Error("listed");
    logWarn("failures", { task: { error: nested }, failures: [listed] });

    const context = sentEntry().context ?? {};
    const task = context.task as { error: { message?: string } };
    expect(task.error.message).toBe(nested.message);
    const failures = context.failures as Array<{ message?: string }>;
    expect(failures[0]?.message).toBe(listed.message);
  });

  it("sends a payload that survives JSON serialization with the failure intact", () => {
    logInfo("attempt failed", { error: new Error("recoverable") });
    vi.advanceTimersByTime(LOG_BATCH_MS);

    const roundTripped = JSON.parse(JSON.stringify(sentEntry())) as SentEntry;
    expect((roundTripped.context?.error as { message?: string }).message).toBe("recoverable");
  });

  it("does not mutate the caller's context object", () => {
    const error = new Error("untouched");
    const context = { error };
    logWarn("keep the caller's object intact", context);

    expect(context.error).toBe(error);
  });

  it("normalizes after the level gate, so a suppressed call does no work", () => {
    let stackReads = 0;
    const error = new Error("gated");
    Object.defineProperty(error, "stack", {
      get: () => {
        stackReads++;
        return "counted";
      },
    });

    // debug sits below the default info floor.
    logDebug("gated", { error });
    vi.advanceTimersByTime(LOG_BATCH_MS);

    expect(logsApi.writeBatch).not.toHaveBeenCalled();
    expect(stackReads).toBe(0);
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

  it("hands the console the live Error, which DevTools can expand", () => {
    removeElectron();
    _resetRendererLoggerForTesting();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("live");

    logError("boom", error);

    const context = errorSpy.mock.calls[0]?.[1] as { error?: unknown };
    expect(context.error).toBe(error);
  });
});
