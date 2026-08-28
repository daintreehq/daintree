/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { StagingStatus } from "@shared/types";
import type { WorktreeState } from "@shared/types";

const {
  getStagingStatusMock,
  onUpdateMock,
  debounceCancelSpy,
  compareWorktreesMock,
  openExternalMock,
  classifyPushErrorMock,
  abortRepositoryOperationMock,
  continueRepositoryOperationMock,
  scanConflictMarkersMock,
  checkoutOursTheirsMock,
  openInEditorMock,
  stageFileMock,
  unstageFileMock,
  stageFilesMock,
  unstageFilesMock,
  stageAllMock,
  unstageAllMock,
  commitMock,
  pushMock,
  pullRebaseMock,
  forcePushWithLeaseMock,
  listRemoteCommitsMock,
  listCommitsMock,
  actionDispatchMock,
  getDecorationsMock,
  onDecorationsChangedMock,
  worktreeStoreData,
} = vi.hoisted(() => ({
  getStagingStatusMock: vi.fn(),
  onUpdateMock: vi.fn(),
  debounceCancelSpy: vi.fn(),
  compareWorktreesMock: vi.fn(),
  openExternalMock: vi.fn().mockResolvedValue(undefined),
  // Mirrors the real GitHub forge provider: extracts a GH### code from stderr
  // and reports the resolved canonical provider id used to route the
  // settings CTA.
  classifyPushErrorMock: vi.fn(async (_cwd: string, stderr: string) => {
    const match = /\bGH\d{3,}\b/.exec(String(stderr));
    return {
      providerId: "daintree.github.github",
      classification: match ? { code: match[0] } : null,
    };
  }),
  abortRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  continueRepositoryOperationMock: vi.fn().mockResolvedValue(undefined),
  scanConflictMarkersMock: vi.fn().mockResolvedValue([]),
  checkoutOursTheirsMock: vi.fn().mockResolvedValue(undefined),
  openInEditorMock: vi.fn().mockResolvedValue(undefined),
  stageFileMock: vi.fn().mockResolvedValue(undefined),
  unstageFileMock: vi.fn().mockResolvedValue(undefined),
  stageFilesMock: vi.fn().mockResolvedValue(undefined),
  unstageFilesMock: vi.fn().mockResolvedValue(undefined),
  stageAllMock: vi.fn().mockResolvedValue(undefined),
  unstageAllMock: vi.fn().mockResolvedValue(undefined),
  commitMock: vi.fn(),
  pushMock: vi.fn(),
  pullRebaseMock: vi.fn(),
  forcePushWithLeaseMock: vi.fn(),
  listRemoteCommitsMock: vi.fn(),
  listCommitsMock: vi.fn().mockResolvedValue({ items: [], hasMore: false, total: 0 }),
  actionDispatchMock: vi.fn().mockResolvedValue({ ok: true }),
  getDecorationsMock: vi.fn().mockResolvedValue({}),
  onDecorationsChangedMock: vi.fn().mockReturnValue(vi.fn()),
  worktreeStoreData: {
    current: new Map<string, Partial<WorktreeState>>([
      [
        "main-wt",
        {
          id: "main-wt",
          path: "/home/user/project",
          name: "main",
          branch: "main",
          isMainWorktree: true,
          isCurrent: false,
          worktreeId: "main-wt",
          worktreeChanges: null,
          lastActivityTimestamp: null,
        },
      ],
    ]),
  },
}));

vi.mock("@/utils/debounce", () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const immediate = (...args: unknown[]) => fn(...args);
    immediate.cancel = debounceCancelSpy;
    immediate.flush = vi.fn();
    return immediate;
  },
}));

vi.mock("@/hooks", () => ({
  useTruncationDetection: vi.fn(() => ({ ref: vi.fn(), isTruncated: false })),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (selector: (state: { worktrees: Map<string, WorktreeState> }) => unknown) =>
    selector({ worktrees: worktreeStoreData.current as Map<string, WorktreeState> }),
}));

vi.mock("@/clients/systemClient", () => ({
  systemClient: { openExternal: openExternalMock },
}));

