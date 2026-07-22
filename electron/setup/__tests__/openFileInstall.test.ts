import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  getPendingOpenFilePaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenFilePaths: vi.fn(),
  setOpenFileConsumer: vi.fn<(c: ((p: string) => void) | null) => void>(),
}));

const intentMock = vi.hoisted(() => ({
  enqueueArchiveInstallIntent: vi.fn<(p: string) => Promise<void>>(async () => {}),
  enqueueArchiveInstallIntents: vi.fn<(p: readonly string[]) => Promise<void>>(async () => {}),
}));

// Tripwire: this module must never reach the installer. Without it a
// regression that both queued a preview AND installed would pass every
// assertion below.
const installPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../environment.js", () => envMock);
vi.mock("../archiveInstallIntent.js", () => intentMock);
vi.mock("../../services/PluginService.js", () => ({
  pluginService: { installPlugin: installPluginMock },
}));

describe("activateOpenFileInstaller", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envMock.getPendingOpenFilePaths.mockReturnValue([]);
    intentMock.enqueueArchiveInstallIntent.mockResolvedValue(undefined);
    intentMock.enqueueArchiveInstallIntents.mockResolvedValue(undefined);
  });

  afterEach(() => {
    expect(installPluginMock).not.toHaveBeenCalled();
  });

  it("sets a consumer and clears the queue even when empty", async () => {
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller();

    expect(envMock.setOpenFileConsumer).toHaveBeenCalledWith(expect.any(Function));
    expect(envMock.clearPendingOpenFilePaths).toHaveBeenCalledOnce();
    expect(intentMock.enqueueArchiveInstallIntents).toHaveBeenCalledWith([]);
  });

  it("queues the cold-launch batch for confirmation instead of installing it", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller();

    // One batch, in order — not path-by-path, so a live event arriving mid-drain
    // can't be interleaved into the middle of the queued batch.
    expect(intentMock.enqueueArchiveInstallIntents).toHaveBeenCalledExactlyOnceWith([
      "/a.dntr",
      "/b.dntr",
    ]);
  });

  it("takes over the queue before draining it, so a mid-drain event isn't lost", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr"]);
    const callOrder: string[] = [];
    envMock.setOpenFileConsumer.mockImplementation(() => callOrder.push("setConsumer"));
    envMock.getPendingOpenFilePaths.mockImplementation(() => {
      callOrder.push("getPending");
      return ["/a.dntr"];
    });

    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    await activateOpenFileInstaller();

    expect(callOrder).toEqual(["setConsumer", "getPending"]);
  });

  it("routes live open-file events through the confirmation queue", async () => {
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    await activateOpenFileInstaller();

    const consumer = envMock.setOpenFileConsumer.mock.calls[0]?.[0];
    expect(consumer).toBeTypeOf("function");
    consumer?.("/live.dntr");

    expect(intentMock.enqueueArchiveInstallIntent).toHaveBeenCalledWith("/live.dntr");
  });
});
