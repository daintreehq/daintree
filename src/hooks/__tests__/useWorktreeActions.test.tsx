// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const {
  dispatchMock,
  addErrorMock,
  addNotificationMock,
  updateNotificationMock,
  addErrorStoreMock,
} = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  addErrorMock: vi.fn(),
  addNotificationMock: vi.fn(() => "toast-123"),
  updateNotificationMock: vi.fn(),
  addErrorStoreMock: vi.fn(),
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: dispatchMock,
  },
}));

vi.mock("@/store", () => ({
  useErrorStore: Object.assign(
    (selector: (state: { addError: typeof addErrorMock }) => unknown) =>
      selector({ addError: addErrorMock }),
    { getState: () => ({ addError: addErrorStoreMock }) }
  ),
}));

vi.mock("@/store/notificationStore", () => ({
  useNotificationStore: {
    getState: () => ({
      addNotification: addNotificationMock,
      updateNotification: updateNotificationMock,
    }),
  },
}));

vi.mock("@/store/recipeStore", () => ({
  useRecipeStore: {
    getState: () => ({
      generateRecipeFromActiveTerminals: vi.fn(() => []),
    }),
  },
}));

import {
  useWorktreeActions,
  formatCopyResultMessage,
  copyContextWithFeedback,
  describeEmptyFolderCopy,
} from "../useWorktreeActions";

describe("useWorktreeActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const worktree: WorktreeState = {
    id: "wt-1",
    worktreeId: "wt-1",
    path: "/repo/wt-1",
    name: "wt-1",
    branch: "main",
    isCurrent: false,
    isMainWorktree: true,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  };

  it("dispatches worktree.copyTree and leaves the completion toast to the action", async () => {
    // The hook used to format and return the result string for the toolbar to
    // render inline. Completion feedback now belongs to the action, which is
    // the only layer the keybinding and palette routes also pass through — so
    // the hook must neither return a message nor raise its own toast (#11735).
    dispatchMock.mockResolvedValueOnce({ ok: true, result: {} });

    const { result } = renderHook(() => useWorktreeActions());

    await expect(result.current.handleCopyTree(worktree)).resolves.toBeUndefined();

    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.copyTree",
      { worktreeId: "wt-1" },
      { source: "user" }
    );
    expect(addNotificationMock).not.toHaveBeenCalled();
    expect(updateNotificationMock).not.toHaveBeenCalled();
  });

  describe("handleCopyTreeWithOptions — replaying a recent (#11733)", () => {
    // Every field `CopyTreeOptions` carries. The point of the fixture is that
    // it is wider than `worktree.copyTree`'s flat args schema, which accepts
    // only worktreeId/format/modified/includePaths/scopePaths and — because Zod
    // object parsing strips rather than rejects unknown keys — would drop the
    // rest without erroring.
    const storedOptions = {
      format: "markdown" as const,
      filter: ["src/auth/**"],
      exclude: ["**/*.snap"],
      always: ["README.md"],
      includePaths: ["src/index.ts"],
      scopePaths: ["src"],
      modified: true,
      changed: "HEAD~3",
      maxFileSize: 1024,
      maxTotalSize: 4096,
      maxFileCount: 50,
      withLineNumbers: true,
      charLimit: 10_000,
      sort: "size" as const,
    };

    it("routes through the action that accepts the whole options object", async () => {
      dispatchMock.mockResolvedValueOnce({ ok: true, result: {} });

      const { result } = renderHook(() => useWorktreeActions());
      await result.current.handleCopyTreeWithOptions(worktree, storedOptions, "toolbar");

      const [actionId, args] = dispatchMock.mock.calls[0]!;
      expect(actionId).toBe("copyTree.generateAndCopyFile");
      // Nested, not spread: flattening would put the options through the wrong
      // schema and silently lose most of them. The representative flattened
      // fields are the ones `worktree.copyTree` would have accepted, so their
      // presence at the top level is exactly what a regression looks like.
      expect(args.options).toEqual(storedOptions);
      expect(args.format).toBeUndefined();
      expect(args.modified).toBeUndefined();
      expect(args.scopePaths).toBeUndefined();
    });

    it("targets the supplied worktree rather than anything carried on the record", async () => {
      dispatchMock.mockResolvedValueOnce({ ok: true, result: {} });

      const { result } = renderHook(() => useWorktreeActions());
      await result.current.handleCopyTreeWithOptions(worktree, storedOptions);

      expect(dispatchMock.mock.calls[0]![1].worktreeId).toBe(worktree.id);
    });

    it("forwards the run source so history attributes the replay to the toolbar", async () => {
      dispatchMock.mockResolvedValueOnce({ ok: true, result: {} });

      const { result } = renderHook(() => useWorktreeActions());
      await result.current.handleCopyTreeWithOptions(worktree, storedOptions, "toolbar");

      expect(dispatchMock.mock.calls[0]![2]).toEqual({
        source: "user",
        copyTreeRunSource: "toolbar",
      });
    });

    it("classifies and phrases a failed replay exactly like a failed full copy", async () => {
      // A user cannot tell the two routes apart, so the error surface must not
      // either. Compared side by side rather than restated, so a change to one
      // path's classification without the other fails here. `source` is the one
      // field that legitimately differs — the Problems panel shows it verbatim,
      // and the replay only ever comes from the toolbar.
      const failure = { ok: false, error: { message: "permission denied" } };

      const { result } = renderHook(() => useWorktreeActions());

      dispatchMock.mockResolvedValueOnce(failure);
      await result.current.handleCopyTree(worktree);
      const fullCopyError = addErrorMock.mock.calls.at(-1)![0];

      dispatchMock.mockResolvedValueOnce(failure);
      await result.current.handleCopyTreeWithOptions(worktree, storedOptions);
      const replayError = addErrorMock.mock.calls.at(-1)![0];

      // `correlationId` is a fresh UUID per report and `details` is a stack
      // trace naming the calling function, so neither can match across paths.
      // What must match is the classification and the words the user reads.
      const comparable = ({
        correlationId: _id,
        source: _source,
        details: _details,
        ...rest
      }: typeof replayError) => rest;
      expect(comparable(replayError)).toEqual(comparable(fullCopyError));
      expect(replayError.source).not.toBe(fullCopyError.source);
    });

    it("settles after a synchronous throw so the caller's spinner can clear", async () => {
      // Not mockRejectedValue: a throw *before* a promise is returned is the
      // case that would escape a `.finally()` on the returned value.
      dispatchMock.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      const { result } = renderHook(() => useWorktreeActions());
      await expect(
        result.current.handleCopyTreeWithOptions(worktree, storedOptions)
      ).resolves.toBeUndefined();
      expect(addErrorMock).toHaveBeenCalled();
    });
  });

  it("records a failed copy in the error store without rejecting", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: "permission denied" },
    });

    const { result } = renderHook(() => useWorktreeActions());

    await expect(result.current.handleCopyTree(worktree)).resolves.toBeUndefined();

    // "permission" routes to the filesystem bucket rather than the default
    // "process" one — the branch is what this asserts, not the literal string.
    expect(addErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "filesystem", context: { worktreeId: "wt-1" } })
    );
  });

  it("handleLaunchAgent dispatches agent.launch through the ActionService", () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: { terminalId: "term-1" } });

    const { result } = renderHook(() => useWorktreeActions());
    result.current.handleLaunchAgent("wt-1", "claude");

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "claude", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );
  });

  it("handleLaunchAgent dispatches agent.launch for dev-preview panels", () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: { terminalId: "term-dev" } });

    const { result } = renderHook(() => useWorktreeActions());
    result.current.handleLaunchAgent("wt-1", "dev-preview");

    expect(dispatchMock).toHaveBeenCalledWith(
      "agent.launch",
      { agentId: "dev-preview", worktreeId: "wt-1", location: "grid" },
      { source: "user" }
    );
  });
});

