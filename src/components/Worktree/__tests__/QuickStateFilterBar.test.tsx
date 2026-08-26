// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QuickStateFilterBar } from "../QuickStateFilterBar";
import { TooltipProvider } from "@/components/ui/tooltip";

// Each segment is a Radix tooltip trigger, so the bar needs a TooltipProvider
// ancestor — the real app supplies one at App.tsx.
function renderBar(ui: Parameters<typeof render>[0]) {
  return render(ui, { wrapper: TooltipProvider });
}

describe("QuickStateFilterBar", () => {
  it("renders all four segments addressable by accessible name when counts are omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    // "All" keeps its visible text anchor; the status segments go icon-only.
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.queryByText("Working")).toBeNull();
    expect(screen.queryByText("Attention")).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
    expect(screen.getByRole("button", { name: "Working" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attention" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finished" })).toBeTruthy();
  });

  it("renders the bare count digit for every segment including All", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 5 }}
      />
    );
    const all = screen.getByRole("button", { name: /^All/ });
    const working = screen.getByRole("button", { name: /Working/ });
    const waiting = screen.getByRole("button", { name: /Attention/ });
    const finished = screen.getByRole("button", { name: /Finished/ });
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
    const working = screen.getByRole("button", { name: /Working/ });
    const waiting = screen.getByRole("button", { name: /Attention/ });
    const finished = screen.getByRole("button", { name: /Finished/ });
    // Empty buckets still show "0" — a missing digit reads as broken, not empty.
    expect(within(working).getByText("0")).toBeTruthy();
    expect(within(waiting).getByText("0")).toBeTruthy();
    expect(within(finished).getByText("0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Working, 0 worktrees" })).toBeTruthy();
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
    const working = screen.getByRole("button", { name: /Working/ });
    const visibleCount = within(working).getByText("3");
    expect(visibleCount.getAttribute("aria-hidden")).toBe("true");
    // The count reaches screen readers only through the button's accessible name.
    expect(screen.getByRole("button", { name: "Working, 3 worktrees" })).toBeTruthy();
  });

  it("exposes the count in the button's accessible name with singular/plural nouns", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 3, waiting: 1, finished: 2 }}
      />
    );
    expect(screen.getByRole("button", { name: "All, 9 worktrees" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Working, 3 worktrees" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attention, 1 worktree" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finished, 2 worktrees" })).toBeTruthy();
  });

  it("marks the active segment with aria-pressed=true", () => {
    renderBar(
      <QuickStateFilterBar
        value="working"
        onChange={() => {}}
        counts={{ all: 9, working: 2, waiting: 0, finished: 1 }}
      />
    );
    expect(screen.getByRole("button", { name: /Working/ }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /Attention/ }).getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(screen.getByRole("button", { name: /Finished/ }).getAttribute("aria-pressed")).toBe(
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
    fireEvent.click(screen.getByRole("button", { name: /Working/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Attention/ }));
    expect(onChange).toHaveBeenCalledWith("all");
  });

  it('"All" is aria-pressed when value is "all"', () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders a state icon on each non-All segment and no icon on All", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 1, waiting: 1, finished: 1 }}
      />
    );
    const all = screen.getByRole("button", { name: /^All/ });
    const working = screen.getByRole("button", { name: /Working/ });
    const waiting = screen.getByRole("button", { name: /Attention/ });
    const finished = screen.getByRole("button", { name: /Finished/ });
    expect(all.querySelector("svg")).toBeNull();
    expect(working.querySelector("svg")).not.toBeNull();
    expect(waiting.querySelector("svg")).not.toBeNull();
    expect(finished.querySelector("svg")).not.toBeNull();
  });

  it("spins the working icon when counts.working > 0 even if Working is not the active filter", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 2, waiting: 0, finished: 0 }}
      />
    );
    const working = screen.getByRole("button", { name: /Working/ });
    const svg = working.querySelector("svg");
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
    const working = screen.getByRole("button", { name: /Working/ });
    expect(working.getAttribute("aria-pressed")).toBe("true");
    const svg = working.querySelector("svg");
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
    const working = screen.getByRole("button", { name: /Working/ });
    const svg = working.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("class") ?? "").not.toContain("animate-spin-slow");
  });

  it("does not spin the working icon when counts prop is omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    const working = screen.getByRole("button", { name: "Working" });
    const svg = working.querySelector("svg");
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
      const svg = screen.getByRole("button", { name }).querySelector("svg");
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
      const button = screen.getByRole("button", { name });
      const svg = button.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders the active count at full text opacity and inactive counts at /60 — issue #7971", () => {
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
    const working = screen.getByRole("button", { name: /Working/ });
    const waiting = screen.getByRole("button", { name: /Attention/ });
    const activeCount = within(working).getByText("3");
    const inactiveCount = within(waiting).getByText("1");
    const activeClass = activeCount.getAttribute("class") ?? "";
    const inactiveClass = inactiveCount.getAttribute("class") ?? "";
    expect(activeClass).toContain("text-daintree-text");
    expect(activeClass).not.toContain("text-daintree-text/");
    expect(inactiveClass).toContain("text-daintree-text/60");
  });

  it("fades each empty bucket's icon with its own state color — issue #10353", () => {
    renderBar(
      <QuickStateFilterBar
        value="all"
        onChange={() => {}}
        counts={{ all: 9, working: 0, waiting: 0, finished: 0 }}
      />
    );
    const fadedBySegment: [RegExp, string][] = [
      [/Working/, "text-state-working/40"],
      [/Attention/, "text-state-waiting/40"],
      [/Finished/, "text-category-blue/40"],
    ];
    for (const [name, fadedClass] of fadedBySegment) {
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class") ?? "").toContain(fadedClass);
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
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).not.toBeNull();
      const svgClass = svg?.getAttribute("class") ?? "";
      expect(svgClass).toContain(colorClass);
      expect(svgClass).not.toContain("/40");
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
        .getByRole("button", { name: /Working/ })
        .querySelector("svg")
        ?.getAttribute("class") ?? "";
    const waitingClass =
      screen
        .getByRole("button", { name: /Attention/ })
        .querySelector("svg")
        ?.getAttribute("class") ?? "";
    const finishedClass =
      screen
        .getByRole("button", { name: /Finished/ })
        .querySelector("svg")
        ?.getAttribute("class") ?? "";
    expect(workingClass).toContain("text-state-working/40");
    expect(finishedClass).toContain("text-category-blue/40");
    expect(waitingClass).toContain("text-state-waiting");
    expect(waitingClass).not.toContain("/40");
  });

  it("does not fade icons when the counts prop is omitted", () => {
    renderBar(<QuickStateFilterBar value="all" onChange={() => {}} />);
    for (const name of ["Working", "Attention", "Finished"]) {
      const svg = screen.getByRole("button", { name }).querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("class") ?? "").not.toContain("/40");
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
    const waiting = screen.getByRole("button", { name: /Attention/ });
    expect(waiting.getAttribute("aria-pressed")).toBe("true");
    expect(waiting.querySelector("svg")?.getAttribute("class") ?? "").toContain(
      "text-state-waiting/40"
    );
    const workingClass =
      screen
        .getByRole("button", { name: /Working/ })
        .querySelector("svg")
        ?.getAttribute("class") ?? "";
    expect(workingClass).toContain("animate-spin-slow");
    expect(workingClass).not.toContain("/40");
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
        .getByRole("button", { name: /Working/ })
        .querySelector("svg")
        ?.getAttribute("class") ?? "";
    expect(svgClass).toContain("text-state-working/40");
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
});
