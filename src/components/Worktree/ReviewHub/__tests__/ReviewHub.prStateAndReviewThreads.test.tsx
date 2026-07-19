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

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: ReactNode) => children };
});

vi.mock("@/hooks", () => ({
  useOverlayState: vi.fn(),
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

import { ReviewHub } from "../ReviewHub";
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

    // The Review Hub's file-list disclosure defaults to collapsed (issue
    // #7886). Existing tests assume rows are visible — expand the disclosure
    // for the canonical worktree path so suite-wide assertions keep working.
    useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, true);

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

  describe("PR state indicator", () => {
    function setWorktreePR(prData: {
      prNumber: number;
      prUrl: string;
      prState: "open" | "merged" | "closed";
      prCiStatus?: "success" | "failure" | "pending";
    }) {
      const existing = worktreeStoreData.current.get("main-wt")!;
      const mappedState =
        prData.prState === "closed"
          ? ("closed" as const)
          : prData.prState === "merged"
            ? ("merged" as const)
            : ("open" as const);
      const ciState =
        prData.prCiStatus === "success"
          ? ("success" as const)
          : prData.prCiStatus === "failure"
            ? ("failure" as const)
            : prData.prCiStatus === "pending"
              ? ("pending" as const)
              : undefined;
      worktreeStoreData.current.set("main-wt", {
        ...existing,
        ...prData,
        linked: {
          providerId: "github",
          pr: {
            ref: {
              providerId: "github",
              owner: "test",
              repo: "test",
              number: prData.prNumber,
              rawData: {},
            },
            state: mappedState,
            url: prData.prUrl,
            ...(ciState
              ? {
                  ciStatus: {
                    state: ciState,
                    total: 0,
                    passed: 0,
                    failed: 0,
                    pending: 0,
                    rawData: null,
                  },
                }
              : {}),
          },
        },
      });
    }

    it("shows PR badge with number and state when worktree has a PR", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByRole("button", { name: /view pull request #42/i });
        screen.getByText("#42");
        screen.getByText("open");
      });
    });

    it("opens PR in browser when external-link button is clicked", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByRole("button", { name: /view pull request #42/i }));

      // Clicking the pill text does not open the PR
      fireEvent.click(screen.getByText("#42"));
      expect(openExternalMock).not.toHaveBeenCalled();

      // Clicking the external-link button opens the PR via the generic
      // system opener (no GitHub-specific IPC).
      fireEvent.click(screen.getByRole("button", { name: /view pull request #42/i }));
      expect(openExternalMock).toHaveBeenCalledWith("https://github.com/test/repo/pull/42");
    });

    it("shows 'No PR' when branch has remote but no PR", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("No PR");
      });
    });

    it("does not show PR indicator when branch has no remote, even with PR data", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));
      expect(screen.queryByText("No PR")).toBeNull();
      expect(screen.queryByText("#42")).toBeNull();
    });

    it("shows closed state for closed PRs", async () => {
      setWorktreePR({
        prNumber: 77,
        prUrl: "https://github.com/test/repo/pull/77",
        prState: "closed",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("#77");
        screen.getByText("closed");
      });
    });

    it("shows merged state for merged PRs", async () => {
      setWorktreePR({
        prNumber: 99,
        prUrl: "https://github.com/test/repo/pull/99",
        prState: "merged",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("#99");
        screen.getByText("merged");
      });
    });

    it("shows CI status when prCiStatus is set", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
        prCiStatus: "failure",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => {
        screen.getByText("failing");
        screen.getByLabelText(/ci failing/i);
      });
    });

    it("omits CI status when prCiStatus is undefined", async () => {
      setWorktreePR({
        prNumber: 42,
        prUrl: "https://github.com/test/repo/pull/42",
        prState: "open",
      });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("#42"));
      expect(screen.queryByText("passing")).toBeNull();
      expect(screen.queryByText("failing")).toBeNull();
      expect(screen.queryByText("pending")).toBeNull();
    });
  });

  // Issue #9953: the review-thread badge on a base-branch file row must
  // open a provider-authored deep-link (decoration.url), not a hardcoded
  // GitHub-shaped `${prUrl}/files?file=...` URL the renderer used to
  // concatenate. The aria-label must be the provider-authored tooltip,
  // not a count re-derived via `Number.parseInt(decoration.badge)`.
  describe("review-thread badge deep-link (#9953)", () => {
    const deepLinkA =
      "https://github.com/test/repo/pull/42/files#diff-deadbeefcafebabe0000000000000000000000000000000000000000000000";

    function setWorktreePRWithLink() {
      const existing = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", {
        ...existing,
        linked: {
          providerId: "github",
          pr: {
            ref: {
              providerId: "github",
              owner: "test",
              repo: "test",
              number: 42,
              rawData: {},
            },
            state: "open",
            url: "https://github.com/test/repo/pull/42",
          },
        },
      });
    }

    beforeEach(() => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { status: "M", path: "src/component.tsx", insertions: 3, deletions: 1 },
          { status: "A", path: "src/new-file.ts", insertions: 7, deletions: 0 },
        ],
      });
    });

    async function switchToBaseBranchWithPR() {
      setWorktreePRWithLink();
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText("index.ts"));

      act(() => {
        fireEvent.click(screen.getByRole("button", { name: /vs main/i }));
      });
      await waitFor(() => screen.getByText("component.tsx"));
    }

    it("opens the provider-authored deep-link when the badge is clicked", async () => {
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      fireEvent.click(badge);

      expect(openExternalMock).toHaveBeenCalledWith(deepLinkA);
    });

    it("does not concatenate a GitHub-shaped ?file= query onto the PR URL", async () => {
      // Regression for the original bug: the badge used to open
      // `${worktreePR.prUrl}/files?file=${encodeURIComponent(file.path)}`,
      // which github.com doesn't honor.
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      fireEvent.click(badge);

      const calledWith = openExternalMock.mock.calls[0]?.[0] as string | undefined;
      expect(calledWith).toBeDefined();
      // No legacy `?file=` query
      expect(calledWith).not.toMatch(/\?file=/);
      // No `/files?file=` shape at all — the provider's URL is the source
      // of truth and may or may not contain `/files`.
      expect(calledWith).not.toMatch(/\/files\?/);
    });

    it("uses decoration.tooltip verbatim as the aria-label (no Number.parseInt re-derivation)", async () => {
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          // Provider-authored semantic text, including the
          // "(partial count)" annotation. The host must NOT re-derive
          // a count-based label like "3 unresolved review comments on
          // src/component.tsx".
          tooltip: "3 unresolved review comments (partial count)",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      // The exact provider text is the accessible label.
      expect(
        await screen.findByRole("button", {
          name: "3 unresolved review comments (partial count)",
        })
      ).toBeDefined();
      // The count re-derivation label must NOT appear.
      expect(
        screen.queryByRole("button", {
          name: /3 unresolved review comments on src\/component\.tsx/i,
        })
      ).toBeNull();
    });

    it("renders the decoration.badge as the visible text", async () => {
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      // Visible text equals the provider's badge value, not a re-parsed count
      expect(badge.textContent).toBe("3");
    });

    it("renders the badge but disables click when decoration.url is absent", async () => {
      // The provider shipped the badge + tooltip + color but the deep-link
      // capability is missing (e.g. a future non-GitHub provider that
      // hasn't implemented `buildPRFileUrl` yet). The badge stays visible
      // as an indicator; the click target is disabled so a tooltip-only
      // row doesn't 404.
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          tooltip: "3 unresolved review comments",
          color: "text-status-warning",
        },
      });

      await switchToBaseBranchWithPR();

      const badge = await screen.findByRole("button", {
        name: /3 unresolved review comments/i,
      });
      expect(badge.hasAttribute("disabled")).toBe(true);

      fireEvent.click(badge);
      // Click must NOT route through the legacy prUrl-shape fallback
      // (the old code did `${prUrl}/files?file=...` host-side).
      expect(openExternalMock).not.toHaveBeenCalled();
    });

    it("falls back to a host-side label when the provider omits tooltip", async () => {
      // The host keeps a narrow fallback label for any provider that
      // forgets `tooltip` — the badge is still informative, just less
      // semantic. This documents the carve-out so a future PR that
      // removes the fallback knows the contract.
      getDecorationsMock.mockResolvedValueOnce({
        "src/component.tsx": {
          badge: "3",
          color: "text-status-warning",
          url: deepLinkA,
        },
      });

      await switchToBaseBranchWithPR();

      // `findByRole` polls until the badge appears (the decoration
      // resolves through an async IPC round-trip, so a single
      // `getByRole` after `switchToBaseBranchWithPR` can race the
      // state update under load).
      const badge = await screen.findByRole("button", {
        name: /Unresolved review comments on/i,
      });
      expect(badge.textContent).toBe("3");
      // Click still routes through the deep-link.
      fireEvent.click(badge);
      expect(openExternalMock).toHaveBeenCalledWith(deepLinkA);
    });
  });
});
