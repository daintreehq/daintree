// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewMarkSummary } from "@shared/types/ipc/reviewMarks";
import { CHANGED_SINCE_REVIEW } from "@/lib/reviewChangeHint";
import { _resetReviewMarksStoreForTesting, useReviewMarksStore } from "@/store/reviewMarksStore";
import { useReviewChangeHint } from "../useReviewChangeHint";

const COMMIT = "a".repeat(40);
const MOVED = "b".repeat(40);

function mark(branch: string, revision: number): ReviewMarkSummary {
  return {
    markedAt: 1_000,
    capturedAt: 1_000,
    head: { kind: "branch", branch, commit: COMMIT },
    base: { ref: null, tip: null },
    complete: true,
    pathCount: 1,
    revision,
  };
}

// Every snapshot from main rebuilds each mark object, unchanged or not.
function adopt(marks: Record<string, ReviewMarkSummary>) {
  act(() => {
    useReviewMarksStore.setState({
      marks: structuredClone(marks),
      revision: useReviewMarksStore.getState().revision + 1,
      loaded: true,
    });
  });
}

function renderCard(headOid: string) {
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useReviewChangeHint({
      id: "wt-1",
      branch: "feature",
      isDetached: false,
      worktreeChanges: { headOid } as never,
      lastActivityTimestamp: null,
    });
  });
  return { hook, renders: () => renders };
}

afterEach(() => {
  _resetReviewMarksStoreForTesting();
});

describe("useReviewChangeHint (#17072)", () => {
  it("does not re-render for a mark saved on another worktree", () => {
    adopt({ "wt-1": mark("feature", 1) });
    const { hook, renders } = renderCard(MOVED);
    expect(hook.result.current).toBe(CHANGED_SINCE_REVIEW);
    const before = renders();

    adopt({ "wt-1": mark("feature", 1), "wt-2": mark("other", 2) });
    expect(renders()).toBe(before);
    expect(hook.result.current).toBe(CHANGED_SINCE_REVIEW);
  });

  it("does not re-render when a snapshot rebuilds its own unchanged mark", () => {
    adopt({ "wt-1": mark("feature", 1) });
    const { renders } = renderCard(COMMIT);
    const before = renders();

    adopt({ "wt-1": mark("feature", 1) });
    expect(renders()).toBe(before);
  });

  it("follows its own mark as it is saved and cleared", () => {
    const { hook } = renderCard(MOVED);
    expect(hook.result.current).toBeNull();

    adopt({ "wt-1": mark("feature", 1) });
    expect(hook.result.current).toBe(CHANGED_SINCE_REVIEW);

    // A mark from another branch never applies to this checkout.
    adopt({ "wt-1": mark("elsewhere", 2) });
    expect(hook.result.current).toBeNull();

    adopt({});
    expect(hook.result.current).toBeNull();
  });
});
