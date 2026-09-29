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
  pruneAuditByRetention: vi.fn(),
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
      runbookSearch: true,
      tier: "core",
      bypassPermissions: false,
      auditRetention: 7,
      modelIds: {},
      customArgs: "",
      idleHibernateMinutes: 5,
      debugLogging: false,
      loadGlobalHooksAndServers: false,
      daintreeConfirmations: "inherit",
    });
  });

  it("merges stored values over defaults so legacy partial state still loads", async () => {
    storeMock.get.mockReturnValue({
      tier: "full",
      bypassPermissions: true,
      auditRetention: 30,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      runbookSearch: true,
      tier: "full",
      bypassPermissions: true,
      auditRetention: 30,
      modelIds: {},
      customArgs: "",
      idleHibernateMinutes: 5,
      debugLogging: false,
      loadGlobalHooksAndServers: false,
      daintreeConfirmations: "inherit",
    });
  });

  it("migrates legacy skipPermissions=true to tier='full' + bypassPermissions=true", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: true,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "full", bypassPermissions: true });
  });

  it("migrates legacy skipPermissions=false to tier='core' + bypassPermissions=false", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "core", bypassPermissions: false });
  });

  it("prefers new fields over legacy skipPermissions when both are present", async () => {
    storeMock.get.mockReturnValue({
      skipPermissions: true,
      tier: "core",
      bypassPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "core", bypassPermissions: false });
  });

  it.each([
    ["workbench", "core"],
    ["action", "core"],
    ["system", "full"],
  ] as const)(
    "reads a tier stored before the core/full split (%s) as %s",
    async (stored, expected) => {
      storeMock.get.mockReturnValue({ tier: stored } as unknown as Partial<HelpAssistantSettings>);
      registerHelpAssistantHandlers();
      const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

      const result = await handler(null);
      expect(result).toMatchObject({ tier: expected });
    }
  );

  it("prefers a pre-split stored tier over legacy skipPermissions", async () => {
    // A stored ladder name is still a tier the user chose; skipPermissions is
    // only the fallback when no tier was ever written.
    storeMock.get.mockReturnValue({
      skipPermissions: true,
      tier: "action",
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "core" });
  });

  it("rejects an invalid stored tier and falls back to default", async () => {
    storeMock.get.mockReturnValue({
      tier: "external",
      bypassPermissions: false,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ tier: "core", bypassPermissions: false });
  });

  it("persists each touched key under helpAssistant.<field>", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: false, bypassPermissions: true });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.docSearch", false);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.bypassPermissions", true);
    expect(storeMock.set).toHaveBeenCalledTimes(2);
  });

  it("persists debugLogging and rejects a non-boolean value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { debugLogging: true });
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.debugLogging", true);

    storeMock.set.mockClear();
    await handler(null, { debugLogging: "yes" as unknown as boolean });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("persists loadGlobalHooksAndServers and rejects a non-boolean value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { loadGlobalHooksAndServers: true });
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.loadGlobalHooksAndServers", true);

    storeMock.set.mockClear();
    await handler(null, { loadGlobalHooksAndServers: "yes" as unknown as boolean });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("persists daintreeConfirmations and rejects values outside the union (#12874)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { daintreeConfirmations: "always-ask" });
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.daintreeConfirmations", "always-ask");

    storeMock.set.mockClear();
    await handler(null, { daintreeConfirmations: "never-ask" as unknown as "inherit" });
    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("reads a stored daintreeConfirmations, and anything unrecognised as inherit (#12874)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    storeMock.get.mockReturnValue({ daintreeConfirmations: "always-ask" });
    expect(await handler(null)).toMatchObject({ daintreeConfirmations: "always-ask" });

    storeMock.get.mockReturnValue({
      daintreeConfirmations: "skip" as unknown as "inherit",
    });
    expect(await handler(null)).toMatchObject({ daintreeConfirmations: "inherit" });
  });

  it("returns a stored debugLogging=true over the default", async () => {
    storeMock.get.mockReturnValue({ debugLogging: true });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ debugLogging: true });
  });

  it("persists tier when set to a valid value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { tier: "full" });
    await handler(null, { tier: "core" });

    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.tier", "full");
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.tier", "core");
    expect(storeMock.set).toHaveBeenCalledTimes(2);
  });

  it("rejects tier values outside the valid HelpAssistantTier union", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { tier: "external" });
    await handler(null, { tier: "off" });
    await handler(null, { tier: 0 });
    // Pre-split names are normalized on read but never accepted as a write.
    await handler(null, { tier: "workbench" });
    await handler(null, { tier: "action" });
    await handler(null, { tier: "system" });

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

  it("applies the new retention window to the MCP audit rings on a valid write (#10776)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { auditRetention: 30 });
    // Pruning is fired-and-forgotten after the await-import resolves — drain
    // the microtask/timer queue before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpServiceMock.pruneAuditByRetention).toHaveBeenCalledWith(30);
  });

  it("forwards the Off value (0) to the audit rings so pruning is disabled (#10776)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { auditRetention: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpServiceMock.pruneAuditByRetention).toHaveBeenCalledWith(0);
  });

  it("does not prune when the auditRetention value is rejected (#10776)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { auditRetention: 90 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(storeMock.set).not.toHaveBeenCalled();
    expect(mcpServiceMock.pruneAuditByRetention).not.toHaveBeenCalled();
  });

  it("does not prune when auditRetention is absent from the patch (#10776)", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { docSearch: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpServiceMock.pruneAuditByRetention).not.toHaveBeenCalled();
  });

  it("rejects boolean fields that are not actually booleans", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, {
      docSearch: "yes",
      daintreeControl: 1,
      runbookSearch: "on",
      bypassPermissions: 0,
    } as unknown as Partial<HelpAssistantSettings>);

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("persists runbookSearch and reads a stored false back", async () => {
    registerHelpAssistantHandlers();
    const set = ipcMainMock._handlers.get(SET_CHANNEL)!;
    await set(null, { runbookSearch: false });
    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.runbookSearch", false);

    storeMock.get.mockReturnValue({ runbookSearch: false });
    const get = ipcMainMock._handlers.get(GET_CHANNEL)!;
    const result = (await get(null)) as HelpAssistantSettings;
    expect(result.runbookSearch).toBe(false);
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
      runbookSearch: "no" as unknown as boolean,
      tier: null as unknown as "core",
      bypassPermissions: "yes" as unknown as boolean,
      auditRetention: 365 as unknown as 7,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toEqual({
      docSearch: true,
      daintreeControl: true,
      runbookSearch: true,
      tier: "core",
      bypassPermissions: false,
      auditRetention: 7,
      modelIds: {},
      customArgs: "",
      idleHibernateMinutes: 5,
      debugLogging: false,
      loadGlobalHooksAndServers: false,
      daintreeConfirmations: "inherit",
    });
  });

  it("rejects idleHibernateMinutes values outside the supported set", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { idleHibernateMinutes: 10 });
    await handler(null, { idleHibernateMinutes: 45 });
    await handler(null, { idleHibernateMinutes: -1 });
    await handler(null, { idleHibernateMinutes: "30" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("accepts each valid idleHibernateMinutes value", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    for (const minutes of [0, 5, 15, 30, 60, 120]) {
      await handler(null, { idleHibernateMinutes: minutes });
    }

    expect(storeMock.set).toHaveBeenCalledTimes(6);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 0);
    expect(storeMock.set).toHaveBeenCalledWith("helpAssistant.idleHibernateMinutes", 5);
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

  it("loads a stored 5-minute idleHibernateMinutes (newest option) from the store", async () => {
    storeMock.get.mockReturnValue({ idleHibernateMinutes: 5 });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ idleHibernateMinutes: 5 });
  });

  it("rejects an out-of-range stored idleHibernateMinutes and falls back to default", async () => {
    storeMock.get.mockReturnValue({
      idleHibernateMinutes: 999,
    } as unknown as Partial<HelpAssistantSettings>);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ idleHibernateMinutes: 5 });
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

  function setModelIds(patch: unknown) {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;
    return handler(null, { modelIds: patch });
  }

  it("persists a model for one agent as a whole-map write under a fixed path", async () => {
    await setModelIds({ claude: "claude-sonnet-4-6" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      claude: "claude-sonnet-4-6",
    });
  });

  it("merges a patch into the stored map without touching other agents", async () => {
    storeMock.get.mockReturnValue({ modelIds: { claude: "opus", gemini: "" } });

    await setModelIds({ codex: "gpt-6-astra" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      claude: "opus",
      gemini: "",
      codex: "gpt-6-astra",
    });
  });

  it("composes successive patches for different agents against what was stored", async () => {
    let stored: Partial<HelpAssistantSettings> | undefined = { modelIds: { claude: "opus" } };
    storeMock.get.mockImplementation(() => stored);
    storeMock.set.mockImplementation((key: string, value: unknown) => {
      if (key === "helpAssistant.modelIds") {
        stored = { ...stored, modelIds: value as Record<string, string> };
      }
    });

    await setModelIds({ codex: "gpt-6-sol" });
    await setModelIds({ gemini: "" });
    await setModelIds({ claude: null });

    expect(stored?.modelIds).toEqual({ codex: "gpt-6-sol", gemini: "" });
  });

  it("reads own keys that shadow Object.prototype names literally", async () => {
    storeMock.get.mockReturnValue({
      modelIds: JSON.parse('{"toString": "custom-model", "__proto__": "opus"}'),
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = (await handler(null)) as HelpAssistantSettings;
    expect(Object.keys(result.modelIds)).toEqual(["toString"]);
    expect(result.modelIds.toString).toBe("custom-model");
  });

  it("persists an empty model so the agent launches with the CLI default", async () => {
    await setModelIds({ claude: "" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      claude: "",
    });
  });

  it("removes only that agent's entry for a null so its recommended model applies again", async () => {
    storeMock.get.mockReturnValue({ modelIds: { claude: "opus", codex: "gpt-6-sol" } });

    await setModelIds({ claude: null });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      codex: "gpt-6-sol",
    });
  });

  it("writes nothing when the patch changes nothing", async () => {
    storeMock.get.mockReturnValue({ modelIds: { claude: "opus" } });

    await setModelIds({ claude: "opus" });
    await setModelIds({ codex: null });
    await setModelIds({});

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("keeps a dotted agent ID as a literal key", async () => {
    await setModelIds({ "my.agent": "custom-model" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      "my.agent": "custom-model",
    });
  });

  it("trims surrounding whitespace from a model", async () => {
    await setModelIds({ codex: "  gpt-5.5  " });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      codex: "gpt-5.5",
    });
  });

  it("rejects a model with internal whitespace (not a single token)", async () => {
    await setModelIds({ claude: "claude sonnet" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a model with an internal tab rather than collapsing it", async () => {
    // A tab is a control char; stripping-before-checking would silently coerce
    // this to "claudesonnet". It must be rejected as a non-single-token value.
    await setModelIds({ claude: "claude\tsonnet" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("accepts a model exactly at the 200-char cap unchanged", async () => {
    const exact = "m".repeat(200);
    await setModelIds({ claude: exact });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      claude: exact,
    });
  });

  it("rejects a model that would inject a bare flag (leading dash)", async () => {
    await setModelIds({ claude: "--dangerously-skip-permissions" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a model containing shell metacharacters", async () => {
    await setModelIds({ claude: "sonnet;rm -rf /" });
    await setModelIds({ claude: "$(whoami)" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects a model that is not a string", async () => {
    await setModelIds({ claude: 42 });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("rejects unsafe agent keys and non-map patches", async () => {
    await setModelIds({ "bad key": "opus", __proto__: "opus", "a/b": "opus" });
    await setModelIds(JSON.parse('{"__proto__": "opus"}'));
    await setModelIds(["opus"]);
    await setModelIds("opus");

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("applies the valid entries of a patch and skips the invalid ones", async () => {
    storeMock.get.mockReturnValue({ modelIds: { claude: "opus" } });

    await setModelIds({ claude: "$(whoami)", codex: "gpt-6-sol" });

    expect(storeMock.set).toHaveBeenCalledExactlyOnceWith("helpAssistant.modelIds", {
      claude: "opus",
      codex: "gpt-6-sol",
    });
  });

  it("caps a model at 200 characters", async () => {
    await setModelIds({ claude: "m".repeat(250) });

    const call = storeMock.set.mock.calls[0];
    expect(call?.[0]).toBe("helpAssistant.modelIds");
    expect((call?.[1] as Record<string, string>).claude.length).toBe(200);
  });

  it("ignores the legacy scalar modelId in a patch", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(SET_CHANNEL)!;

    await handler(null, { modelId: "opus" });

    expect(storeMock.set).not.toHaveBeenCalled();
  });

  it("loads a stored per-agent map", async () => {
    storeMock.get.mockReturnValue({ modelIds: { claude: "claude-opus-4-8", codex: "" } });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = await handler(null);
    expect(result).toMatchObject({ modelIds: { claude: "claude-opus-4-8", codex: "" } });
  });

  it("drops corrupted entries and unsafe keys from a stored map", async () => {
    storeMock.get.mockReturnValue({
      modelIds: {
        claude: "sonnet;rm -rf /",
        codex: "gpt-6-sol",
        gemini: null,
        "bad key": "opus",
      } as unknown as Record<string, string>,
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = (await handler(null)) as HelpAssistantSettings;
    expect(result.modelIds).toEqual({ codex: "gpt-6-sol" });
  });

  it("never exposes a leftover legacy scalar modelId", async () => {
    storeMock.get.mockReturnValue({ modelId: "opus" } as unknown as HelpAssistantSettings);
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(GET_CHANNEL)!;

    const result = (await handler(null)) as Record<string, unknown>;
    expect(result.modelIds).toEqual({});
    expect(result).not.toHaveProperty("modelId");
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
      tier: "full",
      activeGrants: [{ toolId: "terminal.kill", expiresAt: 1000, ttlMs: 500 }],
    });
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    const result = await handler(CTX, { sessionId: "help-1" });

    expect(result).toEqual({
      connected: true,
      tier: "full",
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

    expect(result).toEqual({ connected: false, tier: "core", activeGrants: [] });
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

    expect(result).toMatchObject({ connected: true, tier: "core" });
  });

  it("rejects a payload with a missing/empty sessionId before reaching the service", async () => {
    registerHelpAssistantHandlers();
    const handler = ipcMainMock._handlers.get(LIVE_STATUS_CHANNEL)!;

    await expect(handler(CTX, { sessionId: "" })).rejects.toThrow();
    await expect(handler(CTX, {})).rejects.toThrow();
    expect(mcpServiceMock.getHelpSessionLiveStatus).not.toHaveBeenCalled();
  });
});
