// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reviewMarksMock = vi.hoisted(() => ({
  clearWorktreeReviewMark: vi.fn(),
  getReviewMarksRevision: vi.fn(() => 9),
}));

vi.mock("@/store/reviewMarksStore", () => reviewMarksMock);

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({ getState: () => ({ worktrees: new Map() }) }),
  getCurrentViewStoreOrNull: () => null,
}));

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openPath: vi.fn() },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerWorktreeContextActions } from "../worktreeContextActions";
import {
  _resetReviewHubMarkTargetsForTesting,
  registerReviewHubMarkTarget,
  type ReviewHubMarkTarget,
} from "@/components/Worktree/ReviewHub/reviewHubMarkTargets";

function getAction(id: "worktree.markReviewed" | "worktree.clearReviewMark") {
  const actions: ActionRegistry = new Map();
  // These actions never reach a callback.
  const noCallbacks: ActionCallbacks = Object.create(null);
  registerWorktreeContextActions(actions, noCallbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`${id} is not registered`);
  return factory();
}

function hub(overrides: Partial<ReviewHubMarkTarget> = {}): ReviewHubMarkTarget {
  return {
    panelId: "review-1",
    worktreeId: "/repo/wt",
    isDialog: false,
    markBlockedReason: () => null,
    hasMark: () => true,
    markReviewed: vi.fn(async () => {}),
    clearReviewMark: vi.fn(async () => {}),
    ...overrides,
  };
}

const IN_HUB = { focusedTerminalId: "review-1", focusedTerminalKind: "review" } as ActionContext;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => _resetReviewHubMarkTargetsForTesting());

describe("worktree.markReviewed", () => {
  it("marks through the focused Review Hub", async () => {
    const target = hub();
    registerReviewHubMarkTarget(target);

    await getAction("worktree.markReviewed").run(undefined, IN_HUB);

    expect(target.markReviewed).toHaveBeenCalledTimes(1);
  });

  it("refuses without a hub open on the worktree, and before the hub has read it", async () => {
    const action = getAction("worktree.markReviewed");
    await expect(action.run({ worktreeId: "/repo/wt" }, {} as ActionContext)).rejects.toThrow(
      /Open Review Hub/
    );

    const target = hub({ markBlockedReason: () => "Review Hub is still reading this worktree" });
    registerReviewHubMarkTarget(target);
    await expect(action.run(undefined, IN_HUB)).rejects.toThrow(/still reading/);
    expect(target.markReviewed).not.toHaveBeenCalled();
  });

  it("is offered in the palette only while the context's hub can mark", () => {
    const palette = getAction("worktree.markReviewed").palette;
    if (palette?.mode !== "requireContext") throw new Error("expected a context gate");
    expect(palette.isReady({})).toBe(false);
    const off = registerReviewHubMarkTarget(
      hub({ markBlockedReason: () => "Review Hub is still reading this worktree" })
    );
    expect(palette.isReady(IN_HUB)).toBe(false);
    off();
    registerReviewHubMarkTarget(hub());
    expect(palette.isReady(IN_HUB)).toBe(true);
    expect(palette.isReady({ focusedTerminalId: "terminal-1" })).toBe(false);
  });
});

describe("worktree.clearReviewMark", () => {
  it("clears through the hub when one is open", async () => {
    const target = hub();
    registerReviewHubMarkTarget(target);

    await getAction("worktree.clearReviewMark").run(undefined, IN_HUB);

    expect(target.clearReviewMark).toHaveBeenCalledTimes(1);
    expect(reviewMarksMock.clearWorktreeReviewMark).not.toHaveBeenCalled();
  });

  it("clears a named worktree's mark with no hub open", async () => {
    reviewMarksMock.clearWorktreeReviewMark.mockResolvedValue({ status: "cleared" });

    await getAction("worktree.clearReviewMark").run(
      { worktreeId: "/repo/other" },
      {} as ActionContext
    );

    expect(reviewMarksMock.clearWorktreeReviewMark).toHaveBeenCalledWith("/repo/other", 9);
  });

  it("reports a clear another window's change refused", async () => {
    reviewMarksMock.clearWorktreeReviewMark.mockResolvedValue({ status: "stale" });

    await expect(
      getAction("worktree.clearReviewMark").run({ worktreeId: "/repo/other" }, {} as ActionContext)
    ).rejects.toThrow(/another window/);
  });

  it("needs a hub or a named worktree", async () => {
    await expect(
      getAction("worktree.clearReviewMark").run(undefined, {} as ActionContext)
    ).rejects.toThrow(/Open Review Hub/);
  });
});
