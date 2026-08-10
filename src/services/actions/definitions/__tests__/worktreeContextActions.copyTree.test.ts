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
import {
  registerCopyTreeNoticePresenter,
  _resetCopyTreeNoticePresenterForTest,
} from "@/lib/copyTreeFeedback";
import { useCopyTreeRunStore } from "@/store/copyTreeRunStore";

function setupActions(): {
  run: (id: string, args?: unknown, ctx?: Record<string, unknown>) => Promise<unknown>;
  parseArgs: (id: string, args: unknown) => { success: boolean; message?: string };
} {
  const actions: ActionRegistry = new Map();
  const callbacks: ActionCallbacks = {} as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const define = (id: string): AnyActionDefinition => {
    const factory = actions.get(id);
    if (!factory) throw new Error(`missing ${id}`);
    return factory() as AnyActionDefinition;
  };
  return {
    run: async (id, args, ctx) => define(id).run(args, (ctx ?? {}) as never),
    // `run` is dispatched with already-validated args, so a schema-only rule is
    // invisible to it. ActionService parses `argsSchema` first; this reaches the
    // same schema so a guard that never fires cannot pass as one that does.
    parseArgs: (id, args) => {
      const schema = define(id).argsSchema;
      if (!schema) throw new Error(`${id} has no argsSchema`);
      const result = schema.safeParse(args);
      return result.success
        ? { success: true }
        : { success: false, message: result.error.issues[0]?.message };
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
  _resetCopyTreeNoticePresenterForTest();
  useCopyTreeRunStore.setState({ activeRunCount: 0 });
  copyTreeClientMock.generateAndCopyFile.mockResolvedValue({ ...COPY_TREE_RESULT });
});

// Issue #11735 — this action is the single completion point for every copy-tree
// route that isn't the context menu: the toolbar button, its overflow item,
// Cmd+Shift+C, the command palette, the `worktree.copyContext` alias, and agent
// dispatches. Completion goes through announceCopyTreeCopy: the toolbar button
// presents it as a transient tooltip, and with no presenter registered — as in
// every case below unless one is — it falls back to the toast the notifyMock
// observes, so those cases pin the fallback payload.
describe("worktree.copyTree completion announcement", () => {
  it("prefers a registered presenter over the toast fallback", async () => {
    // The tooltip path: when the toolbar button is visible its presenter
    // consumes the notice, and no toast may stack on top of it.
    const presenter = vi.fn().mockReturnValue(true);
    registerCopyTreeNoticePresenter(presenter);

    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1", format: "xml" });

    expect(presenter).toHaveBeenCalledWith({
      title: "Context copied",
      message: "Copied 3 files (4 KB) as XML to clipboard",
    });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("falls back to the toast when the presenter declines", async () => {
    // A registered presenter whose anchor is hidden (overflow-evicted button)
    // returns false; the completion must still land somewhere visible.
    registerCopyTreeNoticePresenter(() => false);

    const { run } = setupActions();
    await run("worktree.copyTree", { worktreeId: "wt-1" });

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("brackets the shared run store so the toolbar spinner tracks every route", async () => {
    // The spinner derives from this count, so an MCP dispatch spins the button
    // exactly like a click. Sampled mid-flight through the client mock.
    const { run } = setupActions();
    let midFlightCount = -1;
    copyTreeClientMock.generateAndCopyFile.mockImplementationOnce(async () => {
      midFlightCount = useCopyTreeRunStore.getState().activeRunCount;
      return { ...COPY_TREE_RESULT };
    });

    await run("worktree.copyTree", { worktreeId: "wt-1" }, { dispatchSource: "agent" });

    expect(midFlightCount).toBe(1);
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(0);
  });

  it("settles the run count even when the copy fails", async () => {
    const { run } = setupActions();
    copyTreeClientMock.generateAndCopyFile.mockRejectedValueOnce(new Error("boom"));
    await expect(run("worktree.copyTree", { worktreeId: "wt-1" })).rejects.toThrow("boom");
    expect(useCopyTreeRunStore.getState().activeRunCount).toBe(0);
  });
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

/**
 * #11750. This action hand-rolls its `argsSchema` instead of reusing
 * `CopyTreeOptionsSchema`, and builds its options object by conditional spread
 * — so a field added to the shared schema reaches it in neither place. These
 * pin both halves against exactly that drift.
 */
describe("worktree.copyTree ignore-file bypass", () => {
  const optionsOf = () =>
    copyTreeClientMock.generateAndCopyFile.mock.calls[0]?.[1] as Record<string, unknown>;

  it("forwards the bypass alongside the scope that justifies it", async () => {
    const { run } = setupActions();

    await run("worktree.copyTree", {
      worktreeId: "wt-1",
      scopePaths: ["docs"],
      scopeIgnoresIgnoreFiles: true,
    });

    expect(optionsOf()).toMatchObject({
      scopePaths: ["docs"],
      scopeIgnoresIgnoreFiles: true,
    });
  });

  it.each([
    ["omitted", {}],
    // The default spelled out, which the SDK reads identically to absence — so
    // the payload should not carry it, matching how the path fields are spread.
    ["explicitly false", { scopeIgnoresIgnoreFiles: false }],
  ])("omits the field entirely when it is %s", async (_label, extra) => {
    const { run } = setupActions();

    await run("worktree.copyTree", { worktreeId: "wt-1", scopePaths: ["docs"], ...extra });

    expect(optionsOf()).not.toHaveProperty("scopeIgnoresIgnoreFiles");
  });

  it("refuses the bypass at the schema when no scope accompanies it", () => {
    const { parseArgs } = setupActions();

    // Scope-bound in the SDK, so this combination is inert rather than wrong —
    // and an inert flag that parses is how a caller gets a short bundle with no
    // explanation, which is the whole complaint behind the issue.
    expect(parseArgs("worktree.copyTree", { scopeIgnoresIgnoreFiles: true }).success).toBe(false);
    expect(
      parseArgs("worktree.copyTree", {
        scopeIgnoresIgnoreFiles: true,
        includePaths: ["docs/guide.md"],
      })
    ).toMatchObject({ success: false, message: expect.stringContaining("scopePaths") });

    expect(
      parseArgs("worktree.copyTree", { scopePaths: ["docs"], scopeIgnoresIgnoreFiles: true })
        .success
    ).toBe(true);
    // The guard fires on the opt-in only; every request that never asked for it
    // has to keep parsing exactly as before.
    expect(parseArgs("worktree.copyTree", { includePaths: ["src/**"] }).success).toBe(true);
    expect(parseArgs("worktree.copyTree", undefined).success).toBe(true);
  });
});
