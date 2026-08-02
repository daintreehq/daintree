// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PilotFilterBar } from "../PilotFilterBar";
import type { PilotBandFilter, PilotBandFilterCounts } from "../pilotRows";

function counts(overrides: Partial<PilotBandFilterCounts> = {}): PilotBandFilterCounts {
  return { all: 0, "needs-you": 0, working: 0, finished: 0, ...overrides };
}

function renderBar(
  value: PilotBandFilter = "all",
  bandCounts: PilotBandFilterCounts = counts({ all: 3, "needs-you": 1, working: 2 })
) {
  const onChange = vi.fn();
  render(<PilotFilterBar value={value} counts={bandCounts} onChange={onChange} />);
  return { onChange };
}

/** The bar's segments, in rendered order, by accessible name. */
function segmentNames(): string[] {
  return screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label") ?? "");
}

describe("PilotFilterBar", () => {
  it("offers the four states as one mutually exclusive choice", () => {
    // A radiogroup, not the sidebar's toolbar of toggles: these segments are
    // exclusive with All as the null option, which is what a radiogroup IS.
    renderBar();

    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("reports exactly one checked segment", () => {
    renderBar("working");

    const checked = screen.getAllByRole("radio", { checked: true });
    expect(checked).toHaveLength(1);
    expect(checked[0]!.getAttribute("aria-label")).toContain("Working");
  });

  it("gives the group a single tab stop, on the checked segment", () => {
    // Roving tabindex: Tab from the search box lands on the active filter
    // rather than walking four controls on the way to the list.
    renderBar("finished");

    const tabbable = screen
      .getAllByRole("radio")
      .filter((el) => el.getAttribute("tabindex") === "0");

    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("carries the count in each segment's name, so it is never colour-and-digit alone", () => {
    renderBar("all", counts({ all: 7, "needs-you": 2, working: 4, finished: 1 }));

    expect(segmentNames()).toEqual([
      "All, 7 agents",
      "Needs you, 2 agents",
      "Working, 4 agents",
      "Finished, 1 agent",
    ]);
  });

  it("selects a segment on click", () => {
    const { onChange } = renderBar();

    fireEvent.click(screen.getByRole("radio", { name: /Needs you/ }));

    expect(onChange).toHaveBeenCalledWith("needs-you");
  });

  it("does not toggle the checked segment back to All", () => {
    // The sidebar's toolbar toggles because its segments are independent
    // presses. Re-selecting the checked radio in a radiogroup is a no-op, not
    // an escape hatch — All is a segment of its own and is how you get back.
    const { onChange } = renderBar("working");

    fireEvent.click(screen.getByRole("radio", { name: /Working/ }));

    expect(onChange).toHaveBeenCalledWith("working");
    expect(onChange).not.toHaveBeenCalledWith("all");
  });

  describe("keyboard", () => {
    /** Arrows are bound on the group, so they are dispatched there. */
    function press(key: string): void {
      fireEvent.keyDown(screen.getByRole("radiogroup"), { key });
    }

    it("moves selection with the arrows, in both directions", () => {
      // Selection follows focus: the filter is instant and reversible, so
      // charging a second keystroke to confirm would be a toll for nothing.
      const { onChange } = renderBar("needs-you");

      press("ArrowRight");
      expect(onChange).toHaveBeenLastCalledWith("working");

      press("ArrowLeft");
      expect(onChange).toHaveBeenLastCalledWith("all");
    });

    it("wraps backwards off the first segment", () => {
      const { onChange } = renderBar("all");

      press("ArrowLeft");

      expect(onChange).toHaveBeenLastCalledWith("finished");
    });

    it("wraps forwards off the last segment", () => {
      const { onChange } = renderBar("finished");

      press("ArrowRight");

      expect(onChange).toHaveBeenLastCalledWith("all");
    });

    it("jumps to the ends with Home and End", () => {
      const { onChange } = renderBar("working");

      press("Home");
      expect(onChange).toHaveBeenLastCalledWith("all");

      press("End");
      expect(onChange).toHaveBeenLastCalledWith("finished");
    });

    it("claims only the keys it handles", () => {
      // The dialog and the browser still have a use for everything else —
      // cancelling indiscriminately from a control inside a palette is how a
      // surface eats Escape or Enter from the components around it.
      renderBar();
      const group = screen.getByRole("radiogroup");

      expect(fireEvent.keyDown(group, { key: "ArrowRight" })).toBe(false);
      expect(fireEvent.keyDown(group, { key: "Escape" })).toBe(true);
      expect(fireEvent.keyDown(group, { key: "a" })).toBe(true);
    });
  });

  describe("empty buckets", () => {
    /** The glyph a segment renders, if it has one. */
    function glyphOf(name: RegExp): Element | null {
      return screen.getByRole("radio", { name }).querySelector("svg");
    }

    it("keeps a zero segment selectable and still counted", () => {
      // Hiding an empty segment would make the bar's own shape change as the
      // fleet moved, and take away the control that proves the bucket is empty.
      const { onChange } = renderBar("all", counts({ all: 2, working: 2 }));

      const empty = screen.getByRole("radio", { name: /Needs you/ });
      expect(empty.getAttribute("aria-label")).toBe("Needs you, 0 agents");

      fireEvent.click(empty);
      expect(onChange).toHaveBeenCalledWith("needs-you");
    });

    it("mutes the glyph of an empty bucket and not of a populated one", () => {
      // The zero has to register without being read. Compared against the
      // populated segment rather than asserted as a colour literal — the
      // invariant is that the two differ, not what either one spells.
      renderBar("all", counts({ all: 2, working: 2 }));

      const empty = glyphOf(/Needs you/)?.getAttribute("class") ?? "";
      const populated = glyphOf(/Working/)?.getAttribute("class") ?? "";

      expect(empty).not.toBe("");
      expect(populated).not.toBe("");
      expect(empty).not.toBe(populated);
    });

    it("only spins the working glyph when something is actually working", () => {
      // A spinner over a count of zero animates a claim that nothing is
      // happening, which is motion with no information in it.
      renderBar("all", counts({ all: 1, "needs-you": 1 }));
      expect(glyphOf(/Working/)?.getAttribute("class")).not.toContain("animate-spin");

      cleanup();

      renderBar("all", counts({ all: 1, working: 1 }));
      expect(glyphOf(/Working/)?.getAttribute("class")).toContain("animate-spin");
    });
  });

  it("hides the decorative label and digit from the accessible name", () => {
    // The name above already carries both halves; exposing the visible text as
    // well would read every segment twice.
    renderBar("all", counts({ all: 5 }));
    const all = screen.getByRole("radio", { name: /All/ });

    for (const child of Array.from(all.children)) {
      expect(child.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
