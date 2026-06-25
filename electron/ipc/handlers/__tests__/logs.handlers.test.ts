import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stateful logger mock: setLogLevelOverrides mutates `loggerState.overrides`
// and getLogLevelOverrides reflects it, so the verbose-session-only suite can
// assert the in-memory override map directly (no disk involved). isVerbose is
// derived from the same state so a simulated restart (state reset, store never
// written) reports verbose off.
const loggerState = vi.hoisted(() => ({ overrides: {} as Record<string, string> }));
const loggerMock = vi.hoisted(() => {
  // Mirrors the real isValidLogOverrideLevel in electron/utils/logger.ts.
  const VALID_LEVELS = ["error", "warn", "info", "debug", "off"];
  return {
    isVerboseLogging: vi.fn(() => loggerState.overrides["*"] === "debug"),
    logInfo: vi.fn(),
    logDebug: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    getLogFilePath: vi.fn(() => "/tmp/daintree.log"),
    getPreviousSessionTail: vi.fn(() => null),
    getLogLevelOverrides: vi.fn(() => ({ ...loggerState.overrides })),
    getDefaultLogLevel: vi.fn(() => "info"),
    setLogLevelOverrides: vi.fn((o: Record<string, string>) => {
      loggerState.overrides = { ...o };
    }),
    getRegisteredLoggerNames: vi.fn(() => []),
    isValidLogOverrideLevel: vi.fn(
      (v: unknown) => typeof v === "string" && VALID_LEVELS.includes(v)
    ),
  };
});

vi.mock("../../../utils/logger.js", () => loggerMock);

const utilsMock = vi.hoisted(() => {
  const registered: Array<{ channel: string; handler: (...a: unknown[]) => unknown }> = [];
  return {
    registered,
    typedHandle: vi.fn((channel: string, handler: (...a: unknown[]) => unknown) => {
      registered.push({ channel, handler });
      return () => {};
    }),
    broadcastToRenderer: vi.fn(),
  };
});

vi.mock("../../utils.js", () => ({
  typedHandle: utilsMock.typedHandle,
  broadcastToRenderer: utilsMock.broadcastToRenderer,
}));

const storeMock = vi.hoisted(() => {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) => data.get(key)),
    set: vi.fn((key: string, value: unknown) => data.set(key, value)),
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

vi.mock("../../../services/LogBuffer.js", () => ({
  logBuffer: {
    getAll: vi.fn(() => []),
    getFiltered: vi.fn(() => []),
    getSources: vi.fn(() => []),
    clear: vi.fn(),
  },
}));

const FakeAppError = vi.hoisted(
  () =>
    class FakeAppError extends Error {
      code: string;
      constructor(opts: { code: string; message: string }) {
        super(opts.message);
        this.code = opts.code;
      }
    }
);

vi.mock("../../../utils/errorTypes.js", () => ({ AppError: FakeAppError }));

vi.mock("electron", () => ({ shell: { openPath: vi.fn() } }));

import { CHANNELS } from "../../channels.js";

type Handler = (...args: unknown[]) => unknown;
type RegisterLogsHandlers = typeof import("../logs.js").registerLogsHandlers;

// Re-imported per test so the module-scoped verbose session state
// (`verboseSessionActive` / `savedWildcardBeforeVerbose`) starts fresh and
// can't leak across cases.
let registerLogsHandlers: RegisterLogsHandlers;

function getHandler(channel: string): Handler {
  const match = utilsMock.registered.find((r) => r.channel === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match.handler;
}

async function resetMocks() {
  vi.clearAllMocks();
  vi.resetModules();
  utilsMock.registered.length = 0;
  loggerState.overrides = {};
  storeMock.get.mockReturnValue(undefined as unknown);
  ({ registerLogsHandlers } = await import("../logs.js"));
}

describe("logs:write-batch handler", () => {
  let cleanup: () => void;

  beforeEach(async () => {
    await resetMocks();
    cleanup = registerLogsHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("registers the batch channel", () => {
    expect(utilsMock.registered.some((r) => r.channel === CHANNELS.LOGS_WRITE_BATCH)).toBe(true);
  });

  it("dispatches every entry to its level-specific main logger, tagging the source", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE_BATCH);
    await handler([
      { level: "info", message: "one" },
      { level: "warn", message: "two" },
      { level: "debug", message: "three" },
    ]);

    expect(loggerMock.logInfo).toHaveBeenCalledWith("one", { source: "Renderer" });
    expect(loggerMock.logWarn).toHaveBeenCalledWith("two", { source: "Renderer" });
    expect(loggerMock.logDebug).toHaveBeenCalledWith("three", { source: "Renderer" });
  });

  it("routes error entries through logError with the serialized error context", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE_BATCH);
    const serializedError = { name: "Error", message: "kaboom" };
    await handler([{ level: "error", message: "boom", context: { error: serializedError } }]);

    expect(loggerMock.logError).toHaveBeenCalledWith("boom", serializedError, {
      error: serializedError,
      source: "Renderer",
    });
  });

  it("is a no-op for a non-array payload", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE_BATCH);
    await handler(undefined as unknown);
    expect(loggerMock.logInfo).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).not.toHaveBeenCalled();
  });

  it("handles an empty batch without dispatching", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE_BATCH);
    await handler([]);
    expect(loggerMock.logDebug).not.toHaveBeenCalled();
  });

  it("skips a malformed entry without aborting later entries", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE_BATCH);
    await handler([
      { level: "info", message: "ok" },
      null,
      { level: "error", message: "must land" },
    ]);

    expect(loggerMock.logInfo).toHaveBeenCalledWith("ok", { source: "Renderer" });
    expect(loggerMock.logError).toHaveBeenCalledWith("must land", undefined, {
      source: "Renderer",
    });
  });
});

