import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => {
  const data: Record<string, unknown> = {};
  return {
    get: vi.fn((key: string) => data[key]),
    set: vi.fn((key: string, value: unknown) => {
      data[key] = value;
    }),
    _data: data,
  };
});

vi.mock("../../../store.js", () => ({ store: storeMock }));

import { registerGlobalEnvHandlers } from "../globalEnv.js";

function getHandler(channel: string) {
  return ipcMainMock.handle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
    _e: unknown,
    ...args: unknown[]
  ) => unknown;
}

describe("registerGlobalEnvHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(storeMock._data)) {
      delete storeMock._data[key];
    }
  });

  it("registers two IPC handlers and cleanup removes them", () => {
    const cleanup = registerGlobalEnvHandlers();
    expect(ipcMainMock.handle).toHaveBeenCalledTimes(2);
    expect(ipcMainMock.handle).toHaveBeenCalledWith("global-env:get", expect.any(Function));
    expect(ipcMainMock.handle).toHaveBeenCalledWith("global-env:set", expect.any(Function));
    cleanup();
    expect(ipcMainMock.removeHandler).toHaveBeenCalledTimes(2);
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("global-env:get");
    expect(ipcMainMock.removeHandler).toHaveBeenCalledWith("global-env:set");
  });

  it("get returns empty object when store has no global vars", async () => {
    registerGlobalEnvHandlers();
    const result = await getHandler("global-env:get")(null);
    expect(result).toEqual({});
  });

  it("get returns stored global vars", async () => {
    storeMock._data["globalEnvironmentVariables"] = { NODE_ENV: "production", PORT: "3000" };
    registerGlobalEnvHandlers();
    const result = await getHandler("global-env:get")(null);
    expect(result).toEqual({ NODE_ENV: "production", PORT: "3000" });
  });

  it("set stores variables and get returns them", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    const getHandlerFn = getHandler("global-env:get");

    await setHandler(null, { variables: { API_KEY: "abc123", DEBUG: "true" } });
    expect(storeMock.set).toHaveBeenCalledWith("globalEnvironmentVariables", {
      API_KEY: "abc123",
      DEBUG: "true",
    });

    storeMock._data["globalEnvironmentVariables"] = { API_KEY: "abc123", DEBUG: "true" };
    const result = await getHandlerFn(null);
    expect(result).toEqual({ API_KEY: "abc123", DEBUG: "true" });
  });

  it("set rejects null payload", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await expect(setHandler(null, null)).rejects.toThrow("Invalid payload");
  });

  it("set rejects non-object payload", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await expect(setHandler(null, "not-an-object")).rejects.toThrow("Invalid payload");
  });

  it("set rejects missing variables field", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await expect(setHandler(null, { other: "field" })).rejects.toThrow("Invalid variables object");
  });

  it("set rejects array as variables", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await expect(setHandler(null, { variables: ["a", "b"] })).rejects.toThrow(
      "Invalid variables object"
    );
  });

  it("set rejects non-string values in variables", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await expect(setHandler(null, { variables: { PORT: 3000 } })).rejects.toThrow(
      "All environment variable keys and values must be strings"
    );
  });

  it("set accepts empty variables object", async () => {
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");
    await setHandler(null, { variables: {} });
    expect(storeMock.set).toHaveBeenCalledWith("globalEnvironmentVariables", {});
  });

  it("set overwrites previous variables entirely", async () => {
    storeMock._data["globalEnvironmentVariables"] = { OLD_VAR: "old" };
    registerGlobalEnvHandlers();
    const setHandler = getHandler("global-env:set");

    await setHandler(null, { variables: { NEW_VAR: "new" } });
    expect(storeMock.set).toHaveBeenCalledWith("globalEnvironmentVariables", { NEW_VAR: "new" });
  });
});
