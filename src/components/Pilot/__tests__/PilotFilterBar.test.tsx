// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { PilotFilterBar } from "../PilotFilterBar";
import type { PilotBandFilter, PilotBandFilterCounts } from "../pilotRows";
import { emptyBandCounts, type FleetBandCounts } from "@/lib/fleetAttention";

function counts(overrides: Partial<PilotBandFilterCounts> = {}): PilotBandFilterCounts {
  return { all: 0, "needs-you": 0, working: 0, finished: 0, parked: 0, ...overrides };
}

function bands(overrides: Partial<FleetBandCounts> = {}): FleetBandCounts {
  return { ...emptyBandCounts(), ...overrides };
}

function renderBar(
  value: PilotBandFilter = "all",
  bandCounts: PilotBandFilterCounts = counts({ all: 3, "needs-you": 1, working: 2 }),
  perBand: FleetBandCounts = bands({ "needs-you": 1, running: 2 })
) {
  const onChange = vi.fn();
  render(<PilotFilterBar value={value} counts={bandCounts} bands={perBand} onChange={onChange} />);
  return { onChange };
}

/**
 * The bar wired to real state, which is what a keyboard test actually needs.
 *
 * With a fixed `value` prop, pressing an arrow calls `onChange` and nothing
 * moves — so the NEXT key is still computed from the original segment, and a
 * component that never called `.focus()` at all would look identical.
 */
function StatefulBar({ initial = "all" }: { initial?: PilotBandFilter }) {
  const [value, setValue] = useState<PilotBandFilter>(initial);
  return (
    <PilotFilterBar
      value={value}
      counts={counts({ all: 3, "needs-you": 1, working: 2 })}
      bands={bands({ "needs-you": 1, running: 2 })}
      onChange={setValue}
    />
  );
}

/** Checked segment, its tab stop and where focus actually is, as one reading. */
function liveState(): { checked: string; tabbable: string; focused: string } {
  const radios = screen.getAllByRole("radio");
  const name = (el: Element | null) => el?.getAttribute("aria-label")?.split(",")[0] ?? "none";
  return {
    checked: name(radios.find((el) => el.getAttribute("aria-checked") === "true") ?? null),
    tabbable: name(radios.find((el) => el.getAttribute("tabindex") === "0") ?? null),
    focused: name(document.activeElement),
  };
}

/** The bar's segments, in rendered order, by accessible name. */
function segmentNames(): string[] {
  return screen.getAllByRole("radio").map((el) => el.getAttribute("aria-label") ?? "");
}

