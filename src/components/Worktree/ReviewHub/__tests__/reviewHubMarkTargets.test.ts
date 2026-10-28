import { afterEach, describe, expect, it } from "vitest";
import {
  _resetReviewHubMarkTargetsForTesting,
  findReviewHubMarkTarget,
  registerReviewHubMarkTarget,
  type ReviewHubMarkTarget,
} from "../reviewHubMarkTargets";

function target(panelId: string, worktreeId: string, isDialog = false): ReviewHubMarkTarget {
  return {
    panelId,
    worktreeId,
    isDialog,
    markBlockedReason: () => null,
    hasMark: () => false,
    markReviewed: async () => {},
    clearReviewMark: async () => {},
  };
}

afterEach(() => _resetReviewHubMarkTargetsForTesting());

describe("findReviewHubMarkTarget", () => {
  it("prefers the newest dialog's hub, then the focused grid hub", () => {
    const grid = target("grid-1", "/wt/a");
    registerReviewHubMarkTarget(grid);
    const dialog = target("dialog-1", "/wt/b", true);
    const offDialog = registerReviewHubMarkTarget(dialog);

    expect(findReviewHubMarkTarget({ focusedPanelId: "grid-1" })).toBe(dialog);
    offDialog();
    expect(findReviewHubMarkTarget({ focusedPanelId: "grid-1" })).toBe(grid);
    expect(findReviewHubMarkTarget({ focusedPanelId: "terminal-1" })).toBeNull();
  });

  it("never answers a named worktree with a hub on another", () => {
    registerReviewHubMarkTarget(target("dialog-1", "/wt/b", true));
    const grid = target("grid-1", "/wt/a");
    registerReviewHubMarkTarget(grid);

    expect(findReviewHubMarkTarget({ worktreeId: "/wt/a" })).toBe(grid);
    expect(findReviewHubMarkTarget({ worktreeId: "/wt/c" })).toBeNull();
  });

  it("keeps a newer registration when an older one for the same panel is disposed", () => {
    const first = target("grid-1", "/wt/a");
    const offFirst = registerReviewHubMarkTarget(first);
    const second = target("grid-1", "/wt/a");
    registerReviewHubMarkTarget(second);

    offFirst();

    expect(findReviewHubMarkTarget({ focusedPanelId: "grid-1" })).toBe(second);
  });
});
