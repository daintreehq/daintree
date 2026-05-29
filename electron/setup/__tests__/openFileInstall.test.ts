import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  getPendingOpenFilePaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenFilePaths: vi.fn(),
  setOpenFileConsumer: vi.fn<(c: ((p: string) => void) | null) => void>(),
}));

const utilsMock = vi.hoisted(() => ({
  broadcastToRenderer: vi.fn(),
}));

vi.mock("../environment.js", () => envMock);
vi.mock("../../ipc/utils.js", () => utilsMock);
vi.mock("../../ipc/channels.js", () => ({
  CHANNELS: { NOTIFICATION_SHOW_TOAST: "notification:show-toast" },
}));

type InstallResult =
  | { status: "installed"; pluginId: string }
  | { status: "failed"; errors: { code: string; message: string }[] };

function makePluginService(result: InstallResult) {
  return { installPlugin: vi.fn(async () => result) };
}

const SIDELOAD_OPTS = { source: "sideload", originalUrl: undefined };

describe("activateOpenFileInstaller", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envMock.getPendingOpenFilePaths.mockReturnValue([]);
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
