import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(() => "/tmp/userData"),
}));

const notesServiceInstances = vi.hoisted<
  Array<{ projectId: string; instance: Record<string, Mock> }>
>(() => []);

const NotesServiceMock = vi.hoisted(() =>
  vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _userData: string,
    projectId: string
  ) {
    const instance = {
      create: vi.fn().mockResolvedValue({ path: "/note.md", metadata: { id: "n1" } }),
      read: vi.fn().mockResolvedValue({
        content: "",
        metadata: { id: "n1" },
        path: "/note.md",
        lastModified: 0,
      }),
      write: vi.fn().mockResolvedValue({ lastModified: 1 }),
      list: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue({ notes: [], query: "" }),
      saveAttachment: vi.fn().mockResolvedValue({ path: "/attach.png", filename: "attach.png" }),
      getDirPath: vi.fn(() => `/notes/${projectId}`),
      getProjectId: vi.fn(() => projectId),
      createConflictCopy: vi.fn().mockResolvedValue({ conflictPath: "/note.conflict.md" }),
    };
    notesServiceInstances.push({ projectId, instance });
    Object.assign(this, instance);
  })
);

const NoteConflictErrorStub = vi.hoisted(
  () =>
    class NoteConflictErrorStub extends Error {
      constructor(message = "conflict") {
        super(message);
      }
    }
);

const getProjectViewManagerMock = vi.hoisted(() => vi.fn());
const getWindowForWebContentsMock = vi.hoisted(() => vi.fn(() => null));
const getAllAppWebContentsMock = vi.hoisted(() => vi.fn(() => []));
const getAppWebContentsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  app: appMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock("../../../services/NotesService.js", () => ({
  NotesService: NotesServiceMock,
  NoteConflictError: NoteConflictErrorStub,
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: getWindowForWebContentsMock,
  getAllAppWebContents: getAllAppWebContentsMock,
  getAppWebContents: getAppWebContentsMock,
}));

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: getProjectViewManagerMock,
}));

import { CHANNELS } from "../../channels.js";
import { registerNotesHandlers, _resetNotesServicesForTest } from "../notes.js";

function getInvokeHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([registered]) => registered === channel
  );
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function makeEvent(webContentsId: number) {
  return { sender: { id: webContentsId } } as never;
}

function mockProjectFor(webContentsId: number, projectId: string | null) {
  getProjectViewManagerMock.mockReturnValue({
    getProjectIdForWebContents: (id: number) => (id === webContentsId ? projectId : null),
  });
}

describe("notes handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notesServiceInstances.length = 0;
    _resetNotesServicesForTest();
    registerNotesHandlers({} as never);
  });

  const NOTES_CHANNELS = [
    CHANNELS.NOTES_CREATE,
    CHANNELS.NOTES_READ,
    CHANNELS.NOTES_WRITE,
    CHANNELS.NOTES_LIST,
    CHANNELS.NOTES_DELETE,
    CHANNELS.NOTES_SEARCH,
    CHANNELS.NOTES_WRITE_ATTACHMENT,
    CHANNELS.NOTES_GET_DIR,
  ] as const;

  it("registers all eight notes channels via context-aware dispatch", () => {
    const registered = (ipcMainMock.handle as Mock).mock.calls.map(([c]) => c);
    for (const channel of NOTES_CHANNELS) {
      expect(registered).toContain(channel);
    }
  });

  it("throws 'No active project' when ctx.projectId is null", async () => {
    mockProjectFor(1, null);
    for (const channel of NOTES_CHANNELS) {
      const handler = getInvokeHandler(channel);
      await expect(handler(makeEvent(1))).rejects.toThrow(/No active project/);
    }
  });

  it("resolves a distinct NotesService instance for each project id", async () => {
    // Window A → project A
    getProjectViewManagerMock.mockReturnValue({
      getProjectIdForWebContents: (id: number) => (id === 1 ? "project-A" : "project-B"),
    });

    const listHandler = getInvokeHandler(CHANNELS.NOTES_LIST);
    await listHandler(makeEvent(1));
    await listHandler(makeEvent(2));

    expect(NotesServiceMock).toHaveBeenCalledTimes(2);
    expect(notesServiceInstances[0].projectId).toBe("project-A");
    expect(notesServiceInstances[1].projectId).toBe("project-B");
  });

  it("reuses the cached NotesService for repeated calls from the same project", async () => {
    mockProjectFor(1, "project-A");

    const listHandler = getInvokeHandler(CHANNELS.NOTES_LIST);
    await listHandler(makeEvent(1));
    await listHandler(makeEvent(1));
    await listHandler(makeEvent(1));

    expect(NotesServiceMock).toHaveBeenCalledTimes(1);
  });

  it("passes ctx.projectId — not a global singleton — when the active view changes", async () => {
    // First call: window on project-A
    getProjectViewManagerMock.mockReturnValue({
      getProjectIdForWebContents: () => "project-A",
    });
    const listHandler = getInvokeHandler(CHANNELS.NOTES_LIST);
    await listHandler(makeEvent(1));

    // Second call: same webContents id, but the view manager now reports project-B
    // (simulates a second window/view scenario where "current project" diverges).
    getProjectViewManagerMock.mockReturnValue({
      getProjectIdForWebContents: () => "project-B",
    });
    await listHandler(makeEvent(1));

    const projectIds = notesServiceInstances.map((e) => e.projectId);
    expect(projectIds).toEqual(["project-A", "project-B"]);
  });

  it("threads write arguments through to the project's NotesService", async () => {
    mockProjectFor(1, "project-A");

    const writeHandler = getInvokeHandler(CHANNELS.NOTES_WRITE);
    const metadata = {
      id: "note-1",
      title: "Hello",
      scope: "project" as const,
      createdAt: 123,
    };
    await writeHandler(makeEvent(1), "notes/hello.md", "body", metadata, 99);

    const service = notesServiceInstances[0].instance;
    expect(service.write).toHaveBeenCalledWith("notes/hello.md", "body", metadata, 99);
  });

  it("recovers from a NoteConflictError by creating a conflict copy and force-writing", async () => {
    mockProjectFor(1, "project-A");

    const writeHandler = getInvokeHandler(CHANNELS.NOTES_WRITE);
    const metadata = {
      id: "note-1",
      title: "Hello",
      scope: "project" as const,
      createdAt: 123,
    };

    // First invocation creates the cached service and primes a conflict on the
    // next write. The handler re-resolves the service on its second write call,
    // so we must mutate the cached instance rather than building a fresh one.
    await writeHandler(makeEvent(1), "notes/hello.md", "body", metadata);
    const service = notesServiceInstances[0].instance;
    service.write.mockReset();
    service.write
      .mockRejectedValueOnce(new NoteConflictErrorStub("conflict"))
      .mockResolvedValueOnce({ lastModified: 42 });

    const result = await writeHandler(makeEvent(1), "notes/hello.md", "body", metadata);

    expect(service.createConflictCopy).toHaveBeenCalledWith("notes/hello.md");
    expect(service.write).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ lastModified: 42, conflictPath: "/note.conflict.md" });
  });
});
