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

const HOMEPAGE = { source: "package.json", title: "Homepage", url: "https://widget.example.dev/" };

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

  const PROJECTS: Record<string, { id: string; path: string }> = {
    p1: { id: "p1", path: "/repos/widget" },
    p2: { id: "p2", path: "/repos/gadget" },
  };

  it("reads the package.json in the named project's own registered folder", async () => {
    projectStoreMock.getProjectById.mockImplementation((id) => PROJECTS[id] ?? null);
    const result = await getDeclared({ projectId: "p2" });
    await getDeclared({ projectId: "p1" });
    expect(projectStoreMock.getProjectById.mock.calls).toEqual([["p2"], ["p1"]]);
    expect(readMock.mock.calls).toEqual([["/repos/gadget"], ["/repos/widget"]]);
    expect(result).toEqual([HOMEPAGE]);
  });

  it("passes every manifest's links through, each with its source (#17254)", async () => {
    const declared = [
      HOMEPAGE,
      { source: "pyproject.toml", title: "Documentation", url: "https://docs.example.dev/" },
      { source: "Cargo.toml", title: "Repository", url: "https://github.com/acme/widget" },
      { source: "catalog-info.yaml", title: "Dashboard", url: "https://grafana.example.dev/" },
    ];
    readMock.mockResolvedValue(structuredClone(declared));
    projectStoreMock.getProjectById.mockImplementation((id) => PROJECTS[id] ?? null);
    await expect(getDeclared({ projectId: "p1" })).resolves.toEqual(declared);
  });
  it("declares nothing for a project this machine doesn't hold", async () => {
    projectStoreMock.getProjectById.mockImplementation((id) => PROJECTS[id] ?? null);
    const result = await getDeclared({ projectId: "gone" });
    expect(projectStoreMock.getProjectById.mock.calls).toEqual([["gone"]]);
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