describe("PilotFilterBar", () => {
  it("offers the states as one mutually exclusive choice", () => {
    // A radiogroup, not the sidebar's toolbar of toggles: these segments are
    // exclusive with All as the null option, which is what a radiogroup IS.
    renderBar();

    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
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
    renderBar("all", counts({ all: 7, "needs-you": 2, working: 4, finished: 1, parked: 3 }));

    expect(segmentNames()).toEqual([
      "All, 7 agents",
      "Waiting, 2 agents",
      "Working, 4 agents",
      "Finished, 1 agent",
      "Parked, 3 agents",
    ]);
  });

  it("selects a segment on click", () => {
    const { onChange } = renderBar();

    fireEvent.click(screen.getByRole("radio", { name: /Waiting/ }));

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

    it("moves the checked segment, its tab stop and focus together", () => {
      // Selection follows focus: the filter is instant and reversible, so
      // charging a second keystroke to confirm would be a toll for nothing.
      // All three have to move as one, or Tab returns somewhere unexpected.
      render(<StatefulBar initial="needs-you" />);

      press("ArrowRight");
      expect(liveState()).toEqual({
        checked: "Working",
        tabbable: "Working",
        focused: "Working",
      });

      press("ArrowLeft");
      expect(liveState()).toEqual({
        checked: "Waiting",
        tabbable: "Waiting",
        focused: "Waiting",
      });
    });

    it("wraps backwards off the first segment", () => {
      render(<StatefulBar initial="all" />);

      press("ArrowLeft");

      expect(liveState().checked).toBe("Parked");
    });

    it("wraps forwards off the last segment", () => {
      render(<StatefulBar initial="parked" />);

      press("ArrowRight");

      expect(liveState().checked).toBe("All");
    });

    it("jumps to the ends with Home and End", () => {
      render(<StatefulBar initial="working" />);

      press("Home");
      expect(liveState().checked).toBe("All");

      press("End");
      expect(liveState().checked).toBe("Parked");
    });

    it("keeps exactly one tab stop through every move", () => {
      render(<StatefulBar initial="all" />);

      for (const key of ["ArrowRight", "ArrowRight", "End", "Home", "ArrowLeft"]) {
        press(key);
        const tabbable = screen
          .getAllByRole("radio")
          .filter((el) => el.getAttribute("tabindex") === "0");
        expect(tabbable).toHaveLength(1);
      }
    });

    it("claims only the keys it handles, and keeps them off the palette", () => {
      // The dialog and the browser still have a use for everything else —
      // cancelling indiscriminately from a control inside a palette is how a
      // surface eats Escape or Enter from the components around it.
      const outer = vi.fn();
      render(
        <div onKeyDown={outer}>
          <StatefulBar />
        </div>
      );
      const group = screen.getByRole("radiogroup");

      expect(fireEvent.keyDown(group, { key: "ArrowRight" })).toBe(false);
      // Its own arrows must not also reach the palette's tree navigation.
      expect(outer).not.toHaveBeenCalled();

      expect(fireEvent.keyDown(group, { key: "Escape" })).toBe(true);
      expect(fireEvent.keyDown(group, { key: "a" })).toBe(true);
      // ...but everything else still bubbles, so Escape still closes.
      expect(outer).toHaveBeenCalledTimes(2);
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

      const empty = screen.getByRole("radio", { name: /Waiting/ });
      expect(empty.getAttribute("aria-label")).toBe("Waiting, 0 agents");

      fireEvent.click(empty);
      expect(onChange).toHaveBeenCalledWith("needs-you");
    });

    it("mutes the glyph of an empty bucket and not of a populated one", () => {
      // The SAME segment at zero and at one. Comparing two different segments
      // proved nothing — their base tones already differ, so deleting the fade
      // rule entirely would still have passed.
      renderBar("all", counts({ all: 0 }), bands());
      const empty = glyphOf(/Waiting/)?.getAttribute("class") ?? "";

      cleanup();

      renderBar("all", counts({ all: 1, "needs-you": 1 }), bands({ "needs-you": 1 }));
      const populated = glyphOf(/Waiting/)?.getAttribute("class") ?? "";

      expect(empty).not.toBe("");
      expect(empty).not.toBe(populated);
    });

    it("keeps a mixed segment neutral until it actually holds a demand", () => {
      // Finished admits `review`, which is a demand, alongside `done`, which
      // is not. A count alone can't tell them apart, so hueing on membership
      // would paint a project whose completions have all been acknowledged in
      // the colour reserved for work still waiting to be looked at.
      renderBar("all", counts({ all: 2, finished: 2 }), bands({ done: 2 }));
      const acknowledged = glyphOf(/Finished/)?.getAttribute("class") ?? "";

      cleanup();

      renderBar("all", counts({ all: 2, finished: 2 }), bands({ review: 2 }));
      const awaitingReview = glyphOf(/Finished/)?.getAttribute("class") ?? "";

      // Same segment, same count — only the bands underneath differ.
      expect(acknowledged).not.toBe("");
      expect(acknowledged).not.toBe(awaitingReview);
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

  describe("segment hue", () => {
    /**
     * Only the colour utilities on a segment's glyph.
     *
     * The whole class string would have let the spinner's `animate-spin-slow`
     * stand in for a hue difference, so a Working segment that had lost its
     * colour entirely would still have compared as different.
     */
    function toneOf(name: RegExp): string {
      const cls =
        screen.getByRole("radio", { name }).querySelector("svg")?.getAttribute("class") ?? "";
      return cls
        .split(/\s+/)
        .filter((token) => token.startsWith("text-"))
        .sort()
        .join(" ");
    }

    it("hues Working even though a working agent is not a demand", () => {
      // Two segments, neither holding anything to act on. `bandFilterHasDemand`
      // reports false for both — correctly, since `running` is not a demand and
      // an acknowledged `done` is not either. Working is hued anyway, because
      // green for working is the vocabulary the rest of the app speaks; Finished
      // is not. If the demand test alone decided the hue these would match.
      renderBar("all", counts({ all: 4, working: 2, finished: 2 }), bands({ running: 2, done: 2 }));

      expect(toneOf(/Working/)).not.toBe("");
      expect(toneOf(/Working/)).not.toBe(toneOf(/Finished/));
    });

    it("does not let a demand elsewhere in the fleet decide Working's hue", () => {
      renderBar("all", counts({ all: 2, working: 2 }), bands({ running: 2 }));
      const quietFleet = toneOf(/Working/);

      cleanup();

      renderBar(
        "all",
        counts({ all: 3, "needs-you": 1, working: 2 }),
        bands({
          "needs-you": 1,
          running: 2,
        })
      );

      expect(toneOf(/Working/)).toBe(quietFleet);
    });

    it("separates work in flight from work handed back", () => {
      // The row glyphs make this distinction and the segments filter to them,
      // so the two have to agree — a Finished segment sharing Working's colour
      // would file "ready for review" under "still going".
      renderBar(
        "all",
        counts({ all: 4, working: 2, finished: 2 }),
        bands({ running: 2, review: 2 })
      );

      expect(toneOf(/Finished/)).not.toBe(toneOf(/Working/));
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
