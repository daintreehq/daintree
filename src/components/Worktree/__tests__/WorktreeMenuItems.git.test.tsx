/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, screen } from "@testing-library/react";
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

// The regex-based row finder below queries the whole document, so a render
// left standing by an earlier test would be in its way.
afterEach(() => {
  cleanup();
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

function gitRowMatching(name: RegExp): HTMLElement {
  const row = screen.getAllByRole("button").find((node) => name.test(node.textContent ?? ""));
  if (!row) throw new Error(`no Git row matching ${name.source}`);
  return row;
}

/** The harness renders menu items as plain `<button disabled>`. */
function isDisabled(row: HTMLElement): boolean {
  return row.hasAttribute("disabled");
}

/**
 * A completed status pass. Without one the menu treats the upstream as
 * unknown, which is a different state from having none.
 */
const measured = (tracking: string | null) => ({
  worktreeChanges: {
    worktreeId: "wt-1",
    rootPath: "/repo/wt-1",
    changes: [],
    changedFileCount: 0,
    tracking,
  } as WorktreeState["worktreeChanges"],
});

const gitCallbacks = () => ({
  onGitPullRebase: vi.fn(),
  onGitPush: vi.fn(),
  onGitForcePush: vi.fn(),
});

describe("WorktreeMenuItems Git submenu", () => {
  it("sits beside Review in the first root band", () => {
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      onOpenReviewHub: vi.fn(),
      worktree: makeWorktree({ aheadCount: 2, behindCount: 0, ...measured("origin/feature") }),
    });

    const labels = rootRowLabels(container);
    // Both describe the worktree's git state, so they belong to one band —
    // a separator between them would read as a topic change.
    expect(labels.indexOf("Git")).toBe(labels.indexOf("Review") + 1);
  });

  it("offers pull and push when the branch tracks an upstream", () => {
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 3, behindCount: 1, ...measured("origin/feature") }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
    expect(isDisabled(gitRowMatching(/Pull and rebase/))).toBe(false);
    expect(isDisabled(gitRowMatching(/^Push$/))).toBe(false);
  });

  it("says why pull is unavailable rather than dropping the row", () => {
    // `GitStatusPass` leaves ahead/behind undefined when there is no tracking
    // branch, which is the same condition `requireRemoteTarget` throws on
    // server-side — so the row states it instead of offering a failing action.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ ...measured(null) }),
    });

    const pull = gitRowMatching(/Pull and rebase/);
    expect(isDisabled(pull)).toBe(true);
    expect(pull.textContent).toContain("No upstream");
    // The reason is part of what the row says, so it reaches the accessible
    // name too — the Meta slot itself is aria-hidden decoration.
    expect(pull.getAttribute("aria-label")).toBe("Pull and rebase, no upstream");
    // The row states the reason instead of vanishing, so it is still one of the
    // rows alongside push, the two fetch rows and the two base-branch rows.
    expect(gitRowLabels(container)).toHaveLength(6);
  });

  it("does not claim an upstream is missing before anything has looked", () => {
    // A card rendered before the first status pass knows nothing about the
    // upstream. Saying "No upstream" there states a fact nobody established;
    // the action's own error is the honest answer if it turns out to be true.
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ worktreeChanges: null }),
    });

    const pull = gitRowMatching(/Pull and rebase/);
    expect(isDisabled(pull)).toBe(false);
    expect(pull.textContent).not.toContain("No upstream");
  });

  it("keeps push live with no upstream, because the push establishes one", () => {
    // `handlePush` retries with `--set-upstream` on "no upstream branch", so
    // the first push of a new worktree branch is exactly the case this row has
    // to serve.
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ ...measured(null) }),
    });

    expect(isDisabled(gitRowMatching(/^Push$/))).toBe(false);
  });

  it("disables push when nothing is ahead", () => {
    renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 0, behindCount: 4, ...measured("origin/feature") }),
    });

    const push = gitRowMatching(/Push/);
    expect(isDisabled(push)).toBe(true);
    expect(push.textContent).toContain("Nothing to push");
    expect(push.getAttribute("aria-label")).toBe("Push, nothing to push");
    // Pull is what this worktree can actually do, and it stays live — which is
    // also what keeps the trigger from opening onto an all-disabled submenu.
    expect(isDisabled(gitRowMatching(/Pull and rebase/))).toBe(false);
  });

  it("hides the force-push row until a lease has been captured", () => {
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({ aheadCount: 2, ...measured("origin/feature") }),
    });

    // A lease cannot be derived from divergence — only a real push rejection
    // produces one — so a disabled row here would advertise a capability that
    // does not exist.
    expect(gitRowLabels(container).some((label) => /Force push/.test(label))).toBe(false);
  });

  it("offers force push once a lease is held", () => {
    const callbacks = gitCallbacks();
    const { container } = renderWorktreeMenu({
      ...callbacks,
      canForcePush: true,
      worktree: makeWorktree({ aheadCount: 2, ...measured("origin/feature") }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
      "Force push with lease…",
    ]);
    gitRowMatching(/Force push/).click();
    expect(callbacks.onGitForcePush).toHaveBeenCalledWith("menu");
  });

  it("passes the resolved surface source to every row", () => {
    const callbacks = gitCallbacks();
    renderWorktreeMenu({ ...callbacks, worktree: makeWorktree({ aheadCount: 1 }) }, "context-menu");

    gitRowMatching(/Pull and rebase/).click();
    gitRowMatching(/^Push$/).click();
    expect(callbacks.onGitPullRebase).toHaveBeenCalledWith("context-menu");
    expect(callbacks.onGitPush).toHaveBeenCalledWith("context-menu");
  });

  it("is absent on a detached worktree", () => {
    // The status pass only overwrites `branch` when it reads a new one, so a
    // detached worktree keeps the name it had before — every row here would
    // name a branch that is not checked out.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({
        branch: "feature",
        isDetached: true,
        aheadCount: 2,
        ...measured("origin/feature"),
      }),
    });

    // Fetch survives — it only moves remote-tracking refs, so it needs no
    // checked-out branch — which is why the group itself stays (#12099).
    expect(rootRowLabels(container)).toContain("Git");
    expect(gitRowLabels(container)).toEqual([
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
  });

  it("drops the branch rows when the card wires no git callbacks", () => {
    const { container } = renderWorktreeMenu({ worktree: makeWorktree({ aheadCount: 2 }) });
    expect(gitRowLabels(container)).toEqual([
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
  });

  it("gives the main worktree the same rows", () => {
    // It is a real checkout on a real branch; nothing about pushing it differs.
    const { container } = renderWorktreeMenu({
      ...gitCallbacks(),
      worktree: makeWorktree({
        isMainWorktree: true,
        aheadCount: 2,
        behindCount: 1,
        ...measured("origin/main"),
      }),
    });

    expect(gitRowLabels(container)).toEqual([
      "Pull and rebase",
      "Push",
      "Fetch",
      "Fetch and prune",
      expect.stringContaining("Rebase onto base branch"),
      expect.stringContaining("Merge base branch in"),
    ]);
  });
});
