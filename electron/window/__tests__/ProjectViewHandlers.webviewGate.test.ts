import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp"), isPackaged: false, on: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  shell: { openExternal: vi.fn() },
  dialog: {},
  session: {},
}));

import { isWebviewSrcAllowed, setRemoteWebviewSrcGate } from "../ProjectViewHandlers.js";

describe("webview src gate", () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it("keeps today's rule with no remote gate installed", () => {
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "http://dp-a-b.localhost:43000/")).toBe(true);
    expect(isWebviewSrcAllowed(7, "https://example.com/")).toBe(false);
  });

  it("lets a remote-bound view load only what its gate allows, and local views keep the local rule", () => {
    dispose = setRemoteWebviewSrcGate((webContentsId, src) =>
      webContentsId === 9 ? src === "http://localhost:5173/" : null
    );
    expect(isWebviewSrcAllowed(9, "http://localhost:5173/")).toBe(true);
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(false);
    expect(isWebviewSrcAllowed(7, "http://localhost:3000/")).toBe(true);
  });

  it("stops applying a gate once it is disposed", () => {
    setRemoteWebviewSrcGate(() => false)();
    expect(isWebviewSrcAllowed(9, "http://localhost:3000/")).toBe(true);
  });
});
