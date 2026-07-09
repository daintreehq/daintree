// @vitest-environment jsdom
import type { ReactElement } from "react";
import { render, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createStore } from "zustand/vanilla";
import type { FileChangeDetail, GitStatus, WorktreeSnapshot } from "@shared/types";
import { FileDiffModal, _resetDiffCacheForTests } from "../FileDiffModal";
import { usePreferencesStore } from "@/store/preferencesStore";
import { WorktreeStoreContext } from "@/contexts/WorktreeStoreContext";
import type { WorktreeViewStoreApi } from "@/store/createWorktreeStore";

// Capture the `diff` prop the lazy FileViewerModal receives so we can assert
// what `fetchDiff` resolves to for each dispatch outcome.
const { mockDispatch, capturedProps } = vi.hoisted(() => ({
  mockDispatch: vi.fn(),
  capturedProps: {
    diff: undefined as string | undefined,
    diffContentStale: undefined as boolean | undefined,
    onRetryDiff: undefined as (() => void) | undefined,
    restoreFocusTo: undefined as unknown,
    currentFileIndex: undefined as number | undefined,
    totalFileCount: undefined as number | undefined,
    onNavigateFile: undefined as ((delta: -1 | 1) => void) | undefined,
  },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: {
    dispatch: (...args: unknown[]) => mockDispatch(...args),
  },
}));

vi.mock("@/components/FileViewer/FileViewerModal", () => ({
  FileViewerModal: (props: {
    diff?: string;
    diffContentStale?: boolean;
    onRetryDiff?: () => void;
    restoreFocusTo?: unknown;
    currentFileIndex?: number;
    totalFileCount?: number;
    onNavigateFile?: (delta: -1 | 1) => void;
  }) => {
    capturedProps.diff = props.diff;
    capturedProps.diffContentStale = props.diffContentStale;
    capturedProps.onRetryDiff = props.onRetryDiff;
    capturedProps.restoreFocusTo = props.restoreFocusTo;
    capturedProps.currentFileIndex = props.currentFileIndex;
    capturedProps.totalFileCount = props.totalFileCount;
    capturedProps.onNavigateFile = props.onNavigateFile;
    return <div data-testid="file-viewer-modal-stub" />;
  },
}));

vi.mock("@/hooks/useBranchForPath", () => ({
  useBranchForPath: () => "main",
}));

const baseProps = {
  isOpen: true,
  filePath: "src/index.ts",
  status: "modified" as GitStatus,
  worktreePath: "/repo",
  onClose: vi.fn(),
};

// Store entries carry absolute paths in production (electron/utils/git.ts
// keys changesMap by absolutePath) while the modal receives worktree-relative
// paths — the fixtures mirror that mismatch on purpose.
function changeEntry(overrides: Partial<FileChangeDetail> = {}): FileChangeDetail {
  return {
    path: "/repo/src/index.ts",
    status: "modified",
    insertions: 3,
    deletions: 1,
    mtimeMs: 1000,
    ...overrides,
  };
}

function worktreesMap(changes: FileChangeDetail[]): Map<string, WorktreeSnapshot> {
  return new Map([
    ["/repo", { path: "/repo", worktreeChanges: { changes } } as unknown as WorktreeSnapshot],
  ]);
}

// Minimal stand-in for the per-view worktree store: the component only reads
// `worktrees` via getState/subscribe.
function createTestWorktreeStore(changes: FileChangeDetail[]): WorktreeViewStoreApi {
  return createStore(() => ({
    worktrees: worktreesMap(changes),
  })) as unknown as WorktreeViewStoreApi;
}

function renderWithStore(ui: ReactElement, store: WorktreeViewStoreApi) {
  return render(<WorktreeStoreContext.Provider value={store}>{ui}</WorktreeStoreContext.Provider>);
}

