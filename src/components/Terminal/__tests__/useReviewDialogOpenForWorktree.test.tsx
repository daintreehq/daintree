// @vitest-environment jsdom
/**
 * Replacement signal for the deleted `daintree:open-review-hub` event, which
 * carried completion-banner dismissal alongside its open job (#11243).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, render, act } from "@testing-library/react";

const panelsById = vi.hoisted(() => ({
  current: {} as Record<string, { kind: string; worktreeId?: string }>,
}));

vi.mock("@/store/panelStore", async () => {
  const { useSyncExternalStore } = await import("react");
  const listeners = new Set<() => void>();
  return {
    usePanelStore: Object.assign(
      (selector: (s: { panelsById: Record<string, unknown> }) => unknown) =>
        useSyncExternalStore(
          (l: () => void) => {
            listeners.add(l);
            return () => listeners.delete(l);
          },
          () => selector({ panelsById: panelsById.current })
        ),
      { __notify: () => listeners.forEach((l) => l()) }
    ),
  };
});

const { usePanelStore } = await import("@/store/panelStore");
const { usePanelDialogStore } = await import("@/store/panelDialogStore");
const { useReviewDialogOpenForWorktree } = await import("../useReviewDialogOpenForWorktree");

function setStack(ids: string[]) {
  act(() => {
    usePanelDialogStore.setState({ dialogStack: ids });
  });
}

describe("useReviewDialogOpenForWorktree", () => {
  beforeEach(() => {
    panelsById.current = {};
    usePanelDialogStore.setState({ dialogStack: [], requestSeq: 0 });
  });

  it("is false when no dialog is open", () => {
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    expect(result.current).toBe(false);
  });

  it("is false without a worktree id", () => {
    panelsById.current = { "review-1": { kind: "review", worktreeId: "wt-1" } };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree(undefined));
    setStack(["review-1"]);
    expect(result.current).toBe(false);
  });

  it("is true for a review dialog on this worktree", () => {
    panelsById.current = { "review-1": { kind: "review", worktreeId: "wt-1" } };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["review-1"]);
    expect(result.current).toBe(true);
  });

  it("is false for a review dialog on a different worktree", () => {
    panelsById.current = { "review-1": { kind: "review", worktreeId: "wt-other" } };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["review-1"]);
    expect(result.current).toBe(false);
  });

  it("is false for a non-review dialog on this worktree", () => {
    panelsById.current = { "diff-1": { kind: "diff", worktreeId: "wt-1" } };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["diff-1"]);
    expect(result.current).toBe(false);
  });

  it("stays false while the id is reserved but the record has not landed", () => {
    // `openPanelDialog` publishes its id before `addPanel` commits. Reading the
    // stack alone would report an open review during that window.
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["review-pending"]);
    expect(result.current).toBe(false);
  });

  it("finds a review suspended beneath a layered diff", () => {
    panelsById.current = {
      "review-1": { kind: "review", worktreeId: "wt-1" },
      "diff-1": { kind: "diff", worktreeId: "wt-1" },
    };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["review-1", "diff-1"]);
    expect(result.current).toBe(true);
  });

  it("goes false again once the review closes", () => {
    panelsById.current = { "review-1": { kind: "review", worktreeId: "wt-1" } };
    const { result } = renderHook(() => useReviewDialogOpenForWorktree("wt-1"));
    setStack(["review-1"]);
    expect(result.current).toBe(true);

    setStack([]);
    expect(result.current).toBe(false);
  });

  describe("render fanout", () => {
    const PANES = 20;
    const FLUSHES = 60;

    function countRenders(useHook: (id: string) => boolean): number {
      let renders = 0;
      function Pane({ id }: { id: string }) {
        useHook(id);
        renders++;
        return null;
      }
      render(
        <>
          {Array.from({ length: PANES }, (_, i) => (
            <Pane key={i} id={`wt-${i}`} />
          ))}
        </>
      );
      const base = renders;
      for (let f = 0; f < FLUSHES; f++) {
        act(() => {
          panelsById.current = { ...panelsById.current, [`t-${f}`]: { kind: "terminal" } };
          (usePanelStore as unknown as { __notify: () => void }).__notify();
        });
      }
      return renders - base;
    }

    it("does not re-render on panelsById churn while no dialog is open", () => {
      expect(countRenders(useReviewDialogOpenForWorktree)).toBe(0);
    });

    it("the previous whole-map subscription re-rendered on every flush", () => {
      const useLegacy = (id: string) => {
        const stack = usePanelDialogStore((s) => s.dialogStack);
        const byId = usePanelStore((s: { panelsById: typeof panelsById.current }) => s.panelsById);
        return stack.some((p) => byId[p]?.kind === "review" && byId[p]?.worktreeId === id);
      };
      // Each of the PANES panes re-rendered once per flush.
      expect(countRenders(useLegacy)).toBe(FLUSHES * PANES);
    });

    it("does not re-render on unrelated churn while a dialog is open for another worktree", () => {
      panelsById.current = { "review-1": { kind: "review", worktreeId: "other" } };
      setStack(["review-1"]);
      expect(countRenders(useReviewDialogOpenForWorktree)).toBe(0);
    });
  });
});
