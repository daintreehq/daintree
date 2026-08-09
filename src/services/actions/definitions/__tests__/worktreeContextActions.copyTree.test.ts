import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

const copyTreeClientMock = vi.hoisted(() => ({
  generateAndCopyFile: vi.fn(),
}));

const notifyMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

vi.mock("@/clients", () => ({
  copyTreeClient: copyTreeClientMock,
  systemClient: {},
  projectClient: {
    getTerminals: vi.fn().mockResolvedValue([]),
    setTerminals: vi.fn().mockResolvedValue(undefined),
    setTabGroups: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue(null),
  },
}));

import { registerWorktreeContextActions } from "../worktreeContextActions";

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  return {
    run: async (id, args, ctx) => {
      const factory = actions.get(id);
      if (!factory) throw new Error(`missing ${id}`);
      return (factory() as AnyActionDefinition).run(args, (ctx ?? {}) as never);
    },
  };
}

/** What the IPC layer actually answers with for a file-backed copy. */
const COPY_TREE_RESULT = {
  content: "",
  fileCount: 3,
  filePath: "/tmp/daintree-context/repo-main-x.xml",
  outputBytes: 2048,
  stats: { totalSize: 4096, duration: 12 },
};

beforeEach(() => {
  vi.clearAllMocks();
  copyTreeClientMock.generateAndCopyFile.mockResolvedValue({ ...COPY_TREE_RESULT });
});

// Issue #11735 — this action is the single completion point for every copy-tree
// route that isn't the context menu: the toolbar button, its overflow item,
// Cmd+Shift+C, the command palette, the `worktree.copyContext` alias, and agent
// dispatches. All of them were silent or relied on inline button state that
// three of them could not show.
describe("worktree.copyTree completion toast", () => {
  it.each([
    ["the toolbar button and palette", "user"],
    ["Cmd+Shift+C", "keybinding"],
    ["an agent", "agent"],
  ])("announces the copy for %s", async (_label, dispatchSource) => {
    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1", format: "xml" }, { dispatchSource });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        message: "Copied 3 files (4 KB) as XML to clipboard",
        context: { eventKind: "agent" },
      })
    );
  });

  it("announces a source-less dispatch too", async () => {
    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1" });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent for the context menu, which owns its own spinner toast", async () => {
    // `copyContextWithFeedback` opens an info toast and updates it in place.
    // Announcing here as well would stack a second toast on that one.
    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1" }, { dispatchSource: "context-menu" });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("never announces a copy that failed", async () => {
    const { run } = setupActions();
    copyTreeClientMock.generateAndCopyFile.mockResolvedValueOnce({
      content: "",
      fileCount: 0,
      error: "Failed to copy file to clipboard: EACCES",
    });
    await expect(run("worktree.copyTree", { worktreeId: "wt-1" })).rejects.toThrow("EACCES");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("never announces when there is no worktree to copy", async () => {
    // run() short-circuits to null before touching the client; a toast here
    // would claim a copy that never happened.
    const { run } = setupActions();
    await expect(
      run("worktree.copyTree", undefined, { dispatchSource: "user" })
    ).resolves.toBeNull();
    expect(copyTreeClientMock.generateAndCopyFile).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a scoped copy", { scopePaths: ["node_modules"] }],
    ["a glob-filtered copy", { includePaths: ["src/**/*.nope"] }],
    ["a whole-worktree copy", {}],
    ["a modified-files copy", { modified: true }],
  ])("reports an empty %s as a plain count, never as a folder", async (_label, selection) => {
    // The context-menu helper explains an empty result because it knows the
    // user right-clicked a folder. Here the selection may be a glob or a single
    // file, so "this folder…" would be the wrong words — and `modified` isn't a
    // path selection at all. A count is true for every one of these.
    const { run } = setupActions();
    copyTreeClientMock.generateAndCopyFile.mockResolvedValueOnce({
      content: "",
      fileCount: 0,
      filePath: "/tmp/x.xml",
      outputBytes: 0,
      stats: { excluded: { total: 4, byReason: { gitignore: 4 } } },
    });

    await run("worktree.copyTree", { worktreeId: "wt-1", ...selection });

    const payload = notifyMock.mock.calls[0]?.[0] as { type: string; message: string };
    expect(payload.type).toBe("success");
    expect(payload.message).toContain("0 files");
    expect(payload.message).not.toContain("folder");
  });

  it("keeps the worktree out of the toast context so notify() cannot suppress it", async () => {
    // notify() diverts a high-priority toast to the inbox when context names
    // the worktree already on screen — always the case for the toolbar button.
    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-active" }, { activeWorktreeId: "wt-active" });
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ context: { eventKind: "agent" } })
    );
  });

  it("gives the toast a bucket of its own rather than the shared type fallback", async () => {
    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1" });
    const payload = notifyMock.mock.calls[0]?.[0] as { rateLimitKey?: string; type: string };
    expect(payload.rateLimitKey).toBeTruthy();
    expect(payload.rateLimitKey).not.toBe(payload.type);
  });
});
