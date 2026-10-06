import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import nodeFs from "fs/promises";
import nodeOs from "os";
import nodePath from "path";

const ipcMainMock = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
const clipboardMock = vi.hoisted(() => ({ writeBuffer: vi.fn(), writeText: vi.fn() }));
const browserWindowMock = vi.hoisted(() => ({
  fromWebContents: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
}));

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProjectId: vi.fn<() => string | null>(() => null),
  getProjectById: vi.fn<(id: string) => { id: string; path: string; status: string } | null>(
    () => null
  ),
  getProjectSettings: vi.fn<(id: string) => Promise<unknown>>(),
}));

const scratchStoreMock = vi.hoisted(() => ({
  getScratchById: vi.fn<(id: string) => { id: string; path: string } | undefined>(() => undefined),
}));

const windowRefMock = vi.hoisted(() => ({
  getProjectViewManager: vi.fn<
    () => { getProjectIdForWebContents: (id: number) => string | null } | null
  >(() => null),
}));

const rootCopyMock = vi.hoisted(() => ({
  generateWorkspaceRootContext: vi.fn(),
  cancelAllWorkspaceRootContext: vi.fn(),
}));

const historyMock = vi.hoisted(() => ({
  recordCopyTreeRun:
    vi.fn<
      (
        projectId: string | null,
        input: import("../../../../shared/types/ipc/copyTreeHistory.js").CopyTreeHistoryAppendInput
      ) => Promise<void>
    >(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  clipboard: clipboardMock,
  BrowserWindow: browserWindowMock,
}));
vi.mock("../../../services/ProjectStore.js", () => ({ projectStore: projectStoreMock }));
vi.mock("../../../services/ScratchStore.js", () => ({ scratchStore: scratchStoreMock }));
vi.mock("../../../services/workspaceRootCopyTree.js", () => rootCopyMock);
vi.mock("../../../services/copyTreeHistoryService.js", () => historyMock);
vi.mock("../../../window/windowRef.js", () => ({
  getProjectViewManager: windowRefMock.getProjectViewManager,
  setProjectViewManager: vi.fn(),
  getWindowRegistry: vi.fn(() => null),
  setWindowRegistry: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setMainWindow: vi.fn(),
}));

import { CHANNELS } from "../../channels.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import { _resetReservedPathsForTests } from "../../../services/copyTreeOutputFile.js";
import { registerCopyTreeHandlers } from "../copyTree.js";

const sender = { sender: { id: 1 } } as never;
// Resolved so they are fully qualified on Windows too (a drive root there).
const PROJECT = { id: "proj-plain", path: nodePath.resolve("/folders/plain"), status: "active" };
const SCRATCH = { id: "scratch-1", path: nodePath.resolve("/scratches/scratch-1") };

function handler(): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const call = (ipcMainMock.handle as Mock).mock.calls.find(
    ([channel]) => channel === CHANNELS.COPYTREE_GENERATE_AND_COPY_FILE
  );
  if (!call) throw new Error("generate-and-copy-file handler not registered");
  return call[1] as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

/** The workspace the sending view is bound to, read through deps' ProjectViewManager. */
let boundWorkspaceId: string | null = null;
function bindView(workspaceId: string | null): void {
  boundWorkspaceId = workspaceId;
}

describe("copyTree generate-and-copy-file — workspace root (#13210)", () => {
  let tmpRoot: string;
  let worktreeService: {
    getAllStatesForProjectAsync: Mock;
    generateContext: Mock;
    cancelAllContext: Mock;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    boundWorkspaceId = null;
    _resetRateLimitQueuesForTest();
    _resetReservedPathsForTests();
    tmpRoot = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "daintree-root-copy-"));
    vi.stubEnv("TMPDIR", tmpRoot);
    vi.stubEnv("TEMP", tmpRoot);
    vi.stubEnv("TMP", tmpRoot);

    projectStoreMock.getCurrentProjectId.mockReturnValue(null);
    projectStoreMock.getProjectById.mockImplementation((id) =>
      id === PROJECT.id ? PROJECT : null
    );
    projectStoreMock.getProjectSettings.mockResolvedValue({
      excludedPaths: [],
      copyTreeSettings: {},
    });
    scratchStoreMock.getScratchById.mockImplementation((id) =>
      id === SCRATCH.id ? SCRATCH : undefined
    );
    rootCopyMock.generateWorkspaceRootContext.mockImplementation(
      async (_root: string, _options: unknown, _onProgress: unknown, outputPath: string) => {
        await nodeFs.writeFile(outputPath, "<files/>", "utf8");
        return { content: "", fileCount: 4, filePath: outputPath, outputBytes: 8 };
      }
    );

    worktreeService = {
      // A non-git project's host answers with no worktrees at all.
      getAllStatesForProjectAsync: vi.fn(async () => []),
      generateContext: vi.fn(),
      cancelAllContext: vi.fn(),
    };
    registerCopyTreeHandlers({
      mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false } },
      worktreeService,
      projectViewManager: { getProjectIdForWebContents: () => boundWorkspaceId },
    } as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await nodeFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("copies a non-git project's root on main's own worker, never through a workspace host", async () => {
    bindView(PROJECT.id);

    const result = await handler()(sender, { source: "toolbar" });

    expect(result.error).toBeUndefined();
    expect(result.fileCount).toBe(4);
    expect(rootCopyMock.generateWorkspaceRootContext).toHaveBeenCalledTimes(1);
    expect(rootCopyMock.generateWorkspaceRootContext.mock.calls[0]?.[0]).toBe(PROJECT.path);
    expect(worktreeService.generateContext).not.toHaveBeenCalled();
    expect(worktreeService.getAllStatesForProjectAsync).not.toHaveBeenCalled();
    // History keeps its non-empty provenance field by recording the root.
    expect(historyMock.recordCopyTreeRun).toHaveBeenCalledWith(
      PROJECT.id,
      expect.objectContaining({ worktreeId: PROJECT.path, source: "toolbar" })
    );
  });

  it("copies a scratch's own folder, which has no workspace host at all", async () => {
    bindView(SCRATCH.id);

    const result = await handler()(sender, {});

    expect(result.error).toBeUndefined();
    expect(rootCopyMock.generateWorkspaceRootContext.mock.calls[0]?.[0]).toBe(SCRATCH.path);
    // A scratch has no project row, so there is no project history to append to.
    expect(historyMock.recordCopyTreeRun).toHaveBeenCalledWith(null, expect.anything());
  });

  it("never widens a named worktree that doesn't resolve to the workspace root", async () => {
    bindView(PROJECT.id);

    const gone = nodePath.join(PROJECT.path, "gone");
    const result = await handler()(sender, { worktreeId: gone });

    expect(result.error).toBe(`Worktree not found: ${gone}`);
    expect(rootCopyMock.generateWorkspaceRootContext).not.toHaveBeenCalled();
    expect(clipboardMock.writeBuffer).not.toHaveBeenCalled();
    expect(clipboardMock.writeText).not.toHaveBeenCalled();
  });

  it("refuses when the sending view is bound to no workspace", async () => {
    bindView(null);
    // The global pointer must not stand in for the view's own workspace.
    projectStoreMock.getCurrentProjectId.mockReturnValue(PROJECT.id);

    const result = await handler()(sender, {});

    expect(result.error).toBe("No workspace open to copy");
    expect(rootCopyMock.generateWorkspaceRootContext).not.toHaveBeenCalled();
  });

  it("refuses a closed project's root", async () => {
    bindView(PROJECT.id);
    projectStoreMock.getProjectById.mockReturnValue({ ...PROJECT, status: "closed" });

    const result = await handler()(sender, {});

    expect(result.error).toBe("No workspace open to copy");
    expect(rootCopyMock.generateWorkspaceRootContext).not.toHaveBeenCalled();
  });

  it("refuses a root that isn't an absolute path", async () => {
    bindView(PROJECT.id);
    projectStoreMock.getProjectById.mockReturnValue({ ...PROJECT, path: "relative/dir" });

    const result = await handler()(sender, {});

    expect(result.error).toBe("No workspace open to copy");
    expect(rootCopyMock.generateWorkspaceRootContext).not.toHaveBeenCalled();
  });

  it("pins the root captured before the first await, whatever the view rebinds to", async () => {
    bindView(PROJECT.id);
    let release!: () => void;
    projectStoreMock.getProjectSettings.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ excludedPaths: [], copyTreeSettings: {} });
        })
    );

    const pending = handler()(sender, {});
    bindView(SCRATCH.id);
    release();
    await pending;

    expect(rootCopyMock.generateWorkspaceRootContext.mock.calls[0]?.[0]).toBe(PROJECT.path);
  });

  it("cancels in-flight root copies alongside the hosts' on a cancel-all", async () => {
    const call = (ipcMainMock.handle as Mock).mock.calls.find(
      ([channel]) => channel === CHANNELS.COPYTREE_CANCEL
    );
    await (call![1] as (...args: unknown[]) => Promise<void>)(sender, {});
    expect(rootCopyMock.cancelAllWorkspaceRootContext).toHaveBeenCalledTimes(1);
  });
});
