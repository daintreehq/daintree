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
  // Mirrors the real wrapper: parse the first arg with the Zod schema, then
  // invoke the handler with (ctx, parsedPayload). Tests pass a ctx-like object
  // (carrying webContentsId) as the first stored-handler argument.
  typedHandleWithContextValidated: (
    channel: string,
    schema: { parse: (v: unknown) => unknown },
    handler: unknown
  ) => {
    // async so a synchronous schema.parse throw surfaces as a rejected promise
    // (matching the real wrapper / ipcMain.handle behaviour the handler relies on).
    ipcMainMock.handle(channel, async (ctx: unknown, payload: unknown) => {
      const parsed = schema.parse(payload);
      return (handler as (c: unknown, p: unknown) => unknown)(ctx, parsed);
    });
    return () => ipcMainMock.removeHandler(channel);
  },
}));

vi.mock("../../utils.js", () => utilsMock);

const mcpServiceMock = vi.hoisted(() => ({
  getHelpSessionLiveStatus: vi.fn(),
}));

vi.mock("../../../services/McpServerService.js", () => ({ mcpServerService: mcpServiceMock }));

import { registerHelpAssistantHandlers } from "../helpAssistant.js";

const GET_CHANNEL = "help-assistant:get-settings";
const SET_CHANNEL = "help-assistant:set-settings";
const LIVE_STATUS_CHANNEL = "help-assistant:get-live-session-status";

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
      tier: "action",
      bypassPermissions: false,
      auditRetention: 7,
      modelId: "",
      customArgs: "",
      idleHibernateMinutes: 30,
    });
  });

  it("merges stored values over defaults so legacy partial state still loads", async () => {
    storeMock.get.mockReturnValue({
      tier: "system",
      bypassPermissions: true,
      auditRetention: 30,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      tier: "system",
      bypassPermissions: true,
      auditRetention: 30,
      modelId: "",
      customArgs: "",
      idleHibernateMinutes: 30,
    });
  });

  it("migrates legacy skipPermissions=true to tier='system' + bypassPermissions=true", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: true,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "system", bypassPermissions: true });
  });

  it("migrates legacy skipPermissions=false to tier='action' + bypassPermissions=false", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "action", bypassPermissions: false });
  });

  it("prefers new fields over legacy skipPermissions when both are present", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: true,
      tier: "action",
      bypassPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "action", bypassPermissions: false });
  });

  it("rejects an invalid stored tier and falls back to default", async () => {
    storeMock.get.mockReturnValue({
      tier: "external",
      bypassPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "action", bypassPermissions: false });
  });

  it("persists each touched key under helpAssistant.<field>", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: false, bypassPermissions: true });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.docSearch", false);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.bypassPermissions", true);
    expect(storeMock.set).toHaveBeenCalledTimes(2);
  });

  it("persists tier when set to a valid value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { tier: "system" });
    await handler(null, { tier: "workbench" });
    await handler(null, { tier: "action" });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.tier", "system");
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.tier", "workbench");
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.tier", "action");
  });

  it("rejects tier values outside the valid HelpAssistantTier union", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { tier: "external" });
    await handler(null, { tier: "off" });
    await handler(null, { tier: 0 });

    expect(storeMock.set).not.toHaveBeenCalled();
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

    await handler(null, { docSearch: "yes", daintreeControl: 1, bypassPermissions: 0 });

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
      tier: null as unknown as "action",
      bypassPermissions: "yes" as unknown as boolean,
      auditRetention: 365 as unknown as 7,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      tier: "action",
      bypassPermissions: false,
      auditRetention: 7,
      modelId: "",
      customArgs: "",
      idleHibernateMinutes: 30,
    });
  });

  it("rejects idleHibernateMinutes values outside the supported set", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { idleHibernateMinutes: 5 });
    await handler(null, { idleHibernateMinutes: 45 });
    await handler(null, { idleHibernateMinutes: -1 });
    await handler(null, { idleHibernateMinutes: "30" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("accepts each valid idleHibernateMinutes value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    for (const minutes of [0, 15, 30, 60, 120]) {
      await handler(null, { idleHibernateMinutes: minutes });
    }

    expect(storeMock.set).toHaveBeenCalledTimes(5);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 0);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 15);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 30);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 60);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 120);
  });

  it("loads a valid stored idleHibernateMinutes from the store", async () => {
    storeMock.get.mockReturnValue({ idleHibernateMinutes: 60 });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ idleHibernateMinutes: 60 });
  });

  it("rejects an out-of-range stored idleHibernateMinutes and falls back to default", async () => {
    storeMock.get.mockReturnValue({
      idleHibernateMinutes: 999,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ idleHibernateMinutes: 30 });
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
    // Extended deny-list (#7078): chaining, redirection, variable expansion, escape.
    await handler(null, { customArgs: "--model sonnet & whoami" });
    await handler(null, { customArgs: "--verbose > /etc/passwd" });
    await handler(null, { customArgs: "--config < /etc/shadow" });
    await handler(null, { customArgs: "--log >> /tmp/out" });
    await handler(null, { customArgs: "--err 2> /tmp/err" });
    await handler(null, { customArgs: "--model ${HOME}" });
    await handler(null, { customArgs: "--flag\\;evil" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("allows customArgs containing a bare $ without ( or { (no over-blocking)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { customArgs: "--prompt-suffix $TODAY" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "helpAssistant.customArgs",
      "--prompt-suffix $TODAY"
    );
  });

  it("rejects metacharacters past the 10000-char cap (check before truncation)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    // Metachar at position > CUSTOM_ARGS_MAX_LEN must still be caught — the
    // deny-list check runs on the full collapsed string before slice().
    await handler(null, { customArgs: "x".repeat(10000) + "; touch /tmp/pwned" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("catches metacharacters formed after control-char stripping", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    // Control-char stripping happens before the deny-list check, so a value
    // crafted to hide `$(` behind a NUL byte must still be rejected once the
    // NUL is removed.
    await handler(null, { customArgs: "--x $\x00(whoami)" });

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

  it("persists a valid modelId", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "claude-sonnet-4-6" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith(
      "helpAssistant.modelId",
      "claude-sonnet-4-6"
    );
  });

  it("persists an empty modelId so the user can clear back to the CLI default", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelId", "");
  });

  it("trims surrounding whitespace from modelId", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "  gpt-5.5  " });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelId", "gpt-5.5");
  });

  it("rejects a modelId with internal whitespace (not a single token)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "claude sonnet" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a modelId that would inject a bare flag (leading dash)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "--dangerously-skip-permissions" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a modelId containing shell metacharacters", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "sonnet;rm -rf /" });
    await handler(null, { modelId: "$(whoami)" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a modelId that is not a string", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: 42 as unknown as string });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("caps modelId length at 200 characters", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "m".repeat(250) });

    const call = storeMock.set.mock.calls[0];
    expect(call?.[0]).toBe("helpAssistant.modelId");
    expect((call?.[1] as string).length).toBe(200);
  });

  it("loads a valid stored modelId from the store", async () => {
    storeMock.get.mockReturnValue({ modelId: "claude-opus-4-8" });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ modelId: "claude-opus-4-8" });
  });

  it("sanitizes a corrupted stored modelId back to the empty-string default", async () => {
    storeMock.get.mockReturnValue({
      modelId: "sonnet;rm -rf /" as unknown as string,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ modelId: "" });
  });
});

