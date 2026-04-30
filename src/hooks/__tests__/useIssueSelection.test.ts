/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIssueSelection } from "../useIssueSelection";

describe("useIssueSelection", () => {
  it("starts with empty selection", () => {
    const { result } = renderHook(() => useIssueSelection());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("toggles an item on and off", () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => result.current.toggle(42, 0));
    expect(result.current.selectedIds.has(42)).toBe(true);
    expect(result.current.isSelectionActive).toBe(true);

    act(() => result.current.toggle(42, 0));
    expect(result.current.selectedIds.has(42)).toBe(false);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("selects multiple items independently", () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => result.current.toggle(1, 0));
    act(() => result.current.toggle(2, 1));
    act(() => result.current.toggle(3, 2));

    expect(result.current.selectedIds.size).toBe(3);
    expect(result.current.selectedIds.has(1)).toBe(true);
    expect(result.current.selectedIds.has(2)).toBe(true);
    expect(result.current.selectedIds.has(3)).toBe(true);
  });

  it("selects a range from the last toggled item", () => {
    const { result } = renderHook(() => useIssueSelection());
    const getIdAt = (i: number) => [10, 20, 30, 40, 50][i]!;

    // Select item at index 1
    act(() => result.current.toggle(20, 1));
    // Shift-click at index 4
    act(() => result.current.toggleRange(4, getIdAt));

    expect(result.current.selectedIds.has(20)).toBe(true);
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.has(40)).toBe(true);
    expect(result.current.selectedIds.has(50)).toBe(true);
  });

  it("handles reverse range selection", () => {
    const { result } = renderHook(() => useIssueSelection());
    const getIdAt = (i: number) => [10, 20, 30, 40, 50][i]!;

    act(() => result.current.toggle(50, 4));
    act(() => result.current.toggleRange(1, getIdAt));

    expect(result.current.selectedIds.has(20)).toBe(true);
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.has(40)).toBe(true);
    expect(result.current.selectedIds.has(50)).toBe(true);
  });

  it("selects all items", () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => result.current.selectAll([1, 2, 3, 4, 5]));
    expect(result.current.selectedIds.size).toBe(5);
  });

  it("clears all selection", () => {
    const { result } = renderHook(() => useIssueSelection());

    act(() => result.current.selectAll([1, 2, 3]));
    expect(result.current.selectedIds.size).toBe(3);

    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("range select without prior anchor defaults to single toggle", () => {
    const { result } = renderHook(() => useIssueSelection());
    const getIdAt = (i: number) => [10, 20, 30][i]!;

    // No prior toggle, so no anchor — should fall back to single toggle
    act(() => result.current.toggleRange(2, getIdAt));
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.size).toBe(1);
  });
});