vi.mock("@/clients/forgeClient", () => ({
  forgeClient: { classifyPushError: classifyPushErrorMock },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: actionDispatchMock },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-disabled": ariaDisabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-disabled"?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={ariaDisabled}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: ({
    isOpen,
    title,
    description,
    children,
    onConfirm,
    onClose,
    confirmLabel,
    cancelLabel,
  }: {
    isOpen: boolean;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    onConfirm: () => void;
    onClose?: () => void;
    confirmLabel: string;
    cancelLabel?: string;
    variant: "default" | "destructive" | "info";
  }) => {
    if (!isOpen) return null;
    return (
      <div role="alertdialog" aria-label={typeof title === "string" ? title : "confirm"}>
        <div>{title}</div>
        {description && <div>{description}</div>}
        {children && <div>{children}</div>}
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            {cancelLabel ?? "Cancel"}
          </button>
        )}
      </div>
    );
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button type="button">{children}</button>,
  DropdownMenuContent: ({
    children,
    align: _align,
    className: _className,
  }: {
    children: ReactNode;
    align?: string;
    className?: string;
  }) => <div role="menu">{children}</div>,
  DropdownMenuRadioGroup: ({
    children,
    value,
    onValueChange: _onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (v: string) => void;
  }) => <div data-value={value}>{children}</div>,
  DropdownMenuRadioItem: ({ children, value: _value }: { children: ReactNode; value: string }) => (
    <div role="menuitemradio">{children}</div>
  ),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <div
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className="cursor-pointer"
    >
      {children}
    </div>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

vi.mock("@/components/ui/EmptyState", () => ({
  EmptyState: ({
    variant,
    scale,
    title,
    action,
  }: {
    variant: string;
    scale?: string;
    title: string;
    action?: ReactNode;
  }) => (
    <div data-testid={`empty-state-${variant}`} data-scale={scale}>
      <p>{title}</p>
      {action && <div>{action}</div>}
    </div>
  ),
}));

import { ReviewHubContent } from "../ReviewHubContent";
import { useUIStore } from "@/store/uiStore";
import { usePreferencesStore } from "@/store/preferencesStore";

const WORKTREE_PATH = "/home/user/project";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [{ path: "src/app.ts", status: "modified", insertions: 3, deletions: 1 }],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  pushDestination: { remote: "origin", branch: "feature/test" },
  pullSource: { remote: "origin", branch: "feature/test" },
  repoState: "DIRTY",
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
  ...overrides,
});

