/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type { WorktreeState } from "../../../types";
import { makeWorktree, renderWorktreeMenu, rootRowLabels } from "./worktreeMenuHarness";

/**
 * Resolves an ActionResult, not `undefined`: `ActionService.dispatch` CATCHES
 * an action's error and resolves `{ok:false}` rather than rejecting, and the
 * rows read that result to decide whether to raise a toast.
 *
 * Typed as the union rather than inferred from the default — inference narrows
 * to `{ok: boolean}` and then rejects the `error` field a failing dispatch
 * carries.
 */
type MockActionResult = { ok: true } | { ok: false; error: { code: string; message: string } };
const dispatch = vi.hoisted(() =>
  vi.fn((): Promise<MockActionResult> => Promise.resolve({ ok: true }))
);
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));

/**
 * A worktree with everything the Git submenu's start rows need: a base branch,
 * a known-clean tree, and something to integrate.
 *
 * `worktreeChanges` present with a zero count is deliberately NOT the same as
 * absent — absent means "status not read yet", which the rows must treat as
 * unknown rather than clean.
 */
function integrable(overrides: Partial<WorktreeState> = {}): WorktreeState {
  return makeWorktree({
    baseBranchName: "develop",
    baseBehindCount: 3,
    worktreeChanges: {
      worktreeId: "wt-1",
      rootPath: "/repo/wt-1",
      changedFileCount: 0,
      changes: [],
    },
    ...overrides,
  } as Partial<WorktreeState>);
}

function gitRowLabels(container: HTMLElement): string[] {
  const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find((node) =>
    node.firstElementChild?.textContent?.trim().startsWith("Git")
  );
  if (!sub) return [];
  return Array.from(sub.querySelectorAll("[data-menu-subcontent] [data-menu-item]")).map(
    (node) => node.textContent?.trim() ?? ""
  );
}

function gitRow(container: HTMLElement, startsWith: string): HTMLButtonElement {
  const sub = Array.from(container.querySelectorAll("[data-menu-sub]")).find((node) =>
    node.firstElementChild?.textContent?.trim().startsWith("Git")
  )!;
  const row = Array.from(
    sub.querySelectorAll<HTMLButtonElement>("[data-menu-subcontent] [data-menu-item]")
  ).find((node) => (node.textContent ?? "").trim().startsWith(startsWith));
  if (!row) throw new Error(`no Git row starting with ${startsWith}`);
  return row;
}

beforeEach(() => {
  // Reset the IMPLEMENTATION too: a test that swaps in a failing dispatch would
  // otherwise poison every test after it.
  dispatch.mockReset();
  dispatch.mockResolvedValue({ ok: true });
});

describe("Git submenu — root placement", () => {
  it("sits beside Review in the first group", () => {
    // Review and Git are both change-management concerns, so they share the
    // group rather than Git trailing the destructive tail.
    const { container } = renderWorktreeMenu({
      worktree: integrable(),
      onOpenReviewHub: vi.fn(),
    });
    const rows = rootRowLabels(container);
    expect(rows).toContain("Git");
    expect(rows.indexOf("Git")).toBe(rows.indexOf("Review") + 1);
  });

  it("is present even for a worktree with no base branch", () => {
    // The rows disable with a reason instead of vanishing: a submenu that
    // appears and disappears by repository state is undiscoverable.
    const { container } = renderWorktreeMenu({ worktree: makeWorktree() });
    expect(rootRowLabels(container)).toContain("Git");
  });
});

