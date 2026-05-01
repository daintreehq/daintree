import { describe, it, expect } from "vitest";

// We test the announcement logic by recreating the same branching that
// `getDragLabel` uses inside DndProvider. The production helper is
// module-scoped (not exported) so the test mirrors its priority chain
// (issueTitle → branch → name → "worktree") for worktree-sort drags and
// the terminal-title fallback for everything else.

interface WorktreeFixture {
  issueTitle?: string;
  branch?: string;
  name?: string;
}

function makeAnnouncements(worktreeLookup: Map<string, WorktreeFixture>) {
  function isWorktreeSortDragData(data: unknown): data is { worktreeId: string } {
    return (
      data !== null &&
      typeof data === "object" &&
      (data as { type?: unknown }).type === "worktree-sort"
    );
  }

  function resolveWorktreeLabel(worktreeId: string): string {
    const wt = worktreeLookup.get(worktreeId);
    return wt?.issueTitle ?? wt?.branch ?? wt?.name ?? "worktree";
  }

  function getDragLabel(data: unknown): string {
    if (isWorktreeSortDragData(data)) {
      return resolveWorktreeLabel(data.worktreeId);
    }
    return (data as { terminal?: { title?: string } } | undefined)?.terminal?.title ?? "panel";
  }

  function getOverDragLabel(over: { id: string; data: { current: unknown } }): string {
    if (over.id.startsWith("worktree-sort-")) {
      return resolveWorktreeLabel(over.id.slice("worktree-sort-".length));
    }
    if (over.id.startsWith("worktree-drop-")) {
      return resolveWorktreeLabel(over.id.slice("worktree-drop-".length));
    }
    return getDragLabel(over.data.current);
  }

  return {
    onDragStart(active: { data: { current: unknown } }) {
      return `Picked up ${getDragLabel(active.data.current)}`;
    },
    onDragOver(
      active: { data: { current: unknown } },
      over: { id: string; data: { current: unknown } } | null
    ) {
      const label = getDragLabel(active.data.current);
      if (over) {
        return `${label} is over ${getOverDragLabel(over)}`;
      }
      return `${label} is no longer over a droppable area`;
    },
    onDragEnd(active: { data: { current: unknown } }, over: { data: { current: unknown } } | null) {
      const label = getDragLabel(active.data.current);
      if (over) {
        return `Dropped ${label}`;
      }
      return `${label} returned to its original position`;
    },
    onDragCancel(active: { data: { current: unknown } }) {
      const label = getDragLabel(active.data.current);
      return `Drag cancelled. ${label} returned to its original position`;
    },
  };
}

describe("drag announcements — terminal panels", () => {
  const announcements = makeAnnouncements(new Map());
  const withTitle = { data: { current: { terminal: { title: "Claude Agent" } } } };
  const withoutTitle = { data: { current: {} } };

  it("onDragStart announces panel title", () => {
    expect(announcements.onDragStart(withTitle)).toBe("Picked up Claude Agent");
  });

  it("onDragStart falls back to 'panel' without title", () => {
    expect(announcements.onDragStart(withoutTitle)).toBe("Picked up panel");
  });

  it("onDragOver with target announces both labels", () => {
    const over = { id: "term-1", data: { current: { terminal: { title: "Terminal" } } } };
    expect(announcements.onDragOver(withTitle, over)).toBe("Claude Agent is over Terminal");
  });

  it("onDragOver without target announces no droppable area", () => {
    expect(announcements.onDragOver(withTitle, null)).toBe(
      "Claude Agent is no longer over a droppable area"
    );
  });

  it("onDragEnd with target announces drop", () => {
    const over = { data: { current: {} } };
    expect(announcements.onDragEnd(withTitle, over)).toBe("Dropped Claude Agent");
  });

  it("onDragEnd without target announces return to original position", () => {
    expect(announcements.onDragEnd(withTitle, null)).toBe(
      "Claude Agent returned to its original position"
    );
  });

  it("onDragCancel announces cancellation", () => {
    expect(announcements.onDragCancel(withTitle)).toBe(
      "Drag cancelled. Claude Agent returned to its original position"
    );
  });
});

describe("drag announcements — worktree sort", () => {
  const lookup = new Map<string, WorktreeFixture>([
    ["wt-issue", { issueTitle: "Add OAuth support", branch: "feature/oauth", name: "oauth" }],
    ["wt-branch", { branch: "feature/login-flow", name: "login-flow" }],
    ["wt-name", { name: "fallback-name" }],
    ["wt-empty", {}],
  ]);
  const announcements = makeAnnouncements(lookup);

  function activeFor(worktreeId: string) {
    return {
      data: { current: { type: "worktree-sort", worktreeId, dragStartOrder: [worktreeId] } },
    };
  }

  it("prefers issueTitle when available", () => {
    expect(announcements.onDragStart(activeFor("wt-issue"))).toBe("Picked up Add OAuth support");
  });

  it("falls back to branch when issueTitle is missing", () => {
    expect(announcements.onDragStart(activeFor("wt-branch"))).toBe("Picked up feature/login-flow");
  });

  it("falls back to name when branch is missing", () => {
    expect(announcements.onDragStart(activeFor("wt-name"))).toBe("Picked up fallback-name");
  });

  it("falls back to 'worktree' when no fields are populated", () => {
    expect(announcements.onDragStart(activeFor("wt-empty"))).toBe("Picked up worktree");
  });

  it("uses 'worktree' when worktree snapshot is missing entirely", () => {
    expect(announcements.onDragStart(activeFor("wt-unknown"))).toBe("Picked up worktree");
  });

  it("onDragOver resolves both labels via worktree-sort id prefix", () => {
    const active = activeFor("wt-branch");
    const over = {
      id: "worktree-sort-wt-issue",
      data: { current: { type: "worktree-sort", worktreeId: "wt-issue" } },
    };
    expect(announcements.onDragOver(active, over)).toBe(
      "feature/login-flow is over Add OAuth support"
    );
  });

  it("onDragOver resolves the over label via worktree-drop id prefix", () => {
    const active = activeFor("wt-branch");
    const over = {
      id: "worktree-drop-wt-issue",
      data: { current: {} },
    };
    expect(announcements.onDragOver(active, over)).toBe(
      "feature/login-flow is over Add OAuth support"
    );
  });

  it("onDragEnd announces drop with worktree label", () => {
    const over = { data: { current: { type: "worktree-sort", worktreeId: "wt-issue" } } };
    expect(announcements.onDragEnd(activeFor("wt-branch"), over)).toBe(
      "Dropped feature/login-flow"
    );
  });

  it("onDragCancel announces cancellation with worktree label", () => {
    expect(announcements.onDragCancel(activeFor("wt-issue"))).toBe(
      "Drag cancelled. Add OAuth support returned to its original position"
    );
  });
});
