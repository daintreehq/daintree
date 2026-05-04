import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HelpAssistantSettings } from "../../../../shared/types/ipc/api.js";

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
  get: vi.fn<() => Partial<HelpAssistantSettings> | undefined>(() => undefined),
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
      customArgs: "",
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
      customArgs: "",
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

  it("does not persist unknown fields the renderer wasn't supposed to send", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    // Cast through unknown to bypass the typed Partial<HelpAssistantSettings> shape
    // — this exercises the runtime guard against unexpected keys.
    await handler(null, {
      docSearch: false,
      unknownTool: true,
    } as unknown as Partial<HelpAssistantSettings>);

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.docSearch", false);
  });

  it("falls back to defaults when stored data is corrupted", async () => {
    storeMock.get.mockReturnValue({
      docSearch: "not-a-boolean" as unknown as boolean,
      daintreeControl: 42 as unknown as boolean,
      skipPermissions: null as unknown as boolean,
      auditRetention: 365 as unknown as 7,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      skipPermissions: false,
      auditRetention: 7,
      customArgs: "",
    });
  });

  it("persists a valid customArgs string", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "--model sonnet" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "helpAssistant.customArgs",
      "--model sonnet"
    );
  });

  it("normalizes newlines to spaces in customArgs", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "--model sonnet\n--verbose" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "helpAssistant.customArgs",
      "--model sonnet --verbose"
    );
  });

  it("strips control characters from customArgs", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "--model\x00sonnet\x07" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "helpAssistant.customArgs",
      "--modelsonnet"
    );
  });

  it("rejects customArgs containing shell metacharacters", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "--model sonnet; rm -rf /" });
    await handler(null, { customArgs: "--model $(whoami)" });
    await handler(null, { customArgs: "--model `id`" });
    await handler(null, { customArgs: "--model | tee out" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects customArgs values that are not strings", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: 42 as unknown as string });
    await handler(null, { customArgs: ["--model", "sonnet"] as unknown as string });
    await handler(null, { customArgs: null as unknown as string });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("caps customArgs length at 10000 characters", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "x".repeat(10500) });

    const call = storeMock.set.mock.calls[0];
    expect(call?.[0]).toBe("helpAssistant.customArgs");
    expect((call?.[1] as string).length).toBe(10000);
  });

  it("sanitizes corrupted stored customArgs back to empty string default", async () => {
    storeMock.get.mockReturnValue({
      customArgs: "--model sonnet; rm -rf /" as unknown as string,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ customArgs: "" });
  });

  it("loads a valid stored customArgs from the store", async () => {
    storeMock.get.mockReturnValue({ customArgs: "--model sonnet" });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ customArgs: "--model sonnet" });
  });
});
