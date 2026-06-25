import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loggerMock = vi.hoisted(() => ({
  isVerboseLogging: vi.fn(() => false),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  getLogFilePath: vi.fn(() => "/tmp/daintree.log"),
  getPreviousSessionTail: vi.fn(() => null),
  getLogLevelOverrides: vi.fn(() => ({ "*": "warn" })),
  getDefaultLogLevel: vi.fn(() => "info"),
  setLogLevelOverrides: vi.fn(),
  getRegisteredLoggerNames: vi.fn(() => []),
  isValidLogOverrideLevel: vi.fn(
    (v: unknown) => typeof v === "string" && ["debug", "info", "warn", "error", "off"].includes(v)
  ),
}));

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

vi.mock("electron", () => ({ shell: { openPath: vi.fn() } }));

import { CHANNELS } from "../../channels.js";
import { registerLogsHandlers } from "../logs.js";

type Handler = (...args: unknown[]) => unknown;

function getHandler(channel: string): Handler {
  const match = utilsMock.registered.find((r) => r.channel === channel);
  if (!match) throw new Error(`No handler registered for ${channel}`);
  return match.handler;
}

let cleanup: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  utilsMock.registered.length = 0;
  cleanup = registerLogsHandlers();
});

afterEach(() => {
  cleanup();
});

describe("logs:write-batch handler", () => {
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
  it("returns the main-process effective default level", async () => {
    const handler = getHandler(CHANNELS.LOGS_GET_DEFAULT_LEVEL);
    const result = await handler();
    expect(result).toBe("info");
    expect(loggerMock.getDefaultLogLevel).toHaveBeenCalled();
  });
});

describe("logs override-change broadcast", () => {
  it("broadcasts the resolved overrides when set-level-overrides runs", async () => {
    const handler = getHandler(CHANNELS.LOGS_SET_LEVEL_OVERRIDES);
    await handler({ "*": "debug" });

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      CHANNELS.LOGS_LEVEL_OVERRIDES_CHANGED,
      { "*": "warn" } // value comes from getLogLevelOverrides() — the sanitized in-memory map
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