describe("ReviewHub", () => {
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    debounceCancelSpy.mockReset();

    // Clear the file-list disclosure map rather than force-expanding it: the
    // disclosure now defaults to expanded, so an unset entry is what production
    // renders, and clearing also stops a test that collapses it from leaking
    // into the next one.
    useUIStore.setState({ reviewHubFileListExpanded: {} });

    // #8025: reset the per-worktree push-confirm opt-out so a previous test
    // that pre-set it can't leak into the next one.
    usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, false);

    worktreeStoreData.current = new Map([
      [
        "main-wt",
        {
          id: "main-wt",
          path: "/home/user/project",
          name: "main",
          branch: "main",
          isMainWorktree: true,
          isCurrent: false,
          worktreeId: "main-wt",
          worktreeChanges: null,
          lastActivityTimestamp: null,
        },
      ],
    ]);

    getStagingStatusMock.mockResolvedValue(makeStatus());
    onUpdateMock.mockImplementation(() => {
      return mockUnsubscribe;
    });

    compareWorktreesMock.mockResolvedValue({ branch1: "main", branch2: "feature/test", files: [] });

    abortRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    continueRepositoryOperationMock.mockReset().mockResolvedValue(undefined);
    scanConflictMarkersMock.mockReset().mockResolvedValue([]);
    checkoutOursTheirsMock.mockReset().mockResolvedValue(undefined);
    openInEditorMock.mockReset().mockResolvedValue(undefined);
    stageFileMock.mockReset().mockResolvedValue(undefined);
    unstageFileMock.mockReset().mockResolvedValue(undefined);
    stageFilesMock.mockReset().mockResolvedValue(undefined);
    unstageFilesMock.mockReset().mockResolvedValue(undefined);
    stageAllMock.mockReset().mockResolvedValue(undefined);
    unstageAllMock.mockReset().mockResolvedValue(undefined);
    commitMock.mockReset().mockResolvedValue({ hash: "abc123", summary: "commit" });
    pushMock.mockReset().mockResolvedValue(undefined);
    pullRebaseMock.mockReset().mockResolvedValue(undefined);
    forcePushWithLeaseMock.mockReset().mockResolvedValue(undefined);
    listRemoteCommitsMock.mockReset().mockResolvedValue([]);
    listCommitsMock.mockReset().mockResolvedValue({ items: [], hasMore: false, total: 0 });
    actionDispatchMock.mockReset().mockResolvedValue({ ok: true });
    openExternalMock.mockReset().mockResolvedValue(undefined);
    classifyPushErrorMock.mockReset().mockImplementation(async (_cwd: string, stderr: string) => {
      const match = /\bGH\d{3,}\b/.exec(String(stderr));
      return {
        providerId: "daintree.github.github",
        classification: match ? { code: match[0] } : null,
      };
    });
    getDecorationsMock.mockReset().mockResolvedValue({});
    onDecorationsChangedMock.mockReset().mockReturnValue(vi.fn());

    Object.defineProperty(window, "electron", {
      value: {
        git: {
          getStagingStatus: getStagingStatusMock,
          stageFile: stageFileMock,
          unstageFile: unstageFileMock,
          stageFiles: stageFilesMock,
          unstageFiles: unstageFilesMock,
          stageAll: stageAllMock,
          unstageAll: unstageAllMock,
          commit: commitMock,
          push: pushMock,
          pullRebase: pullRebaseMock,
          forcePushWithLease: forcePushWithLeaseMock,
          listRemoteCommits: listRemoteCommitsMock,
          listCommits: listCommitsMock,
          compareWorktrees: compareWorktreesMock,
          abortRepositoryOperation: abortRepositoryOperationMock,
          continueRepositoryOperation: continueRepositoryOperationMock,
          scanConflictMarkers: scanConflictMarkersMock,
          checkoutOursTheirs: checkoutOursTheirsMock,
          onPushProgress: vi.fn().mockReturnValue(vi.fn()),
        },
        system: { openInEditor: openInEditorMock },
        worktreePort: { onEvent: onUpdateMock },
        plugin: {
          // Default to no decorations; per-describe blocks can override via
          // `getDecorationsMock.mockResolvedValueOnce(...)` once a worktree
          // PR is set (the scope is empty when no PR is linked, so the
          // hook skips the IPC anyway).
          getDecorations: getDecorationsMock,
          onDecorationsChanged: onDecorationsChangedMock,
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("section toolbar", () => {
    const multiFileStatus = (): StagingStatus => ({
      staged: [
        { path: "src/index.ts", status: "modified", insertions: null, deletions: null },
        { path: "src/utils.ts", status: "added", insertions: null, deletions: null },
        { path: "package-lock.json", status: "modified", insertions: null, deletions: null },
      ],
      unstaged: [
        { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
        { path: "src/legacy.ts", status: "deleted", insertions: null, deletions: null },
        { path: "docs/readme.md", status: "untracked", insertions: null, deletions: null },
      ],
      conflicted: [],
      conflictedFiles: [],
      isDetachedHead: false,
      currentBranch: "feature/test",
      hasRemote: false,
      pushDestination: { remote: "origin", branch: "feature/test" },
      pullSource: { remote: "origin", branch: "feature/test" },
      repoState: "DIRTY",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
    });

    it("renders filter input in both section headers", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const filters = screen.getAllByPlaceholderText("Filter…");
      expect(filters).toHaveLength(2);
    });

    it("renders view-options dropdown triggers in both section headers", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const viewOptionBtns = screen.getAllByLabelText("View options");
      expect(viewOptionBtns).toHaveLength(2);
    });

    it("shows count chip with total file count", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      // Verify the section headers show "Staged" and "Changes" labels with counts
      screen.getByText("Staged");
      screen.getByText("Changes");
      // Pluralized count appears in the chip ("3 files" — both sections have 3 entries).
      expect(screen.getAllByText("3 files").length).toBe(2);
      // Both sections have 3 files each, and the bulk buttons also show counts
      screen.getByText("Stage all (3)");
      screen.getByText("Unstage all (3)");
    });

    it("includes aggregate +X -Y churn in section header chips when available", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "src/a.ts", status: "modified", insertions: 5, deletions: 2 },
            { path: "src/b.ts", status: "modified", insertions: 10, deletions: 1 },
          ],
          unstaged: [{ path: "src/c.ts", status: "modified", insertions: 3, deletions: 4 }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("a.ts"));
      // Exact full-text match: catches misordered/duplicate/missing segments.
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("2 files·+15-3");
      const changesChip = screen.getByTestId("changes-section-count-chip");
      expect(changesChip.textContent).toBe("1 file·+3-4");
    });

    it("renders only +N when deletions are zero in the chip", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "new.ts", status: "added", insertions: 10, deletions: 0 }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("new.ts"));
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("1 file·+10");
    });

    it("omits churn suffix when all insertions/deletions are null", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      const stagedChip = screen.getByTestId("staged-section-count-chip");
      expect(stagedChip.textContent).toBe("3 files");
      const changesChip = screen.getByTestId("changes-section-count-chip");
      expect(changesChip.textContent).toBe("3 files");
    });

    it("renders base-branch files in sorted path order", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "z-last.ts" },
          { status: "A", path: "a-first.ts" },
          { status: "M", path: "m-middle.ts" },
        ],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() => screen.getByText("a-first.ts"));

      // Query the rendered filename spans in DOM order.
      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans.map((el) => el.textContent)).toEqual([
        "a-first.ts",
        "m-middle.ts",
        "z-last.ts",
      ]);
    });

    it("sorts base-branch files by directory prefix then filename", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "z/a.ts" },
          { status: "A", path: "a/z.ts" },
          { status: "M", path: "a/a.ts" },
        ],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(3)
      );

      const rows = screen.getAllByTestId("base-branch-file-row-dir");
      const bases = screen.getAllByTestId("base-branch-file-row-base");
      // Expected order: a/a.ts, a/z.ts, z/a.ts
      expect(rows.map((el) => el.textContent)).toEqual(["a/", "a/", "z/"]);
      expect(bases.map((el) => el.textContent)).toEqual(["a.ts", "z.ts", "a.ts"]);
    });

    it("splits base-branch row into dir and base spans for nested paths", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [{ status: "M", path: "src/components/button.tsx" }],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() => screen.getByText("button.tsx"));

      const dirSpans = screen.getAllByTestId("base-branch-file-row-dir");
      expect(dirSpans).toHaveLength(1);
      expect(dirSpans[0]!.textContent).toBe("src/components/");

      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans.map((el) => el.textContent)).toEqual(["button.tsx"]);
    });

    it("omits the dir span for root-level base-branch files", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [{ status: "M", path: "rootfile.md" }],
      });

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => fireEvent.click(screen.getByRole("button", { name: /vs main/i })));

      await waitFor(() =>
        expect(screen.getAllByTestId("base-branch-file-row-base")).toHaveLength(1)
      );

      // Root-level path has no dir prefix.
      expect(screen.queryByTestId("base-branch-file-row-dir")).toBeNull();
      const baseSpans = screen.getAllByTestId("base-branch-file-row-base");
      expect(baseSpans[0]!.textContent).toBe("rootfile.md");
    });

    it("renders Stage all (N) button with correct count", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      screen.getByText("Stage all (3)");
      screen.getByText("Unstage all (3)");
    });

    it("filters files when typing in filter input", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      // Type in the Changes filter to find only legacy.ts
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => {
        expect(screen.queryByText("app.ts")).toBeNull();
        expect(screen.queryByText("readme.md")).toBeNull();
        screen.getByText("legacy.ts");
      });
    });

    it("shows Stage shown (N) when filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => screen.getByText("Stage shown (1)"));
    });

    it("shows filtered-empty state when no files match filter", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[0]!, { target: { value: "zzz_nonexistent" } });

      await waitFor(() => screen.getByTestId("empty-state-filtered-empty"));
      screen.getByText('No staged files matching "zzz_nonexistent"');
    });

    it("shows Clear filter link in filtered-empty state", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "zzz" } });

      await waitFor(() => screen.getByText("Clear filter"));
    });

    it("hides generated files when showGenerated is toggled off", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        // package-lock.json should be visible by default
        screen.getByText("package-lock.json");
      });

      // Simulate toggling showGenerated off in Staged section
      // Since DropdownMenu is mocked, we directly call the onCheckedChange via
      // finding the checkbox item and clicking it
      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      // First checkbox is for Staged section "Show generated files"
      fireEvent.click(checkboxes[0]!);

      await waitFor(() => {
        expect(screen.queryByText("package-lock.json")).toBeNull();
      });
    });

    it("uses stageAll IPC when no filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const stageAllBtn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(stageAllBtn);

      await waitFor(() => {
        expect(window.electron.git.stageAll).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    it("uses batched stageFiles when filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "legacy" } });

      await waitFor(() => screen.getByText("Stage shown (1)"));

      const stageBtn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(stageBtn);

      await waitFor(() => {
        expect(stageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/legacy.ts"]);
        expect(window.electron.git.stageAll).not.toHaveBeenCalled();
      });
    });

    it("uses unstageAll IPC when no filter is active", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const unstageAllBtn = screen.getByTestId("review-hub-unstage-section-button");
      fireEvent.click(unstageAllBtn);

      await waitFor(() => {
        expect(window.electron.git.unstageAll).toHaveBeenCalledWith(WORKTREE_PATH);
      });
    });

    /**
     * A fixture whose Changes section contains a generated file, so hiding
     * generated output actually narrows that section.
     */
    const generatedInChangesStatus = (): StagingStatus =>
      makeStatus({
        staged: [{ path: "src/index.ts", status: "modified", insertions: null, deletions: null }],
        unstaged: [
          { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
          { path: "dist/bundle.js", status: "modified", insertions: null, deletions: null },
        ],
      });

    /**
     * The invariant behind #11984's worst defect: the word in the bulk label and
     * the IPC the same button dispatches are two readings of one decision, and
     * they must never disagree. Previously the label branched on the filter
     * query alone while the handler also branched on generated visibility, so
     * hiding generated files produced "Stage all (N)" over a stage-shown call.
     *
     * Asserted as an equivalence rather than a fixed pair, so it keeps holding
     * when new ways to narrow a section are added.
     */
    it("bulk label's scope word agrees with the IPC the button dispatches", async () => {
      const narrowings: { name: string; narrow: () => void }[] = [
        {
          name: "no narrowing at all",
          narrow: () => {},
        },
        {
          name: "an active filter query",
          narrow: () => {
            const filters = screen.getAllByPlaceholderText("Filter…");
            fireEvent.change(filters[1]!, { target: { value: "app" } });
          },
        },
        {
          name: "generated files hidden",
          narrow: () => {
            // [0] is Staged's toggle, [1] is Changes'.
            const checkboxes = screen.getAllByRole("menuitemcheckbox");
            fireEvent.click(checkboxes[1]!);
          },
        },
      ];

      for (const { name, narrow } of narrowings) {
        stageFilesMock.mockClear();
        stageAllMock.mockClear();
        getStagingStatusMock.mockResolvedValue(generatedInChangesStatus());

        const { unmount } = render(
          <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
        );
        await waitFor(() => screen.getByText("app.ts"));

        narrow();

        const button = await screen.findByTestId("review-hub-stage-section-button");
        const claimsWholeSection = /\ball\b/.test(button.textContent ?? "");
        fireEvent.click(button);

        await waitFor(() => {
          expect(stageAllMock.mock.calls.length + stageFilesMock.mock.calls.length).toBe(1);
        });

        // The equivalence. `stageAll` acts on the section; `stageFiles` acts on
        // an explicit path list. Saying "all" and calling the second is the bug.
        expect(
          stageAllMock.mock.calls.length === 1,
          `with ${name}, label was "${button.textContent ?? ""}"`
        ).toBe(claimsWholeSection);

        unmount();
      }
    });

    it("keeps reporting the section's full population when rows are hidden", async () => {
      const status = generatedInChangesStatus();
      getStagingStatusMock.mockResolvedValue(status);

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("app.ts"));

      const total = status.unstaged.length;
      const chip = screen.getByTestId("changes-section-count-chip");
      expect(chip.textContent).toContain(`${total} files`);
      // Nothing hidden yet, so nothing to disclose.
      expect(screen.queryByTestId("unstaged-section-shown-chip")).toBeNull();

      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[1]!);

      await waitFor(() => {
        expect(screen.queryByText("bundle.js")).toBeNull();
      });

      // The headline count must NOT have followed the visible rows down.
      expect(screen.getByTestId("changes-section-count-chip").textContent).toContain(
        `${total} files`
      );
      const shown = screen.getByTestId("unstaged-section-shown-chip");
      expect(shown.textContent).toBe(`${total - 1} shown`);
    });

    it("offers a recovery that can actually reveal the matches when a query only matches hidden generated files", async () => {
      getStagingStatusMock.mockResolvedValue(generatedInChangesStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("app.ts"));

      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[1]!);

      const filters = screen.getAllByPlaceholderText("Filter…");
      fireEvent.change(filters[1]!, { target: { value: "dist" } });

      // "dist/bundle.js" matches the query and exists; it is hidden as
      // generated. Blaming the filter here names the wrong cause and offers a
      // recovery that cannot bring it back.
      const reveal = await screen.findByText("Show generated files", { selector: "button" });
      expect(reveal).toBeTruthy();
      expect(screen.queryByText("Clear filter")).toBeNull();

      fireEvent.click(reveal);
      await waitFor(() => screen.getByText("bundle.js"));
    });

    it("shows bulk button hidden when no files in section", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/a.ts", status: "modified", insertions: null, deletions: null }],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      const allStagedTitle = await screen.findByText("All changes staged");
      const allStagedEmpty = allStagedTitle.closest('[data-testid="empty-state-user-cleared"]');
      expect(allStagedEmpty).not.toBeNull();
      expect(allStagedEmpty?.getAttribute("data-scale")).toBe("sidebar");
      // Stage all button (for Changes section) should be hidden when there are no unstaged files
      expect(screen.queryByTestId("review-hub-stage-section-button")).toBeNull();
      // Unstage all button (for Staged section) should be visible with 1 file
      screen.getByTestId("review-hub-unstage-section-button");
    });

    it("filter input uses ref for typing (no re-render on each keystroke)", async () => {
      getStagingStatusMock.mockResolvedValue(multiFileStatus());

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const filters = screen.getAllByPlaceholderText("Filter…");
      // Just typing should not crash or cause focus loss — the debounce ref handles it
      fireEvent.change(filters[0]!, { target: { value: "src" } });

      // The input value is set via ref, not state, so it shouldn't cause thrashing
      // Verify the input has the value
      expect((filters[0]! as HTMLInputElement).value).toBe("src");
    });

    it("shows Nothing staged user-cleared empty state when section is empty but filter is not active", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [],
          unstaged: [{ path: "src/b.ts", status: "modified", insertions: null, deletions: null }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("Nothing staged");
        screen.getByText("b.ts");
      });
      const nothingStagedTitle = screen.getByText("Nothing staged");
      const nothingStagedEmpty = nothingStagedTitle.closest(
        '[data-testid="empty-state-user-cleared"]'
      );
      expect(nothingStagedEmpty).not.toBeNull();
      expect(nothingStagedEmpty?.getAttribute("data-scale")).toBe("sidebar");
    });

    it("renders files sorted by path ascending by default", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "ccc.ts", status: "added", insertions: null, deletions: null },
            { path: "aaa.ts", status: "modified", insertions: null, deletions: null },
            { path: "bbb.ts", status: "deleted", insertions: null, deletions: null },
          ],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("aaa.ts"));

      // Path asc sort: aaa.ts DOM position < bbb.ts < ccc.ts
      const rows = screen.getAllByText(/\.ts$/).filter((el) => el.tagName === "SPAN");
      const texts = rows.map((el) => el.textContent);
      const aaaIdx = texts.indexOf("aaa.ts");
      const bbbIdx = texts.indexOf("bbb.ts");
      const cccIdx = texts.indexOf("ccc.ts");
      expect(aaaIdx).toBeLessThan(bbbIdx);
      expect(bbbIdx).toBeLessThan(cccIdx);
    });

    it("detects lock files as generated", async () => {
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "package-lock.json", status: "modified", insertions: null, deletions: null },
            { path: "yarn.lock", status: "modified", insertions: null, deletions: null },
            { path: "src/app.ts", status: "modified", insertions: null, deletions: null },
          ],
          unstaged: [],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("package-lock.json");
        screen.getByText("yarn.lock");
        screen.getByText("app.ts");
      });

      // Toggle showGenerated off in Staged section
      const checkboxes = screen.getAllByRole("menuitemcheckbox");
      fireEvent.click(checkboxes[0]!);

      await waitFor(() => {
        expect(screen.queryByText("package-lock.json")).toBeNull();
        expect(screen.queryByText("yarn.lock")).toBeNull();
        screen.getByText("app.ts");
      });
    });
  });
});
