// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { GitWorktreeOperationConfirmDialog } from "../GitWorktreeOperationConfirmDialog";
import {
  useGitWorktreeOperationConfirmStore,
  type GitWorktreeOperationConfirmResult,
} from "@/store/gitWorktreeOperationConfirmStore";
import type {
  GitBaseIntegrationBlocker,
  GitBaseIntegrationCommitPreview,
  GitBaseIntegrationKind,
  RepoOperationPin,
  StagingStatus,
} from "@shared/types/git";

// The app root supplies the TooltipProvider. Triggers render inline; the
// content is left out so a disclosed label is not counted twice.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("zustand/react/shallow", () => ({ useShallow: (fn: unknown) => fn }));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

const listBaseIntegrationCommits = vi.fn();

/** A full commit id, as main's read-last `rev-parse` reports it. */
function oid(char: string): string {
  return char.repeat(40);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CONFIRM_LABEL: Record<GitBaseIntegrationKind, string> = {
  "rebase-onto-base": "Rebase onto base",
  "merge-base": "Merge base in",
};

function measured(
  kind: GitBaseIntegrationKind,
  overrides: Partial<GitBaseIntegrationCommitPreview> = {}
): GitBaseIntegrationCommitPreview {
  return {
    kind,
    branch: "feature/topic",
    baseBranch: "develop",
    blocker: null,
    compareRef: "origin/develop",
    remote: "origin",
    headOid: oid("1"),
    baseOid: oid("2"),
    commits: [{ hash: "abcdef1234567", date: "2026-01-01", message: "Fix the thing", author: "A" }],
    total: 1,
    behind: 3,
    ...overrides,
  };
}

/** What the read returns when a blocker stopped it before measuring. */
function stopped(
  kind: GitBaseIntegrationKind,
  blocker: GitBaseIntegrationBlocker,
  branch: string | null
): GitBaseIntegrationCommitPreview {
  return measured(kind, {
    branch,
    blocker,
    compareRef: null,
    remote: null,
    headOid: null,
    baseOid: null,
    commits: [],
    total: null,
    behind: null,
  });
}

function confirmButton(kind: GitBaseIntegrationKind): HTMLElement {
  return screen.getByRole("button", { name: CONFIRM_LABEL[kind] });
}

function isDisabled(button: HTMLElement): boolean {
  return button.getAttribute("aria-disabled") === "true";
}

async function open(kind: GitBaseIntegrationKind) {
  const outcome: { result: GitWorktreeOperationConfirmResult | null } = { result: null };
  await act(async () => {
    void useGitWorktreeOperationConfirmStore
      .getState()
      .requestConfirmation({ kind, cwd: "/repo", baseBranch: "develop" })
      .then((result) => {
        outcome.result = result;
      });
  });
  return outcome;
}

const KINDS: GitBaseIntegrationKind[] = ["rebase-onto-base", "merge-base"];

describe("GitWorktreeOperationConfirmDialog — base integration blockers (#17189)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { git: { listBaseIntegrationCommits } },
    });
  });

  afterEach(() => {
    if (useGitWorktreeOperationConfirmStore.getState().pendingConfirm) {
      useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
    delete (window as { electron?: unknown }).electron;
  });

  describe.each(KINDS)("%s", (kind) => {
    it("enables approval for a clean branch with something to integrate", async () => {
      listBaseIntegrationCommits.mockResolvedValue(measured(kind));
      render(<GitWorktreeOperationConfirmDialog />);
      await open(kind);

      expect(listBaseIntegrationCommits).toHaveBeenCalledWith("/repo", "develop", kind, 100);
      expect(isDisabled(confirmButton(kind))).toBe(false);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("blocks over uncommitted changes, keeps the commits visible, and offers Retry", async () => {
      listBaseIntegrationCommits.mockResolvedValue(
        measured(kind, { blocker: { reason: "uncommitted-changes", count: 3 } })
      );
      render(<GitWorktreeOperationConfirmDialog />);
      const outcome = await open(kind);

      const notice = screen.getByTestId("git-base-integration-dirty");
      expect(notice.textContent).toContain("3 uncommitted changes");
      // Plain `git stash` leaves the untracked files that block this too.
      expect(notice.textContent).toContain("--include-untracked");
      expect(screen.getByTestId("git-base-integration-dirty-retry")).toBeTruthy();
      expect(isDisabled(confirmButton(kind))).toBe(true);
      // What the operation would do is still worth seeing while deciding to commit first.
      expect(screen.getAllByTestId("git-base-integration-commit-row")).toHaveLength(1);

      await act(async () => {
        confirmButton(kind).click();
      });
      expect(outcome.result).toBeNull();
    });

    it("names unresolved conflicts rather than the dirty-tree advice", async () => {
      listBaseIntegrationCommits.mockResolvedValue(
        measured(kind, { blocker: { reason: "conflicts", count: 2 } })
      );
      render(<GitWorktreeOperationConfirmDialog />);
      await open(kind);

      expect(screen.getByTestId("git-base-integration-conflicts").textContent).toContain(
        "2 unresolved conflicts"
      );
      expect(screen.queryByTestId("git-base-integration-dirty")).toBeNull();
      expect(screen.getByTestId("git-base-integration-conflicts-retry")).toBeTruthy();
      expect(isDisabled(confirmButton(kind))).toBe(true);
    });

    it("diagnoses a halted rebase as an operation in progress, with its progress", async () => {
      listBaseIntegrationCommits.mockResolvedValue(
        stopped(
          kind,
          {
            reason: "operation-in-progress",
            operation: "REBASING",
            rebaseStep: 2,
            rebaseTotalSteps: 5,
          },
          null
        )
      );
      render(<GitWorktreeOperationConfirmDialog />);
      await open(kind);

      const notice = screen.getByTestId("git-base-integration-operation-in-progress");
      expect(notice.textContent).toContain("Rebase in progress");
      expect(notice.textContent).toContain("2 of 5");
      expect(screen.getByTestId("git-base-integration-operation-retry")).toBeTruthy();
      expect(isDisabled(confirmButton(kind))).toBe(true);
      // Unmeasured is not "nothing to do": no in-sync claim, no summary of blanks.
      expect(screen.queryByTestId("git-base-integration-in-sync")).toBeNull();
      expect(screen.queryByTestId("git-base-integration-summary")).toBeNull();
    });

    it("refuses to integrate the base into itself when the base is checked out", async () => {
      listBaseIntegrationCommits.mockResolvedValue(
        stopped(kind, { reason: "base-checked-out" }, "develop")
      );
      render(<GitWorktreeOperationConfirmDialog />);
      await open(kind);

      expect(screen.getByTestId("git-base-integration-base-checked-out").textContent).toContain(
        "develop"
      );
      expect(screen.getByTestId("git-base-integration-base-checked-out-retry")).toBeTruthy();
      expect(isDisabled(confirmButton(kind))).toBe(true);
      expect(screen.queryByTestId("git-base-integration-in-sync")).toBeNull();
      expect(screen.queryByTestId("git-base-integration-summary")).toBeNull();
    });

    it("holds approval for a clean branch already level with the base", async () => {
      listBaseIntegrationCommits.mockResolvedValue(
        measured(kind, { commits: [], total: 0, behind: 0 })
      );
      render(<GitWorktreeOperationConfirmDialog />);
      const outcome = await open(kind);

      expect(screen.getByTestId("git-base-integration-in-sync")).toBeTruthy();
      expect(isDisabled(confirmButton(kind))).toBe(true);
      await act(async () => {
        confirmButton(kind).click();
      });
      expect(outcome.result).toBeNull();
    });

    it("re-enables approval once Retry reads a clean tree, approving the new commits", async () => {
      listBaseIntegrationCommits.mockResolvedValueOnce(
        measured(kind, { blocker: { reason: "uncommitted-changes", count: 1 } })
      );
      render(<GitWorktreeOperationConfirmDialog />);
      const outcome = await open(kind);
      expect(isDisabled(confirmButton(kind))).toBe(true);

      // The agent committed the change, so the branch tip moved: approval must
      // carry the commit the retried read measured, not the first one.
      const retried = deferred<GitBaseIntegrationCommitPreview>();
      listBaseIntegrationCommits.mockReturnValueOnce(retried.promise);
      await act(async () => {
        screen.getByTestId("git-base-integration-dirty-retry").click();
      });
      expect(listBaseIntegrationCommits).toHaveBeenCalledTimes(2);
      // Held while the re-read is in flight.
      expect(isDisabled(confirmButton(kind))).toBe(true);

      await act(async () => {
        retried.resolve(measured(kind, { headOid: oid("3") }));
        await retried.promise;
      });
      expect(screen.queryByTestId("git-base-integration-dirty")).toBeNull();
      expect(isDisabled(confirmButton(kind))).toBe(false);

      await act(async () => {
        confirmButton(kind).click();
      });
      expect(outcome.result).toEqual({
        confirmed: true,
        pinned: { branch: "feature/topic", headOid: oid("3"), baseOid: oid("2") },
        operation: null,
      });
    });
  });

  it("says nothing is to do over a dirty tree already level with the base", async () => {
    // "Commit or stash first" would send the user off to do work that ends in
    // "nothing to do".
    listBaseIntegrationCommits.mockResolvedValue(
      measured("merge-base", {
        blocker: { reason: "uncommitted-changes", count: 1 },
        commits: [],
        total: 0,
        behind: 0,
      })
    );
    render(<GitWorktreeOperationConfirmDialog />);
    await open("merge-base");

    expect(screen.getByTestId("git-base-integration-in-sync")).toBeTruthy();
    expect(screen.queryByTestId("git-base-integration-dirty")).toBeNull();
    expect(isDisabled(confirmButton("merge-base"))).toBe(true);
  });

  it("keeps a clean rebase that only moves the branch approvable", async () => {
    // An empty replay set with the base ahead still moves the branch.
    listBaseIntegrationCommits.mockResolvedValue(
      measured("rebase-onto-base", { commits: [], total: 0, behind: 2 })
    );
    render(<GitWorktreeOperationConfirmDialog />);
    await open("rebase-onto-base");

    expect(screen.getByTestId("git-base-integration-nothing-to-replay")).toBeTruthy();
    expect(isDisabled(confirmButton("rebase-onto-base"))).toBe(false);
  });
});

describe("GitWorktreeOperationConfirmDialog — abort binds to the operation it read (#17559)", () => {
  const getStagingStatus = vi.fn();

  function halted(overrides: Partial<StagingStatus> = {}): StagingStatus {
    return {
      staged: [{ path: "a.ts", status: "modified", insertions: 1, deletions: 1 }],
      unstaged: [],
      conflicted: ["b.ts"],
      conflictedFiles: [{ path: "b.ts", xy: "UU", label: "both modified" }],
      isDetachedHead: false,
      currentBranch: "feature/topic",
      hasRemote: false,
      pushDestination: null,
      pullSource: null,
      repoState: "MERGING",
      repoOperationId: "merge-a",
      rebaseStep: null,
      rebaseTotalSteps: null,
      rebaseSequence: null,
      ...overrides,
    };
  }

  async function openAbort(operation: RepoOperationPin["operation"]) {
    const outcome: { result: GitWorktreeOperationConfirmResult | null } = { result: null };
    await act(async () => {
      void useGitWorktreeOperationConfirmStore
        .getState()
        .requestConfirmation({ kind: "abort-operation", cwd: "/repo", operation })
        .then((result) => {
          outcome.result = result;
        });
    });
    return outcome;
  }

  const abortButton = (label: string) => screen.getByRole("button", { name: `Abort ${label}` });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(window, "electron", {
      configurable: true,
      value: { git: { getStagingStatus } },
    });
  });

  afterEach(() => {
    if (useGitWorktreeOperationConfirmStore.getState().pendingConfirm) {
      useGitWorktreeOperationConfirmStore.getState().resolveConfirmation(false);
    }
    cleanup();
    vi.restoreAllMocks();
    delete (window as { electron?: unknown }).electron;
  });

  it("approves the operation its own read found, not the one the menu named", async () => {
    getStagingStatus.mockResolvedValue(halted());
    render(<GitWorktreeOperationConfirmDialog />);
    const outcome = await openAbort("REBASING");

    expect(getStagingStatus).toHaveBeenCalledWith("/repo");
    await act(async () => {
      abortButton("merge").click();
    });
    expect(outcome.result).toEqual({
      confirmed: true,
      pinned: null,
      operation: { operation: "MERGING", operationId: "merge-a" },
    });
  });

  it("holds approval when the read fails, and offers Retry", async () => {
    getStagingStatus.mockRejectedValueOnce(new Error("index.lock exists"));
    render(<GitWorktreeOperationConfirmDialog />);
    const outcome = await openAbort("MERGING");

    expect(isDisabled(abortButton("merge"))).toBe(true);
    await act(async () => {
      abortButton("merge").click();
    });
    expect(outcome.result).toBeNull();

    getStagingStatus.mockResolvedValue(halted({ repoOperationId: "merge-b" }));
    await act(async () => {
      screen.getByTestId("git-abort-operation-retry").click();
    });
    expect(isDisabled(abortButton("merge"))).toBe(false);
    await act(async () => {
      abortButton("merge").click();
    });
    expect(outcome.result?.operation).toEqual({ operation: "MERGING", operationId: "merge-b" });
  });

  it("holds approval for an operation the read couldn't identify", async () => {
    getStagingStatus.mockResolvedValue(halted({ repoState: "REBASING", repoOperationId: null }));
    render(<GitWorktreeOperationConfirmDialog />);
    const outcome = await openAbort("REBASING");

    expect(screen.getByTestId("git-abort-operation-unidentified")).toBeTruthy();
    expect(isDisabled(abortButton("rebase"))).toBe(true);
    await act(async () => {
      abortButton("rebase").click();
    });
    expect(outcome.result).toBeNull();

    // Retry reads again, and an identified answer is what can be approved.
    getStagingStatus.mockResolvedValue(halted({ repoState: "REBASING", repoOperationId: "rb-1" }));
    await act(async () => {
      screen.getByTestId("git-abort-operation-retry").click();
    });
    expect(screen.queryByTestId("git-abort-operation-unidentified")).toBeNull();
    await act(async () => {
      abortButton("rebase").click();
    });
    expect(outcome.result?.operation).toEqual({ operation: "REBASING", operationId: "rb-1" });
  });

  it("declines from Close once the read finds nothing in progress", async () => {
    getStagingStatus.mockResolvedValue(halted({ repoState: "CLEAN", repoOperationId: null }));
    render(<GitWorktreeOperationConfirmDialog />);
    const outcome = await openAbort("MERGING");

    // Nothing destructive left to confirm, so not an alert.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const close = within(screen.getByRole("dialog")).getByRole("button", { name: "Close" });
    expect(isDisabled(close)).toBe(false);
    await act(async () => {
      close.click();
    });
    expect(outcome.result).toEqual({ confirmed: false, pinned: null, operation: null });
  });
});
