import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

import { buildFileBrowserNamespace } from "../fileBrowser.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";

/**
 * The #11366 scenario: project A's view is cached (backgrounded) in a window
 * whose `windowToProject` mapping now points at the active project B. The
 * sender's own project binding (`ctx.projectId`) must decide routing — the
 * window-scoped state query must never be consulted.
 */
describe("fileBrowser listDirectory project scoping", () => {
  const WT_A = "/projects/a/main";
  const WT_B = "/projects/b/main";

  let getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
  let getAllStatesAsync: ReturnType<typeof vi.fn>;
  let getFileTree: ReturnType<typeof vi.fn>;
  let deps: HandlerDependencies;

  const cachedSenderCtx = {
    projectId: "project-a",
    senderWindow: { id: 7 },
  } as unknown as IpcContext;

  function invoke(ctx: IpcContext, payload: { worktreeId: string; dirPath?: string }) {
    const spec = buildFileBrowserNamespace(deps).ops.listDirectory;
    return (spec.handler as (c: IpcContext, p: unknown) => Promise<unknown>)(ctx, payload);
  }

  beforeEach(() => {
    _resetRateLimitQueuesForTest();
    projectStoreMock.getProjectById.mockReset();
    projectStoreMock.getProjectById.mockImplementation((id: string) =>
      id === "project-a"
        ? { id: "project-a", path: "/projects/a" }
        : id === "project-b"
          ? { id: "project-b", path: "/projects/b" }
          : undefined
    );

    // Project-scoped query answers with the owning project's worktrees;
    // the legacy window-scoped query would answer with the ACTIVE project's
    // (B's) — reaching it at all is the bug.
    getAllStatesForProjectAsync = vi.fn(async (projectPath: string) =>
      projectPath === "/projects/a" ? [{ id: WT_A, path: WT_A }] : [{ id: WT_B, path: WT_B }]
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

    expect(getAllStatesForProjectAsync).toHaveBeenCalledWith("/projects/a", "project-a");
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
