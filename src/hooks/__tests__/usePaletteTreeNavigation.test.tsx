// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import {
  usePaletteTreeNavigation,
  type NavigablePaletteTreeRow,
  type PaletteTreeGroupInput,
} from "@/hooks/usePaletteTreeNavigation";

interface TestGroup {
  name: string;
}

interface TestItem {
  label: string;
}

/** `[groupId, itemIds, { collapsed, navigableHeader }]` */
type GroupSpec = [
  string,
  string[],
  { collapsed?: boolean; navigableHeader?: boolean; skipItems?: string[] }?,
];

function buildGroups(specs: GroupSpec[]): PaletteTreeGroupInput<TestGroup, TestItem>[] {
  return specs.map(([groupId, itemIds, options = {}]) => ({
    groupId,
    group: { name: groupId.toUpperCase() },
    header: {
      rowId: `h:${groupId}`,
      domId: `dom-h-${groupId}`,
      navigable: options.navigableHeader ?? false,
    },
    isCollapsed: options.collapsed ?? false,
    items: itemIds.map((itemId) => ({
      rowId: `i:${itemId}`,
      domId: `dom-i-${itemId}`,
      navigable: !(options.skipItems ?? []).includes(itemId),
      item: { label: itemId },
    })),
  }));
}

/**
 * The handlers read only `key`, the composition fields, and the two consume
 * methods, so a minimal stand-in exercises them faithfully. Built here once so
 * the cast lives in a single place rather than at every call site.
 */
function keyEvent(
  key: string,
  overrides: { isComposing?: boolean; keyCode?: number; value?: string } = {}
) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const event = {
    key,
    preventDefault,
    stopPropagation,
    currentTarget: { value: overrides.value ?? "" },
    nativeEvent: {
      isComposing: overrides.isComposing ?? false,
      keyCode: overrides.keyCode ?? 0,
    },
  };
  return {
    // The handlers touch only the fields above; a real synthetic event cannot
    // be constructed outside React's own dispatch, so this stand-in is the
    // faithful option rather than a shortcut.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- hand-built keyboard event stand-in
    event: event as unknown as KeyboardEvent<HTMLInputElement>,
    preventDefault,
    stopPropagation,
  };
}

/** A consumed key is one the handler both cancelled and kept to itself. */
function expectConsumed(handle: ReturnType<typeof keyEvent>, consumed: boolean, label: string) {
  expect(handle.preventDefault.mock.calls.length > 0, label).toBe(consumed);
  expect(handle.stopPropagation.mock.calls.length > 0, label).toBe(consumed);
}

/** Typed so `mock.calls[0][0]` is the row union, not `any` needing a cast. */
const makeActivateSpy = () => vi.fn<(row: NavigablePaletteTreeRow<TestGroup, TestItem>) => void>();

function setup(
  specs: GroupSpec[],
  options: {
    onActivate?: (row: NavigablePaletteTreeRow<TestGroup, TestItem>) => void;
    onGroupCollapsedChange?: (groupId: string, collapsed: boolean) => void;
    shouldPreserveInputCaretKey?: (event: KeyboardEvent<HTMLInputElement>) => boolean;
    selectionScopeKey?: string;
    isActive?: boolean;
  } = {}
) {
  const onActivate = options.onActivate ?? vi.fn();
  return renderHook(
    ({ groups, scope }: { groups: PaletteTreeGroupInput<TestGroup, TestItem>[]; scope?: string }) =>
      usePaletteTreeNavigation<TestGroup, TestItem>({
        groups,
        isActive: options.isActive ?? true,
        selectionScopeKey: scope ?? null,
        onActivate,
        onGroupCollapsedChange: options.onGroupCollapsedChange,
        shouldPreserveInputCaretKey: options.shouldPreserveInputCaretKey,
      }),
    { initialProps: { groups: buildGroups(specs), scope: options.selectionScopeKey } }
  );
}

const rowIds = <T extends { rowId: string }>(rows: readonly T[]) => rows.map((row) => row.rowId);

/** Typed to the real signature so the assignment to the prototype checks. */
const makeScrollSpy = () => vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();

