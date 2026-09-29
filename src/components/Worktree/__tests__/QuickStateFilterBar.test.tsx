// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QuickStateFilterBar } from "../QuickStateFilterBar";
import { EMPTY_BUCKET_GLYPH_CLASS } from "../quickStateGlyph";
import { TooltipProvider } from "@/components/ui/tooltip";
import { glyphBox, GLYPH_SELECTOR } from "@/components/icons/__tests__/glyphBox";
import type { QuickStateFilter } from "@/lib/worktreeFilters";

// Each segment is a Radix tooltip trigger, so the bar needs a TooltipProvider
// ancestor — the real app supplies one at App.tsx.
function renderBar(ui: Parameters<typeof render>[0]) {
  return render(ui, { wrapper: TooltipProvider });
}

// A faded glyph keeps its own hue and is dimmed on top of it — the empty bucket
// must still be recognisably the same state, never a different colour.
function classes(glyphClass: string): string[] {
  return glyphClass.split(/\s+/);
}
function isFadedHue(glyphClass: string, hue: string): boolean {
  const list = classes(glyphClass);
  return list.includes(hue) && list.includes(EMPTY_BUCKET_GLYPH_CLASS);
}
// A controlled host, so keyboard moves land in `value` the way the sidebar's do.
function StatefulBar({
  initial,
  onChange,
}: {
  initial: QuickStateFilter;
  onChange?: (value: QuickStateFilter) => void;
}) {
  const [value, setValue] = useState<QuickStateFilter>(initial);
  return (
    <QuickStateFilterBar
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
      counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      trailing={<button type="button">Arm</button>}
    />
  );
}

function checkedName(): string | null {
  return (
    screen
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") === "true")
      ?.getAttribute("aria-label") ?? null
  );
}

const FADED = new RegExp(`(^|\\s)${EMPTY_BUCKET_GLYPH_CLASS}(\\s|$)`);

