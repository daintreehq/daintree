import { homedir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));
const resolveProject = vi.hoisted(() => vi.fn());
const serviceMock = vi.hoisted(() => ({
  watch: vi.fn((_project: unknown, _endpoint: unknown) => ({ projectId: "p1", revision: 1 })),
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
vi.mock("../../../services/ProjectOnlineOnlyService.js", () => ({
  ProjectOnlineOnlyService: vi.fn(function () {
    return serviceMock;
  }),
}));

import { registerOnlineOnlyFilesHandlers } from "../onlineOnlyFiles.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

// One object per view, because a view's endpoint is cached against its sender.
const senders = new Map<number, unknown>();
function senderFor(id: number): unknown {
  let sender = senders.get(id);
  if (!sender) {
    sender = { id, isDestroyed: () => false, once: vi.fn(), send: vi.fn() };
    senders.set(id, sender);
  }
  return sender;
}

function invoke(channel: string, senderId = 1): Promise<unknown> {
  const fn = ipcHandlers.get(channel) as Handler;
  return fn({ sender: senderFor(senderId) } as unknown as Electron.IpcMainInvokeEvent);
}

const cloudPath = `${homedir()}/Library/CloudStorage/Dropbox/Video Editor`;
const plainPath = `${homedir()}/Projects/plain`;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function resolvesTo(path: string, id = "p1"): void {
  resolveProject.mockReturnValue({ project: { id, path }, workspaceId: id });
}

const endpointOfWatch = (call: number) => serviceMock.watch.mock.calls[call]?.[1];

describe("online-only files IPC", () => {
  const realPlatform = process.platform;
  let cleanup: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    senders.clear();
    setPlatform("darwin");
    resolvesTo(cloudPath);
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

      expect(await invoke("online-only-files:watch")).toBeNull();

      expect(resolveProject).not.toHaveBeenCalled();
      expect(serviceMock.watch).not.toHaveBeenCalled();
    }
  );

  it("answers null for a project outside the cloud roots without starting anything", async () => {
    resolvesTo(plainPath);

    expect(await invoke("online-only-files:watch")).toBeNull();

    expect(serviceMock.watch).not.toHaveBeenCalled();
  });

  it("answers null for a view that holds no project", async () => {
    resolveProject.mockReturnValue({ project: null, workspaceId: null });

    expect(await invoke("online-only-files:watch")).toBeNull();

    expect(serviceMock.watch).not.toHaveBeenCalled();
  });

  it("watches the sender's own project, naming its provider", async () => {
    expect(await invoke("online-only-files:watch")).toEqual({ projectId: "p1", revision: 1 });

    expect(serviceMock.watch).toHaveBeenCalledWith(
      { id: "p1", path: cloudPath, service: "Dropbox" },
      expect.anything()
    );
  });

  it("hands the service a root find will print back the same way", async () => {
    resolvesTo(`${cloudPath}/`);

    await invoke("online-only-files:watch");

    expect(serviceMock.watch.mock.calls[0]?.[0]).toMatchObject({ path: cloudPath });
  });

  it("releases only the rebound view when it moves outside the cloud roots", async () => {
    await invoke("online-only-files:watch", 1);
    await invoke("online-only-files:watch", 2);
    resolvesTo(plainPath, "p2");

    await invoke("online-only-files:watch", 1);

    expect(serviceMock.release).toHaveBeenCalledTimes(1);
    expect(serviceMock.release).toHaveBeenCalledWith(endpointOfWatch(0));
    expect(endpointOfWatch(0)).not.toBe(endpointOfWatch(1));
  });

  it("releases only the view that unwatched", async () => {
    await invoke("online-only-files:watch", 1);
    await invoke("online-only-files:watch", 2);

    await invoke("online-only-files:unwatch", 2);

    expect(serviceMock.release).toHaveBeenCalledTimes(1);
    expect(serviceMock.release).toHaveBeenCalledWith(endpointOfWatch(1));
  });

  it("disposes the service with the handlers", () => {
    cleanup();
    cleanup = () => {};

    expect(serviceMock.dispose).toHaveBeenCalledTimes(1);
  });
});
