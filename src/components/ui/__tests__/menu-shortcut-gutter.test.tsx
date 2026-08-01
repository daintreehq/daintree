// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ContextMenuShortcut } from "../context-menu";
import { DropdownMenuShortcut } from "../dropdown-menu";

afterEach(cleanup);

// Both primitives are plain spans with no `useRadixPrimitives()` call, so they
// render standalone — no `primeRadix()` needed.
const PRIMITIVES = [
  { name: "ContextMenuShortcut", Shortcut: ContextMenuShortcut },
  { name: "DropdownMenuShortcut", Shortcut: DropdownMenuShortcut },
] as const;

const COMBO = "⌘I";

// An inline-start padding utility at a non-zero scale. `pl-0`/`px-0` would
// satisfy a bare `p[lx]-` match while leaving the hint flush, so they have to
// fail this.
const GUTTER = /^p[lx]-(?!0$)/;

function renderShortcut(Shortcut: (typeof PRIMITIVES)[number]["Shortcut"]): HTMLElement {
  render(<Shortcut>{COMBO}</Shortcut>);
  return screen.getByText(COMBO);
}

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("menu shortcut gutter — issue #11598", () => {
  it.each(PRIMITIVES)(
    "$name separates the hint from the label with padding, which flex cannot collapse",
    ({ Shortcut }) => {
      // `ml-auto` distributes leftover space, so it renders a gap only on rows
      // that have some. Menu width is set by the widest row, and a row carrying
      // both a label and a hint is typically that row — leaving it zero slack,
      // collapsing its auto margin to 0, and butting the hint against the
      // label. The separation therefore has to come from a box-model layer flex
      // cannot redistribute.
      //
      // jsdom has no compiled Tailwind and no flex layout, so this asserts the
      // utility is present and non-zero, not the rendered pixel gap. The gap
      // itself is a visual check.
      expect(
        classesOf(renderShortcut(Shortcut)).some((c) => GUTTER.test(c)),
        "shortcut needs a non-zero inline-start padding, not just `ml-auto`"
      ).toBe(true);
    }
  );

  it("keeps both menu families visually identical", () => {
    // #11598 reported the context menu, but `DropdownMenuShortcut` carried the
    // same class string and the same defect. These are duplicated wrappers kept
    // in sync by hand, so fixing one and missing the other is the realistic
    // regression — and it can only be resolved by editing the other primitive,
    // never by editing this test.
    const context = classesOf(renderShortcut(ContextMenuShortcut)).sort();
    cleanup();
    const dropdown = classesOf(renderShortcut(DropdownMenuShortcut)).sort();

    expect(dropdown).toEqual(context);
  });
});