describe("usePaletteTreeNavigation", () => {
  describe("flattening", () => {
    it("emits each header immediately before only that group's items", () => {
      const { result } = setup([
        ["a", ["a1", "a2"]],
        ["b", ["b1"]],
      ]);

      expect(rowIds(result.current.rows)).toEqual(["h:a", "i:a1", "i:a2", "h:b", "i:b1"]);
    });

    it("keeps a collapsed group's header while structurally excluding its items", () => {
      const { result } = setup([
        ["a", ["a1", "a2"], { collapsed: true }],
        ["b", ["b1"]],
      ]);

      expect(rowIds(result.current.rows)).toEqual(["h:a", "h:b", "i:b1"]);
      // The render model and the nav domain are the same objects, so a hidden
      // row cannot exist in one and not the other.
      const rendered = result.current.renderGroups.flatMap((g) => [g.header, ...g.items]);
      expect(rendered).toEqual(result.current.rows);
    });

    it("hands the render model the same row objects the arrow keys walk", () => {
      const { result } = setup([["a", ["a1"]]]);

      const renderedItem = result.current.renderGroups[0]!.items[0]!;
      const walkedItem = result.current.rows.find((row) => row.rowId === "i:a1");
      expect(walkedItem).toBe(renderedItem);
    });
  });

  describe("stepping", () => {
    it("skips non-navigable headers when crossing a group boundary", () => {
      const { result } = setup([
        ["a", ["a1"]],
        ["b", ["b1"]],
      ]);

      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBe("i:b1");
    });

    it("stops on headers that are marked navigable", () => {
      const { result } = setup([
        ["a", ["a1"], { navigableHeader: true }],
        ["b", ["b1"], { navigableHeader: true }],
      ]);

      expect(result.current.selectedRowId).toBe("h:a");
      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBe("i:a1");
      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBe("h:b");
    });

    it("skips an individual item marked non-navigable", () => {
      const { result } = setup([["a", ["a1", "a2", "a3"], { skipItems: ["a2"] }]]);

      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBe("i:a3");
    });

    it("wraps forward off the end and backward off the start", () => {
      const { result } = setup([
        ["a", ["a1"]],
        ["b", ["b1"]],
      ]);

      act(() => result.current.step(-1));
      expect(result.current.selectedRowId).toBe("i:b1");
      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("composes two steps issued in one React batch", () => {
      const { result } = setup([["a", ["a1", "a2", "a3"]]]);

      // Both calls in ONE act: batched into a single tick, which is the case a
      // step resolved from a stale outer closure would collapse into one move.
      act(() => {
        result.current.step(1);
        result.current.step(1);
      });

      expect(result.current.selectedRowId).toBe("i:a3");
    });

    it("does nothing when no row is navigable", () => {
      const { result } = setup([["a", [], { navigableHeader: false }]]);

      act(() => result.current.step(1));
      expect(result.current.selectedRowId).toBeNull();
      expect(result.current.selectedRowIndex).toBe(-1);
    });
  });

  describe("selection identity (#11071)", () => {
    it("follows the selected row when a row above it disappears", () => {
      const { result, rerender } = setup([["a", ["a1", "a2", "a3"]]]);

      act(() => result.current.selectRow("i:a3"));
      rerender({ groups: buildGroups([["a", ["a2", "a3"]]]), scope: undefined });

      expect(result.current.selectedRowId).toBe("i:a3");
      // Its position moved, which is exactly what a stored index would have missed.
      expect(result.current.selectedRowIndex).toBe(2);
    });

    it("falls back to the first navigable row when the selected row is gone", () => {
      const { result, rerender } = setup([["a", ["a1", "a2"]]]);

      act(() => result.current.selectRow("i:a2"));
      rerender({ groups: buildGroups([["a", ["a1"]]]), scope: undefined });

      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("never names an active descendant that is absent from the rendered rows", () => {
      const { result, rerender } = setup([
        ["a", ["a1", "a2"]],
        ["b", ["b1"]],
      ]);

      act(() => result.current.selectRow("i:b1"));
      expect(result.current.activeDescendantId).toBe("dom-i-b1");

      // Collapsing b removes the selected row from the model entirely.
      rerender({
        groups: buildGroups([
          ["a", ["a1", "a2"]],
          ["b", ["b1"], { collapsed: true }],
        ]),
        scope: undefined,
      });

      const renderedDomIds = result.current.rows.map((row) => row.domId);
      expect(renderedDomIds).not.toContain("dom-i-b1");
      expect(renderedDomIds).toContain(result.current.activeDescendantId);
    });

    it("reports no active descendant when nothing is navigable", () => {
      const { result } = setup([["a", [], {}]]);

      expect(result.current.activeDescendantId).toBeUndefined();
      expect(result.current.selectedRow).toBeNull();
    });

    it("drops the selection back to the top when the selection scope changes", () => {
      const { result, rerender } = setup([["a", ["a1", "a2"]]], { selectionScopeKey: "q1" });

      act(() => result.current.selectRow("i:a2"));
      rerender({ groups: buildGroups([["a", ["a1", "a2"]]]), scope: "q2" });

      expect(result.current.selectedRowId).toBe("i:a1");
    });
  });

  describe("disclosure", () => {
    it("collapses the selected row's group on ArrowLeft", () => {
      const onGroupCollapsedChange = vi.fn();
      const { result } = setup(
        [
          ["a", ["a1"]],
          ["b", ["b1"]],
        ],
        { onGroupCollapsedChange }
      );

      act(() => result.current.selectRow("i:b1"));
      const { event } = keyEvent("ArrowLeft");
      act(() => result.current.handleBodyKeyDown(event));

      expect(onGroupCollapsedChange).toHaveBeenCalledWith("b", true);
    });

    it("handles ArrowRight before the no-navigable-row guard", () => {
      const onGroupCollapsedChange = vi.fn();
      // Every group shut: nothing is navigable, so a guard placed first would
      // strand the user with no way to reopen anything.
      const { result } = setup([["a", ["a1"], { collapsed: true }]], { onGroupCollapsedChange });

      expect(result.current.selectedRow).toBeNull();
      const right = keyEvent("ArrowRight");
      act(() => result.current.handleBodyKeyDown(right.event));

      expect(onGroupCollapsedChange).toHaveBeenCalledWith("a", false);
      expectConsumed(right, true, "ArrowRight with every group shut");
    });

    it("reopens the group ArrowLeft just closed rather than the first collapsed one", () => {
      const onGroupCollapsedChange = vi.fn();
      const { result, rerender } = setup(
        [
          ["a", ["a1"], { collapsed: true }],
          ["b", ["b1"]],
        ],
        { onGroupCollapsedChange }
      );

      act(() => result.current.selectRow("i:b1"));
      act(() => result.current.handleBodyKeyDown(keyEvent("ArrowLeft").event));
      expect(onGroupCollapsedChange).toHaveBeenLastCalledWith("b", true);

      rerender({
        groups: buildGroups([
          ["a", ["a1"], { collapsed: true }],
          ["b", ["b1"], { collapsed: true }],
        ]),
        scope: undefined,
      });
      act(() => result.current.handleBodyKeyDown(keyEvent("ArrowRight").event));

      expect(onGroupCollapsedChange).toHaveBeenLastCalledWith("b", false);
    });

    it("falls through to a still-collapsed group when the remembered one is gone", () => {
      const onGroupCollapsedChange = vi.fn();
      const { result, rerender } = setup(
        [
          ["a", ["a1"], { collapsed: true }],
          ["b", ["b1"]],
        ],
        { onGroupCollapsedChange }
      );

      act(() => result.current.selectRow("i:b1"));
      act(() => result.current.handleBodyKeyDown(keyEvent("ArrowLeft").event));

      // b disappears entirely while the palette is open; the remembered target
      // is now stale, and consuming the key against it would do nothing.
      rerender({ groups: buildGroups([["a", ["a1"], { collapsed: true }]]), scope: undefined });
      act(() => result.current.handleBodyKeyDown(keyEvent("ArrowRight").event));

      expect(onGroupCollapsedChange).toHaveBeenLastCalledWith("a", false);
    });

    it("leaves the horizontal arrows alone when no collapse handler is supplied", () => {
      const { result } = setup([["a", ["a1"]]]);

      const left = keyEvent("ArrowLeft");
      const right = keyEvent("ArrowRight");
      act(() => result.current.handleBodyKeyDown(left.event));
      act(() => result.current.handleBodyKeyDown(right.event));

      expectConsumed(left, false, "ArrowLeft without a collapse handler");
      expectConsumed(right, false, "ArrowRight without a collapse handler");
    });
  });

  describe("caret arbitration", () => {
    it("leaves Home, End and the horizontal arrows to the caret when the predicate says so", () => {
      const onGroupCollapsedChange = vi.fn();
      const { result } = setup([["a", ["a1", "a2"]]], {
        onGroupCollapsedChange,
        shouldPreserveInputCaretKey: (event) => event.currentTarget.value.length > 0,
      });

      for (const key of ["Home", "End", "ArrowLeft", "ArrowRight"]) {
        const handle = keyEvent(key, { value: "typed" });
        act(() => result.current.handleInputKeyDown(handle.event));
        expectConsumed(handle, false, `${key} should stay with the caret`);
      }
      expect(onGroupCollapsedChange).not.toHaveBeenCalled();
      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("still moves the highlight vertically while the caret keys are preserved", () => {
      const { result } = setup([["a", ["a1", "a2"]]], {
        shouldPreserveInputCaretKey: () => true,
      });

      const handle = keyEvent("ArrowDown", { value: "typed" });
      act(() => result.current.handleInputKeyDown(handle.event));

      expectConsumed(handle, true, "ArrowDown is not a caret key");
      expect(result.current.selectedRowId).toBe("i:a2");
    });

    it("takes the caret keys once the predicate releases them", () => {
      const { result } = setup([["a", ["a1", "a2"]]], {
        shouldPreserveInputCaretKey: (event) => event.currentTarget.value.length > 0,
      });

      const handle = keyEvent("End", { value: "" });
      act(() => result.current.handleInputKeyDown(handle.event));

      expectConsumed(handle, true, "End with an empty box");
      expect(result.current.selectedRowId).toBe("i:a2");
    });

    it("never consults the predicate on the body region, which has no caret", () => {
      const shouldPreserveInputCaretKey = vi.fn(() => true);
      const { result } = setup([["a", ["a1", "a2"]]], { shouldPreserveInputCaretKey });

      const handle = keyEvent("End");
      act(() => result.current.handleBodyKeyDown(handle.event));

      expect(shouldPreserveInputCaretKey).not.toHaveBeenCalled();
      expectConsumed(handle, true, "End on the body region");
      expect(result.current.selectedRowId).toBe("i:a2");
    });
  });

  describe("input guards", () => {
    it("ignores a key delivered mid-composition", () => {
      const { result } = setup([["a", ["a1", "a2"]]]);

      const handle = keyEvent("ArrowDown", { isComposing: true });
      act(() => result.current.handleInputKeyDown(handle.event));

      expectConsumed(handle, false, "ArrowDown mid-composition");
      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("ignores the legacy composition keyCode", () => {
      const { result } = setup([["a", ["a1", "a2"]]]);

      const handle = keyEvent("Enter", { keyCode: 229 });
      act(() => result.current.handleInputKeyDown(handle.event));

      expectConsumed(handle, false, "Enter accepting an IME candidate");
    });

    it("leaves Enter and the vertical arrows to the browser when nothing is navigable", () => {
      const { result } = setup([["a", [], {}]]);

      for (const key of ["Enter", "ArrowDown", "ArrowUp"]) {
        const handle = keyEvent(key);
        act(() => result.current.handleBodyKeyDown(handle.event));
        expectConsumed(handle, false, `${key} should fall through`);
      }
    });

    it("leaves every other key untouched", () => {
      const { result } = setup([["a", ["a1"]]]);

      for (const key of ["Escape", "Tab", "Backspace", "PageDown", "a"]) {
        const handle = keyEvent(key);
        act(() => result.current.handleInputKeyDown(handle.event));
        expectConsumed(handle, false, `${key} should not be consumed`);
      }
    });
  });

  describe("activation", () => {
    it("activates the row the active descendant names", () => {
      const onActivate = makeActivateSpy();
      const { result } = setup([["a", ["a1", "a2"]]], { onActivate });

      act(() => result.current.step(1));
      act(() => result.current.handleBodyKeyDown(keyEvent("Enter").event));

      expect(onActivate).toHaveBeenCalledTimes(1);
      const activated = onActivate.mock.calls[0]![0];
      expect(activated.domId).toBe(result.current.activeDescendantId);
    });

    it("carries the caller's item through to the activation callback", () => {
      const onActivate = makeActivateSpy();
      const { result } = setup([["a", ["a1"]]], { onActivate });

      act(() => result.current.activateRow("i:a1"));

      const activated = onActivate.mock.calls[0]![0];
      expect(activated.kind === "item" && activated.item.label).toBe("a1");
      expect(activated.group.name).toBe("A");
    });

    it("ignores activation of a row that is not navigable", () => {
      const onActivate = vi.fn();
      const { result } = setup([["a", ["a1"]]], { onActivate });

      act(() => result.current.activateRow("h:a"));

      expect(onActivate).not.toHaveBeenCalled();
    });
  });

  describe("scrolling", () => {
    let scrollIntoView: ReturnType<typeof makeScrollSpy>;
    let original: typeof Element.prototype.scrollIntoView;

    beforeEach(() => {
      original = Element.prototype.scrollIntoView;
      scrollIntoView = makeScrollSpy();
      Element.prototype.scrollIntoView = scrollIntoView;
      const node = document.createElement("div");
      node.id = "dom-i-a1";
      document.body.append(node);
    });

    afterEach(() => {
      Element.prototype.scrollIntoView = original;
      document.body.innerHTML = "";
    });

    it("scrolls the selected row into view", () => {
      setup([["a", ["a1"]]]);

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it("does not re-scroll when rows are rebuilt under an unchanged selection", () => {
      const { rerender } = setup([["a", ["a1"]]]);
      scrollIntoView.mockClear();

      // A fresh array of fresh objects with the same ids — what a live data
      // refresh produces, and what must not yank the user's own scroll.
      rerender({ groups: buildGroups([["a", ["a1"]]]), scope: undefined });

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("stands down while the palette is inactive", () => {
      setup([["a", ["a1"]]], { isActive: false });

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });
});
