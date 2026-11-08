import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));
const resolveProject = vi.hoisted(() => vi.fn());
const serviceLoaded = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  watch: vi.fn(() => ({ projectId: "p1", revision: 1 })),
  release: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));
vi.mock("../../projectContext.js", () => ({
  resolveScopedProjectForIpcContext: resolveProject,
}));
vi.mock("../../../services/ProjectOnlineOnlyService.js", () => {
  serviceLoaded();
  return {
    ProjectOnlineOnlyService: vi.fn(function () {
      return serviceMock;
    }),
  };
});

import { registerOnlineOnlyFilesHandlers } from "../onlineOnlyFiles.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function invoke(channel: string, senderId = 1): Promise<unknown> {
  const fn = ipcHandlers.get(channel) as Handler;
  const sender = { id: senderId, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
  return fn({ sender } as unknown as Electron.IpcMainInvokeEvent);
}

const unwrapped = (result: unknown) =>
  result && typeof result === "object" && "data" in result
    ? (result as { data: unknown }).data
    : result;

const cloudPath = `${homedir()}/Library/CloudStorage/Dropbox/Video Editor`;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("online-only files IPC", () => {
  const realPlatform = process.platform;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    setPlatform("darwin");
    resolveProject.mockReturnValue({ project: { id: "p1", path: cloudPath }, workspaceId: "p1" });
    cleanup = registerOnlineOnlyFilesHandlers({});
  });

  afterEach(() => {
    cleanup();
    setPlatform(realPlatform);
  });

  it.each(["linux", "win32"] as const)(
    "costs %s nothing, not even a look at the project",
    async (platform) => {
      setPlatform(platform);

      expect(unwrapped(await invoke("online-only-files:watch"))).toBeNull();

      expect(resolveProject).not.toHaveBeenCalled();
      expect(serviceMock.watch).not.toHaveBeenCalled();
    }
  );

  it("answers null for a project outside the cloud roots without starting anything", async () => {
    resolveProject.mockReturnValue({
      project: { id: "p1", path: `${homedir()}/Projects/plain` },
      workspaceId: "p1",
    });

    expect(unwrapped(await invoke("online-only-files:watch"))).toBeNull();

    expect(serviceMock.watch).not.toHaveBeenCalled();
  });

  it("answers null for a view that holds no project", async () => {
    resolveProject.mockReturnValue({ project: null, workspaceId: null });

    expect(unwrapped(await invoke("online-only-files:watch"))).toBeNull();

    expect(serviceMock.watch).not.toHaveBeenCalled();
  });

  it("watches the sender's own project, naming its provider", async () => {
    const snapshot = unwrapped(await invoke("online-only-files:watch"));

    expect(snapshot).toEqual({ projectId: "p1", revision: 1 });
    expect(serviceMock.watch).toHaveBeenCalledWith(
      { id: "p1", path: cloudPath, service: "Dropbox" },
      expect.anything()
    );
  });

  it("lets go of the old project when a view rebinds to one outside the cloud roots", async () => {
    await invoke("online-only-files:watch");
    resolveProject.mockReturnValue({
      project: { id: "p2", path: `${homedir()}/Projects/plain` },
      workspaceId: "p2",
    });

    await invoke("online-only-files:watch");

    expect(serviceMock.release).toHaveBeenCalledTimes(1);
  });

  it("releases on unwatch", async () => {
    await invoke("online-only-files:watch");

    await invoke("online-only-files:unwatch");

    expect(serviceMock.release).toHaveBeenCalledTimes(1);
  });

  it("treats an unwatch before any watch as nothing to do", async () => {
    await invoke("online-only-files:unwatch");

    expect(serviceMock.release).not.toHaveBeenCalled();
  });

  it("disposes the service with the handlers", async () => {
    await invoke("online-only-files:watch");

    cleanup();
    cleanup = () => {};

    expect(serviceMock.dispose).toHaveBeenCalledTimes(1);
  });
});
