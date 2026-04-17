import { beforeEach, describe, expect, it, vi } from "vitest";

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
  it("registers handlers for PLUGIN_LIST, PLUGIN_INVOKE, PLUGIN_TOOLBAR_BUTTONS, and PLUGIN_MENU_ITEMS", () => {
    registerPluginHandlers();
    expect(mockIpcMainHandle).toHaveBeenCalledTimes(4);
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:list", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:toolbar-buttons", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:menu-items", expect.any(Function));
  });

  it("cleanup removes all handlers", () => {
    const cleanup = registerPluginHandlers();
    cleanup();
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:list");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:invoke");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:toolbar-buttons");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:menu-items");
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

  it("PLUGIN_INVOKE handler delegates to pluginService.dispatchHandler for trusted senders", async () => {
    mockDispatchHandler.mockResolvedValue({ data: "hello" });

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = { senderFrame: { url: "app://daintree/" } };
    const result = await invokeHandler(trustedEvent, "my-plugin", "get-data", "arg1", "arg2");
    expect(mockDispatchHandler).toHaveBeenCalledWith("my-plugin", "get-data", ["arg1", "arg2"]);
    expect(result).toEqual({ data: "hello" });
  });

  it("PLUGIN_INVOKE handler propagates errors from dispatchHandler", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("No plugin handler registered for x:y"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = { senderFrame: { url: "app://daintree/" } };
    await expect(invokeHandler(trustedEvent, "x", "y")).rejects.toThrow(
      "No plugin handler registered for x:y"
    );
  });

  it("PLUGIN_INVOKE handler rejects untrusted senders and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const untrustedEvent = { senderFrame: { url: "https://evil.com/attack.html" } };
    await expect(invokeHandler(untrustedEvent, "my-plugin", "get-data", "arg1")).rejects.toThrow(
      "plugin:invoke rejected: untrusted sender"
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE handler rejects when senderFrame is missing and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const nullFrameEvent = { senderFrame: null };
    await expect(invokeHandler(nullFrameEvent, "my-plugin", "get-data")).rejects.toThrow(
      "plugin:invoke rejected: untrusted sender"
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
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
