import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

const scratchStoreMock = vi.hoisted(() => ({
  getScratchById: vi.fn(),
}));

vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: scratchStoreMock,
}));

const fileTreeServiceMock = vi.hoisted(() => ({
  getFileTree: vi.fn(),
}));

vi.mock("../../../services/FileTreeService.js", () => ({
  fileTreeService: fileTreeServiceMock,
}));

import { buildFileBrowserNamespace } from "../fileBrowser.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";

const PROJECT_A = resolve("projects", "a");
const PROJECT_B = resolve("projects", "b");
const WT_A = resolve(PROJECT_A, "main");
const WT_B = resolve(PROJECT_B, "main");
const LIGHTWEIGHT_ROOT = resolve("folders", "notes");
const SCRATCH_ROOT = resolve("scratches", "one");

/**
 * The #11366 scenario: project A's view is cached (backgrounded) in a window
 * whose `windowToProject` mapping now points at the active project B. The
 * sender's own project binding (`ctx.projectId`) must decide routing — the
 * window-scoped state query must never be consulted.
 */
describe("fileBrowser listDirectory project scoping", () => {
  // A real UUID-v4 shape: `getScratchById` screens the id before querying, so
  // a placeholder string would exercise the rejection path, not the lookup.
  const SCRATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  let getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
  let getAllStatesAsync: ReturnType<typeof vi.fn>;
  let getFileTree: ReturnType<typeof vi.fn>;
  let deps: HandlerDependencies;

  const cachedSenderCtx = {
    projectId: "project-a",
    senderWindow: { id: 7 },
  } as unknown as IpcContext;

  function invoke(ctx: IpcContext, payload: { worktreeId?: string; dirPath?: string }) {
    const spec = buildFileBrowserNamespace(deps).ops.listDirectory;
    return (spec.handler as (c: IpcContext, p: unknown) => Promise<unknown>)(ctx, payload);
  }

  beforeEach(() => {
    _resetRateLimitQueuesForTest();
    projectStoreMock.getProjectById.mockReset();
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      id === "project-a"
        ? { id: "project-a", path: PROJECT_A }
        : id === "project-b"
          ? { id: "project-b", path: PROJECT_B }
          : id === "lightweight"
            ? { id: "lightweight", path: LIGHTWEIGHT_ROOT, gitBacked: false }
            : undefined
    );
    scratchStoreMock.getScratchById.mockReset();
    scratchStoreMock.getScratchById.mockImplementation((id: string) =>
      id === SCRATCH_ID ? { id: SCRATCH_ID, path: SCRATCH_ROOT } : null
    );
    fileTreeServiceMock.getFileTree.mockReset();
    fileTreeServiceMock.getFileTree.mockResolvedValue([]);

    // Project-scoped query answers with the owning project's worktrees;
    // the legacy window-scoped query would answer with the ACTIVE project's
    // (B's) — reaching it at all is the bug.
    getAllStatesForProjectAsync = vi.fn(async (projectPath: string) =>
      projectPath === PROJECT_A ? [{ id: WT_A, path: WT_A }] : [{ id: WT_B, path: WT_B }]
    );
    getAllStatesAsync = vi.fn(async () => [{ id: WT_B, path: WT_B }]);
    getFileTree = vi.fn(async () => ({ entries: [] }));

    deps = {
      worktreeService: {
        getAllStatesForProjectAsync,
        getAllStatesAsync,
        getFileTree,
      },
    } as unknown as HandlerDependencies;
  });

  it("routes a cached view's listing to its own project's host", async () => {
    await invoke(cachedSenderCtx, { worktreeId: WT_A });

    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith(PROJECT_A, "project-a");
    expect(getAllStatesAsync).not.toHaveBeenCalled();
    // The raw listing takes no options: it returns every entry and the browser
    // hides them client-side (#11330). The ignore-aware listing is a separate
    // route, `copytree:get-file-tree` (#11439).
    expect(getFileTree).toHaveBeenCalledWith(WT_A, undefined);
  });

  it("refuses the active project's worktree id from the cached sender", async () => {
    await expect(invoke(cachedSenderCtx, { worktreeId: WT_B })).rejects.toThrow(
      /Worktree not found/
    );
    expect(getFileTree).not.toHaveBeenCalled();
  });

  it("fails closed for a sender with no project binding, even with a window", async () => {
    const unboundCtx = { projectId: null, senderWindow: { id: 7 } } as unknown as IpcContext;
    await expect(invoke(unboundCtx, { worktreeId: WT_A })).rejects.toThrow(
      /requesting view's project/
    );
    expect(getAllStatesForProjectAsync).not.toHaveBeenCalled();
    expect(getAllStatesAsync).not.toHaveBeenCalled();
  });
});

