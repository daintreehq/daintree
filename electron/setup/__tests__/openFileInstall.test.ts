import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallResult } from "../../../shared/types/plugin.js";

const envMock = vi.hoisted(() => ({
  getPendingOpenFilePaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenFilePaths: vi.fn(),
  setOpenFileConsumer: vi.fn<(c: ((p: string) => void) | null) => void>(),
}));

const utilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
}));

const pendingErrorsMock = vi.hoisted(() => ({
  appendPendingError: vi.fn(),
}));

const registryMock = vi.hoisted(() => ({
  // Default: one live renderer, so toasts fire. Tests that exercise the
  // no-renderer fallback override this to return [].
  getAllAppWebContents: vi.fn<() => { isDestroyed: () => boolean }[]>(() => [
    { isDestroyed: () => false },
  ]),
}));

vi.mock("../environment.js", () => envMock);
vi.mock("../../ipc/utils.js", () => utilsMock);
vi.mock("../../ipc/pendingErrorsStore.js", () => pendingErrorsMock);
vi.mock("../../window/webContentsRegistry.js", () => registryMock);
vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { NOTIFICATION_SHOW_TOAST: "notification:show-toast" },
}));

function makePluginService(result: PluginInstallResult) {
  return { installPlugin: vi.fn(async () => result) };
}

const SIDELOAD_OPTS = { source: "sideload", originalUrl: undefined };

describe("activateOpenFileInstaller", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envMock.getPendingOpenFilePaths.mockReturnValue([]);
    registryMock.getAllAppWebContents.mockReturnValue([{ isDestroyed: () => false }]);
  });

  it("sets a consumer and clears the queue even when empty", async () => {
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const svc = makePluginService({ status: "installed", pluginId: "x" });

    await activateOpenFileInstaller(svc);

    expect(envMock.setOpenFileConsumer).toHaveBeenCalledWith(expect.any(Function));
    expect(envMock.clearPendingOpenFilePaths).toHaveBeenCalledOnce();
    expect(svc.installPlugin).not.toHaveBeenCalled();
    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
  });

  it("installs each queued path with sideload provenance", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const svc = makePluginService({ status: "installed", pluginId: "x" });

    await activateOpenFileInstaller(svc);

    expect(svc.installPlugin).toHaveBeenCalledTimes(2);
    expect(svc.installPlugin).toHaveBeenCalledWith("/a.dntr", SIDELOAD_OPTS);
    expect(svc.installPlugin).toHaveBeenCalledWith("/b.dntr", SIDELOAD_OPTS);
  });

  it("drains the queue in FIFO order", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const svc = makePluginService({ status: "installed", pluginId: "x" });

    await activateOpenFileInstaller(svc);

    expect(svc.installPlugin).toHaveBeenNthCalledWith(1, "/a.dntr", SIDELOAD_OPTS);
    expect(svc.installPlugin).toHaveBeenNthCalledWith(2, "/b.dntr", SIDELOAD_OPTS);
  });

  it("drains sequentially — the next install waits for the previous to settle", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    let resolveFirst: (() => void) | null = null;
    const svc = {
      installPlugin: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<PluginInstallResult>((resolve) => {
              resolveFirst = () => resolve({ status: "installed", pluginId: "x" });
            })
        )
        .mockResolvedValue({ status: "installed", pluginId: "y" }),
    };
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    const done = activateOpenFileInstaller(svc);
    // First install is pending; the second must not have started yet.
    await Promise.resolve();
    expect(svc.installPlugin).toHaveBeenCalledTimes(1);

    resolveFirst!();
    await done;
    expect(svc.installPlugin).toHaveBeenCalledTimes(2);
  });

  it("shows a success toast naming the file on a successful install", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/dir/my-plugin.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller(makePluginService({ status: "installed", pluginId: "x" }));

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      "notification:show-toast",
      expect.objectContaining({
        type: "success",
        message: expect.stringContaining("my-plugin.dntr"),
      })
    );
  });

  it("shows an error toast carrying the structured failure message", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/bad.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller(
      makePluginService({
        status: "failed",
        errors: [{ code: "archive_invalid", message: "not a valid zip" }],
      })
    );

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      "notification:show-toast",
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("not a valid zip"),
      })
    );
  });

  it("shows an error toast when installPlugin throws instead of crashing", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/boom.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const svc = {
      installPlugin: vi.fn(async () => {
        throw new Error("disk gone");
      }),
    };

    await activateOpenFileInstaller(svc);

    expect(utilsMock.broadcastToRenderer).toHaveBeenCalledWith(
      "notification:show-toast",
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("disk gone"),
      })
    );
  });

  it("persists a pending error (no toast) when no renderer is live", async () => {
    registryMock.getAllAppWebContents.mockReturnValue([]);
    envMock.getPendingOpenFilePaths.mockReturnValue(["/bad.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller(
      makePluginService({
        status: "failed",
        errors: [{ code: "archive_invalid", message: "not a valid zip" }],
      })
    );

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    expect(pendingErrorsMock.appendPendingError).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "validation",
        retryability: "none",
        message: expect.stringContaining("not a valid zip"),
      })
    );
  });

  it("skips the success toast when no renderer is live", async () => {
    registryMock.getAllAppWebContents.mockReturnValue([]);
    envMock.getPendingOpenFilePaths.mockReturnValue(["/ok.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller(makePluginService({ status: "installed", pluginId: "x" }));

    expect(utilsMock.broadcastToRenderer).not.toHaveBeenCalled();
    expect(pendingErrorsMock.appendPendingError).not.toHaveBeenCalled();
  });

  it("routes live consumer events through installPlugin", async () => {
    let captured: ((p: string) => void) | null = null;
    envMock.setOpenFileConsumer.mockImplementation((c) => {
      captured = c;
    });
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const svc = makePluginService({ status: "installed", pluginId: "x" });

    await activateOpenFileInstaller(svc);
    expect(captured).toBeTypeOf("function");

    captured!("/live.dntr");
    await vi.waitFor(() =>
      expect(svc.installPlugin).toHaveBeenCalledWith("/live.dntr", SIDELOAD_OPTS)
    );
  });
});
