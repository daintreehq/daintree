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
import { useDiffViewedStore } from "@/store/diffViewedStore";

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

const makeWorktreeState = (path = WORKTREE_PATH): WorktreeState =>
  ({
    id: path,
    path,
    worktreeId: path,
    name: "test",
    isCurrent: true,
    worktreeChanges: null,
    lastActivityTimestamp: null,
  }) as unknown as WorktreeState;

/**
 * `checkoutOursTheirs` now gates on a per-file `ConfirmDialog` (#8242). The
 * row button only opens the dialog; clicking its `Take ours` / `Take theirs`
 * confirm button is what reaches the IPC.
 */

/**
 * `pullRebase` now gates on a `ConfirmDialog` showing the divergence preview
 * (#8242). The push-error CTA only opens the dialog; clicking its
 * `Pull and rebase` confirm button is what reaches the IPC.
 */

const HUB_PANEL_ID = "diff-panel-1";

// Reactive stand-in for the real store's single dialog pointer. Every ownership
// transition the hub has to survive — close, promote to grid, superseded by
// another surface — is a move of that pointer, so a constant makes them
// unobservable and lets a reopen loop hide behind a first-call assertion.
const dialogStore = vi.hoisted(() => {
  let panelId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => panelId,
    set: (next: string | null) => {
      panelId = next;
      for (const listener of listeners) listener();
    },
  };
});

const openPanelDialogMock = vi.hoisted(() =>
  vi.fn<(options: Record<string, unknown>) => Promise<string | null>>()
);
const closePanelDialogMock = vi.hoisted(() => vi.fn<() => void>());

vi.mock("@/store/panelDialogStore", async () => {
  const { useSyncExternalStore } = await import("react");
  // This harness models a single dialog slot, which is what a grid-hosted hub
  // sees: it opens the diff with `openPanelDialog` (replace), so the stack
  // never grows past one. Layering is exercised in panelDialogStore's own suite.
  // The stack array must be referentially stable for a given id, or
  // useSyncExternalStore sees a new snapshot on every call and re-renders
  // forever. Cache it and rebuild only when the underlying id changes.
  const EMPTY: string[] = [];
  let cachedId: string | null = null;
  let cachedStack: string[] = EMPTY;
  const stackOf = (id: string | null) => {
    if (id !== cachedId) {
      cachedId = id;
      cachedStack = id ? [id] : EMPTY;
    }
    return cachedStack;
  };
  const snapshot = () => ({ dialogStack: stackOf(dialogStore.get()) });
  return {
    usePanelDialogStore: Object.assign(
      (selector: (s: { dialogStack: string[] }) => unknown) =>
        useSyncExternalStore(dialogStore.subscribe, () =>
          selector({ dialogStack: stackOf(dialogStore.get()) })
        ),
      {
        getState: () => ({
          ...snapshot(),
          openPanelDialog: openPanelDialogMock,
          closePanelDialog: closePanelDialogMock,
          // Mirrors the real store's membership guard: closing an id that is
          // not presented is a no-op, so it can't tear down another surface's
          // dialog.
          closePanelDialogById: (id: string) => {
            if (dialogStore.get() !== id) return;
            closePanelDialogMock();
          },
        }),
      }
    ),
  };
});

