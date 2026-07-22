import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { buildFileBrowserNamespace } from "../fileBrowser.js";
import { _resetRateLimitQueuesForTest } from "../../utils.js";
import type { HandlerDependencies, IpcContext } from "../../types.js";

describe("fileBrowser statPaths", () => {
  let root: string;
  const ctx = { senderWindow: { id: 7 } } as unknown as IpcContext;

  function makeHandler(worktrees: Array<{ id: string; path: string }>) {
    const deps = {
      worktreeService: {
        getAllStatesAsync: vi.fn(async () => worktrees),
      },
    } as unknown as HandlerDependencies;
    const spec = buildFileBrowserNamespace(deps).ops.statPaths;
    return {
      invoke: (context: IpcContext, payload: { worktreeId: string; paths: string[] }) =>
        (spec.handler as (c: IpcContext, p: unknown) => Promise<unknown>)(context, payload),
      deps,
    };
  }

  beforeEach(async () => {
    _resetRateLimitQueuesForTest();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fb-statpaths-"));
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
      (deps.worktreeService as unknown as { getAllStatesAsync: ReturnType<typeof vi.fn> })
        .getAllStatesAsync
    ).not.toHaveBeenCalled();
  });

  it("refuses an unresolvable sender window", async () => {
    const { invoke } = makeHandler([{ id: root, path: root }]);
    const blindCtx = { senderWindow: undefined } as unknown as IpcContext;
    await expect(invoke(blindCtx, { worktreeId: root, paths: ["src"] })).rejects.toThrow(
      /requesting window/
    );
  });

  it("rejects a worktree the sender's window does not own", async () => {
    const { invoke } = makeHandler([{ id: "other", path: "/somewhere/else" }]);
    await expect(invoke(ctx, { worktreeId: root, paths: ["src"] })).rejects.toThrow(
      /Worktree not found/
    );
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