describe("formatCopyResultMessage", () => {
  it("formats message with file count, size, and format", () => {
    expect(
      formatCopyResultMessage({ fileCount: 42, stats: { totalSize: 1024 }, format: "xml" })
    ).toBe("Copied 42 files (1 KB) as XML to clipboard");
  });

  it("handles missing stats", () => {
    expect(formatCopyResultMessage({ fileCount: 5 })).toBe("Copied 5 files to clipboard");
  });

  it("handles missing fileCount gracefully", () => {
    expect(formatCopyResultMessage({} as { fileCount: number })).toBe(
      "Copied 0 files to clipboard"
    );
  });

  // The destination decides the verb and the trailing phrase. `copyTree.generate`
  // writes a temp file and `injectToTerminal` streams into a PTY — neither
  // touches the clipboard, so the default wording would be false there (#11735).
  it("swaps verb and destination for a terminal injection", () => {
    expect(
      formatCopyResultMessage(
        { fileCount: 42, stats: { totalSize: 1024 }, format: "xml" },
        "terminal"
      )
    ).toBe("Injected 42 files (1 KB) as XML into terminal");
  });

  it("swaps verb and destination for a generated bundle", () => {
    expect(
      formatCopyResultMessage(
        { fileCount: 42, stats: { totalSize: 1024 }, format: "xml" },
        "temporary-file"
      )
    ).toBe("Bundled 42 files (1 KB) as XML into a temporary file");
  });

  it("says nothing about the clipboard for a non-clipboard destination", () => {
    // Guards the whole set at once: a destination that forgot to override the
    // suffix would still claim the bundle reached the clipboard.
    for (const destination of ["terminal", "temporary-file"] as const) {
      expect(formatCopyResultMessage({ fileCount: 1 }, destination)).not.toContain("clipboard");
      expect(formatCopyResultMessage({ fileCount: 1 }, destination)).not.toContain("Copied");
    }
  });
});