describe("QuickStateFilterBar", () => {
  it("renders all four segments addressable by accessible name when counts are omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    // "All" keeps its visible text anchor; the status segments go icon-only.
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Attention")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getByRole("radio", { name: "Working" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Attention" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Finished" })).toBeTruthy();
  });

  it("renders the bare count digit for every segment including All", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 5 }}
      />
    );
    const all = screen.getByRole("radio", { name: /^All/ });
    const working = screen.getByRole("radio", { name: /Working/ });
    const waiting = screen.getByRole("radio", { name: /Attention/ });
    const finished = screen.getByRole("radio", { name: /Finished/ });
    expect(within(all).getByText("9")).toBeTruthy();
    expect(within(working).getByText("3")).toBeTruthy();
    expect(within(waiting).getByText("1")).toBeTruthy();
    expect(within(finished).getByText("5")).toBeTruthy();
    // No parenthesised count anymore — just the digit.
    expect(within(working).queryByText("(3)", { exact: false })).toBeNull();
  });

  it("shows the count digit even for empty buckets", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 0, waiting: 0, finished: 0 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    const waiting = screen.getByRole("radio", { name: /Attention/ });
    const finished = screen.getByRole("radio", { name: /Finished/ });
    // Empty buckets still show "0" — a missing digit reads as broken, not empty.
    expect(within(working).getByText("0")).toBeTruthy();
    expect(within(waiting).getByText("0")).toBeTruthy();
    expect(within(finished).getByText("0")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Working, 0 worktrees" })).toBeTruthy();
    // The count digit stays out of the accessible name.
    expect(working.textContent).not.toContain("worktree");
  });

  it("keeps the visible count out of the accessible name via aria-hidden", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    const visibleCount = within(working).getByText("3");
    expect(visibleCount.getAttribute("aria-hidden")).toBe("true");
    // The count reaches screen readers only through the segment's accessible name.
    expect(screen.getByRole("radio", { name: "Working, 3 worktrees" })).toBeTruthy();
  });

  it("exposes the count in the segment's accessible name with singular/plural nouns", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      />
    );
    expect(screen.getByRole("radio", { name: "All, 9 worktrees" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Working, 3 worktrees" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Attention, 1 worktree" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Finished, 2 worktrees" })).toBeTruthy();
  });

  it("marks the active segment with aria-checked=true", () => {
    renderBar(
      <QuickStateFilterBar
        value="working"
        onChange={() => {}}
        counts={{ all: 9, working: 2, waiting: 0, finished: 1 }}
      />
    );
    expect(screen.getByRole("radio", { name: /Working/ }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(screen.getByRole("radio", { name: /^All/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("radio", { name: /Attention/ }).getAttribute("aria-checked")).toBe(
      "false"
    );
    expect(screen.getByRole("radio", { name: /Finished/ }).getAttribute("aria-checked")).toBe(
      "false"
    );
  });

  it("clicking an inactive segment calls onChange with that value", () => {
    const onChange = vi.fn();
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={onChange}
        counts={{ all: 9, working: 1, waiting: 0, finished: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /Working/ }));
    expect(onChange).toHaveBeenCalledWith("working");
  });

  it('clicking the active segment toggles back to "all"', () => {
    const onChange = vi.fn();
    renderBar(
      <QuickStateFilterBar
        value="waiting"
        onChange={onChange}
        counts={{ all: 9, working: 0, waiting: 3, finished: 0 }}
      />
    );
    fireEvent.click(screen.getByRole("radio", { name: /Attention/ }));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it('"All" is aria-checked when value is "all"', () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: /^All/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("renders a state icon on each non-All segment and no icon on All", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 1, waiting: 1, finished: 1 }}
      />
    );
    const all = screen.getByRole("radio", { name: /^All/ });
    const working = screen.getByRole("radio", { name: /Working/ });
    const waiting = screen.getByRole("radio", { name: /Attention/ });
    const finished = screen.getByRole("radio", { name: /Finished/ });
    expect(all.querySelector(GLYPH_SELECTOR)).toBeNull();
    expect(working.querySelector(GLYPH_SELECTOR)).not.toBeNull();
    expect(waiting.querySelector(GLYPH_SELECTOR)).not.toBeNull();
    expect(finished.querySelector(GLYPH_SELECTOR)).not.toBeNull();
  });

  it("spins the working icon when counts.working > 0 even if Working is not the active filter", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 2, waiting: 0, finished: 0 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    const svg = glyphBox(working);
    expect(svg).not.toBeNull();
    const svgClass = svg?.getAttribute("class") ?? "";
    expect(svgClass).toContain("animate-spin-slow");
    expect(svgClass).toContain("motion-reduce:animate-none");
  });

  it("keeps the working icon spinning while Working is the active filter", () => {
    renderBar(
      <QuickStateFilterBar
        value="working"
        onChange={() => {}}
        counts={{ all: 9, working: 2, waiting: 0, finished: 0 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    expect(working.getAttribute("aria-checked")).toBe("true");
    const svg = glyphBox(working);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").toContain("animate-spin-slow");
  });

  it("does not spin the working icon when counts.working is zero", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 0, waiting: 1, finished: 1 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    const svg = glyphBox(working);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").not.toContain("animate-spin-slow");
  });

  it("does not spin the working icon when counts prop is omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    const working = screen.getByRole("radio", { name: "Working" });
    const svg = glyphBox(working);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").not.toContain("animate-spin-slow");
  });

  it("only the working segment can spin — waiting and finished icons never animate", () => {
    // The spinner is the working segment's distinguishing shape signal; the
    // spin class must stay scoped to working even when every state has a count.
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 2, finished: 4 }}
      />
    );
    for (const name of [/Attention/, /Finished/]) {
      const svg = glyphBox(screen.getByRole("radio", { name }));
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class") ?? "").not.toContain("animate-spin-slow");
    }
  });

  it("marks each segment icon as aria-hidden so the accessible name stays clean", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 1, waiting: 1, finished: 1 }}
      />
    );
    for (const name of [/Working/, /Attention/, /Finished/]) {
      const button = screen.getByRole("radio", { name });
      const svg = glyphBox(button);
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("distinguishes the active count from the inactive ones — issue #7971", () => {
    // The count digit is the load-bearing signal in icon-only segments — the
    // active segment must read at full neutral text opacity (no /N suffix);
    // inactive segments stay muted at /60 to preserve the active hierarchy.
    renderBar(
      <QuickStateFilterBar
        value="working"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      />
    );
    const working = screen.getByRole("radio", { name: /Working/ });
    const waiting = screen.getByRole("radio", { name: /Attention/ });
    const activeCount = within(working).getByText("3");
    const inactiveCount = within(waiting).getByText("1");
    const activeClass = activeCount.getAttribute("class") ?? "";
    const inactiveClass = inactiveCount.getAttribute("class") ?? "";
    // The selected bucket's count leads and the rest recede. Naming either
    // colour would just copy the component; that they differ is the claim, and
    // neither may fall back to the retired alpha ramp (#12065).
    expect(activeClass).not.toBe(inactiveClass);
    expect(activeClass).not.toContain("text-daintree-text/");
    expect(inactiveClass).not.toContain("text-daintree-text/");
  });

  it("fades each empty bucket's icon with its own state color — issue #10353", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 0, waiting: 0, finished: 0 }}
      />
    );
    const hueBySegment: [RegExp, string][] = [
      [/Working/, "text-state-working"],
      [/Attention/, "text-state-waiting"],
      [/Finished/, "text-category-blue"],
    ];
    for (const [name, hue] of hueBySegment) {
      const svg = glyphBox(screen.getByRole("radio", { name }));
      expect(svg).not.toBeNull();
      expect(isFadedHue(svg?.getAttribute("class") ?? "", hue)).toBe(true);
    }
  });

  it("keeps icons at their full state color when their count is positive", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      />
    );
    const colorBySegment: [RegExp, string][] = [
      [/Working/, "text-state-working"],
      [/Attention/, "text-state-waiting"],
      [/Finished/, "text-category-blue"],
    ];
    for (const [name, colorClass] of colorBySegment) {
      const svg = glyphBox(screen.getByRole("radio", { name }));
      expect(svg).not.toBeNull();
      const svgClass = svg?.getAttribute("class") ?? "";
      expect(svgClass).toContain(colorClass);
      expect(svgClass).not.toMatch(FADED);
    }
  });

  it("fades only the segments whose count is zero in a mixed-count bar", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 2, working: 0, waiting: 2, finished: 0 }}
      />
    );
    const workingClass =
      screen
        .getByRole("radio", { name: /Working/ })
        .querySelector(GLYPH_SELECTOR)
        ?.getAttribute("class") ?? "";
    const waitingClass =
      screen
        .getByRole("radio", { name: /Attention/ })
        .querySelector(GLYPH_SELECTOR)
        ?.getAttribute("class") ?? "";
    const finishedClass =
      screen
        .getByRole("radio", { name: /Finished/ })
        .querySelector(GLYPH_SELECTOR)
        ?.getAttribute("class") ?? "";
    expect(isFadedHue(workingClass, "text-state-working")).toBe(true);
    expect(isFadedHue(finishedClass, "text-category-blue")).toBe(true);
    expect(waitingClass).toContain("text-state-waiting");
    expect(waitingClass).not.toMatch(FADED);
  });

  it("does not fade icons when the counts prop is omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    for (const name of ["Working", "Attention", "Finished"]) {
      const svg = glyphBox(screen.getByRole("radio", { name }));
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class") ?? "").not.toMatch(FADED);
    }
  });

  it("fades the active segment's icon when its own count is zero", () => {
    // Active styling lives on the button, the fade lives on the icon — they
    // must compose rather than conflict.
    renderBar(
      <QuickStateFilterBar
        value="waiting"
        onChange={() => {}}
        counts={{ all: 2, working: 1, waiting: 0, finished: 1 }}
      />
    );
    const waiting = screen.getByRole("radio", { name: /Attention/ });
    expect(waiting.getAttribute("aria-checked")).toBe("true");
    expect(
      isFadedHue(
        waiting.querySelector(GLYPH_SELECTOR)?.getAttribute("class") ?? "",
        "text-state-waiting"
      )
    ).toBe(true);
    const workingClass =
      screen
        .getByRole("radio", { name: /Working/ })
        .querySelector(GLYPH_SELECTOR)
        ?.getAttribute("class") ?? "";
    expect(workingClass).toContain("animate-spin-slow");
    expect(workingClass).not.toMatch(FADED);
  });

  it("renders the zero-count working icon faded and not spinning", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 0, working: 0, waiting: 0, finished: 0 }}
      />
    );
    const svgClass =
      screen
        .getByRole("radio", { name: /Working/ })
        .querySelector(GLYPH_SELECTOR)
        ?.getAttribute("class") ?? "";
    expect(isFadedHue(svgClass, "text-state-working")).toBe(true);
    expect(svgClass).not.toContain("animate-spin-slow");
  });

  it("renders the optional trailing slot past a divider", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 1, waiting: 1, finished: 1 }}
        trailing={<button type="button">Arm</button>}
      />
    );
    expect(screen.getByRole("button", { name: "Arm" })).toBeTruthy();
  });
  it("groups the four segments in a named radiogroup, with the trailing slot outside it", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        trailing={<button type="button">Arm</button>}
      />
    );
    const group = screen.getByRole("radiogroup", { name: "Quick state filter" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "All",
      "Working",
      "Attention",
      "Finished",
    ]);
    // Exactly one segment is checked.
    expect(radios.filter((radio) => radio.getAttribute("aria-checked") === "true")).toHaveLength(1);
    // The trailing control is a separate stop, not a fifth option of the filter.
    expect(group.contains(screen.getByRole("button", { name: "Arm" }))).toBe(false);
  });

  it("makes the checked segment the group's only tab stop", () => {
    renderBar(<QuickStateFilterBar value="waiting" onChange={() => {}} />);
    const tabStops = screen.getAllByRole("radio").filter((radio) => radio.tabIndex === 0);
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]?.getAttribute("aria-label")).toBe("Attention");
    for (const radio of screen.getAllByRole("radio")) {
      if (radio !== tabStops[0]) expect(radio.tabIndex).toBe(-1);
    }
  });

  it("moves the selection and focus together on the arrow keys, wrapping at both ends", () => {
    renderBar(<StatefulBar initial="all" />);
    const start = screen.getByRole("radio", { name: /^All/ });
    start.focus();

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(checkedName()).toBe("Working, 3 worktrees");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Working/ }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(checkedName()).toBe("Attention, 1 worktree");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Attention/ }));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(checkedName()).toBe("All, 9 worktrees");
    expect(document.activeElement).toBe(start);

    // Left from the first segment wraps to the last; Right from the last wraps back.
    fireEvent.keyDown(start, { key: "ArrowLeft" });
    expect(checkedName()).toBe("Finished, 2 worktrees");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Finished/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(checkedName()).toBe("All, 9 worktrees");
    expect(document.activeElement).toBe(start);

    // The tab stop travels with the selection.
    expect(start.tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: /Finished/ }).tabIndex).toBe(-1);
  });

  it("jumps to the first and last segments on Home and End", () => {
    renderBar(<StatefulBar initial="working" />);
    const working = screen.getByRole("radio", { name: /Working/ });
    working.focus();

    fireEvent.keyDown(working, { key: "End" });
    expect(checkedName()).toBe("Finished, 2 worktrees");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Finished/ }));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(checkedName()).toBe("All, 9 worktrees");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /^All/ }));
  });

  it("keeps the keys it handles from reaching the surface around it", () => {
    const outer = vi.fn();
    const onChange = vi.fn();
    renderBar(
      <div onKeyDown={(event) => outer(event.key)}>
        <StatefulBar initial="all" onChange={onChange} />
      </div>
    );
    const all = screen.getByRole("radio", { name: /^All/ });
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
      fireEvent.keyDown(document.activeElement === document.body ? all : document.activeElement!, {
        key,
      });
    }
    expect(onChange).toHaveBeenCalledTimes(6);
    expect(outer).not.toHaveBeenCalled();

    // Keys the group has no use for still bubble.
    fireEvent.keyDown(all, { key: "Enter" });
    fireEvent.keyDown(all, { key: "a" });
    expect(outer.mock.calls.map(([key]) => key)).toEqual(["Enter", "a"]);
  });

  it("cancels the default action only for the keys it handles", () => {
    renderBar(<StatefulBar initial="all" />);
    const all = screen.getByRole("radio", { name: /^All/ });
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(all, { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(document.activeElement!, { key: "Tab" })).toBe(true);
  });
});