/**
 * #11482: a scratch or a worktree-less project has no worktree to name, so the
 * request omits `worktreeId` and main resolves the root from the sender's own
 * binding. The renderer never names a path — that is what keeps this from
 * widening what a compromised renderer can reach.
 */
describe("fileBrowser listDirectory workspace roots", () => {
  const SCRATCH_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  let getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
  let getFileTree: ReturnType<typeof vi.fn>;
  let deps: HandlerDependencies;

  function invoke(ctx: IpcContext, payload: { worktreeId?: string; dirPath?: string }) {
    const spec = buildFileBrowserNamespace(deps).ops.listDirectory;
    return (spec.handler as (c: IpcContext, p: unknown) => Promise<unknown>)(ctx, payload);
  }

  const ctxFor = (projectId: string | null) =>
    ({ projectId, senderWindow: { id: 3 } }) as unknown as IpcContext;

  beforeEach(() => {
    _resetRateLimitQueuesForTest();
    projectStoreMock.getProjectById.mockReset();
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      id === "lightweight" ? { id: "lightweight", path: LIGHTWEIGHT_ROOT } : undefined
    );
    scratchStoreMock.getScratchById.mockReset();
    scratchStoreMock.getScratchById.mockImplementation((id: string) =>
      id === SCRATCH_ID ? { id: SCRATCH_ID, path: SCRATCH_ROOT } : null
    );
    fileTreeServiceMock.getFileTree.mockReset();
    fileTreeServiceMock.getFileTree.mockResolvedValue([]);

    getAllStatesForProjectAsync = vi.fn(async () => []);
    getFileTree = vi.fn(async () => []);
    deps = {
      worktreeService: { getAllStatesForProjectAsync, getFileTree },
    } as unknown as HandlerDependencies;
  });

  it("lists a scratch's own folder for a scratch-bound sender", async () => {
    await invoke(ctxFor(SCRATCH_ID), {});

    expect(scratchStoreMock.getScratchById).toHaveBeenCalledWith(SCRATCH_ID);
    expect(fileTreeServiceMock.getFileTree).toHaveBeenCalledWith(SCRATCH_ROOT, "");
    // Never the host route: a scratch has no workspace host, and
    // `resolveHostForPath`'s single-host fallback would hand the listing to an
    // unrelated project's host rather than failing.
    expect(getFileTree).not.toHaveBeenCalled();
  });

  it("lists a worktree-less project's own folder without enumerating worktrees", async () => {
    await invoke(ctxFor("lightweight"), { dirPath: "sub" });

    expect(fileTreeServiceMock.getFileTree).toHaveBeenCalledWith(LIGHTWEIGHT_ROOT, "sub");
    expect(getAllStatesForProjectAsync).not.toHaveBeenCalled();
  });

  it("prefers the project row over a scratch id collision", async () => {
    await invoke(ctxFor("lightweight"), {});
    expect(scratchStoreMock.getScratchById).not.toHaveBeenCalled();
  });

  it("still refuses a sender with no binding when no worktree is named", async () => {
    // The null-projectId gate is the #11366 boundary; omitting `worktreeId`
    // must not become a way around it.
    await expect(invoke(ctxFor(null), {})).rejects.toThrow(/requesting view's project/);
    expect(fileTreeServiceMock.getFileTree).not.toHaveBeenCalled();
  });

  it("refuses a sender whose id is in neither store", async () => {
    await expect(invoke(ctxFor("ghost"), {})).rejects.toThrow(/Unknown project/);
    expect(fileTreeServiceMock.getFileTree).not.toHaveBeenCalled();
  });

  it("refuses a worktree id from a scratch sender rather than widening to its folder", async () => {
    // A supplied worktree id always demands a project row; falling back to the
    // scratch root here would silently open a different folder than asked for.
    await expect(invoke(ctxFor(SCRATCH_ID), { worktreeId: WT_A })).rejects.toThrow(
      /Unknown project/
    );
    expect(fileTreeServiceMock.getFileTree).not.toHaveBeenCalled();
  });

  it("refuses an unresolvable worktree id instead of falling back to the project root", async () => {
    await expect(invoke(ctxFor("lightweight"), { worktreeId: LIGHTWEIGHT_ROOT })).rejects.toThrow(
      /Worktree not found/
    );
    expect(fileTreeServiceMock.getFileTree).not.toHaveBeenCalled();
  });

  it("rejects a traversing dirPath before resolving any root", async () => {
    await expect(invoke(ctxFor(SCRATCH_ID), { dirPath: "../../etc" })).rejects.toThrow(
      /traverse outside/
    );
    expect(scratchStoreMock.getScratchById).not.toHaveBeenCalled();
  });
});