describe("copyContextWithFeedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addNotificationMock.mockReturnValue("toast-123");
  });

  it("shows info toast then updates to success on full context copy", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 10, stats: { totalSize: 2048 }, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu");

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", message: "Copying context…" })
    );
    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({ type: "success", duration: 3000 })
    );
  });

  it("passes modified option to dispatch", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 3, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu", { modified: true });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying modified files…" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.copyTree",
      { worktreeId: "wt-1", modified: true },
      { source: "context-menu" }
    );
  });

  it("forwards includePaths to dispatch and labels the progress toast for a folder", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 7, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu", {
      includePaths: ["src/panels/**"],
    });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying folder context…" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.copyTree",
      expect.objectContaining({ worktreeId: "wt-1", includePaths: ["src/panels/**"] }),
      { source: "context-menu" }
    );
  });

  it("forwards scopePaths verbatim and labels the progress toast for a folder", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 4, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu", {
      scopePaths: ["src/panels"],
    });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying folder context…" })
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      "worktree.copyTree",
      expect.objectContaining({ worktreeId: "wt-1", scopePaths: ["src/panels"] }),
      { source: "context-menu" }
    );
  });

  it("names a single-file scope as a file, and keeps scopeKind out of the action args", async () => {
    // The file-row menu's Copy context scopes one file (#11757); calling that a
    // folder would be a lie the transient toast gets away with exactly once.
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 1, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu", {
      scopePaths: ["src/index.ts"],
      scopeKind: "file",
    });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying file context…" })
    );
    expect(dispatchMock).toHaveBeenLastCalledWith(
      "worktree.copyTree",
      expect.objectContaining({ worktreeId: "wt-1", scopePaths: ["src/index.ts"] }),
      { source: "context-menu" }
    );
    // The kind is feedback-only; forwarding it would put an unknown key on the
    // action's args, where Zod strips it silently rather than complaining.
    expect(dispatchMock).not.toHaveBeenLastCalledWith(
      "worktree.copyTree",
      expect.objectContaining({ scopeKind: expect.anything() }),
      expect.anything()
    );
  });

  it("still reads a scoped copy as a folder when the caller says nothing", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: { fileCount: 2, stats: null, format: "xml" },
    });

    await copyContextWithFeedback("wt-1", "context-menu", { scopePaths: ["src"] });

    expect(addNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copying folder context…" })
    );
  });

  it("explains an empty file scope in file words, not folder words", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: true,
      result: {
        fileCount: 0,
        stats: { excluded: { total: 1, byReason: { gitignore: 1 } } },
        format: "xml",
      },
    });

    await copyContextWithFeedback("wt-1", "context-menu", {
      scopePaths: ["dist/bundle.js"],
      scopeKind: "file",
    });

    expect(updateNotificationMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "No files copied",
        message: expect.stringMatching(/^(?!.*folder).*file/i),
      })
    );
  });

  describe("a folder copy that came back empty", () => {
    async function copyFolderYielding(stats: unknown) {
      dispatchMock.mockResolvedValueOnce({
        ok: true,
        result: { fileCount: 0, stats, format: "xml" },
      });
      await copyContextWithFeedback("wt-1", "context-menu", { scopePaths: ["node_modules"] });
      return updateNotificationMock.mock.calls.at(-1)?.[1] as {
        type: string;
        title?: string;
        message: string;
      };
    }

    it("explains an ignored folder instead of reporting a bare zero", async () => {
      const update = await copyFolderYielding({
        excluded: { total: 1, byReason: { configExclude: 1 } },
      });

      expect(update.message).not.toMatch(/\b0 files\b/);
      expect(update.message).toMatch(/ignore/i);
      // A folder the project ignores is a normal outcome, not a failure.
      expect(update.type).toBe("info");
    });

    it("separates a genuinely empty folder from an ignored one", async () => {
      const ignored = await copyFolderYielding({
        excluded: { total: 2, byReason: { gitignore: 2 } },
      });
      const empty = await copyFolderYielding({ excluded: { total: 0, byReason: {} } });

      expect(empty.message).not.toBe(ignored.message);
      expect(empty.message).not.toMatch(/ignore/i);
    });

    it("stops short of a single cause when the exclusions are mixed", async () => {
      const pure = await copyFolderYielding({
        excluded: { total: 2, byReason: { gitignore: 2 } },
      });
      const mixed = await copyFolderYielding({
        excluded: { total: 3, byReason: { gitignore: 1, sizeGate: 2 } },
      });

      // Half the files hitting a size limit doesn't make "everything is
      // ignored" true, so the mixed case must not reuse the confident wording.
      expect(mixed.message).not.toBe(pure.message);
      expect(mixed.message).toMatch(/settings/i);
    });

    it("says the files couldn't be read when that's the only reason", async () => {
      const update = await copyFolderYielding({
        excluded: { total: 2, byReason: { unreadable: 2 } },
      });

      // A folder deleted between render and click reads as unreadable; blaming
      // ignore rules or settings would send the user to the wrong place.
      expect(update.message).not.toMatch(/ignore|settings/i);
      expect(update.message).toMatch(/read/i);
    });

    it("leaves a non-empty folder copy on the normal success path", async () => {
      dispatchMock.mockResolvedValueOnce({
        ok: true,
        result: { fileCount: 3, stats: { totalSize: 1024 }, format: "xml" },
      });

      await copyContextWithFeedback("wt-1", "context-menu", { scopePaths: ["src"] });

      expect(updateNotificationMock).toHaveBeenLastCalledWith(
        "toast-123",
        expect.objectContaining({ type: "success" })
      );
    });

    it("keeps the bare count for a whole-worktree copy, which has no folder to explain", async () => {
      dispatchMock.mockResolvedValueOnce({
        ok: true,
        result: { fileCount: 0, stats: { excluded: { total: 5, byReason: { gitignore: 5 } } } },
      });

      await copyContextWithFeedback("wt-1", "context-menu");

      expect(updateNotificationMock).toHaveBeenLastCalledWith(
        "toast-123",
        expect.objectContaining({ type: "success" })
      );
    });
  });

  describe("describeEmptyFolderCopy", () => {
    it("treats missing stats as an empty folder rather than an ignore rule", () => {
      expect(describeEmptyFolderCopy(undefined)).toBe(
        describeEmptyFolderCopy({ excluded: { total: 0, byReason: {} } })
      );
    });

    it("sums ignore reasons across every ignore source", () => {
      const single = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 2 } },
      });
      const spread = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 1, globalGitignore: 1 } },
      });

      // Split across two ignore files is still "wholly ignored".
      expect(spread).toBe(single);
    });

    it("stops claiming ignore rules once a non-ignore reason is in the mix", () => {
      const pure = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 2 } },
      });
      const mixed = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 1, sizeGate: 1 } },
      });

      expect(mixed).not.toBe(pure);
    });

    it("does not upgrade an inconsistent count into the strongest claim", () => {
      const consistent = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 2 } },
      });
      // Should the SDK ever double-count, an ignore tally above the total is a
      // sign the accounting is wrong — not licence to assert "all ignored".
      const overcounted = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { gitignore: 3 } },
      });

      expect(overcounted).not.toBe(consistent);
    });

    it("reports an all-unreadable folder as unreadable, not as filtered", () => {
      const unreadable = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { unreadable: 2 } },
      });
      const mixed = describeEmptyFolderCopy({
        excluded: { total: 2, byReason: { unreadable: 1, gitignore: 1 } },
      });

      expect(unreadable).not.toBe(mixed);
      expect(unreadable).not.toBe(
        describeEmptyFolderCopy({ excluded: { total: 0, byReason: {} } })
      );
    });
  });

  it("shows 'No files to copy' when result is null", async () => {
    dispatchMock.mockResolvedValueOnce({ ok: true, result: null });

    await copyContextWithFeedback("wt-1", "context-menu");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({ type: "info", message: "No files to copy" })
    );
  });

  it("shows error toast and adds to error store on dispatch failure", async () => {
    dispatchMock.mockResolvedValueOnce({
      ok: false,
      error: { message: "Something went wrong" },
    });

    await copyContextWithFeedback("wt-1", "context-menu");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({
        type: "error",
        message: "Copy context failed: Something went wrong",
      })
    );
    expect(addErrorStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Copy context failed: Something went wrong" })
    );
  });

  it("handles thrown errors gracefully", async () => {
    dispatchMock.mockRejectedValueOnce(new Error("Network error"));

    await copyContextWithFeedback("wt-1", "context-menu");

    expect(updateNotificationMock).toHaveBeenCalledWith(
      "toast-123",
      expect.objectContaining({
        type: "error",
        message: "Copy context failed: Network error",
      })
    );
  });
});
