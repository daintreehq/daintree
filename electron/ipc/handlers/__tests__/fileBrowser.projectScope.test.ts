import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path, { resolve } from "node:path";

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

describe("fileBrowser statPaths", () => {
  let root: string;
  const ctx = { projectId: "project-a" } as unknown as IpcContext;

  function makeHandler(worktrees: Array<{ id: string; path: string }>) {
    const deps = {
      worktreeService: {
        getAllStatesForProjectAsync: vi.fn(async () => worktrees),
      },
    } as unknown as HandlerDependencies;
    const spec = buildFileBrowserNamespace(deps).ops.statPaths;
    return {
      invoke: (context: IpcContext, payload: { worktreeId?: string; paths: string[] }) =>
        (spec.handler as (c: IpcContext, p: unknown) => Promise<unknown>)(context, payload),
      deps,
    };
  }

  beforeEach(async () => {
    _resetRateLimitQueuesForTest();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fb-statpaths-"));
    projectStoreMock.getProjectById.mockReset();
    projectStoreMock.getProjectById.mockReturnValue({ id: "project-a", path: root });
    await fs.mkdir(path.join(root, "src", "panels"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "index.ts"), "export {}\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns kinds in request order with null for missing entries", async () => {
    const { invoke } = makeHandler([{ id: root, path: root }]);
    await expect(
      invoke(ctx, { worktreeId: root, paths: ["src", "src/index.ts", "does-not-exist"] })
    ).resolves.toEqual(["directory", "file", null]);
  });

  it("rejects traversal before touching the filesystem", async () => {
    const { invoke, deps } = makeHandler([{ id: root, path: root }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["../outside"] })).rejects.toThrow(
      /traverse/
    );
    // Validation failed before any worktree resolution happened.
    expect(
      (
        deps.worktreeService as unknown as {
          getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
        }
      ).getAllStatesForProjectAsync
    ).not.toHaveBeenCalled();
  });

  it("refuses a sender with no project binding", async () => {
    const { invoke, deps } = makeHandler([{ id: root, path: root }]);
    const unboundCtx = { projectId: null } as unknown as IpcContext;
    await expect(invoke(unboundCtx, { worktreeId: root, paths: ["src"] })).rejects.toThrow(
      /requesting view's project/
    );
    expect(
      (
        deps.worktreeService as unknown as {
          getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
        }
      ).getAllStatesForProjectAsync
    ).not.toHaveBeenCalled();
  });

  it("refuses a sender whose project no longer exists", async () => {
    projectStoreMock.getProjectById.mockReturnValue(undefined);
    const { invoke, deps } = makeHandler([{ id: root, path: root }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["src"] })).rejects.toThrow(
      /Unknown project/
    );
    expect(
      (
        deps.worktreeService as unknown as {
          getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
        }
      ).getAllStatesForProjectAsync
    ).not.toHaveBeenCalled();
  });

  it("stats against the sender's workspace root when no worktree is named", async () => {
    // #11482: the same containment logic, rooted at the project/scratch folder
    // the sender is bound to rather than a worktree.
    const { invoke, deps } = makeHandler([]);
    await expect(invoke(ctx, { paths: ["src", "src/index.ts", "nope"] })).resolves.toEqual([
      "directory",
      "file",
      null,
    ]);
    expect(
      (
        deps.worktreeService as unknown as {
          getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
        }
      ).getAllStatesForProjectAsync
    ).not.toHaveBeenCalled();
  });

  it("keeps symlink containment for a workspace root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fb-ws-outside-"));
    try {
      await fs.mkdir(path.join(outside, "secret"));
      await fs.symlink(outside, path.join(root, "hop"));
      const { invoke } = makeHandler([]);
      // The canonical target lands outside the root, so the escape stays
      // indistinguishable from a missing path — same guarantee as a worktree.
      await expect(invoke(ctx, { paths: ["hop/secret"] })).resolves.toEqual([null]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a worktree the sender's project does not own", async () => {
    const { invoke } = makeHandler([{ id: "other", path: "/somewhere/else" }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["src"] })).rejects.toThrow(
      /Worktree not found/
    );
  });

  it("scopes the state query to the sender's own project path and id", async () => {
    const { invoke, deps } = makeHandler([{ id: root, path: root }]);
    await invoke(ctx, { worktreeId: root, paths: ["src"] });
    expect(projectStoreMock.getProjectById).toHaveBeenCalledWith("project-a");
    expect(
      (
        deps.worktreeService as unknown as {
          getAllStatesForProjectAsync: ReturnType<typeof vi.fn>;
        }
      ).getAllStatesForProjectAsync
    ).toHaveBeenCalledWith(root, "project-a");
  });

  it("never reports kinds through a symlink that escapes the root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fb-outside-"));
    try {
      await fs.mkdir(path.join(outside, "secret"));
      await fs.symlink(outside, path.join(root, "escape"));

      const { invoke } = makeHandler([{ id: root, path: root }]);
      // Both the symlink itself and a child THROUGH it (the intermediate-
      // symlink case a final-component lstat would miss) must read as absent.
      await expect(
        invoke(ctx, { worktreeId: root, paths: ["escape", "escape/secret"] })
      ).resolves.toEqual([null, null]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("resolves in-root symlinks, and paths reached through one (#11939)", async () => {
    // The tree lists symlinks now, so a reference in terminal output that
    // points at or through an in-root link names something the browser can
    // actually open — reporting it absent would be the wrong answer.
    await fs.symlink(path.join(root, "src"), path.join(root, "src-link"));
    await fs.symlink(path.join(root, "src", "index.ts"), path.join(root, "index-link.ts"));

    const { invoke } = makeHandler([{ id: root, path: root }]);
    await expect(
      invoke(ctx, {
        worktreeId: root,
        paths: ["src-link", "index-link.ts", "src-link/index.ts"],
      })
    ).resolves.toEqual(["directory", "file", "file"]);
  });

  it("still reports a dangling in-root symlink as absent", async () => {
    // Containment is not the only reason to answer null: a link whose target
    // does not exist names nothing openable either, and `realpath` throws.
    await fs.symlink(path.join(root, "gone.ts"), path.join(root, "dangling.ts"));
    const { invoke } = makeHandler([{ id: root, path: root }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["dangling.ts"] })).resolves.toEqual([
      null,
    ]);
  });

  it("rejects a sibling directory whose path merely starts with the root's", async () => {
    // `${root}-sibling` passes a naive `startsWith(root)` prefix test while
    // living entirely outside it. Containment is decided by `path.relative`
    // precisely so that shape can't slip through.
    const sibling = `${root}-sibling`;
    await fs.mkdir(sibling, { recursive: true });
    try {
      await fs.writeFile(path.join(sibling, "secret.txt"), "x");
      await fs.symlink(sibling, path.join(root, "near"));

      const { invoke } = makeHandler([{ id: root, path: root }]);
      await expect(
        invoke(ctx, { worktreeId: root, paths: ["near", "near/secret.txt"] })
      ).resolves.toEqual([null, null]);
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });
});
