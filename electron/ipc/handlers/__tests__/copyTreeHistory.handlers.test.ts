import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getProjectById: vi.fn<(projectId: string) => { id: string; status: string } | null>(() => null),
  getCopyTreeHistory: vi.fn<(projectId: string) => Promise<unknown[]>>(),
}));

const browserWindowMock = vi.hoisted(() => ({
  fromWebContents: vi.fn<() => { id: number; isDestroyed: () => boolean } | null>(() => null),
  getAllWindows: vi.fn(() => []),
}));

const windowRefMock = vi.hoisted(() => ({
  getProjectViewManager: vi.fn<
    () => { getProjectIdForWebContents: (id: number) => string | null } | null
  >(() => null),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  clipboard: { writeBuffer: vi.fn(), writeText: vi.fn() },
  BrowserWindow: browserWindowMock,
}));

vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));

vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import { registerCopyTreeHistoryHandlers } from "../copyTreeHistory.js";

const PROJECT_A = "a".repeat(64);
const PROJECT_B = "b".repeat(64);

function getHandler(): (...args: unknown[]) => Promise<unknown> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([channel]) => channel === CHANNELS.COPY_TREE_HISTORY_GET_RECORDS
  );
  if (!call) throw new Error("copy-tree-history:get-records was never registered");
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

/**
 * Register against a sender view bound to `viewProjectId`, mirroring how
 * production supplies the ProjectViewManager through handler dependencies.
 */
function registerBoundTo(viewProjectId: string | null) {
  ipcMainMock.handle.mockClear();
  registerCopyTreeHistoryHandlers({
    projectViewManager: { getProjectIdForWebContents: () => viewProjectId },
  } as never);
}

/** Unwrap the `{ ok: true, data }` envelope the IPC security layer adds. */
async function invoke(sender = { id: 1 }): Promise<unknown> {
  const result = (await getHandler()({ sender })) as { ok?: boolean; data?: unknown };
  return result?.ok ? result.data : result;
}

describe("copyTreeHistory handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    projectStoreMock.getProjectById.mockReturnValue(null);
    projectStoreMock.getCopyTreeHistory.mockReset().mockResolvedValue([]);
    browserWindowMock.fromWebContents.mockReturnValue(null);
    windowRefMock.getProjectViewManager.mockReturnValue(null);
    registerBoundTo(PROJECT_A);
  });

  it("exposes only a read — there is no channel to forge entries through", () => {
    const channels = (ipcMainMock.handle as Mock).mock.calls.map(([channel]) => channel as string);
    expect(channels).toEqual([CHANNELS.COPY_TREE_HISTORY_GET_RECORDS]);
  });

  it("serves the history of the project bound to the sender's view", async () => {
    registerBoundTo(PROJECT_A);
    projectStoreMock.getProjectById.mockReturnValue({ id: PROJECT_A, status: "open" });
    projectStoreMock.getCopyTreeHistory.mockResolvedValue([{ id: "r1" }]);

    await expect(invoke()).resolves.toEqual([{ id: "r1" }]);
    expect(projectStoreMock.getCopyTreeHistory).toHaveBeenCalledWith(PROJECT_A);
  });

  it("never serves another project's history to a bound view", async () => {
    // The reader resolves from the sender's own binding, so a different project
    // being current globally cannot redirect the read.
    registerBoundTo(PROJECT_A);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT_A ? { id: PROJECT_A, status: "open" } : { id: PROJECT_B, status: "open" }
    );
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT_B);

    await invoke();

    expect(projectStoreMock.getCopyTreeHistory).toHaveBeenCalledWith(PROJECT_A);
    expect(projectStoreMock.getCopyTreeHistory).not.toHaveBeenCalledWith(PROJECT_B);
  });

  it("returns an empty history for a view bound to no project", async () => {
    // Must NOT fall back to the globally-current project — an unbound view
    // inheriting the global pointer is the #6015 bug class.
    registerBoundTo(null);
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT_B);

    await expect(invoke()).resolves.toEqual([]);
    expect(projectStoreMock.getCopyTreeHistory).not.toHaveBeenCalled();
  });

  it("reports an unreadable history as empty instead of failing the call", async () => {
    // A file whose quarantine could not be renamed stays unreadable. The writer
    // still refuses to overwrite it; the reader just has nothing to show.
    registerBoundTo(PROJECT_A);
    projectStoreMock.getProjectById.mockReturnValue({ id: PROJECT_A, status: "open" });
    projectStoreMock.getCopyTreeHistory.mockRejectedValue(new Error("EPERM"));

    await expect(invoke()).resolves.toEqual([]);
  });
});
