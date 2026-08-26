/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIssueSelection } from "../useIssueSelection";
import { useIssueSelectionStore, type SelectableItem } from "@/store/issueSelectionStore";

const PROJECT = "/test/project";

/**
 * A minimal item — the store only reads `number`, and holding the objects is
 * the whole point of the shape under test. One instance per number, so
 * `toggle` round-trips on identity as it does in the app.
 */
const ITEMS = new Map<number, SelectableItem>();
function item(n: number): SelectableItem {
  const existing = ITEMS.get(n);
  if (existing) return existing;
  const made = { number: n, title: `Item ${n}` } as SelectableItem;
  ITEMS.set(n, made);
  return made;
}
const items = (...ns: number[]): SelectableItem[] => ns.map(item);

describe("useIssueSelection", () => {
  beforeEach(() => {
    useIssueSelectionStore.setState({ selections: new Map() });
  });

  it("starts with empty selection", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("toggles an item on and off", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => result.current.toggle(item(42)));
    expect(result.current.selectedIds.has(42)).toBe(true);
    expect(result.current.isSelectionActive).toBe(true);

    act(() => result.current.toggle(item(42)));
    expect(result.current.selectedIds.has(42)).toBe(false);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("selects multiple items independently", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => result.current.toggle(item(1)));
    act(() => result.current.toggle(item(2)));
    act(() => result.current.toggle(item(3)));

    expect(result.current.selectedIds.size).toBe(3);
    expect(result.current.selectedIds.has(1)).toBe(true);
    expect(result.current.selectedIds.has(2)).toBe(true);
    expect(result.current.selectedIds.has(3)).toBe(true);
  });

  it("selects a range from the last toggled item", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    const order = items(10, 20, 30, 40, 50);

    // Anchor on 20
    act(() => result.current.toggle(item(20)));
    // Shift-extend to 50
    act(() => result.current.toggleRange(item(50), order));

    expect(result.current.selectedIds.has(20)).toBe(true);
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.has(40)).toBe(true);
    expect(result.current.selectedIds.has(50)).toBe(true);
  });

  it("handles reverse range selection", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    const order = items(10, 20, 30, 40, 50);

    act(() => result.current.toggle(item(50)));
    act(() => result.current.toggleRange(item(20), order));

    expect(result.current.selectedIds.has(20)).toBe(true);
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.has(40)).toBe(true);
    expect(result.current.selectedIds.has(50)).toBe(true);
  });

  it("selects all items", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => result.current.selectAll(items(1, 2, 3, 4, 5)));
    expect(result.current.selectedIds.size).toBe(5);
  });

  it("clears all selection", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => result.current.selectAll(items(1, 2, 3)));
    expect(result.current.selectedIds.size).toBe(3);

    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isSelectionActive).toBe(false);
  });

  it("range select without prior anchor defaults to single toggle", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    const order = items(10, 20, 30);

    // No prior toggle, so no anchor — should fall back to single toggle
    act(() => result.current.toggleRange(item(30), order));
    expect(result.current.selectedIds.has(30)).toBe(true);
    expect(result.current.selectedIds.size).toBe(1);
  });

  it("clear is idempotent when selection is already empty", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    const initialIds = result.current.selectedIds;
    expect(initialIds.size).toBe(0);

    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedIds).toBe(initialIds);

    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedIds).toBe(initialIds);
  });

  it("isolates selection by type and project path", () => {
    const issuesA = renderHook(() => useIssueSelection("issue", "/proj/a"));
    const prsA = renderHook(() => useIssueSelection("pr", "/proj/a"));
    const issuesB = renderHook(() => useIssueSelection("issue", "/proj/b"));

    act(() => issuesA.result.current.toggle(item(1)));

    expect(issuesA.result.current.selectedIds.has(1)).toBe(true);
    expect(prsA.result.current.selectedIds.size).toBe(0);
    expect(issuesB.result.current.selectedIds.size).toBe(0);
  });

  it("clear reaches the same selection regardless of which hook instance calls it", () => {
    // Mirrors the bulk-create flow: the dropdown hands its `clear` to the
    // dialog, then may remount before "Done" fires. A stale-but-key-bound
    // clear must still empty the live selection.
    const first = renderHook(() => useIssueSelection("issue", PROJECT));
    act(() => first.result.current.selectAll(items(1, 2, 3)));
    const staleClear = first.result.current.clear;
    first.unmount();

    const second = renderHook(() => useIssueSelection("issue", PROJECT));
    expect(second.result.current.selectedIds.size).toBe(3);

    act(() => staleClear());
    expect(second.result.current.selectedIds.size).toBe(0);
  });

  it("clear resets the range anchor", () => {
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    const order = items(10, 20, 30);

    act(() => result.current.toggle(item(20)));
    act(() => result.current.clear());
    // No anchor after clear — range select falls back to a single toggle.
    act(() => result.current.toggleRange(item(30), order));

    expect(result.current.selectedIds.size).toBe(1);
    expect(result.current.selectedIds.has(30)).toBe(true);
  });

  it("starts a new range when the anchored item is no longer in the list", () => {
    // The selection deliberately survives a search, a state-tab switch, a sort
    // change and pagination — so the anchored row is routinely gone by the
    // next shift-click. Anchoring by index used to index past the end of the
    // shorter list and throw.
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => result.current.toggle(item(50))); // anchor on an item...
    act(() => result.current.toggleRange(item(20), items(10, 20, 30))); // ...that this list lacks

    expect(result.current.selectedIds.has(20)).toBe(true);
    expect(result.current.selectedIds.has(10)).toBe(false);
    expect(result.current.selectedIds.has(30)).toBe(false);

    // ...and 20 is the new anchor, so the next extend measures from it.
    act(() => result.current.toggleRange(item(10), items(10, 20, 30)));
    expect(result.current.selectedIds.has(10)).toBe(true);
    expect(result.current.selectedIds.has(30)).toBe(false);
  });

  it("keeps selected item snapshots alive across a remount", () => {
    // The bulk bar counts ids but acts on objects. The objects used to sit in
    // the dropdown's own `useState`, so after a remount (project-view
    // eviction, the toolbar's lazy/direct swap) the bar read "2 selected" and
    // handed the create dialog an empty array.
    const first = renderHook(() => useIssueSelection("issue", PROJECT));
    act(() => first.result.current.toggle(item(1)));
    act(() => first.result.current.toggle(item(2)));
    first.unmount();

    const second = renderHook(() => useIssueSelection("issue", PROJECT));
    expect(second.result.current.selectedIds.size).toBe(2);
    expect(second.result.current.selectedItems.get(1)).toBeDefined();
    expect(second.result.current.selectedItems.get(2)).toBeDefined();

    // Bounded by the selection itself — nothing unselected is retained.
    expect(second.result.current.selectedItems.size).toBe(2);

    act(() => second.result.current.clear());
    expect(second.result.current.selectedItems.size).toBe(0);
  });

  it("refreshes stored copies from newer data without touching membership", () => {
    // A background revalidation can rename an issue under a selection made
    // minutes ago. The bulk action reads the stored object, so a selection
    // that never re-reconciles plans from a stale title.
    const { result } = renderHook(() => useIssueSelection("issue", PROJECT));
    const stale = { number: 5, title: "Old title" } as SelectableItem;
    const fresh = { number: 5, title: "New title" } as SelectableItem;

    act(() => result.current.toggle(stale));
    expect(result.current.selectedItems.get(5)).toBe(stale);

    // A row that is NOT selected must not be added by reconciling.
    act(() => result.current.reconcile([fresh, { number: 6 } as SelectableItem]));
    expect(result.current.selectedItems.get(5)).toBe(fresh);
    expect(result.current.selectedItems.size).toBe(1);
    expect(result.current.selectedIds.has(6)).toBe(false);
  });

  it("keeps range anchors isolated per key", () => {
    const a = renderHook(() => useIssueSelection("issue", "/proj/a"));
    const b = renderHook(() => useIssueSelection("issue", "/proj/b"));
    const order = items(10, 20, 30, 40);

    act(() => a.result.current.toggle(item(20))); // anchor on /proj/a only
    // /proj/b has no anchor → single toggle, unaffected by /proj/a's anchor.
    act(() => b.result.current.toggleRange(item(40), order));

    expect(b.result.current.selectedIds.size).toBe(1);
    expect(b.result.current.selectedIds.has(40)).toBe(true);
  });

  it("two hooks on the same key observe each other's mutations", () => {
    const first = renderHook(() => useIssueSelection("issue", PROJECT));
    const second = renderHook(() => useIssueSelection("issue", PROJECT));

    act(() => first.result.current.toggle(item(7)));
    expect(second.result.current.selectedIds.has(7)).toBe(true);

    act(() => second.result.current.clear());
    expect(first.result.current.selectedIds.size).toBe(0);
  });
});
