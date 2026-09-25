import { afterAll, describe, expect, it, vi } from "vitest";

// A host's MCP server reaches the local view that drives its project through
// this machine's renderer bridge. The bridge's response listeners otherwise
// exist only while this machine's own server runs, so the passthrough has to
// bring them up itself, once.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-host-dispatch-${Math.random().toString(36).slice(2)}`
);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => testHomeDir),
    setPath: vi.fn(),
    getVersion: vi.fn(() => "0.0.0-test"),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  ipcMain: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: () => null,
  getWindowRegistry: () => null,
  setWindowRegistry: vi.fn(),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => [],
  getProjectForWebContents: () => null,
}));

import { McpServerService } from "../McpServerService.js";

describe("McpServerService host passthroughs", () => {
  const service = new McpServerService();

  afterAll(() => {
    service._sessionStore.drain();
    service._sessionStore.grantCache.dispose();
  });

  it("dispatches into the named view with the host's approval options, listening once", async () => {
    const bridge = service._bridge;
    const setupListeners = vi.spyOn(bridge, "setupListeners").mockImplementation(() => {});
    const envelope = { result: { ok: true as const, result: null } };
    const dispatch = vi
      .spyOn(bridge, "dispatchActionForWebContents")
      .mockResolvedValue(envelope as never);
    const manifest = vi.spyOn(bridge, "requestManifestForWebContents").mockResolvedValue([]);

    await expect(
      service.dispatchActionForHost(11, "terminal.new", { a: 1 }, true, undefined, "external", {
        approvalOnly: true,
      })
    ).resolves.toBe(envelope);
    await service.requestManifestForHost(11);

    expect(dispatch).toHaveBeenCalledWith(
      11,
      "terminal.new",
      { a: 1 },
      true,
      undefined,
      "external",
      {
        approvalOnly: true,
      }
    );
    expect(manifest).toHaveBeenCalledWith(11);
    expect(setupListeners).toHaveBeenCalledTimes(1);
  });
});
