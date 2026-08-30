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

/** `[groupId, itemIds, { navigableHeader, skipItems }]` */
type GroupSpec = [string, string[], { navigableHeader?: boolean; skipItems?: string[] }?];

function buildGroups(specs: GroupSpec[]): PaletteTreeGroupInput<TestGroup, TestItem>[] {
  return specs.map(([groupId, itemIds, options = {}]) => ({
    groupId,
    group: { name: groupId.toUpperCase() },
    header: {
      rowId: `h:${groupId}`,
      domId: `dom-h-${groupId}`,
      navigable: options.navigableHeader ?? false,
    },
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
    shouldPreserveInputCaretKey?: (event: KeyboardEvent<HTMLInputElement>) => boolean;
    selectionScopeKey?: string;
    isActive?: boolean;
    preferredInitialRowId?: string | null;
  } = {}
) {
  const onActivate = options.onActivate ?? vi.fn();
  return renderHook(
    ({ groups, scope }: { groups: PaletteTreeGroupInput<TestGroup, TestItem>[]; scope?: string }) =>
      usePaletteTreeNavigation<TestGroup, TestItem>({
        groups,
        isActive: options.isActive ?? true,
        selectionScopeKey: scope ?? null,
        preferredInitialRowId: options.preferredInitialRowId ?? null,
        onActivate,
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

    it("builds the render model and the nav domain from the same pass", () => {
      // A caller that maps over `renderGroups` is rendering exactly what the
      // arrows address, so neither can hold a row the other does not.
      const { result } = setup([
        ["a", ["a1", "a2"]],
        ["b", ["b1"]],
      ]);

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
      expect(result.current.selectedNavigableIndex).toBe(-1);
    });

    it("wraps a delta larger than the list rather than running off the end", () => {
      // A single `+ length` in the modulo only rescues a delta of -1; this is a
      // shared API that may be handed a page-sized jump.
      const { result } = setup([["a", ["a1", "a2", "a3"]]]);

      act(() => result.current.step(-4));
      expect(result.current.selectedRowId).toBe("i:a3");

      act(() => result.current.step(7));
      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("counts the navigable sequence, not the rows that include headers", () => {
      const { result } = setup([
        ["a", ["a1"]],
        ["b", ["b1"]],
      ]);

      act(() => result.current.step(1));
      // Third entry in `rows` (h:a, i:a1, h:b, i:b1) but second navigable one.
      expect(result.current.selectedNavigableIndex).toBe(1);
    });
  });

  describe("preferred initial row", () => {
    /**
     * The caller names where the highlight should start; every movement key has
     * to agree with what is drawn. They did not: the index shown came from the
     * preferred row while `step` and `page` counted from zero, so the first
     * arrow after opening jumped somewhere the user had not been.
     */
    it("seats the highlight on the preferred row", () => {
      const { result } = setup(
        [
          ["a", ["a1", "a2"]],
          ["b", ["b1"]],
        ],
        { preferredInitialRowId: "i:a2" }
      );

      expect(result.current.selectedRow?.rowId).toBe("i:a2");
      expect(result.current.selectedNavigableIndex).toBe(1);
    });

    it("moves the FIRST arrow relative to the preferred row, not to the top", () => {
      const { result } = setup(
        [
          ["a", ["a1", "a2"]],
          ["b", ["b1"]],
        ],
        { preferredInitialRowId: "i:a2" }
      );

      act(() => result.current.step(1));
      expect(result.current.selectedRow?.rowId).toBe("i:b1");
    });

    it("moves the first ArrowUp and the first page key from it too", () => {
      const { result } = setup(
        [
          ["a", ["a1", "a2"]],
          ["b", ["b1"]],
        ],
        { preferredInitialRowId: "i:a2" }
      );

      act(() => result.current.step(-1));
      expect(result.current.selectedRow?.rowId).toBe("i:a1");

      const paged = setup(
        [
          ["a", ["a1", "a2"]],
          ["b", ["b1"]],
        ],
        { preferredInitialRowId: "i:a2" }
      );
      // Page keys clamp rather than wrap, so a page down from the middle of a
      // three-row list lands on the last row.
      act(() => paged.result.current.handleInputKeyDown(keyEvent("PageDown").event));
      expect(paged.result.current.selectedRow?.rowId).toBe("i:b1");
    });

    it("yields to the user's own selection, and to a preference that no longer exists", () => {
      const { result } = setup(
        [
          ["a", ["a1", "a2"]],
          ["b", ["b1"]],
        ],
        { preferredInitialRowId: "i:a2" }
      );

      act(() => result.current.selectRow("i:b1"));
      act(() => result.current.step(-1));
      expect(result.current.selectedRow?.rowId).toBe("i:a2");

      const missing = setup([["a", ["a1", "a2"]]], { preferredInitialRowId: "i:gone" });
      expect(missing.result.current.selectedRow?.rowId).toBe("i:a1");
    });
  });

  describe("selection identity (#11071)", () => {
    it("follows the selected row when a row above it disappears", () => {
      const { result, rerender } = setup([["a", ["a1", "a2", "a3"]]]);

      act(() => result.current.selectRow("i:a3"));
      rerender({ groups: buildGroups([["a", ["a2", "a3"]]]), scope: undefined });

      expect(result.current.selectedRowId).toBe("i:a3");
      // Its position moved, which is exactly what a stored index would have missed.
      expect(result.current.selectedNavigableIndex).toBe(1);
    });

    it("commits a fallback selection when Enter activates it", () => {
      // The highlight can be a DERIVED fallback: the stored row vanished and
      // the first navigable one took over. Activating without storing that id
      // leaves the next list change move the highlight off the row the user
      // just acted on — palettes that stay open on a failed activation show it.
      const onActivate = makeActivateSpy();
      const { result, rerender } = setup([["a", ["a1", "a2"]]], { onActivate });

      act(() => result.current.selectRow("i:a2"));
      rerender({ groups: buildGroups([["a", ["a1"]]]), scope: undefined });
      expect(result.current.selectedRowId).toBe("i:a1");

      act(() => result.current.handleBodyKeyDown(keyEvent("Enter").event));
      expect(onActivate.mock.calls[0]![0].rowId).toBe("i:a1");

      // A row arriving above the activated one must not steal the highlight.
      rerender({ groups: buildGroups([["a", ["a0", "a1"]]]), scope: undefined });
      expect(result.current.selectedRowId).toBe("i:a1");
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

      // b's run exits, removing the selected row from the model entirely.
      rerender({
        groups: buildGroups([
          ["a", ["a1", "a2"]],
          ["b", []],
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

  describe("paging", () => {
    /** Twenty-six rows, so a page-sized jump has somewhere to land. */
    const longList = (): GroupSpec[] => [["a", Array.from({ length: 26 }, (_, i) => `a${i}`)]];

    const selectedIndex = (result: { current: { selectedNavigableIndex: number } }) =>
      result.current.selectedNavigableIndex;

    it("moves further than an arrow does", () => {
      // Asserted as a relationship rather than against the page size itself,
      // which would just be the constant copied out of the implementation.
      const { result } = setup(longList());

      act(() => result.current.handleBodyKeyDown(keyEvent("ArrowDown").event));
      const oneRow = selectedIndex(result);

      act(() => result.current.selectRow("i:a0"));
      act(() => result.current.handleBodyKeyDown(keyEvent("PageDown").event));

      expect(selectedIndex(result)).toBeGreaterThan(oneRow);
    });

    it("returns to where it started when a page down is undone by a page up", () => {
      const { result } = setup(longList());

      act(() => result.current.selectRow("i:a12"));
      act(() => result.current.handleBodyKeyDown(keyEvent("PageDown").event));
      act(() => result.current.handleBodyKeyDown(keyEvent("PageUp").event));

      expect(result.current.selectedRowId).toBe("i:a12");
    });

    it("lands on the last row rather than wrapping past the end", () => {
      // The reason this cannot be `step(+n)`: modulo arithmetic over a list
      // shorter than a page returns the row it started from, so the key would
      // visibly do nothing at all.
      const { result } = setup([["a", ["a1", "a2", "a3"]]]);

      const pageDown = keyEvent("PageDown");
      act(() => result.current.handleBodyKeyDown(pageDown.event));

      expectConsumed(pageDown, true, "PageDown on a short list");
      expect(result.current.selectedRowId).toBe("i:a3");
    });

    it("lands on the first row rather than wrapping past the start", () => {
      // Every non-first starting position, because a single one can agree with
      // wrapping by coincidence: over a three-row list a wrapping PageUp from
      // row 2 also lands on row 1, so that fixture alone proves nothing.
      for (const from of ["i:a2", "i:a3"]) {
        const { result, unmount } = setup([["a", ["a1", "a2", "a3"]]]);

        act(() => result.current.selectRow(from));
        act(() => result.current.handleBodyKeyDown(keyEvent("PageUp").event));

        expect(result.current.selectedRowId, `PageUp from ${from}`).toBe("i:a1");
        unmount();
      }
    });

    it.each(["PageUp", "PageDown"])(
      "keeps %s off the browser's own scrolling of the region",
      (key) => {
        const { result } = setup(longList());
        act(() => result.current.selectRow("i:a12"));

        const handle = keyEvent(key);
        act(() => result.current.handleBodyKeyDown(handle.event));

        // Native scrolling walks the viewport while the selection sits still,
        // which is how the highlight ends up off screen with Enter still on it.
        expectConsumed(handle, true, `${key} must not also scroll natively`);
      }
    );

    it.each(["PageUp", "PageDown"])("leaves %s to the browser when nothing is navigable", (key) => {
      const { result } = setup([["a", []]]);

      const handle = keyEvent(key);
      act(() => result.current.handleBodyKeyDown(handle.event));

      expectConsumed(handle, false, `${key} over an empty list`);
    });

    it.each(["PageUp", "PageDown"])("takes %s from the input, where focus actually sits", (key) => {
      // The body region is only reachable after Tab. The search box owns the
      // keyboard by default, so a page key misclassified as a caret key would
      // leave the main path broken with every body-path test still green.
      const { result } = setup(longList(), {
        shouldPreserveInputCaretKey: (event) => event.currentTarget.value.length > 0,
      });
      act(() => result.current.selectRow("i:a12"));

      const handle = keyEvent(key, { value: "typed" });
      act(() => result.current.handleInputKeyDown(handle.event));

      expectConsumed(handle, true, `${key} on the input, caret keys preserved`);
      expect(result.current.selectedRowId).not.toBe("i:a12");
    });
  });

  describe("caret arbitration", () => {
    it("leaves Home and End to the caret when the predicate says so", () => {
      const { result } = setup([["a", ["a1", "a2"]]], {
        shouldPreserveInputCaretKey: (event) => event.currentTarget.value.length > 0,
      });

      for (const key of ["Home", "End"]) {
        const handle = keyEvent(key, { value: "typed" });
        act(() => result.current.handleInputKeyDown(handle.event));
        expectConsumed(handle, false, `${key} should stay with the caret`);
      }
      expect(result.current.selectedRowId).toBe("i:a1");
    });

    it("never contests the horizontal arrows, whatever the predicate says", () => {
      // The list has no horizontal axis: the disclosure that gave these keys a
      // job is gone, so they belong to the caret unconditionally and must reach
      // it uncancelled from the body region too.
      const shouldPreserveInputCaretKey = vi.fn(() => false);
      const { result } = setup([["a", ["a1", "a2"]]], { shouldPreserveInputCaretKey });

      for (const key of ["ArrowLeft", "ArrowRight"]) {
        const onInput = keyEvent(key, { value: "" });
        act(() => result.current.handleInputKeyDown(onInput.event));
        expectConsumed(onInput, false, `${key} on the input`);

        const onBody = keyEvent(key);
        act(() => result.current.handleBodyKeyDown(onBody.event));
        expectConsumed(onBody, false, `${key} on the body region`);
      }
      expect(shouldPreserveInputCaretKey).not.toHaveBeenCalled();
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

      // PageDown was here until the page keys were bound; everything left is a
      // key the palette shell, the dialog or the browser still has a use for.
      for (const key of ["Escape", "Tab", "Backspace", "a"]) {
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

    it("re-scrolls when the selected row keeps its id but changes position", () => {
      // A list that re-ranks under an open palette moves the selected row
      // without touching its id, so an effect watching the active descendant
      // alone never fires: the highlight walks off screen while Enter still
      // commits it. This is the whole reason position is a dependency.
      //
      // The effect resolves the row through `getElementById`, so the rows this
      // case walks past need elements of their own — the shared setup only
      // stands up the first one.
      for (const id of ["dom-i-a2", "dom-i-a3"]) {
        const node = document.createElement("div");
        node.id = id;
        document.body.append(node);
      }

      const { result, rerender } = setup([["a", ["a1", "a2", "a3"]]]);
      act(() => result.current.selectRow("i:a3"));
      scrollIntoView.mockClear();

      // Same three rows, same selected id — re-ranked so it now leads.
      rerender({ groups: buildGroups([["a", ["a3", "a1", "a2"]]]), scope: undefined });

      expect(result.current.selectedRowId).toBe("i:a3");
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    });
  });
});
