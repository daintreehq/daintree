import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = vi.hoisted(() => ({
  getPendingOpenFilePaths: vi.fn<() => string[]>(() => []),
  clearPendingOpenFilePaths: vi.fn(),
  setOpenFileConsumer: vi.fn<(c: ((p: string) => void) | null) => void>(),
}));

const intentMock = vi.hoisted(() => ({
  enqueueArchiveInstallIntent: vi.fn<(p: string) => Promise<void>>(async () => {}),
}));

vi.mock("../environment.js", () => envMock);
vi.mock("../archiveInstallIntent.js", () => intentMock);

describe("activateOpenFileInstaller", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    envMock.getPendingOpenFilePaths.mockReturnValue([]);
    intentMock.enqueueArchiveInstallIntent.mockResolvedValue(undefined);
  });

  it("sets a consumer and clears the queue even when empty", async () => {
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller();

    expect(envMock.setOpenFileConsumer).toHaveBeenCalledWith(expect.any(Function));
    expect(envMock.clearPendingOpenFilePaths).toHaveBeenCalledOnce();
    expect(intentMock.enqueueArchiveInstallIntent).not.toHaveBeenCalled();
  });

  it("queues each cold-launch path for confirmation instead of installing it", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    const { activateOpenFileInstaller } = await import("../openFileInstall.js");

    await activateOpenFileInstaller();

    expect(intentMock.enqueueArchiveInstallIntent).toHaveBeenCalledTimes(2);
    expect(intentMock.enqueueArchiveInstallIntent).toHaveBeenNthCalledWith(1, "/a.dntr");
    expect(intentMock.enqueueArchiveInstallIntent).toHaveBeenNthCalledWith(2, "/b.dntr");
  });

  it("awaits each queued path before starting the next", async () => {
    envMock.getPendingOpenFilePaths.mockReturnValue(["/a.dntr", "/b.dntr"]);
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    intentMock.enqueueArchiveInstallIntent.mockImplementation(async (p: string) => {
      order.push(`start:${p}`);
      if (p === "/a.dntr") {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      order.push(`end:${p}`);
    });

    const { activateOpenFileInstaller } = await import("../openFileInstall.js");
    const pending = activateOpenFileInstaller();
    await Promise.resolve();

    expect(order).toEqual(["start:/a.dntr"]);
    releaseFirst?.();
    await pending;

    expect(order).toEqual(["start:/a.dntr", "end:/a.dntr", "start:/b.dntr", "end:/b.dntr"]);
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