describe("registerHelpAssistantHandlers — getLiveSessionStatus (#10032)", () => {
  const CTX = { webContentsId: 4242 };

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainMock._handlers.clear();
  });

  it("returns a connected snapshot shaped from the service result", async () => {
    mcpServiceMock.getHelpSessionLiveStatus.mockReturnValue({
      tier: "system",
      activeGrants: [{ toolId: "terminal.kill", expiresAt: 1000, ttlMs: 500 }],
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    const result = await handler(CTX, { sessionId: "help-1" });

    expect(result).toEqual({
      connected: true,
      tier: "system",
      activeGrants: [{ toolId: "terminal.kill", expiresAt: 1000, ttlMs: 500 }],
    });
    // The public help id and the caller's webContentsId are threaded through.
    expect(mcpServiceMock.getHelpSessionLiveStatus).toHaveBeenCalledWith("help-1", 4242);
  });

  it("returns safe disconnected defaults when the service finds no live session", async () => {
    mcpServiceMock.getHelpSessionLiveStatus.mockReturnValue(null);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    const result = await handler(CTX, { sessionId: "help-1" });

    expect(result).toEqual({ connected: false, tier: "workbench", activeGrants: [] });
  });

  it("narrows an unexpected external tier down to a safe HelpAssistantTier", async () => {
    // Help sessions are never "external", but the service tier is an McpTier
    // which admits it — the handler must never surface it on the IPC contract.
    mcpServiceMock.getHelpSessionLiveStatus.mockReturnValue({
      tier: "external",
      activeGrants: [],
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    const result = await handler(CTX, { sessionId: "help-1" });

    expect(result).toMatchObject({ connected: true, tier: "workbench" });
  });

  it("rejects a payload with a missing/empty sessionId before reaching the service", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    await expect(handler(CTX, { sessionId: "" })).rejects.toThrow();
    await expect(handler(CTX, {})).rejects.toThrow();
    expect(mcpServiceMock.getHelpSessionLiveStatus).not.toHaveBeenCalled();
  });
});
