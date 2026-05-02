import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    _handlers: handlers,
  };
});

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => undefined),
  set: vi.fn(),
}));

vi.mock("../../../store.js", () => ({ store: storeMock }));

const utilsMock = vi.hoisted(() => ({
  typedHandle: (channel: string, handler: unknown) => {
    ipcMainMock.handle(channel, (_e: unknown, ...args: unknown[]) =>
      (handler as (...a: unknown[]) => unknown)(...args)
    );
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../utils.js", () => utilsMock);

import { registerHelpAssistantHandlers } from "../helpAssistant.js";

const GET_CHANNEL = "help-assistant:get-settings";
const SET_CHANNEL = "help-assistant:set-settings";

describe("registerHelpAssistantHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
    storeMock.get.mockReturnValue(undefined);
  });

  it("returns hard-coded defaults when the store has no value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;
    expect(handler).toBeDefined();

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      skipPermissions: false,
      auditRetention: 7,
    });
  });

  it("merges stored values over defaults so legacy partial state still loads", async () => {
    storeMock.get.mockReturnValue({ skipPermissions: true, auditRetention: 30 });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      skipPermissions: true,
      auditRetention: 30,
    });
  });

  it("persists each touched key under helpAssistant.<field>", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: false, skipPermissions: true });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.docSearch", false);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.skipPermissions", true);
    expect(storeMock.set).toHaveBeenCalledTimes(2);
  });

  it("ignores undefined values so partial patches do not erase keys", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: undefined, daintreeControl: false });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.daintreeControl", false);
  });

  it("rejects non-object payloads silently", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, null);
    await handler(null, "nope");
    await handler(null, undefined);

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects auditRetention values outside the supported set", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { auditRetention: 90 });
    await handler(null, { auditRetention: "7" });
    await handler(null, { auditRetention: -1 });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("accepts the three valid auditRetention values", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { auditRetention: 0 });
    await handler(null, { auditRetention: 7 });
    await handler(null, { auditRetention: 30 });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.auditRetention", 0);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.auditRetention", 7);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.auditRetention", 30);
  });

  it("rejects boolean fields that are not actually booleans", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: "yes", daintreeControl: 1, skipPermissions: 0 });

    expect(storeMock.set).not.toHaveBeenCalled();
  });
});