describe("FileDiffModal", () => {
  beforeEach(() => {
    _resetDiffCacheForTests();
    mockDispatch.mockReset();
    capturedProps.diff = undefined;
    capturedProps.diffContentStale = undefined;
    capturedProps.onRetryDiff = undefined;
    capturedProps.restoreFocusTo = undefined;
    capturedProps.currentFileIndex = undefined;
    capturedProps.totalFileCount = undefined;
    capturedProps.onNavigateFile = undefined;
  });

  it("unwraps the { content } envelope and passes the diff string to the viewer", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(mockDispatch).toHaveBeenCalledWith(
      "git.getFileDiff",
      { cwd: "/repo", filePath: "src/index.ts", status: "modified", ignoreWhitespace: false },
      { source: "user" }
    );
  });

  it("maps empty content to the NO_CHANGES sentinel", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("NO_CHANGES");
    });
  });

  it("maps a failed dispatch to the ERROR sentinel", async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      error: { code: "EXECUTION_ERROR", message: "boom" },
    });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("ERROR");
    });
  });

  it("maps a thrown dispatch error to the ERROR sentinel", async () => {
    mockDispatch.mockRejectedValue(new Error("boom"));
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("ERROR");
    });
  });

  it("threads focus-restore and file-stepping props through to the viewer (#9217)", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const ref = { current: document.createElement("div") };
    const onNavigateFile = vi.fn();
    render(
      <FileDiffModal
        {...baseProps}
        restoreFocusTo={ref}
        currentFileIndex={2}
        totalFileCount={5}
        onNavigateFile={onNavigateFile}
      />
    );
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(capturedProps.restoreFocusTo).toBe(ref);
    expect(capturedProps.currentFileIndex).toBe(2);
    expect(capturedProps.totalFileCount).toBe(5);
    expect(capturedProps.onNavigateFile).toBe(onNavigateFile);
  });

  it("purges stale cache entries when the ignore-whitespace preference toggles", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(1);
    });

    act(() => {
      usePreferencesStore.getState().setDiffIgnoreWhitespace(true);
    });
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(2);
    });

    // Toggling back must hit git again: the entry built without the flag was
    // purged on the first toggle, not kept warm in the cache.
    act(() => {
      usePreferencesStore.getState().setDiffIgnoreWhitespace(false);
    });
    await waitFor(() => {
      expect(mockDispatch).toHaveBeenCalledTimes(3);
    });
    expect(mockDispatch).toHaveBeenLastCalledWith(
      "git.getFileDiff",
      { cwd: "/repo", filePath: "src/index.ts", status: "modified", ignoreWhitespace: false },
      { source: "user" }
    );
  });

  it("flags the diff stale when the file changes under the same status, without refetching (#11032)", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const store = createTestWorktreeStore([changeEntry()]);
    renderWithStore(<FileDiffModal {...baseProps} />, store);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(capturedProps.diffContentStale).toBe(false);

    act(() => {
      store.setState({ worktrees: worktreesMap([changeEntry({ mtimeMs: 2000, insertions: 9 })]) });
    });
    await waitFor(() => {
      expect(capturedProps.diffContentStale).toBe(true);
    });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("ignores changes to other files in the same worktree", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const store = createTestWorktreeStore([changeEntry()]);
    renderWithStore(<FileDiffModal {...baseProps} />, store);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });

    act(() => {
      store.setState({
        worktrees: worktreesMap([
          changeEntry(),
          changeEntry({ path: "/repo/src/other.ts", mtimeMs: 9999 }),
        ]),
      });
    });
    expect(capturedProps.diffContentStale).toBe(false);
  });

  it("matches store entries that carry worktree-relative paths too", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const store = createTestWorktreeStore([changeEntry({ path: "src/index.ts" })]);
    renderWithStore(<FileDiffModal {...baseProps} />, store);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(capturedProps.diffContentStale).toBe(false);

    act(() => {
      store.setState({
        worktrees: worktreesMap([changeEntry({ path: "src/index.ts", mtimeMs: 2000 })]),
      });
    });
    await waitFor(() => {
      expect(capturedProps.diffContentStale).toBe(true);
    });
  });

  it("clears the stale flag after a refresh that bypasses the cache", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const store = createTestWorktreeStore([changeEntry()]);
    renderWithStore(<FileDiffModal {...baseProps} />, store);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });

    act(() => {
      store.setState({ worktrees: worktreesMap([changeEntry({ mtimeMs: 2000 })]) });
    });
    await waitFor(() => {
      expect(capturedProps.diffContentStale).toBe(true);
    });

    mockDispatch.mockResolvedValue({ ok: true, result: { content: "fresh diff" } });
    act(() => {
      capturedProps.onRetryDiff?.();
    });
    await waitFor(() => {
      expect(capturedProps.diff).toBe("fresh diff");
    });
    expect(capturedProps.diffContentStale).toBe(false);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it("flags the diff stale when the file leaves the change list", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const store = createTestWorktreeStore([changeEntry()]);
    renderWithStore(<FileDiffModal {...baseProps} />, store);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });

    act(() => {
      store.setState({ worktrees: worktreesMap([]) });
    });
    await waitFor(() => {
      expect(capturedProps.diffContentStale).toBe(true);
    });
  });

  it("never flags staleness without a worktree-store provider", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    render(<FileDiffModal {...baseProps} />);
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    expect(capturedProps.diffContentStale).toBe(false);
  });

  it("surfaces staleness for a prefetched adjacent diff on navigation", async () => {
    mockDispatch.mockResolvedValue({ ok: true, result: { content: "diff text" } });
    const next = { path: "src/next.ts", status: "modified" as GitStatus };
    const store = createTestWorktreeStore([
      changeEntry(),
      changeEntry({ path: "/repo/src/next.ts" }),
    ]);
    const view = renderWithStore(
      <FileDiffModal {...baseProps} getAdjacentFile={(delta) => (delta === 1 ? next : null)} />,
      store
    );
    await waitFor(() => {
      expect(capturedProps.diff).toBe("diff text");
    });
    // Prefetch fires after the dwell timer (real 500ms) and caches the
    // adjacent diff together with its fetch-time freshness key. Generous
    // timeout so loaded CI runners can't flake it.
    await waitFor(() => expect(mockDispatch).toHaveBeenCalledTimes(2), { timeout: 10000 });

    act(() => {
      store.setState({
        worktrees: worktreesMap([
          changeEntry(),
          changeEntry({ path: "/repo/src/next.ts", mtimeMs: 2000 }),
        ]),
      });
    });
    view.rerender(
      <WorktreeStoreContext.Provider value={store}>
        <FileDiffModal {...baseProps} filePath={next.path} getAdjacentFile={() => null} />
      </WorktreeStoreContext.Provider>
    );
    await waitFor(() => {
      expect(capturedProps.diffContentStale).toBe(true);
    });
    // Served from the prefetch cache — no third fetch, yet still marked stale.
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});
