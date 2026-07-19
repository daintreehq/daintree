/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
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

/**
 * `pullRebase` now gates on a `ConfirmDialog` showing the divergence preview
 * (#8242). The push-error CTA only opens the dialog; clicking its
 * `Pull and rebase` confirm button is what reaches the IPC.
 */
async function confirmPullRebase(): Promise<void> {
  const dialog = await screen.findByRole("alertdialog");
  const confirmBtn = within(dialog).getByRole("button", { name: "Pull and rebase" });
  fireEvent.click(confirmBtn);
}

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

  describe("commit panel", () => {
    it("renders both Commit and Commit & Push buttons when hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.getByRole("button", { name: /^Commit$/i })).toBeDefined();
      expect(screen.getByRole("button", { name: /Commit & Push \(1\)/i })).toBeDefined();
    });

    it("renders single Commit button when hasRemote is false", async () => {
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.queryByRole("button", { name: /Commit & Push/i })).toBeNull();
      expect(screen.getByRole("button", { name: /Commit \(1\)/i })).toBeDefined();
    });

    it("uses aria-disabled instead of native disabled on commit button when blocked", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const btn = screen.getByRole("button", { name: /Commit \(0\)/i });
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.hasAttribute("disabled")).toBe(false);
    });

    it("uses aria-disabled on both buttons when blocked and hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const commitBtn = screen.getByRole("button", { name: /^Commit$/i });
      const pushBtn = screen.getByRole("button", { name: /Commit & Push \(0\)/i });
      expect(commitBtn.getAttribute("aria-disabled")).toBe("true");
      expect(pushBtn.getAttribute("aria-disabled")).toBe("true");
    });

    it("shows tooltip content when blocked and hasRemote is false", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: false }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      // The TooltipContent is mocked but the blocker list renders as ReactNode
      // Since our Tooltip mock renders children, the tooltip content reveals via DOM
      expect(screen.getByText("Cannot commit")).toBeDefined();
    });

    it("shows tooltip content when blocked and hasRemote is true", async () => {
      getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [], hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      expect(screen.getAllByText("Cannot commit").length).toBeGreaterThan(0);
    });

    it("reentrancy guard prevents double-commit via rapid clicks", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: test double click" } });

      const btn = screen.getByRole("button", { name: /Commit \(1\)/i });
      fireEvent.click(btn);
      fireEvent.click(btn);

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    });

    it("Cmd+Enter fires primary commit when not blocked", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: keyboard shortcut" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
    });

    it("Cmd+Shift+Enter fires commit (alternate) when hasRemote", async () => {
      commitMock.mockResolvedValue({ hash: "abc", summary: "ok" });
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: shift shortcut" } });
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, shiftKey: true });

      await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  describe("push error banner", () => {
    async function triggerCommitAndPush() {
      // #8025: every remote push now opens a confirm dialog. These tests
      // target push-error handling, not the confirm UI, so pre-set the
      // per-worktree opt-out to bypass the dialog and exercise the push
      // path directly.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, { target: { value: "feat: do the thing" } });

      const commitPushBtn = screen.getByRole("button", { name: /Commit & Push/i });
      await act(async () => {
        fireEvent.click(commitPushBtn);
        await Promise.resolve();
      });
    }

    it("shows auth-failed banner with Open forge settings CTA routed to the resolved provider", async () => {
      const rawError = "fatal: Authentication failed for 'https://github.com/foo/bar.git/'";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("auth-failed");
      expect(banner.textContent).toMatch(/Push failed/i);
      expect(banner.textContent).toMatch(/credentials or SSH key/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();

      // The settings CTA is stamped once the forge provider resolves (async).
      const cta = await screen.findByTestId("review-hub-push-error-cta");
      expect(cta.textContent).toMatch(/Open forge settings/i);
      expect(classifyPushErrorMock).toHaveBeenCalledWith(
        WORKTREE_PATH,
        expect.stringContaining("Authentication failed")
      );
      fireEvent.click(cta);

      expect(actionDispatchMock).toHaveBeenCalledWith(
        "app.settings.openTab",
        { tab: "code-forge", subtab: "daintree.github.github" },
        { source: "user" }
      );
    });

    it("omits the settings CTA when push-error classification fails (no provider resolved)", async () => {
      classifyPushErrorMock.mockRejectedValue(new Error("no forge provider"));
      pushMock.mockRejectedValue(
        Object.assign(new Error("fatal: Authentication failed for 'https://example.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("auth-failed");
      // Message still shows, but there is no provider-agnostic settings route.
      await waitFor(() => expect(classifyPushErrorMock).toHaveBeenCalled());
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("does not show a stale code when a retry surfaces a different error", async () => {
      // First failure is network-unavailable (has a Retry CTA) and the stderr
      // carries a GH code so the default regex mock surfaces it.
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com — GH999"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH999");

      // Retry surfaces a code-less auth failure; hold the classification
      // pending so we can observe the in-flight window.
      let releaseSecond: (v: { providerId: string; classification: null }) => void = () => {};
      classifyPushErrorMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          })
      );
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("fatal: Authentication failed for 'https://example.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "auth-failed"
        )
      );
      // While the second classification is pending, the stale GH999 must be gone.
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();

      await act(async () => {
        releaseSecond({ providerId: "daintree.github.github", classification: null });
        await Promise.resolve();
      });
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();
    });

    it("shows push-rejected-outdated banner with Pull-and-rebase primary CTA only when leaseSha is missing", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected] main -> main (non-fast-forward)"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-outdated");
      expect(banner.textContent).toMatch(/Pull and rebase, or force push to overwrite/i);
      // Primary CTA renders even without leaseSha — it just doesn't get the
      // force-push secondary CTA (would silently degrade to plain --force).
      const primary = screen.getByTestId("review-hub-push-error-cta");
      expect(primary.textContent).toMatch(/Pull and rebase/i);
      expect(screen.queryByTestId("review-hub-push-error-secondary-cta")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
    });

    it("shows both Pull-and-rebase primary and Force-push secondary CTAs when leaseSha is present", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected] feature/x -> feature/x (non-fast-forward)"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc1234567890abc1234567890abc1234567890a",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-outdated");
      const primary = screen.getByTestId("review-hub-push-error-cta");
      expect(primary.textContent).toMatch(/Pull and rebase/i);
      const secondary = screen.getByTestId("review-hub-push-error-secondary-cta");
      expect(secondary.textContent).toMatch(/Force push/i);
    });

    it("Pull-and-rebase CTA invokes pullRebase, refreshes status, and clears the banner on success", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      pullRebaseMock.mockResolvedValueOnce(undefined);

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });
      await act(async () => {
        await confirmPullRebase();
        await Promise.resolve();
      });

      await waitFor(() => expect(pullRebaseMock).toHaveBeenCalledWith(WORKTREE_PATH));
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
      // refresh() called: once on initial load + once after commit (in
      // handleCommitAndPush) + once after pull-rebase success.
      expect(getStagingStatusMock).toHaveBeenCalledTimes(3);
    });

    it("does not call pullRebase until the confirm dialog is accepted (#8242)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      // Dialog is open but unconfirmed — the rebase IPC must not have fired.
      await screen.findByRole("alertdialog");
      expect(pullRebaseMock).not.toHaveBeenCalled();
    });

    it("Pull-and-rebase failure surfaces conflict-unresolved through the banner", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "abc123",
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      pullRebaseMock.mockRejectedValueOnce(
        Object.assign(new Error("CONFLICT (content): Merge conflict in foo.ts"), {
          name: "GitOperationError",
          gitReason: "conflict-unresolved",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });
      await act(async () => {
        await confirmPullRebase();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "conflict-unresolved"
        )
      );
    });

    it("Force-push CTA opens the confirmation dialog with loaded remote commits and confirm calls forcePushWithLease", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          leaseSha: "deadbeef",
          branchName: "feature/x",
        })
      );
      listRemoteCommitsMock.mockResolvedValueOnce([
        { hash: "abcd1234567", date: "2026-01-01", message: "first remote commit", author: "Bob" },
        { hash: "efgh1234567", date: "2026-01-02", message: "second remote commit", author: "Bob" },
      ]);

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-secondary-cta"));
        await Promise.resolve();
      });

      // Dialog opens; commit list loads.
      await waitFor(() =>
        expect(listRemoteCommitsMock).toHaveBeenCalledWith(WORKTREE_PATH, "feature/x", 20)
      );
      await waitFor(() => screen.getByText("first remote commit"));

      const dialog = screen.getByRole("alertdialog");
      const confirmBtn = within(dialog).getByRole("button", { name: /Force push/i });

      await act(async () => {
        fireEvent.click(confirmBtn);
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(forcePushWithLeaseMock).toHaveBeenCalledWith(WORKTREE_PATH, "feature/x", "deadbeef")
      );
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("Force-push CTA is suppressed when leaseSha is absent", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("! [rejected]"), {
          name: "GitOperationError",
          gitReason: "push-rejected-outdated",
          // no leaseSha
          branchName: "feature/x",
        })
      );

      await triggerCommitAndPush();
      await screen.findByTestId("review-hub-push-error");

      expect(screen.queryByTestId("review-hub-push-error-secondary-cta")).toBeNull();
    });

    it("shows push-rejected-policy banner with collapsed raw stderr and GH code", async () => {
      const rawError = "GH006: Protected branch update failed for refs/heads/main.";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "push-rejected-policy",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("push-rejected-policy");
      expect(banner.textContent).toMatch(/protected branch/i);
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
      // The code is resolved async via the forge provider classification.
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH006");
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();

      const toggle = screen.getByTestId("review-hub-push-error-toggle");
      expect(toggle.textContent).toMatch(/Show details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
      expect(toggle.textContent).toMatch(/Hide details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
    });

    it("shows hook-rejected banner with collapsed raw stderr", async () => {
      const rawError = "[remote rejected] main -> main (pre-receive hook declined)";
      pushMock.mockRejectedValue(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("hook-rejected");
      expect(banner.textContent).toMatch(/server-side hook rejected/i);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
    });

    it("shows network-unavailable banner with Retry button that re-pushes without re-committing", async () => {
      const rawError = "Could not resolve host: github.com";
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error(rawError), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("network-unavailable");
      expect(banner.textContent).toMatch(/internet connection/i);
      expect(banner.textContent).not.toContain(rawError);
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);

      pushMock.mockResolvedValueOnce(undefined);

      const retryBtn = screen.getByTestId("review-hub-push-error-cta");
      expect(retryBtn.textContent?.trim()).toBe("Retry");
      await act(async () => {
        fireEvent.click(retryBtn);
        await Promise.resolve();
      });

      await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(2));
      expect(commitMock).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("renders the banner with the classified reason when push rejects (throws)", async () => {
      pushMock.mockRejectedValueOnce(new Error("Could not resolve host: github.com"));

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("network-unavailable");
      // "Push failed" appears exactly once — the title prepends it, so the
      // unknown message must not repeat it.
      expect(banner.textContent?.match(/Push failed/gi) ?? []).toHaveLength(1);
      expect(banner.textContent).toMatch(/internet connection/i);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
    });

    it("updates the banner when a retry fails with a different reason", async () => {
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");

      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("[remote rejected] main -> main (pre-receive hook declined)"), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "hook-rejected"
        )
      );
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
    });

    it("clears the push banner when the modal is closed and reopened", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("Authentication failed"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      // #8025: bypass the per-push confirm dialog for this push-error test.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));
      const { rerender } = render(
        <ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      fireEvent.change(screen.getByPlaceholderText("Commit message…"), {
        target: { value: "feat: thing" },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Commit & Push/i }));
        await Promise.resolve();
      });
      await screen.findByTestId("review-hub-push-error");

      rerender(<ReviewHub isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => expect(screen.queryByTestId("review-hub-push-error")).toBeNull());
    });

    it("does not call push when commit itself fails", async () => {
      commitMock.mockRejectedValueOnce(new Error("nothing to commit"));
      getStagingStatusMock.mockResolvedValue(makeStatus({ hasRemote: true }));

      // #8025: bypass the per-push confirm dialog for this push-error test.
      usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, true);

      render(<ReviewHub isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      fireEvent.change(screen.getByPlaceholderText("Commit message…"), {
        target: { value: "feat: thing" },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Commit & Push/i }));
        await Promise.resolve();
      });

      expect(pushMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId("review-hub-push-error")).toBeNull();
      await waitFor(() => screen.getByText("nothing to commit"));
    });

    it("falls back to generic copy + collapsed raw stderr for an unclassified failure", async () => {
      const rawError = "unexpected: something weird happened";
      pushMock.mockRejectedValue(new Error(rawError));

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(banner.textContent).toMatch(/Push failed/i);
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-cta")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(rawError);
    });

    it("shows a rate-limit message when push throws AppError(RATE_LIMITED)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("Rate limit exceeded"), {
          name: "AppError",
          code: "RATE_LIMITED",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.getAttribute("data-reason")).toBe("unknown");
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      fireEvent.click(screen.getByTestId("review-hub-push-error-toggle"));
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toMatch(
        /Too many push attempts/i
      );
    });

    it("does not render the banner on successful push", async () => {
      pushMock.mockResolvedValue(undefined);

      await triggerCommitAndPush();

      await waitFor(() => expect(pushMock).toHaveBeenCalled());
      expect(screen.queryByTestId("review-hub-push-error")).toBeNull();
    });

    it("shows the 'Push failed' title across reasons", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("Authentication failed"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      const banner = await screen.findByTestId("review-hub-push-error");
      expect(banner.textContent).toMatch(/Push failed/i);
    });

    it("extracts and displays a GH code when present in the raw message", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("GH013: Repository rule violations found."), {
          name: "GitOperationError",
          gitReason: "push-rejected-policy",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect((await screen.findByTestId("review-hub-push-error-code")).textContent).toBe("GH013");
      // Code stays visible without expanding the toggle.
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
    });

    it("does not render a GH code element when none is present", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("[remote rejected] main -> main (pre-receive hook declined)"), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-code")).toBeNull();
    });

    it("hides raw output entirely for hide-policy reasons (no toggle)", async () => {
      pushMock.mockRejectedValue(
        Object.assign(new Error("fatal: Authentication failed for 'https://github.com/'"), {
          name: "GitOperationError",
          gitReason: "auth-failed",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
    });

    it("resets the details toggle when a retry surfaces a new push error", async () => {
      // First failure: network-unavailable has a Retry CTA but no toggle.
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error("Could not resolve host: github.com"), {
          name: "GitOperationError",
          gitReason: "network-unavailable",
        })
      );

      await triggerCommitAndPush();

      await screen.findByTestId("review-hub-push-error");
      expect(screen.queryByTestId("review-hub-push-error-toggle")).toBeNull();

      // Retry rejects with a collapse-policy reason; the new banner must start collapsed
      // (i.e. the toggle state from any prior banner doesn't leak in).
      const retryError = "[remote rejected] main -> main (pre-receive hook declined)";
      pushMock.mockRejectedValueOnce(
        Object.assign(new Error(retryError), {
          name: "GitOperationError",
          gitReason: "hook-rejected",
        })
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId("review-hub-push-error-cta"));
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(screen.getByTestId("review-hub-push-error").getAttribute("data-reason")).toBe(
          "hook-rejected"
        )
      );
      expect(screen.queryByTestId("review-hub-push-error-details")).toBeNull();
      const toggle = screen.getByTestId("review-hub-push-error-toggle");
      expect(toggle.textContent).toMatch(/Show details/i);
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      expect(screen.getByTestId("review-hub-push-error-details").textContent).toBe(retryError);
    });
  });
});
