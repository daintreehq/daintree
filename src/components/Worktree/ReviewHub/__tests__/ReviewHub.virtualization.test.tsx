/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ForwardedRef, ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
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
  // Reached only when a row menu actually renders, which only happens in this
  // file once a windowed row has been revealed.
  useAriaKeyshortcuts: vi.fn(() => undefined),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  // The hoisted fixture holds partial worktrees, which is all the hub reads —
  // typing the selector's view to match beats asserting the narrower shape.
  useWorktreeStore: (
    selector: (state: { worktrees: Map<string, Partial<WorktreeState>> }) => unknown
  ) => selector({ worktrees: worktreeStoreData.current }),
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

/**
 * A `Virtuoso` that mounts every row but reports an arbitrary rendered range.
 *
 * Copied in shape from `src/panels/file-browser/__tests__/FileTreeView.test.tsx`,
 * for the same reason: jsdom measures nothing, so the real virtualizer's window
 * is a function of a viewport that does not exist. Mounting everything while
 * reporting a NARROW range is a combination the real component cannot produce,
 * and it is exactly the one these tests need — it separates "is this row in the
 * DOM" from "does the hub believe this row is in the DOM", which is the whole
 * of the `aria-activedescendant` contract.
 */
const virtuosoRange = { current: null as { startIndex: number; endIndex: number } | null };
const scrollIntoViewMock = vi.fn();

vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  return {
    ...actual,
    Virtuoso: forwardRef(function VirtuosoStub(
      props: {
        data: unknown[];
        context: unknown;
        itemContent: (index: number, item: unknown, context: unknown) => ReactNode;
        computeItemKey?: (index: number, item: unknown, context: unknown) => string;
        rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
      },
      ref: ForwardedRef<Pick<VirtuosoHandle, "scrollIntoView">>
    ) {
      useImperativeHandle(ref, () => ({ scrollIntoView: scrollIntoViewMock }), []);
      const { rangeChanged, data } = props;
      const lastIndex = data.length - 1;
      useEffect(() => {
        rangeChanged?.(virtuosoRange.current ?? { startIndex: 0, endIndex: lastIndex });
      }, [rangeChanged, lastIndex]);
      // Mounts only the slice it reports. `FileTreeView`'s stub renders
      // everything because its tests only need the reported range to differ
      // from the mounted one; these need a row that genuinely has no DOM node,
      // which is the state every contract below is about.
      const range = virtuosoRange.current;
      return (
        <div>
          {props.data.map((item, index) => {
            if (range && (index < range.startIndex || index > range.endIndex)) return null;
            return (
              <div key={props.computeItemKey?.(index, item, props.context) ?? index}>
                {props.itemContent(index, item, props.context)}
              </div>
            );
          })}
        </div>
      );
    }),
  };
});

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

/** Past the 80-row windowing threshold, split across both sections. */
const makeLargeStatus = () =>
  makeStatus({
    staged: Array.from({ length: 60 }, (_, i) => ({
      path: `src/staged/file-${String(i).padStart(3, "0")}.ts`,
      status: "modified" as const,
      insertions: i,
      deletions: 1,
    })),
    unstaged: Array.from({ length: 60 }, (_, i) => ({
      path: `src/unstaged/file-${String(i).padStart(3, "0")}.ts`,
      status: "modified" as const,
      insertions: i,
      deletions: 1,
    })),
  });

