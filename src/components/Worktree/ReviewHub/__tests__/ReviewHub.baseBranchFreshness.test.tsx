/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import type { GitStatus, StagingStatus, WorktreeState } from "@shared/types";
import type { CrossWorktreeDiffResult, CrossWorktreeFile } from "@shared/types/ipc/git";

const { getStagingStatusMock, onUpdateMock, compareWorktreesMock, commitMock, worktreeStoreData } =
  vi.hoisted(() => ({
    getStagingStatusMock: vi.fn(),
    onUpdateMock: vi.fn(),
    compareWorktreesMock: vi.fn(),
    commitMock: vi.fn(),
    worktreeStoreData: {
      current: new Map<string, Partial<WorktreeState>>(),
    },
  }));

vi.mock("@/utils/debounce", () => ({
  debounce: (fn: (...args: unknown[]) => void) => {
    const immediate = (...args: unknown[]) => fn(...args);
    immediate.cancel = vi.fn();
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

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ReviewHubContent } from "../ReviewHubContent";
import { useUIStore } from "@/store/uiStore";
import { useReviewCommitDraftStore } from "@/store/reviewCommitDraftStore";
import { resetStagingStatusCacheForTests } from "../stagingStatusCache";
import { usePanelDialogStore } from "@/store/panelDialogStore";
import { usePanelStore } from "@/store/panelStore";

const MAIN_PATH = "/home/user/project";
const WORKTREE_PATH = "/home/user/project-feature";

const makeStatus = (overrides?: Partial<StagingStatus>): StagingStatus => ({
  staged: [{ path: "src/index.ts", status: "modified", insertions: 5, deletions: 2 }],
  unstaged: [],
  conflicted: [],
  conflictedFiles: [],
  isDetachedHead: false,
  currentBranch: "feature/test",
  hasRemote: false,
  pushDestination: null,
  pullSource: null,
  repoState: "CLEAN",
  repoOperationId: null,
  rebaseStep: null,
  rebaseTotalSteps: null,
  rebaseSequence: null,
  ...overrides,
});

function setWorktrees({
  baseHead = "base1",
  head = "head1",
  branch = "feature/test",
  extra = [],
}: {
  baseHead?: string;
  head?: string;
  branch?: string;
  extra?: Array<[string, Partial<WorktreeState>]>;
} = {}) {
  const changes = (headOid: string, rootPath: string) => ({
    worktreeId: rootPath,
    rootPath,
    changes: [],
    changedFileCount: 0,
    headOid,
  });
  worktreeStoreData.current = new Map<string, Partial<WorktreeState>>([
    [
      "main-wt",
      {
        id: "main-wt",
        path: MAIN_PATH,
        name: "main",
        branch: "main",
        isMainWorktree: true,
        worktreeId: "main-wt",
        worktreeChanges: changes(baseHead, MAIN_PATH),
      },
    ],
    [
      "feature-wt",
      {
        id: "feature-wt",
        path: WORKTREE_PATH,
        name: "feature",
        branch,
        isMainWorktree: false,
        worktreeId: "feature-wt",
        worktreeChanges: changes(head, WORKTREE_PATH),
      },
    ],
    ...extra,
  ]);
}

function comparison(paths: string[]): CrossWorktreeDiffResult {
  return {
    branch1: "main",
    branch2: "feature/test",
    files: paths.map((path) => ({ path, status: "M" }) as CrossWorktreeFile),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const baseRows = () =>
  screen.queryAllByTestId("base-branch-file-row-base").map((row) => row.textContent);

const hub = () => <ReviewHubContent isOpen={true} worktreePath={WORKTREE_PATH} onClose={vi.fn()} />;

async function openVsMain() {
  act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));
  await waitFor(() => expect(baseRows().length).toBeGreaterThan(0));
}

describe("ReviewHub base-branch freshness (#17196)", () => {
  beforeEach(() => {
    resetStagingStatusCacheForTests();
    useUIStore.setState({ reviewHubFileListExpanded: {} });
    useReviewCommitDraftStore.setState({ draftsByWorktree: {} });
    setWorktrees();
    getStagingStatusMock.mockResolvedValue(makeStatus());
    onUpdateMock.mockReturnValue(vi.fn());
    compareWorktreesMock.mockResolvedValue(comparison(["alpha.ts"]));
    commitMock.mockResolvedValue({ hash: "abc123", summary: "commit", oid: null });

    Object.defineProperty(window, "electron", {
      value: {
        git: {
          getStagingStatus: getStagingStatusMock,
          stageFile: vi.fn().mockResolvedValue(undefined),
          unstageFile: vi.fn().mockResolvedValue(undefined),
          stageAll: vi.fn().mockResolvedValue(undefined),
          unstageAll: vi.fn().mockResolvedValue(undefined),
          commit: commitMock,
          push: vi.fn().mockResolvedValue(undefined),
          listCommits: vi.fn().mockResolvedValue({ items: [], hasMore: false, total: 0 }),
          compareWorktrees: compareWorktreesMock,
          onPushProgress: vi.fn().mockReturnValue(vi.fn()),
        },
        system: { openInEditor: vi.fn().mockResolvedValue(undefined) },
        worktreePort: { onEvent: onUpdateMock },
        plugin: {
          getDecorations: vi.fn().mockResolvedValue({}),
          onDecorationsChanged: vi.fn().mockReturnValue(vi.fn()),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("compares again on returning to vs main after a commit in the hub", async () => {
    render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();
    expect(baseRows()).toEqual(["alpha.ts"]);
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);

    act(() => fireEvent.click(screen.getByRole("radio", { name: /working tree/i })));
    fireEvent.change(await screen.findByLabelText("Commit message"), {
      target: { value: "feat: beta" },
    });
    getStagingStatusMock.mockResolvedValue(makeStatus({ staged: [] }));
    act(() => fireEvent.click(screen.getByRole("button", { name: /^Commit$/i })));
    await waitFor(() => expect(commitMock).toHaveBeenCalledTimes(1));

    // Back before the worktree store has heard of the new commit.
    compareWorktreesMock.mockResolvedValue(comparison(["alpha.ts", "beta.ts"]));
    await openVsMain();
    await waitFor(() => expect(baseRows()).toEqual(["alpha.ts", "beta.ts"]));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
  });

  it("lists the new branch's changes after checking out another feature branch", async () => {
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();

    compareWorktreesMock.mockResolvedValue(comparison(["other.ts"]));
    getStagingStatusMock.mockResolvedValue(makeStatus({ currentBranch: "feature/other" }));
    // Created from the same commit, so only the branch name says it moved.
    setWorktrees({ branch: "feature/other" });
    // The worktree's own event is what reads the new branch into the hub.
    const onWorktreeUpdate = onUpdateMock.mock.calls.find(
      ([type]) => type === "worktree-update"
    )?.[1] as (data: unknown) => void;
    await act(async () => {
      onWorktreeUpdate({ worktree: { path: WORKTREE_PATH } });
    });
    rerender(hub());

    await waitFor(() => expect(baseRows()).toEqual(["other.ts"]));
    expect(compareWorktreesMock).toHaveBeenLastCalledWith(
      WORKTREE_PATH,
      "main",
      "feature/other",
      undefined,
      true
    );
  });

  it("goes back to the working tree when HEAD detaches", async () => {
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();

    getStagingStatusMock.mockResolvedValue(
      makeStatus({ currentBranch: null, isDetachedHead: true })
    );
    const onWorktreeUpdate = onUpdateMock.mock.calls.find(
      ([type]) => type === "worktree-update"
    )?.[1] as (data: unknown) => void;
    await act(async () => {
      onWorktreeUpdate({ worktree: { path: WORKTREE_PATH } });
    });
    rerender(hub());

    await waitFor(() =>
      expect(
        screen.getByRole("radio", { name: /working tree/i }).getAttribute("aria-checked")
      ).toBe("true")
    );
    expect(baseRows()).toEqual([]);
    expect(compareWorktreesMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes in place when a commit lands elsewhere while vs main is on screen", async () => {
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();

    const refresh = deferred<CrossWorktreeDiffResult>();
    compareWorktreesMock.mockReturnValue(refresh.promise);
    // An agent's commit in a terminal reaches the hub only through the store.
    setWorktrees({ head: "head2" });
    rerender(hub());

    await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(2));
    // The list being read stays up while the new one is fetched.
    expect(baseRows()).toEqual(["alpha.ts"]);
    expect(screen.queryByRole("status", { name: /loading changes vs main/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" }).getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      refresh.resolve(comparison(["alpha.ts", "gamma.ts"]));
      await refresh.promise;
    });
    expect(baseRows()).toEqual(["alpha.ts", "gamma.ts"]);
  });

  it("refreshes when the base branch moves", async () => {
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();

    compareWorktreesMock.mockResolvedValue(comparison([]));
    setWorktrees({ baseHead: "base2" });
    rerender(hub());

    await waitFor(() => screen.getByText("No changes vs main"));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
  });

  it("follows the base branch where it is checked out, not a detached main worktree", async () => {
    const linkedMain = (headOid: string): [string, Partial<WorktreeState>] => [
      "linked-main",
      {
        id: "linked-main",
        path: "/home/user/project-main",
        name: "main",
        branch: "main",
        isMainWorktree: false,
        worktreeId: "linked-main",
        worktreeChanges: {
          worktreeId: "linked-main",
          rootPath: "/home/user/project-main",
          changes: [],
          changedFileCount: 0,
          headOid,
        },
      },
    ];
    // The main worktree detached, keeping its old branch name on the snapshot.
    const detachMain = () => {
      const main = worktreeStoreData.current.get("main-wt")!;
      worktreeStoreData.current.set("main-wt", { ...main, isDetached: true });
    };
    setWorktrees({ extra: [linkedMain("base1")] });
    detachMain();
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    await openVsMain();

    compareWorktreesMock.mockResolvedValue(comparison([]));
    setWorktrees({ extra: [linkedMain("base2")] });
    detachMain();
    rerender(hub());

    await waitFor(() => screen.getByText("No changes vs main"));
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
  });

  it("doesn't strand the skeleton when the tip moves away from a comparison still loading", async () => {
    compareWorktreesMock.mockReturnValue(new Promise<CrossWorktreeDiffResult>(() => {}));
    const { rerender } = render(hub());
    await waitFor(() => screen.getByText("index.ts"));
    act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));
    await waitFor(() => expect(compareWorktreesMock).toHaveBeenCalledTimes(1));

    // Leave mid-load, and let the tip move while away: that drops the request.
    act(() => fireEvent.click(screen.getByRole("radio", { name: /working tree/i })));
    setWorktrees({ head: "head2" });
    rerender(hub());

    compareWorktreesMock.mockResolvedValue(comparison(["delta.ts"]));
    await openVsMain();
    expect(baseRows()).toEqual(["delta.ts"]);
    expect(compareWorktreesMock).toHaveBeenCalledTimes(2);
  });
  describe("opening a base-branch file carries its change type (#17582)", () => {
    const PANEL_ID = "base-diff-panel";

    afterEach(() => {
      vi.restoreAllMocks();
      usePanelDialogStore.setState({ dialogStack: [] });
      usePanelStore.setState((state) => {
        const { [PANEL_ID]: _removed, ...rest } = state.panelsById;
        return { panelsById: rest };
      });
    });

    it("opens a deleted file as deleted and steps to an added one as added", async () => {
      compareWorktreesMock.mockResolvedValue({
        branch1: "main",
        branch2: "feature/test",
        files: [
          { path: "gone.ts", status: "D", insertions: 0, deletions: 3 },
          { path: "fresh.ts", status: "A", insertions: 4, deletions: 0 },
        ],
      } satisfies CrossWorktreeDiffResult);
      const open = vi
        .spyOn(usePanelDialogStore.getState(), "openPanelDialog")
        .mockImplementation(async (rawOptions) => {
          // AddPanelOptions is a union that doesn't name the diff fields.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the hub's diff request
          const options = rawOptions as unknown as {
            title: string;
            filePath: string;
            fileStatus: GitStatus;
          };
          usePanelStore.setState((state) => ({
            panelsById: {
              ...state.panelsById,
              [PANEL_ID]: {
                id: PANEL_ID,
                kind: "diff",
                title: options.title,
                location: "dialog",
                filePath: options.filePath,
                fileStatus: options.fileStatus,
                diffSource: "base-branch",
              },
            },
          }));
          usePanelDialogStore.setState({ dialogStack: [PANEL_ID] });
          return PANEL_ID;
        });
      render(hub());
      await waitFor(() => screen.getByText("index.ts"));
      act(() => fireEvent.click(screen.getByRole("radio", { name: /vs main/i })));
      await waitFor(() => expect(baseRows().length).toBe(2));

      const rows = screen.getAllByTestId("base-branch-file-row-base");
      fireEvent.click(rows.find((row) => row.textContent === "gone.ts")!);
      await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
      const options = open.mock.calls[0]![0] as {
        fileStatus: string;
        changeSet: Array<{ path: string; status: string }>;
      };
      expect(options.fileStatus).toBe("deleted");
      expect(options.changeSet.map((entry) => [entry.path, entry.status])).toEqual([
        ["fresh.ts", "added"],
        ["gone.ts", "deleted"],
      ]);

      await act(async () => {});
      fireEvent.click(
        screen
          .getAllByTestId("base-branch-file-row-base")
          .find((r) => r.textContent === "fresh.ts")!
      );
      await waitFor(() => {
        const panel = usePanelStore.getState().panelsById[PANEL_ID];
        expect(panel?.kind === "diff" && panel.fileStatus).toBe("added");
      });
      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});
