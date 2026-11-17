import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipcHandlers = vi.hoisted(() => new Map<string, unknown>());
const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn((channel: string, fn: unknown) => ipcHandlers.set(channel, fn)),
  removeHandler: vi.fn((channel: string) => ipcHandlers.delete(channel)),
}));
const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn<(id: string) => { id: string; path: string } | null>(),
  changeLinks: vi.fn(),
}));
const readMock = vi.hoisted(() => vi.fn<(root: string) => Promise<unknown[]>>());

vi.mock("electron", () => ({ ipcMain: ipcMainMock }));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/projectDeclaredLinks.js", () => ({
  readDeclaredProjectLinks: (root: string) => readMock(root),
}));

import { registerProjectLinksHandlers } from "../projectLinks.js";
import { CHANNELS } from "../../channels.js";

type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>;

function getDeclared(...args: unknown[]): Promise<unknown> {
  const fn = ipcHandlers.get(CHANNELS.PROJECT_LINKS_GET_DECLARED) as Handler | undefined;
  if (!fn) throw new Error("handler not registered");
  return fn({ sender: {} } as Electron.IpcMainInvokeEvent, ...args);
}

const HOMEPAGE = { field: "homepage", title: "Homepage", url: "https://widget.example.dev/" };

describe("project-links:get-declared (#17252)", () => {
  let cleanup: () => void;

  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    readMock.mockResolvedValue([HOMEPAGE]);
    cleanup = registerProjectLinksHandlers();
  });

  afterEach(() => {
    cleanup();
  });

  it("reads the package.json in the project's own registered folder", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: "/repos/widget" });
    const result = await getDeclared({ projectId: "p1" });
    expect(readMock.mock.calls).toEqual([["/repos/widget"]]);
    expect(result).toEqual([HOMEPAGE]);
  });

  it("declares nothing for a project this machine doesn't hold", async () => {
    projectStoreMock.getProjectById.mockReturnValue(null);
    const result = await getDeclared({ projectId: "gone" });
    expect(readMock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("refuses a payload that names a path of its own", async () => {
    projectStoreMock.getProjectById.mockReturnValue({ id: "p1", path: "/repos/widget" });
    await expect(getDeclared({ projectId: "p1", path: "/etc" })).rejects.toThrow();
    await expect(getDeclared({})).rejects.toThrow();
    expect(readMock).not.toHaveBeenCalled();
  });
});
