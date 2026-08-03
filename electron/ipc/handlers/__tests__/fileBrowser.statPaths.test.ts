import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

const projectStoreMock = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: projectStoreMock,
}));

// Mocked even where unused: the real module opens the shared SQLite database at
// import time, which this suite has no business booting.
const scratchStoreMock = vi.hoisted(() => ({
  getScratchById: vi.fn(() => null),
}));

vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: scratchStoreMock,
}));

import { buildFileBrowserNamespace } from "../fileBrowser.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";

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
      // Realpath equality rejects the intermediate symlink, so the escape is
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

  it("refuses in-root symlinks too — only paths the tree can render validate", async () => {
    await fs.symlink(path.join(root, "src"), path.join(root, "src-link"));
    const { invoke } = makeHandler([{ id: root, path: root }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["src-link"] })).resolves.toEqual([null]);
  });
});
