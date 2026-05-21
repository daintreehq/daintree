import { describe, expect, it, vi, beforeEach } from "vitest";

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { getVersion: vi.fn(() => "1.0.0"), getPath: vi.fn(() => "/tmp") },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      ipcHandlers.delete(channel);
    }),
  },
}));

const panelSuspectLedger = {
  clearQuarantinedPanel: vi.fn((_panelId: string) => false),
};

vi.mock("../../services/PanelSuspectLedgerService.js", () => ({
  getPanelSuspectLedger: () => panelSuspectLedger,
}));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    assertIpcSecurityReady: vi.fn(),
  };
});

import { registerSafeModeHandlers } from "../handlers/safeMode.js";

async function invokeClear(panelId: unknown) {
  const cleanup = registerSafeModeHandlers();
  const handler = ipcHandlers.get("app:clear-quarantined-panel");
  if (!handler) throw new Error("app:clear-quarantined-panel handler not registered");
  // ipcMain.handle passes (event, ...args); the test's stub captures the wrapped
  // callback so we must reproduce the IPC-event arg.
  const result = (await handler({}, panelId)) as { cleared: boolean };
  cleanup();
  return result;
}

describe("app:clear-quarantined-panel handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    panelSuspectLedger.clearQuarantinedPanel.mockReset();
  });

  it("forwards the request to the ledger when given a non-empty string id", async () => {
    panelSuspectLedger.clearQuarantinedPanel.mockReturnValue(true);
    const result = await invokeClear("panel-1");
    expect(panelSuspectLedger.clearQuarantinedPanel).toHaveBeenCalledWith("panel-1");
    expect(result).toEqual({ cleared: true });
  });

  it("reports cleared=false when the ledger had no record", async () => {
    panelSuspectLedger.clearQuarantinedPanel.mockReturnValue(false);
    const result = await invokeClear("missing-panel");
    expect(result).toEqual({ cleared: false });
  });

  it("rejects an empty string id without calling the ledger", async () => {
    const result = await invokeClear("");
    expect(panelSuspectLedger.clearQuarantinedPanel).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false });
  });

  it("rejects non-string ids without calling the ledger", async () => {
    const result = await invokeClear(42);
    expect(panelSuspectLedger.clearQuarantinedPanel).not.toHaveBeenCalled();
    expect(result).toEqual({ cleared: false });
  });
});