describe("Git submenu — start rows", () => {
  it("names the base branch on both rows", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() });
    // Fetch and Fetch and prune lead the submenu (#12091) — the base-integration
    // rows are appended to that same array, not a submenu of their own.
    expect(gitRowLabels(container)).toEqual([
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto develop"),
      expect.stringContaining("Merge develop in"),
    ]);
  });

  it("shows the base-relative behind count, not the upstream one", () => {
    // `behindCount` measures against the branch's own upstream and says nothing
    // about the base having moved — the whole reason this feature exists.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ baseBehindCount: 7, behindCount: 99 }),
    });
    expect(gitRow(container, "Rebase onto").textContent).toContain("7");
    expect(gitRow(container, "Rebase onto").textContent).not.toContain("99");
  });

  it("dispatches the rebase action with the worktree id and base branch", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() }, "context-menu");
    gitRow(container, "Rebase onto").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.rebaseOntoBase",
      { worktreeId: "wt-1", baseBranch: "develop" },
      { source: "context-menu" }
    );
  });

  it("dispatches the merge action with the worktree id and base branch", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable() });
    gitRow(container, "Merge develop in").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.mergeBaseIntoBranch",
      { worktreeId: "wt-1", baseBranch: "develop" },
      { source: "menu" }
    );
  });

  it.each([
    ["no base branch", integrable({ baseBranchName: null }), "No base branch"],
    ["detached HEAD", integrable({ isDetached: true }), "No branch checked out"],
    [
      "uncommitted changes",
      integrable({
        worktreeChanges: {
          worktreeId: "wt-1",
          rootPath: "/repo/wt-1",
          changedFileCount: 2,
          changes: [],
        },
      } as Partial<WorktreeState>),
      "Commit or stash first",
    ],
    ["already up to date", integrable({ baseBehindCount: 0 }), "Up to date"],
  ])("disables both rows with a visible reason: %s", (_name, worktree, reason) => {
    const { container } = renderWorktreeMenu({ worktree });
    for (const label of ["Rebase onto", "Merge"]) {
      const row = gitRow(container, label);
      expect(row.disabled).toBe(true);
      expect(row.textContent).toContain(reason);
    }
  });

  it("treats an unread status as unknown rather than clean", () => {
    // `worktreeChanges == null` means the status pass has not answered yet.
    // Reading that as clean would offer a rebase that git then refuses.
    const { container } = renderWorktreeMenu({
      worktree: makeWorktree({ baseBranchName: "develop", baseBehindCount: 3 }),
    });
    const row = gitRow(container, "Rebase onto");
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("Checking status");
  });

  it("dispatches nothing from a disabled row", () => {
    const { container } = renderWorktreeMenu({ worktree: integrable({ baseBehindCount: 0 }) });
    gitRow(container, "Rebase onto").click();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("Git submenu — recovery rows", () => {
  it.each([
    ["REBASING", "rebase"],
    ["MERGING", "merge"],
    ["CHERRY_PICKING", "cherry-pick"],
    ["REVERTING", "revert"],
  ] as const)("replaces the start rows for %s", (repoState, label) => {
    // A worktree mid-operation has exactly one useful next move, and it is not
    // "start another rebase" — the handler refuses that anyway.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState } as Partial<WorktreeState>),
    });
    const rows = gitRowLabels(container);
    // Fetch survives: it writes only remote-tracking refs, so it is safe and
    // useful mid-operation. Only the start rows are replaced.
    expect(rows).toEqual(["Fetch", "Fetch and prune", `Continue ${label}`, `Abort ${label}…`]);
    expect(rows.some((r) => r.includes("Rebase onto develop"))).toBe(false);
  });

  it("dispatches continue without an operation argument", () => {
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "REBASING" } as Partial<WorktreeState>),
    });
    gitRow(container, "Continue").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.continueRepositoryOperation",
      { worktreeId: "wt-1" },
      { source: "menu" }
    );
  });

  it("passes the in-progress operation to abort, so the confirm can name it", () => {
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "MERGING" } as Partial<WorktreeState>),
    });
    gitRow(container, "Abort").click();
    expect(dispatch).toHaveBeenCalledWith(
      "git.abortRepositoryOperation",
      { worktreeId: "wt-1", operation: "MERGING" },
      { source: "menu" }
    );
  });

  it("marks only Abort as destructive, and only it opens a dialog", () => {
    // Continue advances an operation the user already started and stays
    // abortable afterwards; abort is what discards their conflict work.
    const { container } = renderWorktreeMenu({
      worktree: integrable({ repoState: "REBASING" } as Partial<WorktreeState>),
    });
    expect(gitRow(container, "Abort").textContent).toContain("…");
    expect(gitRow(container, "Continue").textContent).not.toContain("…");
  });

  it("shows recovery rows even on a dirty tree", () => {
    // A halted operation is dirty by definition — conflicts ARE unstaged
    // changes — so the clean-tree gate must not reach these rows.
    const { container } = renderWorktreeMenu({
      worktree: integrable({
        repoState: "REBASING",
        worktreeChanges: {
          worktreeId: "wt-1",
          rootPath: "/repo/wt-1",
          changedFileCount: 4,
          changes: [],
        },
      } as Partial<WorktreeState>),
    });
    for (const label of ["Continue", "Abort"]) {
      expect(gitRow(container, label).disabled).toBe(false);
    }
  });
});

describe("Git submenu — accessibility", () => {
  it("keeps the disabled reason out of the accessible name's way", () => {
    // `Meta` is aria-hidden decoration, so the reason must not be the only
    // place the state is expressed — the row's own disabled attribute is.
    const { container } = renderWorktreeMenu({ worktree: integrable({ baseBehindCount: 0 }) });
    const row = gitRow(container, "Rebase onto");
    expect(row.disabled).toBe(true);
    expect(row.querySelector("[data-menu-meta]")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the submenu trigger as a labelled control", () => {
    renderWorktreeMenu({ worktree: integrable() });
    expect(screen.getByText("Git")).toBeDefined();
  });
});
