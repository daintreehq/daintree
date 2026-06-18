import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));

const serviceMock = vi.hoisted(() => ({
  getStatus: vi.fn<() => { enabled: boolean; port: number | null; hasApiKey: boolean }>(() => ({
    enabled: false,
    port: null,
    hasApiKey: false,
  })),
  setEnabled: vi.fn().mockResolvedValue(undefined),
  setPort: vi.fn().mockResolvedValue(undefined),
  rotateApiKey: vi.fn().mockResolvedValue("k-new"),
  getConfigSnippet: vi.fn(() => "snippet"),
  getAuditRecords: vi.fn(() => []),
  getLogRecords: vi.fn(() => []),
  getAuditConfig: vi.fn(() => ({ enabled: true, maxRecords: 500 })),
  clearAuditLog: vi.fn(),
  getTurnOutcomeRecords: vi.fn(() => []),
  clearTurnOutcomeLog: vi.fn(),
  setAuditEnabled: vi.fn(() => ({ enabled: true, maxRecords: 500 })),
  setAuditMaxRecords: vi.fn(() => ({ enabled: true, maxRecords: 500 })),
  getRuntimeState: vi.fn(() => ({
    enabled: false,
    state: "disabled" as const,
    port: null,
    lastError: null,
  })),
  onRuntimeStateChange: vi.fn(() => () => {}),
  listActiveBearers: vi.fn(() => []),
  disconnectBearer: vi.fn((tokenHash: string) => ({ tokenHash, disconnected: true })),
  resetDenialCounts: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: { getVersion: () => "0.0.0-test" },
  // withContext handlers resolve the sender window via BrowserWindow —
  // stub it so the context-bearing ops (resetDenialCounts) don't blow up.
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock("../../../services/McpServerService.js", () => ({ mcpServerService: serviceMock }));

import { registerMcpServerHandlers } from "../mcpServer.js";
import { CHANNELS } from "../../channels.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const fn = ipcHandlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn as Handler;
}

function fakeEvent(): Electron.IpcMainInvokeEvent {
  return { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent;
}

describe("mcpServer IPC adversarial", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    serviceMock.getStatus.mockReturnValue({ enabled: false, port: null, hasApiKey: false });
    cleanup = registerMcpServerHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("setPort rejects port below 1024 (privileged range)", async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), 1023)).rejects.toThrow(
      /1024 and 65535/
    );
    expect(serviceMock.setPort).not.toHaveBeenCalled();
  });

  it("setPort rejects port above 65535", async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), 65536)).rejects.toThrow(
      /1024 and 65535/
    );
  });

  it("setPort rejects non-integer numeric (1.5)", async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), 1.5)).rejects.toThrow(
      /integer/
    );
  });

  it("setPort rejects NaN and Infinity", async () => {
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), Number.NaN)
    ).rejects.toThrow();
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), Number.POSITIVE_INFINITY)
    ).rejects.toThrow();
  });

  it('setPort rejects string-encoded port ("45454")', async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), "45454")).rejects.toThrow(
      /integer/
    );
  });

  it("setPort accepts 1024 and 65535 exactly (boundary ok)", async () => {
    await getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), 1024);
    await getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), 65535);
    expect(serviceMock.setPort).toHaveBeenCalledTimes(2);
  });

  it("setPort accepts null (auto-select)", async () => {
    await getHandler(CHANNELS.MCP_SERVER_SET_PORT)(fakeEvent(), null);
    expect(serviceMock.setPort).toHaveBeenCalledWith(null);
  });

  it("setEnabled rejects non-boolean values", async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_ENABLED)(fakeEvent(), "true")).rejects.toThrow(
      /boolean/
    );
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_ENABLED)(fakeEvent(), 1)).rejects.toThrow(
      /boolean/
    );
    expect(serviceMock.setEnabled).not.toHaveBeenCalled();
  });

  it("setEnabled returns the post-mutation status (not pre-call cached)", async () => {
    const newStatus = { enabled: true, port: 4040, hasApiKey: true };
    serviceMock.setEnabled.mockImplementationOnce(async () => {
      serviceMock.getStatus.mockReturnValue(newStatus);
    });

    const result = await getHandler(CHANNELS.MCP_SERVER_SET_ENABLED)(fakeEvent(), true);
    expect(result).toEqual(newStatus);
  });

  it("rotateApiKey passes through the service-rotated key", async () => {
    serviceMock.rotateApiKey.mockResolvedValue("rotated-secret-123");
    const result = await getHandler(CHANNELS.MCP_SERVER_ROTATE_API_KEY)(fakeEvent());
    expect(result).toBe("rotated-secret-123");
    expect(serviceMock.rotateApiKey).toHaveBeenCalledTimes(1);
  });

  it("setAuditEnabled rejects non-boolean values", async () => {
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_ENABLED)(fakeEvent(), "true")
    ).rejects.toThrow(/boolean/);
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_ENABLED)(fakeEvent(), 1)).rejects.toThrow(
      /boolean/
    );
    expect(serviceMock.setAuditEnabled).not.toHaveBeenCalled();
  });

  it("setAuditMaxRecords rejects non-integer or out-of-range values", async () => {
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), 49)
    ).rejects.toThrow(/between/);
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), 10001)
    ).rejects.toThrow(/between/);
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), 1.5)
    ).rejects.toThrow(/integer/);
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), Number.NaN)
    ).rejects.toThrow();
    await expect(
      getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), "500")
    ).rejects.toThrow(/integer/);
    expect(serviceMock.setAuditMaxRecords).not.toHaveBeenCalled();
  });

  it("setAuditMaxRecords accepts boundary values", async () => {
    await getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), 50);
    await getHandler(CHANNELS.MCP_SERVER_SET_AUDIT_MAX_RECORDS)(fakeEvent(), 10000);
    expect(serviceMock.setAuditMaxRecords).toHaveBeenCalledTimes(2);
  });

  it("getAuditRecords passes through service result", async () => {
    serviceMock.getAuditRecords.mockReturnValueOnce([
      {
        id: "x",
        timestamp: 1,
        toolId: "t",
        sessionId: "s",
        tier: "unknown",
        argsSummary: "{}",
        result: "success",
        durationMs: 0,
      },
    ] as never);
    const result = await getHandler(CHANNELS.MCP_SERVER_GET_AUDIT_RECORDS)(fakeEvent());
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(1);
  });

  it("getLogRecords returns the full union (dispatch + grant) and does not call the dispatch variant (#10027)", async () => {
    const mixed = [
      {
        id: "a",
        timestamp: 2,
        toolId: "t",
        sessionId: "s",
        tier: "unknown",
        argsSummary: "{}",
        result: "success",
        durationMs: 0,
      },
      {
        id: "g",
        timestamp: 1,
        type: "grant.issued",
        sessionId: "s",
        toolId: "files.search",
        ttlMs: 60000,
      },
    ] as never;
    serviceMock.getLogRecords.mockReturnValueOnce(mixed);
    const result = await getHandler(CHANNELS.MCP_SERVER_GET_LOG_RECORDS)(fakeEvent());
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(2);
    expect(serviceMock.getLogRecords).toHaveBeenCalledTimes(1);
    // Make sure the new channel routes to the union accessor, not the
    // legacy dispatch-only one — a typo in the handler would silently
    // re-introduce the original bug.
    expect(serviceMock.getAuditRecords).not.toHaveBeenCalled();
  });

  it("clearAuditLog calls service clear", async () => {
    await getHandler(CHANNELS.MCP_SERVER_CLEAR_AUDIT_LOG)(fakeEvent());
    expect(serviceMock.clearAuditLog).toHaveBeenCalledTimes(1);
  });

  it("getTurnOutcomeRecords passes through service result", async () => {
    serviceMock.getTurnOutcomeRecords.mockReturnValueOnce([
      {
        id: "turn-1",
        timestamp: 1,
        terminalId: "t1",
        sessionId: "s1",
        outcome: "answered",
      },
    ] as never);
    const result = await getHandler(CHANNELS.MCP_SERVER_GET_TURN_OUTCOME_RECORDS)(fakeEvent());
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(1);
  });

  it("clearTurnOutcomeLog calls service clear", async () => {
    await getHandler(CHANNELS.MCP_SERVER_CLEAR_TURN_OUTCOME_LOG)(fakeEvent());
    expect(serviceMock.clearTurnOutcomeLog).toHaveBeenCalledTimes(1);
  });

  const DISCONNECT_BEARER_CHANNEL = "mcp-server:disconnect-bearer";

  it("disconnectBearer rejects a non-hex / wrong-length tokenHash", async () => {
    const bad = ["", "xyz", "a".repeat(63), "a".repeat(65), "A".repeat(64), 42, null];
    for (const value of bad) {
      await expect(getHandler(DISCONNECT_BEARER_CHANNEL)(fakeEvent(), value)).rejects.toThrow(
        /Invalid tokenHash/
      );
    }
    expect(serviceMock.disconnectBearer).not.toHaveBeenCalled();
  });

  it("disconnectBearer forwards a valid 64-char lowercase hex hash to the service", async () => {
    const valid = "a".repeat(64);
    await expect(getHandler(DISCONNECT_BEARER_CHANNEL)(fakeEvent(), valid)).resolves.toEqual({
      tokenHash: valid,
      disconnected: true,
    });
    expect(serviceMock.disconnectBearer).toHaveBeenCalledWith(valid);
  });

  const RESET_DENIAL_COUNTS_CHANNEL = "mcp-server:reset-denial-counts";

  it("resetDenialCounts rejects a non-object payload", async () => {
    for (const bad of [null, undefined, "s1", 42]) {
      await expect(getHandler(RESET_DENIAL_COUNTS_CHANNEL)(fakeEvent(), bad)).rejects.toThrow(
        /Invalid payload/
      );
    }
    expect(serviceMock.resetDenialCounts).not.toHaveBeenCalled();
  });

  it("resetDenialCounts rejects an empty or non-string sessionId", async () => {
    for (const sessionId of ["", 42, null, undefined]) {
      await expect(
        getHandler(RESET_DENIAL_COUNTS_CHANNEL)(fakeEvent(), { sessionId })
      ).rejects.toThrow(/Invalid sessionId/);
    }
    expect(serviceMock.resetDenialCounts).not.toHaveBeenCalled();
  });

  it("resetDenialCounts forwards a valid sessionId to the service with the caller's webContents id", async () => {
    const event = {
      sender: { id: 77 } as Electron.WebContents,
    } as Electron.IpcMainInvokeEvent;
    await getHandler(RESET_DENIAL_COUNTS_CHANNEL)(event, { sessionId: "sess-7" });
    // The caller-pin id must ride along so the service can reject a renderer
    // that doesn't own the session.
    expect(serviceMock.resetDenialCounts).toHaveBeenCalledWith("sess-7", 77);
  });

  it("cleanup removes all twenty-six registered handlers", () => {
    // 24 baseline + issueNativeGrant + revokeNativeGrant (#10648).
    expect(ipcHandlers.size).toBe(26);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
