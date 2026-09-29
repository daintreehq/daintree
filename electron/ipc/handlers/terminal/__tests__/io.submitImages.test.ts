/**
 * #12792: `terminal:submit` carries the composer's image chips as an optional
 * trailing argument. Drives the real `defineIpcNamespace` registration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: () => [] },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAppWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
  getWebContentsForProject: vi.fn(() => []),
  hasRegisteredProjectViews: vi.fn(() => true),
  isCachedViewWebContents: vi.fn(() => false),
}));

vi.mock("../../../../window/portDistribution.js", () => ({
  distributeTerminalWorkerPortToView: vi.fn(),
  releaseTerminalWorkerPort: vi.fn(),
}));

import { CHANNELS } from "../../../channels.js";
import { registerTerminalIOHandlers } from "../io.js";
import { _resetIpcGuardForTesting, markIpcSecurityReady } from "../../../ipcGuard.js";
import type { HandlerDependencies } from "../../../types.js";

const getTerminalAsync = vi.fn();
const submit = vi.fn();

function buildDeps(): HandlerDependencies {
  return {
    ptyClient: { getTerminalAsync, submit },
    windowRegistry: { getByWindowId: () => undefined },
  } as unknown as HandlerDependencies;
}

function submitViaIpc(...args: unknown[]): Promise<unknown> {
  const call = ipcMainMock.handle.mock.calls.find(
    ([channel]) => channel === CHANNELS.TERMINAL_SUBMIT
  );
  if (!call) throw new Error("submit handler was never registered");
  const registered = call[1] as (...handlerArgs: unknown[]) => Promise<unknown>;
  return registered({ sender: { id: 1 } }, ...args);
}

describe("terminal:submit image paths (#12792)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetIpcGuardForTesting();
    markIpcSecurityReady();
    getTerminalAsync.mockResolvedValue({ id: "term-1", hasPty: true });
    registerTerminalIOHandlers(buildDeps());
  });

  it("forwards image paths to the pty-host", async () => {
    await submitViaIpc("term-1", "see /a/shot.png", undefined, undefined, ["/a/shot.png"]);

    expect(submit).toHaveBeenCalledWith(
      "term-1",
      "see /a/shot.png",
      undefined,
      undefined,
      undefined,
      ["/a/shot.png"]
    );
  });

  it("keeps the existing call shape when no images ride along", async () => {
    await submitViaIpc("term-1", "hello");

    expect(submit).toHaveBeenCalledWith("term-1", "hello", undefined, undefined);
  });

  it.each([
    ["a non-array", "/a/shot.png"],
    ["a relative path", ["shot.png"]],
    ["a non-image", ["/a/notes.txt"]],
    ["a UNC share", ["\\\\server\\share\\shot.png"]],
    ["a non-string", [42]],
    ["too many paths", Array.from({ length: 33 }, (_, i) => `/a/${i}.png`)],
  ])("refuses %s without writing anything", async (_label, imagePaths) => {
    await expect(
      submitViaIpc("term-1", "text", undefined, undefined, imagePaths)
    ).rejects.toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });
});