describe("ReviewHub", () => {
  let capturedUpdateCallback: ((state: WorktreeState) => void) | null = null;
  const mockUnsubscribe = vi.fn();

  beforeEach(() => {
    capturedUpdateCallback = null;
    debounceCancelSpy.mockReset();

    // Mirror the real store: opening publishes the pointer, closing clears it.
    dialogStore.set(null);
    openPanelDialogMock.mockImplementation(async () => {
      dialogStore.set(HUB_PANEL_ID);
      return HUB_PANEL_ID;
    });
    closePanelDialogMock.mockImplementation(() => dialogStore.set(null));

    // The Review Hub's file-list disclosure defaults to collapsed (issue
    // #7886). Existing tests assume rows are visible — expand the disclosure
    // for the canonical worktree path so suite-wide assertions keep working.
    useUIStore.getState().setReviewHubFileListExpanded(WORKTREE_PATH, true);

    // #8025: reset the per-worktree push-confirm opt-out so a previous test
    // that pre-set it can't leak into the next one.
    usePreferencesStore.getState().setSkipPushConfirmForWorktree(WORKTREE_PATH, false);

    // Viewed markers live in the shared diffViewedStore (they deliberately
    // survive hub close/reopen), so tests must reset them explicitly.
    useDiffViewedStore.setState({ viewedByWorktree: {} });

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
    onUpdateMock.mockImplementation((_type: string, callback: (data: unknown) => void) => {
      // The component subscribes to the per-view worktree port; tests keep
      // driving it with a plain WorktreeState by wrapping it in the port
      // event envelope here.
      capturedUpdateCallback = (state: WorktreeState) => callback({ worktree: state });
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

  describe("commit message subject counter", () => {
    it("shows subject line length counter", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      fireEvent.change(textarea, {
        target: { value: "fix: resolve bug" },
      });

      expect(screen.getByText("16/72")).toBeTruthy();
    });

    it("counter reflects subject length past the 72-char limit", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…");
      const longSubject = "x".repeat(85);
      fireEvent.change(textarea, { target: { value: longSubject } });

      expect(screen.getByText("85/72")).toBeTruthy();
    });
  });

  describe("commit history arrow-key cycling", () => {
    function renderOpen() {
      return render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );
    }

    function focusTextareaAt(textarea: HTMLTextAreaElement, start: number, end = start) {
      textarea.focus();
      textarea.setSelectionRange(start, end);
    }

    it("fetches and cycles through recent commits on ArrowUp from caret 0", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "fix: older commit",
            body: "Detailed body text.",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const getTextarea = () =>
        screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      // Position cursor at 0 (empty textarea)
      focusTextareaAt(getTextarea(), 0);

      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      expect(listCommitsMock).toHaveBeenCalledWith({
        cwd: WORKTREE_PATH,
        limit: 8,
      });

      // After fetch, the textarea should show the most recent commit message
      await waitFor(() => expect(getTextarea().value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      // ArrowUp again → next older commit (with body)
      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(
        () => expect(getTextarea().value).toBe("fix: older commit\n\nDetailed body text."),
        {
          timeout: 3000,
        }
      );

      // ArrowUp again → no more commits, stays at last
      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(
        () => expect(getTextarea().value).toBe("fix: older commit\n\nDetailed body text."),
        {
          timeout: 3000,
        }
      );
    });

    it("keeps cycling history after the first recalled message even when the caret moved", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "fix: older commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const getTextarea = () =>
        screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(getTextarea(), 0);
      fireEvent.keyDown(getTextarea(), { key: "ArrowUp" });
      await waitFor(() => expect(getTextarea().value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      const textarea = getTextarea();
      focusTextareaAt(textarea, textarea.value.length);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(getTextarea().value).toBe("fix: older commit"), {
        timeout: 3000,
      });
    });

    it("ArrowDown unwinds through history and restores original draft", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: most recent commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
        ],
        hasMore: false,
        total: 1,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      // Type a draft first
      fireEvent.change(textarea, { target: { value: "my draft message" } });
      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: most recent commit"), {
        timeout: 3000,
      });

      // ArrowDown → back to draft
      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      await waitFor(() => expect(textarea.value).toBe("my draft message"), { timeout: 3000 });
    });

    it("does not intercept ArrowUp when caret is not at position 0", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "some text" } });
      // Caret in middle of text
      focusTextareaAt(textarea, 4);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(listCommitsMock).not.toHaveBeenCalled();
    });

    it("resets history index when user types manually after cycling", async () => {
      listCommitsMock.mockResolvedValue({
        items: [
          {
            hash: "abc1234",
            shortHash: "abc1234",
            message: "feat: first commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-10",
          },
          {
            hash: "def5678",
            shortHash: "def5678",
            message: "feat: second commit",
            author: { name: "Test", email: "test@example.com" },
            date: "2026-05-09",
          },
        ],
        hasMore: false,
        total: 2,
      });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: first commit"), { timeout: 3000 });

      // Type manually — should reset history index and start fresh on next ArrowUp
      fireEvent.change(textarea, { target: { value: "typed after cycling" } });

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      // Should show most recent again (cycling from start), not the second-oldest
      await waitFor(() => expect(textarea.value).toBe("feat: first commit"), { timeout: 3000 });

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea.value).toBe("feat: second commit"), { timeout: 3000 });
    });

    it("ArrowUp does nothing when there is no commit history", async () => {
      listCommitsMock.mockResolvedValue({ items: [], hasMore: false, total: 0 });

      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await act(async () => {
        await Promise.resolve();
      });

      expect(textarea.value).toBe("");
    });

    it("ArrowDown does nothing when not in history mode", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      fireEvent.change(textarea, { target: { value: "no history here" } });
      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      // Should remain unchanged
      expect(textarea.value).toBe("no history here");
    });

    it("does not intercept ArrowUp with modifier keys", async () => {
      renderOpen();
      await waitFor(() => screen.getByPlaceholderText("Commit message…"));

      const textarea = screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement;

      focusTextareaAt(textarea, 0);

      fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
      expect(listCommitsMock).not.toHaveBeenCalled();
    });
  });

  describe("per-file Viewed checkbox", () => {
    it("renders an unchecked Viewed checkbox next to each file row", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const viewedCheckboxes = screen.getAllByRole("checkbox", { name: /Mark .* as viewed/ });
      // One per file (1 staged + 1 unstaged from makeStatus).
      expect(viewedCheckboxes).toHaveLength(2);
      for (const cb of viewedCheckboxes) {
        expect((cb as HTMLInputElement).checked).toBe(false);
      }
    });

    it("toggles a file's Viewed state when its checkbox is clicked", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const indexCheckbox = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as viewed",
      }) as HTMLInputElement;
      expect(indexCheckbox.checked).toBe(false);

      fireEvent.click(indexCheckbox);

      // After being checked, the aria-label flips so we now look for the inverse.
      const stillThere = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as not viewed",
      }) as HTMLInputElement;
      expect(stillThere.checked).toBe(true);
    });

    it("does not open the diff panel when the Viewed checkbox is clicked", async () => {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const indexCheckbox = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as viewed",
      });
      openPanelDialogMock.mockClear();

      fireEvent.click(indexCheckbox);

      // Marking a file viewed must not select it — only a row click does that.
      expect(openPanelDialogMock).not.toHaveBeenCalled();
    });

    it("tracks Viewed state independently for staged and unstaged copies of the same path", async () => {
      // Partial-staging scenario: the same file is both staged and unstaged
      // (e.g. user staged some hunks, left others unstaged).
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [{ path: "src/dual.ts", status: "modified", insertions: 1, deletions: 0 }],
          unstaged: [{ path: "src/dual.ts", status: "modified", insertions: 2, deletions: 0 }],
        })
      );

      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getAllByText("dual.ts"));

      const checkboxes = screen.getAllByRole("checkbox", {
        name: "Mark src/dual.ts as viewed",
      }) as HTMLInputElement[];
      // One in the staged section, one in the unstaged section.
      expect(checkboxes).toHaveLength(2);
      const firstCheckbox = checkboxes[0]!;

      fireEvent.click(firstCheckbox);

      // Only the clicked row flips to "viewed"; the sibling row stays unchecked.
      const checkedAfter = screen.getAllByRole("checkbox", {
        name: /Mark src\/dual\.ts as (not viewed|viewed)/,
      }) as HTMLInputElement[];
      const viewedCount = checkedAfter.filter((cb) => cb.checked).length;
      expect(viewedCount).toBe(1);
    });

    it("keeps Viewed state when the modal closes and reopens", async () => {
      // Viewed markers live in the shared diffViewedStore so an in-progress
      // review survives closing the hub (and shows in the diff workspace's
      // sidebar); only an app restart clears them.
      const { rerender } = render(
        <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />
      );

      await waitFor(() => screen.getByText("index.ts"));

      fireEvent.click(screen.getByRole("checkbox", { name: "Mark src/index.ts as viewed" }));

      rerender(<ReviewHubContent isOpen={false} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      rerender(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);

      await waitFor(() => screen.getByText("index.ts"));

      const reopened = screen.getByRole("checkbox", {
        name: "Mark src/index.ts as not viewed",
      }) as HTMLInputElement;
      expect(reopened.checked).toBe(true);
    });
  });

  describe("multi-select", () => {
    const makeMultiFileStatus = (): StagingStatus =>
      makeStatus({
        staged: [
          { path: "src/a.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/c.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
        unstaged: [
          { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
      });

    const renderHub = async () => {
      getStagingStatusMock.mockResolvedValue(makeMultiFileStatus());
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/x.ts"));
    };

    it("renders the default Stage all / Unstage all labels with no selection", async () => {
      await renderHub();
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
      expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
        /Unstage all/i
      );
    });

    it("cmd-click selects an unstaged row and swaps button label to 'Stage selection (1)'", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      fireEvent.click(row, { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });
      expect(row.getAttribute("aria-selected")).toBe("true");
    });

    it("ctrl-click also selects (Windows/Linux modifier)", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      fireEvent.click(row, { ctrlKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });
    });

    it("cmd-click again on a selected row deselects it", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");

      fireEvent.click(row, { metaKey: true });
      await waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

      fireEvent.click(row, { metaKey: true });
      await waitFor(() => {
        expect(row.getAttribute("aria-selected")).toBe("false");
      });
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
    });

    it("shift-click extends the selection across a range", async () => {
      await renderHub();
      const x = screen.getByTestId("file-stage-row-src/x.ts");
      const z = screen.getByTestId("file-stage-row-src/z.ts");

      fireEvent.click(x, { metaKey: true });
      fireEvent.click(z, { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(3\)/i
        );
      });
      expect(screen.getByTestId("file-stage-row-src/y.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("plain click clears an active selection (and does not toggle selection)", async () => {
      await renderHub();
      const x = screen.getByTestId("file-stage-row-src/x.ts");
      const y = screen.getByTestId("file-stage-row-src/y.ts");

      fireEvent.click(x, { metaKey: true });
      fireEvent.click(y, { metaKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(2\)/i
        );
      });

      fireEvent.click(screen.getByTestId("file-stage-row-src/z.ts"));

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
      expect(x.getAttribute("aria-selected")).toBe("false");
      expect(y.getAttribute("aria-selected")).toBe("false");
    });

    it("clicking in the other section clears the existing selection (per-section scope)", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(2\)/i
        );
      });

      // Cmd-click in the staged section
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });
    });

    it("'Stage selection (N)' invokes stageFiles once with all selected paths", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/z.ts"), { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(3\)/i
        );
      });

      fireEvent.click(screen.getByTestId("review-hub-stage-section-button"));

      await waitFor(() => expect(stageFilesMock).toHaveBeenCalledTimes(1));
      expect(stageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, [
        "src/x.ts",
        "src/y.ts",
        "src/z.ts",
      ]);
      expect(stageFileMock).not.toHaveBeenCalled();
      expect(stageAllMock).not.toHaveBeenCalled();
    });

    it("'Unstage selection (N)' invokes unstageFiles once with all selected paths", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      fireEvent.click(screen.getByTestId("review-hub-unstage-section-button"));

      await waitFor(() => expect(unstageFilesMock).toHaveBeenCalledTimes(1));
      expect(unstageFilesMock).toHaveBeenCalledWith(WORKTREE_PATH, ["src/a.ts", "src/b.ts"]);
      expect(unstageFileMock).not.toHaveBeenCalled();
      expect(unstageAllMock).not.toHaveBeenCalled();
    });

    it("clears the selection after a successful batch stage", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/y.ts"), { metaKey: true });

      // Status will reflect the stage on refresh:
      getStagingStatusMock.mockResolvedValueOnce(
        makeStatus({
          staged: [
            { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
          unstaged: [{ path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 }],
        })
      );

      fireEvent.click(screen.getByTestId("review-hub-stage-section-button"));

      await waitFor(() => expect(stageFilesMock).toHaveBeenCalled());
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
    });

    it("guards against rapid double-clicks — only one IPC call is issued", async () => {
      // Hold the resolution of stageFiles so a second click can land before it completes.
      let resolveStageFiles!: () => void;
      stageFilesMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveStageFiles = resolve;
          })
      );

      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });

      const btn = screen.getByTestId("review-hub-stage-section-button");
      fireEvent.click(btn);
      fireEvent.click(btn);

      // Resolve the pending call so the test cleans up.
      resolveStageFiles();
      await waitFor(() => expect(stageFilesMock).toHaveBeenCalledTimes(1));
    });

    it("Escape clears an active selection before closing the modal", async () => {
      const onClose = vi.fn();
      getStagingStatusMock.mockResolvedValue(makeMultiFileStatus());
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={onClose} />);
      await waitFor(() => screen.getByTestId("file-stage-row-src/x.ts"));

      fireEvent.click(screen.getByTestId("file-stage-row-src/x.ts"), { metaKey: true });
      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage selection \(1\)/i
        );
      });

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
          /Stage all/i
        );
      });
      expect(onClose).not.toHaveBeenCalled();

      // Second Escape with no selection closes the modal.
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("removes a staged-then-no-longer-present path from the selection after refresh", async () => {
      await renderHub();
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      // Background refresh removes src/a.ts from the staged section.
      const updated = makeStatus({
        staged: [{ path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 }],
        unstaged: [
          { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
          { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
        ],
      });
      getStagingStatusMock.mockResolvedValue(updated);

      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("file-stage-row-src/a.ts")).toBeNull();
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });
    });

    it("reseats the anchor onto a surviving path when the original anchor is evicted by a refresh", async () => {
      await renderHub();
      // Anchor on src/a.ts, extend to b.ts — selection = {a, b}, anchor = a.
      fireEvent.click(screen.getByTestId("file-stage-row-src/a.ts"), { metaKey: true });
      fireEvent.click(screen.getByTestId("file-stage-row-src/b.ts"), { metaKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });

      // Background refresh drops src/a.ts (the anchor); b.ts and c.ts remain.
      getStagingStatusMock.mockResolvedValue(
        makeStatus({
          staged: [
            { path: "src/b.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/c.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
          unstaged: [
            { path: "src/x.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/y.ts", status: "modified", insertions: 1, deletions: 0 },
            { path: "src/z.ts", status: "modified", insertions: 1, deletions: 0 },
          ],
        })
      );

      await act(async () => {
        capturedUpdateCallback!(makeWorktreeState());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByTestId("file-stage-row-src/a.ts")).toBeNull();
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(1\)/i
        );
      });

      // Shift-click from b (the surviving anchor) to c — selection should extend.
      fireEvent.click(screen.getByTestId("file-stage-row-src/c.ts"), { shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("review-hub-unstage-section-button").textContent).toMatch(
          /Unstage selection \(2\)/i
        );
      });
      expect(screen.getByTestId("file-stage-row-src/b.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
      expect(screen.getByTestId("file-stage-row-src/c.ts").getAttribute("aria-selected")).toBe(
        "true"
      );
    });

    it("stage toggle button on a row does not start a selection", async () => {
      await renderHub();
      const row = screen.getByTestId("file-stage-row-src/x.ts");
      const toggle = within(row).getByRole("button", { name: /Stage src\/x\.ts/i });

      fireEvent.click(toggle);

      // No selection started; the per-row toggle still fires single-file stage.
      await waitFor(() => expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_PATH, "src/x.ts"));
      expect(row.getAttribute("aria-selected")).toBe("false");
      expect(screen.getByTestId("review-hub-stage-section-button").textContent).toMatch(
        /Stage all/i
      );
    });
  });

  describe("diff panel ownership", () => {
    /** Opens the diff for a file row and settles the open promise. */
    async function openDiffFor(fileName: string): Promise<void> {
      render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
      await waitFor(() => screen.getByText(fileName));
      openPanelDialogMock.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByText(fileName).closest("button")!);
      });
      await act(async () => {});
      expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
      expect(dialogStore.get()).toBe(HUB_PANEL_ID);
    }

    it("does not reopen the dialog the user just closed", async () => {
      await openDiffFor("index.ts");

      // Closing clears the global pointer while the hub's row selection is
      // still set — the exact state that used to read as "open a panel".
      await act(async () => {
        closePanelDialogMock();
      });
      await act(async () => {});

      expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
      expect(dialogStore.get()).toBeNull();
    });

    it("does not open a duplicate after its panel is promoted into the grid", async () => {
      await openDiffFor("index.ts");

      // Promotion drops the pointer WITHOUT removing the panel: it now lives in
      // the grid, so a second dialog would be a visible duplicate of it.
      await act(async () => {
        dialogStore.set(null);
      });
      await act(async () => {});

      expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
      // And the promoted panel must survive — no close was issued for it.
      expect(closePanelDialogMock).not.toHaveBeenCalled();
    });

    it("neither reopens nor closes anything when another surface takes the dialog", async () => {
      await openDiffFor("index.ts");

      await act(async () => {
        dialogStore.set("some-other-surfaces-panel");
      });
      await act(async () => {});

      expect(openPanelDialogMock).toHaveBeenCalledTimes(1);
      // Dropping our selection must not reach for the global close: the pointer
      // now names a panel we don't own.
      expect(closePanelDialogMock).not.toHaveBeenCalled();
      expect(dialogStore.get()).toBe("some-other-surfaces-panel");
    });

    it("reopens on a fresh row click after the dialog was closed", async () => {
      await openDiffFor("index.ts");
      await act(async () => {
        closePanelDialogMock();
      });
      await act(async () => {});

      // Clearing the selection on ownership loss must not strand the hub: a new
      // click is a new intent and has to open again.
      await act(async () => {
        fireEvent.click(screen.getByText("app.ts").closest("button")!);
      });
      await act(async () => {});

      expect(openPanelDialogMock).toHaveBeenCalledTimes(2);
      expect(openPanelDialogMock.mock.calls[1]?.[0]).toMatchObject({ filePath: "src/app.ts" });
      expect(dialogStore.get()).toBe(HUB_PANEL_ID);
    });
  });
});
