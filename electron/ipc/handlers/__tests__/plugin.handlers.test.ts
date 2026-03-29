import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchHandler = vi.fn();
const mockRegisterHandler = vi.fn();
const mockRemoveHandlers = vi.fn();
const mockListPlugins = vi.fn();

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: (...args: unknown[]) => mockListPlugins(...args),
    dispatchHandler: (...args: unknown[]) => mockDispatchHandler(...args),
    registerHandler: (...args: unknown[]) => mockRegisterHandler(...args),
    removeHandlers: (...args: unknown[]) => mockRemoveHandlers(...args),
  },
}));

const mockIpcMainHandle = vi.fn();
const mockIpcMainRemoveHandler = vi.fn();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => mockIpcMainHandle(...args),
    removeHandler: (...args: unknown[]) => mockIpcMainRemoveHandler(...args),
  },
}));

import { registerPluginHandlers, registerPluginHandler, removePluginHandlers } from "../plugin.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerPluginHandlers", () => {
  it("registers handlers for PLUGIN_LIST and PLUGIN_INVOKE", () => {
    registerPluginHandlers();
    expect(mockIpcMainHandle).toHaveBeenCalledTimes(2);
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:list", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
  });

  it("cleanup removes both handlers", () => {
    const cleanup = registerPluginHandlers();
    cleanup();
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:list");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:invoke");
  });

  it("PLUGIN_LIST handler delegates to pluginService.listPlugins", async () => {
    const plugins = [{ manifest: { name: "test" } }];
    mockListPlugins.mockReturnValue(plugins);

    registerPluginHandlers();
    const listHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:list"
    )![1] as (...args: unknown[]) => unknown;

    const result = await listHandler();
    expect(result).toBe(plugins);
  });

  it("PLUGIN_INVOKE handler delegates to pluginService.dispatchHandler", async () => {
    mockDispatchHandler.mockResolvedValue({ data: "hello" });

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const result = await invokeHandler({}, "my-plugin", "get-data", "arg1", "arg2");
    expect(mockDispatchHandler).toHaveBeenCalledWith("my-plugin", "get-data", ["arg1", "arg2"]);
    expect(result).toEqual({ data: "hello" });
  });

  it("PLUGIN_INVOKE handler propagates errors from dispatchHandler", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("No plugin handler registered for x:y"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    await expect(invokeHandler({}, "x", "y")).rejects.toThrow(
      "No plugin handler registered for x:y"
    );
  });
});

describe("registerPluginHandler", () => {
  it("delegates to pluginService.registerHandler", () => {
    const handler = vi.fn();
    registerPluginHandler("my-plugin", "my-channel", handler);
    expect(mockRegisterHandler).toHaveBeenCalledWith("my-plugin", "my-channel", handler);
  });
});

describe("removePluginHandlers", () => {
  it("delegates to pluginService.removeHandlers", () => {
    removePluginHandlers("my-plugin");
    expect(mockRemoveHandlers).toHaveBeenCalledWith("my-plugin");
  });
});