describe("ReviewHub windowed file list (#12241)", () => {
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
    onUpdateMock.mockImplementation((_type: string, callback: (data: unknown) => void) => {
      // The component subscribes to the per-view worktree port; tests keep
      // driving it with a plain WorktreeState by wrapping it in the port
      // event envelope here.
      void callback;
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

  beforeEach(() => {
    virtuosoRange.current = null;
    scrollIntoViewMock.mockClear();
    // jsdom implements neither; the static path's reveal calls the first and
    // Radix's menu machinery touches the second.
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  const renderLargeHub = async () => {
    getStagingStatusMock.mockResolvedValue(makeLargeStatus());
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByTestId("file-stage-row-src/staged/file-000.ts"));
    return screen.getByRole("listbox", { name: "Changed files" });
  };

  it("keeps row ids, roles and the flat index space across the section split", async () => {
    await renderLargeHub();
    // Row 60 is the first unstaged file: the staged section's 60 rows come
    // first in one continuous coordinate space, exactly as before windowing.
    const firstUnstaged = screen.getByTestId("file-stage-row-src/unstaged/file-000.ts");
    expect(firstUnstaged.getAttribute("id")).toBe("review-hub-row-60");
    expect(firstUnstaged.getAttribute("data-row-index")).toBe("60");
    expect(firstUnstaged.getAttribute("role")).toBe("option");
    expect(firstUnstaged.getAttribute("aria-selected")).toBe("false");
  });

  it("drops the content-visibility hint once the list windows", async () => {
    await renderLargeHub();
    // The two optimisations answer the same question with different numbers:
    // `contain-intrinsic-size` is a guess, and a virtualizer that measures rows
    // would cache the guess instead of the row.
    const row = screen.getByTestId("file-stage-row-src/staged/file-000.ts");
    expect(row.style.contentVisibility).toBe("");
    expect(row.style.containIntrinsicSize).toBe("");
  });

  it("arrows onto an off-screen row and asks the virtualizer to reveal it", async () => {
    // Only the first ten rows of each section are mounted, so the cursor's
    // fifteenth step lands somewhere with no DOM node.
    virtuosoRange.current = { startIndex: 0, endIndex: 9 };
    const listbox = await renderLargeHub();

    for (let i = 0; i < 15; i++) {
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    }

    // The cursor moved — the hub's own state says so — but the row it names is
    // outside the mounted window, so the listbox must not claim it as its
    // active descendant.
    expect(listbox.getAttribute("aria-activedescendant")).toBeNull();
    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: 14, behavior: "auto" })
    );
  });

  it("names the active descendant again once the window covers the cursor", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 40 };
    const listbox = await renderLargeHub();

    for (let i = 0; i < 15; i++) {
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    }
    expect(listbox.getAttribute("aria-activedescendant")).toBe("review-hub-row-14");
  });

  it("reveals into the unstaged section using that section's own indices", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 59 };
    await renderLargeHub();

    // 61 steps: 60 staged rows, then the second unstaged row.
    for (let i = 0; i < 61; i++) {
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    }
    // Flat index 60 is the unstaged section's index 0 — the reveal has to speak
    // the section's coordinates, not the cursor's.
    expect(scrollIntoViewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ index: 0, behavior: "auto" })
    );
  });

  it("does not re-reveal a stationary cursor when the list renumbers", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 59 };
    await renderLargeHub();
    act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    scrollIntoViewMock.mockClear();

    // Staging a file above the cursor shifts its index without moving it. A
    // reveal keyed on the index alone would scroll here and drag the view off
    // whatever the user was looking at (#11684).
    const status = makeLargeStatus();
    getStagingStatusMock.mockResolvedValue({
      ...status,
      staged: [
        { path: "src/staged/added.ts", status: "modified" as const, insertions: 1, deletions: 0 },
        ...status.staged,
      ],
    });
    act(() => void fireEvent.keyDown(document, { key: "v" }));
    await waitFor(() => expect(scrollIntoViewMock).not.toHaveBeenCalled());
  });

  it("reveals the row before opening its menu when the window has scrolled past it", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 9 };
    await renderLargeHub();
    for (let i = 0; i < 15; i++) {
      act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    }
    expect(screen.queryByTestId("file-stage-row-src/staged/file-014.ts")).toBeNull();
    scrollIntoViewMock.mockClear();

    act(() => void fireEvent.keyDown(document, { key: "F10", shiftKey: true }));

    // Before windowing there was always a node to open the menu on. Now there
    // may not be, and the key must not simply evaporate: the hub asks the
    // virtualizer for the row and replays the menu on the commit that mounts
    // it.
    expect(scrollIntoViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: 14, behavior: "auto" })
    );
  });

  it("windows the base-branch list without changing its rows", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 9 };
    compareWorktreesMock.mockResolvedValue({
      branch1: "main",
      branch2: "feature/test",
      files: Array.from({ length: 120 }, (_, i) => ({
        path: `src/base/file-${String(i).padStart(3, "0")}.ts`,
        status: "modified" as const,
        insertions: i,
        deletions: 1,
      })),
    });
    getStagingStatusMock.mockResolvedValue(makeLargeStatus());
    render(<ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />);
    await waitFor(() => screen.getByTestId("file-stage-row-src/staged/file-000.ts"));

    act(() => void fireEvent.click(screen.getByRole("button", { name: /vs main/i })));
    await waitFor(() => screen.getByText("file-000.ts"));

    // Windowed, but still the same read-only rows: a native button per file,
    // named the way it always was. This list has no cursor and no listbox
    // semantics, and windowing must not invent either.
    expect(screen.queryByText("file-050.ts")).toBeNull();
    expect(screen.getByRole("button", { name: /file-000\.ts/ })).toBeTruthy();
    expect(screen.queryAllByRole("option", { name: /file-000\.ts/ })).toHaveLength(0);
  });

  it("opens the menu directly when the focused row is mounted", async () => {
    virtuosoRange.current = { startIndex: 0, endIndex: 59 };
    await renderLargeHub();
    act(() => void fireEvent.keyDown(document, { key: "ArrowDown" }));
    scrollIntoViewMock.mockClear();

    act(() => void fireEvent.keyDown(document, { key: "F10", shiftKey: true }));

    // No reveal needed, and none requested — the deferred path is for absent
    // rows only, not a new cost on every menu.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByRole("menu").length).toBeGreaterThan(0));
  });
});