describe("logs:get-default-level handler", () => {
  let cleanup: () => void;

  beforeEach(async () => {
    await resetMocks();
    cleanup = registerLogsHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("returns the main-process effective default level", async () => {
    const handler = getHandler(CHANNELS.LOGS_GET_DEFAULT_LEVEL);
    const result = await handler();
    expect(result).toBe("info");
    expect(loggerMock.getDefaultLogLevel).toHaveBeenCalled();
  });
});

describe("logs override-change broadcast", () => {
  let cleanup: () => void;

  beforeEach(async () => {
    await resetMocks();
    cleanup = registerLogsHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("broadcasts the resolved in-memory overrides when set-level-overrides runs", async () => {
    const handler = getHandler(CHANNELS.LOGS_SET_LEVEL_OVERRIDES);
    await handler({ "*": "debug" });

    // Broadcast payload comes from getLogLevelOverrides() — the sanitized
    // in-memory map after the set, not the raw request.
    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.LOGS_LEVEL_OVERRIDES_CHANGED,
      { "*": "debug" }
    );
  });

  it("broadcasts when clear-level-overrides runs", async () => {
    const handler = getHandler(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES);
    await handler();

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.LOGS_LEVEL_OVERRIDES_CHANGED,
      expect.any(Object)
    );
  });

  it("broadcasts when verbose is toggled", async () => {
    const handler = getHandler(CHANNELS.LOGS_SET_VERBOSE);
    await handler(true);

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.LOGS_LEVEL_OVERRIDES_CHANGED,
      expect.any(Object)
    );
  });

  it("does not broadcast on a plain write", async () => {
    const handler = getHandler(CHANNELS.LOGS_WRITE);
    await handler({ level: "info", message: "hi" });
    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
  });
});

describe("registerLogsHandlers — verbose toggle is session-only", () => {
  let cleanup: () => void;
  let ptyClient: { setLogLevelOverrides: ReturnType<typeof vi.fn> };
  let worktreeService: { setLogLevelOverrides: ReturnType<typeof vi.fn> };

  function register() {
    cleanup = registerLogsHandlers({
      ptyClient: ptyClient as never,
      worktreeService: worktreeService as never,
    });
  }

  beforeEach(async () => {
    await resetMocks();
    ptyClient = { setLogLevelOverrides: vi.fn() };
    worktreeService = { setLogLevelOverrides: vi.fn() };
  });

  afterEach(() => {
    cleanup?.();
  });

  it("enabling verbose updates the in-memory map without writing to the store", async () => {
    register();
    storeMock.set.mockClear();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);

    expect(loggerState.overrides["*"]).toBe("debug");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("enabling verbose fans out the override to utility processes", async () => {
    register();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);

    expect(ptyClient.setLogLevelOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ "*": "debug" })
    );
    expect(worktreeService.setLogLevelOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ "*": "debug" })
    );
  });

  it("disabling verbose updates memory without writing to the store", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    storeMock.set.mockClear();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);

    expect(loggerState.overrides["*"]).toBeUndefined();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("an on/off cycle preserves a pre-existing explicit wildcard override", async () => {
    // Persisted explicit "*":"warn" (e.g. from the per-module overrides UI).
    storeMock.get.mockReturnValue({ "*": "warn" });
    register();
    expect(loggerState.overrides["*"]).toBe("warn");

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    expect(loggerState.overrides["*"]).toBe("debug");

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);
    expect(loggerState.overrides["*"]).toBe("warn");
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("double-enable does not clobber the saved prior wildcard", async () => {
    storeMock.get.mockReturnValue({ "*": "warn" });
    register();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);

    // The "warn" stashed on first enable must survive the redundant enable.
    expect(loggerState.overrides["*"]).toBe("warn");
  });

  it("preserves non-wildcard per-module overrides through a verbose cycle", async () => {
    storeMock.get.mockReturnValue({ "main:Foo": "warn" });
    register();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    expect(loggerState.overrides).toEqual({ "main:Foo": "warn", "*": "debug" });

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);
    expect(loggerState.overrides).toEqual({ "main:Foo": "warn" });
  });

  it("verbose does not survive a simulated restart", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    expect(loggerState.overrides["*"]).toBe("debug");

    // Restart: a fresh process re-hydrates from disk, which was never written.
    cleanup?.();
    loggerState.overrides = {};
    utilsMock.registered.length = 0;
    storeMock.get.mockReturnValue({});
    register();

    const verbose = await getHandler(CHANNELS.LOGS_GET_VERBOSE)();
    expect(verbose).toBe(false);
    expect(loggerState.overrides["*"]).toBeUndefined();
  });

  it("rejects a non-boolean payload without mutating state or store", async () => {
    register();
    storeMock.set.mockClear();

    await expect(getHandler(CHANNELS.LOGS_SET_VERBOSE)("yes")).rejects.toBeInstanceOf(FakeAppError);
    expect(loggerState.overrides["*"]).toBeUndefined();
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("explicit per-module overrides still persist to the store", async () => {
    register();
    storeMock.set.mockClear();

    await getHandler(CHANNELS.LOGS_SET_LEVEL_OVERRIDES)({ "main:Foo": "warn", "*": "debug" });

    expect(storeMock.set).toHaveBeenCalledWith("logLevelOverrides", {
      "main:Foo": "warn",
      "*": "debug",
    });
    expect(loggerState.overrides).toEqual({ "main:Foo": "warn", "*": "debug" });
  });

  it("disable fans out a map with no verbose wildcard", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    ptyClient.setLogLevelOverrides.mockClear();
    worktreeService.setLogLevelOverrides.mockClear();

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);

    expect(ptyClient.setLogLevelOverrides).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ "*": "debug" })
    );
    expect(worktreeService.setLogLevelOverrides).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ "*": "debug" })
    );
  });

  // Critical regression: the LogLevelPalette fetches the override map on open and
  // writes it back when the user edits any logger. If verbose is active, the
  // fetched map must not carry "*":"debug", or the round-trip re-persists verbose.
  it("hides the verbose overlay from get-level-overrides while verbose is active", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);

    const result = (await getHandler(CHANNELS.LOGS_GET_LEVEL_OVERRIDES)()) as Record<
      string,
      string
    >;

    expect(result["*"]).toBeUndefined();
  });

  it("exposes the underlying explicit wildcard (not debug) while verbose is active", async () => {
    storeMock.get.mockReturnValue({ "*": "warn" });
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);

    const result = (await getHandler(CHANNELS.LOGS_GET_LEVEL_OVERRIDES)()) as Record<
      string,
      string
    >;

    expect(result["*"]).toBe("warn");
  });

  it("does not persist the verbose wildcard when a per-module override is set while verbose is active", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    storeMock.set.mockClear();

    // Simulate the palette writing back the full map it fetched plus a new edit.
    await getHandler(CHANNELS.LOGS_SET_LEVEL_OVERRIDES)({ "*": "debug", "main:Foo": "warn" });

    // Store must never receive the session-only verbose wildcard.
    const persisted = storeMock.set.mock.calls.at(-1)?.[1] as Record<string, string>;
    expect(persisted).toEqual({ "main:Foo": "warn" });
    // ...but verbose stays live in memory for the rest of the session.
    expect(loggerState.overrides["*"]).toBe("debug");
    expect(loggerState.overrides["main:Foo"]).toBe("warn");
  });

  it("keeps an explicit non-debug wildcard set while verbose is active and restores it on disable", async () => {
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);

    // User explicitly sets "*":"error" via the palette while verbose is on.
    await getHandler(CHANNELS.LOGS_SET_LEVEL_OVERRIDES)({ "*": "error" });
    expect(loggerState.overrides["*"]).toBe("debug"); // overlay still active in memory

    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);
    expect(loggerState.overrides["*"]).toBe("error"); // user's wildcard restored
  });

  it("clearing overrides while verbose is active keeps verbose live and resets the saved wildcard", async () => {
    storeMock.get.mockReturnValue({ "*": "warn" });
    register();
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(true);
    storeMock.set.mockClear();

    await getHandler(CHANNELS.LOGS_CLEAR_LEVEL_OVERRIDES)();
    expect(storeMock.set).toHaveBeenCalledWith("logLevelOverrides", {});
    expect(loggerState.overrides).toEqual({ "*": "debug" });

    // With nothing persisted to restore, disabling verbose clears the wildcard.
    await getHandler(CHANNELS.LOGS_SET_VERBOSE)(false);
    expect(loggerState.overrides["*"]).toBeUndefined();
  });
});
