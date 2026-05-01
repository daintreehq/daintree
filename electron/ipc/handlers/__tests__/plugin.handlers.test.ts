import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDispatchHandler = vi.fn();
const mockRegisterHandler = vi.fn();
const mockRemoveHandlers = vi.fn();
const mockListPlugins = vi.fn();
const mockListPluginActions = vi.fn();
const mockRegisterPluginAction = vi.fn();
const mockUnregisterPluginAction = vi.fn();

vi.mock("../../../services/PluginService.js", () => ({
  pluginService: {
    listPlugins: (...args: unknown[]) => mockListPlugins(...args),
    dispatchHandler: (...args: unknown[]) => mockDispatchHandler(...args),
    registerHandler: (...args: unknown[]) => mockRegisterHandler(...args),
    removeHandlers: (...args: unknown[]) => mockRemoveHandlers(...args),
    listPluginActions: (...args: unknown[]) => mockListPluginActions(...args),
    registerPluginAction: (...args: unknown[]) => mockRegisterPluginAction(...args),
    unregisterPluginAction: (...args: unknown[]) => mockUnregisterPluginAction(...args),
  },
}));

const mockGetPluginToolbarButtonIds = vi.fn();
const mockGetToolbarButtonConfig = vi.fn();
vi.mock("../../../../shared/config/toolbarButtonRegistry.js", () => ({
  getPluginToolbarButtonIds: (...args: unknown[]) => mockGetPluginToolbarButtonIds(...args),
  getToolbarButtonConfig: (...args: unknown[]) => mockGetToolbarButtonConfig(...args),
}));

const mockGetPluginMenuItems = vi.fn();
vi.mock("../../../services/pluginMenuRegistry.js", () => ({
  getPluginMenuItems: (...args: unknown[]) => mockGetPluginMenuItems(...args),
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
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../ipcGuard.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPluginToolbarButtonIds.mockReturnValue([]);
  mockGetToolbarButtonConfig.mockReturnValue(undefined);
  mockGetPluginMenuItems.mockReturnValue([]);
  mockListPluginActions.mockReturnValue([]);
  _resetIpcGuardForTesting();
  markIpcSecurityReady();
});

describe("registerPluginHandlers", () => {
  it("registers handlers for all plugin channels", () => {
    registerPluginHandlers();
    expect(mockIpcMainHandle).toHaveBeenCalledTimes(9);
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:list", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:toolbar-buttons", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:menu-items", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:validate-action-ids",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:actions-get", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:actions-register", expect.any(Function));
    expect(mockIpcMainHandle).toHaveBeenCalledWith(
      "plugin:actions-unregister",
      expect.any(Function)
    );
    expect(mockIpcMainHandle).toHaveBeenCalledWith("plugin:panel-kinds-get", expect.any(Function));
  });

  it("throws before registering any handler when invoked before enforceIpcSenderValidation", () => {
    _resetIpcGuardForTesting();
    expect(() => registerPluginHandlers()).toThrow(
      /registered before enforceIpcSenderValidation\(\) was called/
    );
    expect(mockIpcMainHandle).not.toHaveBeenCalledWith("plugin:invoke", expect.any(Function));
  });

  it("cleanup removes all handlers", () => {
    const cleanup = registerPluginHandlers();
    cleanup();
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:list");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:invoke");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:toolbar-buttons");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:menu-items");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:validate-action-ids");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-get");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-register");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:actions-unregister");
    expect(mockIpcMainRemoveHandler).toHaveBeenCalledWith("plugin:panel-kinds-get");
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

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 33 },
    };
    const result = await invokeHandler(trustedEvent, "acme.my-plugin", "get-data", "arg1", "arg2");
    expect(mockDispatchHandler).toHaveBeenCalledWith(
      "acme.my-plugin",
      "get-data",
      {
        projectId: null,
        worktreeId: null,
        webContentsId: 33,
        pluginId: "acme.my-plugin",
      },
      ["arg1", "arg2"]
    );
    expect(result).toEqual({ data: "hello" });
  });

  it("PLUGIN_INVOKE handler builds ctx with webContentsId from event.sender.id", async () => {
    mockDispatchHandler.mockResolvedValue(undefined);

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 7 },
    };
    await invokeHandler(trustedEvent, "acme.my-plugin", "get-data");
    const ctxArg = mockDispatchHandler.mock.calls[0][2];
    expect(ctxArg).toEqual({
      projectId: null,
      worktreeId: null,
      webContentsId: 7,
      pluginId: "acme.my-plugin",
    });
  });

  it("PLUGIN_INVOKE handler propagates errors from dispatchHandler", async () => {
    mockDispatchHandler.mockRejectedValue(new Error("No plugin handler registered for x:y"));

    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const trustedEvent = {
      senderFrame: { url: "app://daintree/" },
      sender: { id: 1 },
    };
    await expect(invokeHandler(trustedEvent, "x", "y")).rejects.toThrow(
      "No plugin handler registered for x:y"
    );
  });

  it("PLUGIN_INVOKE handler rejects untrusted senders and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const untrustedEvent = {
      senderFrame: { url: "https://evil.com/attack.html" },
      sender: { id: 1 },
    };
    await expect(
      invokeHandler(untrustedEvent, "acme.my-plugin", "get-data", "arg1")
    ).rejects.toThrow("plugin:invoke rejected: untrusted sender");
    expect(mockDispatchHandler).not.toHaveBeenCalled();
  });

  it("PLUGIN_INVOKE handler rejects when senderFrame is missing and does not dispatch", async () => {
    registerPluginHandlers();
    const invokeHandler = mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:invoke"
    )![1] as (...args: unknown[]) => unknown;

    const nullFrameEvent = { senderFrame: null, sender: { id: 1 } };
    await expect(invokeHandler(nullFrameEvent, "acme.my-plugin", "get-data")).rejects.toThrow(
      "plugin:invoke rejected: untrusted sender"
    );
    expect(mockDispatchHandler).not.toHaveBeenCalled();
  });
});

