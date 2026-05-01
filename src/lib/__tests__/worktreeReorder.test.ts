import { describe, it, expect } from "vitest";
import { applyManualWorktreeReorder } from "../worktreeReorder";

describe("applyManualWorktreeReorder", () => {
  it("moves a visible item up while preserving filter-hidden positions", () => {
    const fullOrder = ["hidden-1", "a", "hidden-2", "b", "c", "hidden-3"];
    const visible = ["a", "b", "c"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 2, 0);
    expect(result).toEqual(["hidden-1", "c", "hidden-2", "a", "b", "hidden-3"]);
  });

  it("moves a visible item down while preserving filter-hidden positions", () => {
    const fullOrder = ["a", "hidden-1", "b", "c", "hidden-2"];
    const visible = ["a", "b", "c"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 0, 2);
    expect(result).toEqual(["b", "hidden-1", "c", "a", "hidden-2"]);
  });

  it("preserves hidden items at the beginning of the full order", () => {
    const fullOrder = ["hidden-1", "hidden-2", "a", "b"];
    const visible = ["a", "b"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 0, 1);
    expect(result).toEqual(["hidden-1", "hidden-2", "b", "a"]);
  });

  it("preserves hidden items at the end of the full order", () => {
    const fullOrder = ["a", "b", "hidden-1", "hidden-2"];
    const visible = ["a", "b"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 0, 1);
    expect(result).toEqual(["b", "a", "hidden-1", "hidden-2"]);
  });

  it("appends visible IDs missing from the full order (first-ever drag case)", () => {
    const fullOrder: string[] = [];
    const visible = ["a", "b", "c"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 0, 2);
    expect(result).toEqual(["b", "c", "a"]);
  });

  it("returns full order unchanged when fromIndex equals toIndex", () => {
    const fullOrder = ["a", "b", "c"];
    const visible = ["a", "b", "c"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 1, 1);
    expect(result).toEqual(fullOrder);
    expect(result).not.toBe(fullOrder);
  });

  it("returns full order unchanged for single-element visible subset", () => {
    const fullOrder = ["hidden", "a"];
    const visible = ["a"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 0, 0);
    expect(result).toEqual(fullOrder);
  });

  it("returns full order unchanged for empty visible subset", () => {
    const fullOrder = ["a", "b"];
    const result = applyManualWorktreeReorder(fullOrder, [], 0, 0);
    expect(result).toEqual(fullOrder);
  });

  it("guards against negative fromIndex", () => {
    const fullOrder = ["a", "b", "c"];
    const result = applyManualWorktreeReorder(fullOrder, ["a", "b", "c"], -1, 0);
    expect(result).toEqual(fullOrder);
  });

  it("guards against fromIndex out of range", () => {
    const fullOrder = ["a", "b"];
    const result = applyManualWorktreeReorder(fullOrder, ["a", "b"], 5, 0);
    expect(result).toEqual(fullOrder);
  });

  it("guards against toIndex out of range", () => {
    const fullOrder = ["a", "b"];
    const result = applyManualWorktreeReorder(fullOrder, ["a", "b"], 0, 5);
    expect(result).toEqual(fullOrder);
  });

  it("does not mutate the input arrays", () => {
    const fullOrder = ["a", "b", "c"];
    const visible = ["a", "b", "c"];
    const fullCopy = [...fullOrder];
    const visibleCopy = [...visible];
    applyManualWorktreeReorder(fullOrder, visible, 0, 2);
    expect(fullOrder).toEqual(fullCopy);
    expect(visible).toEqual(visibleCopy);
  });

  it("handles middle-to-middle move within visible subset", () => {
    const fullOrder = ["a", "hidden-1", "b", "hidden-2", "c", "d"];
    const visible = ["a", "b", "c", "d"];
    const result = applyManualWorktreeReorder(fullOrder, visible, 1, 2);
    expect(result).toEqual(["a", "hidden-1", "c", "hidden-2", "b", "d"]);
  });
});
