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
  setApiKey: vi.fn().mockResolvedValue(undefined),
  generateApiKey: vi.fn().mockResolvedValue("k-new"),
  getConfigSnippet: vi.fn(() => "snippet"),
}));

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
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

  it("setApiKey rejects non-string values", async () => {
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_API_KEY)(fakeEvent(), 42)).rejects.toThrow(
      /string/
    );
    await expect(getHandler(CHANNELS.MCP_SERVER_SET_API_KEY)(fakeEvent(), null)).rejects.toThrow(
      /string/
    );
  });

  it("generateApiKey passes through the service-generated key", async () => {
    serviceMock.generateApiKey.mockResolvedValue("new-secret-123");
    const result = await getHandler(CHANNELS.MCP_SERVER_GENERATE_API_KEY)(fakeEvent());
    expect(result).toBe("new-secret-123");
  });

  it("cleanup removes all six registered handlers", () => {
    expect(ipcHandlers.size).toBe(6);
    cleanup();
    expect(ipcHandlers.size).toBe(0);
  });
});