describe("PLUGIN_VALIDATE_ACTION_IDS handler", () => {
  function getValidateHandler() {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find(
      (c: unknown[]) => c[0] === "plugin:validate-action-ids"
    )![1] as (event: unknown, actionIds: string[]) => Promise<void>;
  }

  it("does nothing when there are no plugin contributions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.a", "action.b"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not warn when every toolbar button actionId is known", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.my.button"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.my.button",
      label: "My Button",
      iconId: "icon",
      actionId: "action.known",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known", "action.other"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("warns with the exact message when a toolbar button actionId is unknown", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.my.button"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.my.button",
      label: "My Button",
      iconId: "icon",
      actionId: "action.missing",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Plugin] Unknown actionId "action.missing" on toolbar button "plugin.my.button" (plugin: acme.my-plugin)'
    );
    warn.mockRestore();
  });

  it("warns with the exact message when a menu item actionId is unknown", async () => {
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "acme.my-plugin",
        item: {
          label: "Do Thing",
          actionId: "action.missing",
          location: "view",
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.known"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[Plugin] Unknown actionId "action.missing" on menu item "Do Thing" (plugin: acme.my-plugin)'
    );
    warn.mockRestore();
  });

  it("warns only for unknown actionIds when contributions are mixed", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a", "plugin.b"]);
    mockGetToolbarButtonConfig.mockImplementation((id: string) => {
      if (id === "plugin.a") {
        return {
          id: "plugin.a",
          label: "A",
          iconId: "i",
          actionId: "action.ok",
          priority: 3,
          pluginId: "p1",
        };
      }
      return {
        id: "plugin.b",
        label: "B",
        iconId: "i",
        actionId: "action.bad",
        priority: 3,
        pluginId: "p2",
      };
    });
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "p3",
        item: { label: "Menu OK", actionId: "action.ok", location: "view" },
      },
      {
        pluginId: "p4",
        item: { label: "Menu Bad", actionId: "action.bad2", location: "view" },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["action.ok"]);
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((c) => c[0] as string).join("\n");
    expect(messages).toContain("action.bad");
    expect(messages).toContain("action.bad2");
    expect(messages).not.toContain("action.ok");
    warn.mockRestore();
  });

  it("skips toolbar button ids with no config", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.orphan"]);
    mockGetToolbarButtonConfig.mockReturnValue(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, [])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resolves without throwing when warnings are emitted", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, [])).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["string", "action.a"],
    ["object", { a: 1 }],
  ])("does not warn when payload is a non-array (%s)", async (_label, payload) => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await expect(handler({}, payload as unknown as string[])).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("recognises plugin-registered actionIds from pluginService.listPluginActions", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.btn"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.btn",
      label: "Btn",
      iconId: "i",
      actionId: "acme.my-plugin.doThing",
      priority: 3,
      pluginId: "acme.my-plugin",
    });
    mockGetPluginMenuItems.mockReturnValue([
      {
        pluginId: "acme.my-plugin",
        item: { label: "Do", actionId: "acme.my-plugin.other", location: "terminal" },
      },
    ]);
    mockListPluginActions.mockReturnValue([
      { pluginId: "acme.my-plugin", id: "acme.my-plugin.doThing" },
      { pluginId: "acme.my-plugin", id: "acme.my-plugin.other" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, ["terminal.list"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("validates on every invocation", async () => {
    mockGetPluginToolbarButtonIds.mockReturnValue(["plugin.a"]);
    mockGetToolbarButtonConfig.mockReturnValue({
      id: "plugin.a",
      label: "A",
      iconId: "i",
      actionId: "action.missing",
      priority: 3,
      pluginId: "p1",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = getValidateHandler();
    await handler({}, []);
    await handler({}, []);
    await handler({}, []);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("PLUGIN_ACTIONS_GET / REGISTER / UNREGISTER handlers", () => {
  function getHandler(channel: string) {
    registerPluginHandlers();
    return mockIpcMainHandle.mock.calls.find((c: unknown[]) => c[0] === channel)![1] as (
      ...args: unknown[]
    ) => unknown;
  }

  it("PLUGIN_ACTIONS_GET returns the list from pluginService", async () => {
    const actions = [
      {
        pluginId: "acme.my-plugin",
        id: "acme.my-plugin.doThing",
        title: "Do Thing",
        description: "Does a thing",
        category: "plugin",
        kind: "command",
        danger: "safe",
      },
    ];
    mockListPluginActions.mockReturnValue(actions);
    const handler = getHandler("plugin:actions-get");
    const result = await handler({});
    expect(result).toEqual(actions);
  });

  it("PLUGIN_ACTIONS_REGISTER delegates to pluginService.registerPluginAction", async () => {
    const handler = getHandler("plugin:actions-register");
    const contribution = {
      id: "acme.my-plugin.doThing",
      title: "Do Thing",
      description: "Does a thing",
      category: "plugin",
      kind: "command",
      danger: "safe",
    };
    await handler({}, "acme.my-plugin", contribution);
    expect(mockRegisterPluginAction).toHaveBeenCalledWith("acme.my-plugin", contribution);
  });

  it("PLUGIN_ACTIONS_REGISTER propagates errors from pluginService", async () => {
    mockRegisterPluginAction.mockImplementation(() => {
      throw new Error('Plugin action "bad.id" is invalid');
    });
    const handler = getHandler("plugin:actions-register");
    await expect(handler({}, "acme.my-plugin", { id: "bad.id" })).rejects.toThrow(/Plugin action/);
  });

  it("PLUGIN_ACTIONS_UNREGISTER delegates to pluginService.unregisterPluginAction", async () => {
    const handler = getHandler("plugin:actions-unregister");
    await handler({}, "acme.my-plugin", "acme.my-plugin.doThing");
    expect(mockUnregisterPluginAction).toHaveBeenCalledWith(
      "acme.my-plugin",
      "acme.my-plugin.doThing"
    );
  });
});

describe("registerPluginHandler", () => {
  it("delegates to pluginService.registerHandler", () => {
    const handler = vi.fn();
    registerPluginHandler("acme.my-plugin", "my-channel", handler);
    expect(mockRegisterHandler).toHaveBeenCalledWith("acme.my-plugin", "my-channel", handler);
  });
});

describe("removePluginHandlers", () => {
  it("delegates to pluginService.removeHandlers", () => {
    removePluginHandlers("acme.my-plugin");
    expect(mockRemoveHandlers).toHaveBeenCalledWith("acme.my-plugin");
  });
});
