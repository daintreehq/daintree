// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { HeatCell } from "@shared/types";
import { PulseHeatmap } from "../PulseHeatmap";
import { TooltipProvider } from "../../ui/tooltip";

// #11172: the heatmap must have no way to express failure. A zero-commit day
// bracketed by active days used to be styled as a "missed day" — a danger tint,
// an inset ring, and a "Missed day" label. Every quiet day now reads the same,
// whatever its neighbours did.

function heatLevel(count: number): HeatCell["level"] {
  if (count >= 4) return 4;
  if (count === 3) return 3;
  if (count === 2) return 2;
  if (count === 1) return 1;
  return 0;
}

function cell(day: number, count: number): HeatCell {
  return {
    date: `2026-01-${String(day).padStart(2, "0")}`,
    count,
    level: heatLevel(count),
  };
}

// Day 03 is a zero bracketed by activity on both sides — the exact shape the
// old isMissedDay() flagged. Day 07 is an isolated zero with no activity near
// it, which it never flagged.
const CELLS: HeatCell[] = [
  cell(1, 3),
  cell(2, 2),
  cell(3, 0),
  cell(4, 4),
  cell(5, 1),
  cell(6, 0),
  cell(7, 0),
  cell(8, 0),
];

function renderHeatmap(cells: HeatCell[] = CELLS) {
  return render(
    <TooltipProvider>
      <PulseHeatmap cells={cells} rangeDays={60} />
    </TooltipProvider>
  );
}

function cellByDate(date: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-cell-date="${date}"]`);
  if (!el) throw new Error(`no cell rendered for ${date}`);
  return el;
}

// The date prefix differs per cell; the state description is what must match.
function stateOf(date: string): string {
  const label = cellByDate(date).getAttribute("aria-label") ?? "";
  return label.slice(label.indexOf(":") + 1).trim();
}

describe("PulseHeatmap — a quiet day is never a failure", () => {
  it("styles a zero day bracketed by activity exactly like an isolated zero day", () => {
    renderHeatmap();
    const bracketed = cellByDate("2026-01-03");
    const isolated = cellByDate("2026-01-07");

    // Under the old isMissedDay(), the bracketed cell alone got a danger tint
    // and the .pulse-heat-cell-missed ring.
    expect(bracketed.style.background).toBe(isolated.style.background);
    expect(bracketed.className).toBe(isolated.className);
  });

  it("describes every zero day the same way, whatever its neighbours did", () => {
    renderHeatmap();
    const quietDays = ["2026-01-03", "2026-01-06", "2026-01-07", "2026-01-08"];
    const described = quietDays.map(stateOf);

    // Every zero day must actually SAY something — otherwise "they all match"
    // would hold vacuously if the labels went missing.
    for (const state of described) {
      expect(state.length).toBeGreaterThan(0);
      // Whatever the wording, it can't be a failure. The old one was "Missed day".
      expect(state).not.toMatch(/miss|fail|break|broke|lost|skip/i);
    }
    expect(new Set(described).size).toBe(1);
    expect(screen.queryByLabelText(/missed/i)).toBeNull();
  });

  it("gives a zero day no forced-colors shape cue", () => {
    renderHeatmap();
    // The shape span is painted solid CanvasText under forced-colors. A quiet
    // day carrying one would become a signal again, by a different route than
    // the background this suite guards above.
    for (const date of ["2026-01-03", "2026-01-07"]) {
      const quiet = cellByDate(date);
      expect(quiet.querySelector(".pulse-heat-cell-shape")).toBeNull();
      expect(quiet.hasAttribute("data-heat-level")).toBe(false);
    }
  });

  it("still distinguishes days that actually had commits", () => {
    // Positive control: the equality above must not be holding because every
    // cell collapsed to one rendering.
    renderHeatmap();
    const worked = cellByDate("2026-01-04");
    const quiet = cellByDate("2026-01-03");
    expect(worked.style.background).not.toBe(quiet.style.background);
    expect(stateOf("2026-01-04")).not.toBe(stateOf("2026-01-03"));
    expect(worked.getAttribute("data-heat-level")).toBe("4");
    expect(worked.querySelector(".pulse-heat-cell-shape")).not.toBeNull();
  });
});

describe("PulseHeatmap — cells stay squares", () => {
  it("merges every cell, the latest active one included, down to the hairline corner", () => {
    renderHeatmap(
      CELLS.map((c) => (c.date === "2026-01-05" ? { ...c, isMostRecentActive: true } : c))
    );
    expect(document.querySelector("[data-latest-active]")).not.toBeNull();

    const cells = [...document.querySelectorAll<HTMLElement>(".pulse-heat-cell")];
    expect(cells.length).toBeGreaterThanOrEqual(CELLS.length);
    // Exactly one radius per cell after cn() has merged its arguments: a later
    // `rounded-full` or a theme step would turn the 10px cells into dots.
    const radii = cells.map((el) => [...el.classList].filter((c) => c.startsWith("rounded")));
    expect(new Set(radii.map((r) => r.join(" ")))).toEqual(new Set(["rounded-2xs"]));
  });
});

describe("PulseHeatmap — today is named, not inferred", () => {
  // Today is a quiet day here, so the latest-active ring sits elsewhere — the
  // case where "the ringed cell" and "today" would otherwise be confused.
  const cells: HeatCell[] = [
    { date: "2026-09-20", count: 3, level: 3, isMostRecentActive: false },
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 4, level: 4, isMostRecentActive: true },
    { date: "2026-09-23", count: 0, level: 0, isToday: true },
  ];

  it("labels today's row beside the grid and names today in its cell", () => {
    renderHeatmap(cells);
    const label = document.querySelector<HTMLElement>('[data-testid="pulse-heatmap-today"]')!;
    expect(label.textContent).toBe("Today");

    const today = cellByDate("2026-09-23");
    expect(today.getAttribute("aria-label")).toMatch(/^Today, /);

    // Only today says "Today"; the latest-active day keeps its own meaning.
    expect(cellByDate("2026-09-22").getAttribute("aria-label")).not.toMatch(/Today/);
    expect(cellByDate("2026-09-22").hasAttribute("data-latest-active")).toBe(true);
    expect(today.hasAttribute("data-latest-active")).toBe(false);
  });

  it("moves the label with today's weekday row", () => {
    // 2026-09-21 is a Monday (top row), 22 a Tuesday, 23 a Wednesday.
    const topFor = (todayDate: string) => {
      const { unmount } = renderHeatmap(
        cells.map((c) => ({ ...c, isToday: c.date === todayDate }))
      );
      const top = parseFloat(
        document.querySelector<HTMLElement>('[data-testid="pulse-heatmap-today"]')!.style.top
      );
      unmount();
      return top;
    };
    const monday = topFor("2026-09-21");
    const tuesday = topFor("2026-09-22");
    const wednesday = topFor("2026-09-23");
    expect(monday).toBe(0);
    expect(tuesday).toBeGreaterThan(0);
    expect(wednesday).toBe(2 * tuesday);
  });

  it("draws no today label when the range does not include today", () => {
    renderHeatmap(cells.map((c) => ({ ...c, isToday: false })));
    expect(document.querySelector('[data-testid="pulse-heatmap-today"]')).toBeNull();
  });
});

describe("PulseHeatmap — a day's tooltip is its readout, not a passing hint", () => {
  const cells: HeatCell[] = [
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 5, level: 4 },
    { date: "2026-09-23", count: 0, level: 0 },
    { date: "2026-09-24", count: 1, level: 1, isToday: true, isMostRecentActive: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the focused day's date and count on screen past the app's hint window", async () => {
    renderHeatmap(cells);
    // Radix loads lazily; let the loader settle before driving focus.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const cell = cellByDate("2026-09-22");
    act(() => {
      cell.focus();
      fireEvent.focus(cell);
    });
    const shown = () => document.body.textContent ?? "";
    expect(shown()).toContain("5 commits");

    // The app-wide tooltip wrapper auto-hides hints after a fixed window. A
    // heatmap day has no other visible place its count lives, so it must
    // outlast that window while the cell holds focus.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(shown()).toContain("5 commits");
  });
});

describe("PulseHeatmap — one shared tooltip", () => {
  const cells: HeatCell[] = [
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 5, level: 4 },
    { date: "2026-09-23", count: 0, level: 0 },
    { date: "2026-09-24", count: 1, level: 1, isToday: true, isMostRecentActive: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts a single tooltip anchor, not one per cell, and moves it with the pointer", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(document.querySelectorAll('[data-testid="pulse-heatmap-tooltip-anchor"]').length).toBe(
      1
    );
    expect(document.body.textContent).not.toContain("5 commits");

    const first = cellByDate("2026-09-21");
    const second = cellByDate("2026-09-22");
    fireEvent.pointerOver(first, { pointerType: "mouse" });
    expect(document.body.textContent).toContain("2 commits");
    const anchor = document.querySelector<HTMLElement>(
      '[data-testid="pulse-heatmap-tooltip-anchor"]'
    )!;
    const before = anchor.style.top;

    fireEvent.pointerOver(second, { pointerType: "mouse" });
    expect(document.body.textContent).toContain("5 commits");
    expect(anchor.style.top).not.toBe(before);
  });

  it("closes when the pointer leaves the grid", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.pointerOver(cellByDate("2026-09-22"), { pointerType: "mouse" });
    expect(document.body.textContent).toContain("5 commits");

    fireEvent.pointerLeave(document.querySelector('[data-testid="pulse-heatmap"]')!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).not.toContain("5 commits");
  });

  it("follows keyboard focus even while the pointer rests on another cell", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.pointerOver(cellByDate("2026-09-21"), { pointerType: "mouse" });
    expect(document.body.textContent).toContain("2 commits");

    const focused = cellByDate("2026-09-22");
    act(() => {
      focused.focus();
      fireEvent.focus(focused);
    });
    expect(document.body.textContent).toContain("5 commits");
  });

  it("does not open from the focus a click causes, and a press closes it", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const cell = cellByDate("2026-09-22");
    fireEvent.pointerOver(cell, { pointerType: "mouse" });
    expect(document.body.textContent).toContain("5 commits");

    fireEvent.pointerDown(cell, { pointerType: "mouse" });
    act(() => {
      cell.focus();
      fireEvent.focus(cell);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).not.toContain("5 commits");
  });

  it("keeps keyboard focus's readout when the pointer leaves, and closes it on activation", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    const grid = document.querySelector('[data-testid="pulse-heatmap"]')!;
    fireEvent.pointerOver(cellByDate("2026-09-21"), { pointerType: "mouse" });
    const focused = cellByDate("2026-09-22");
    act(() => {
      focused.focus();
      fireEvent.focus(focused);
    });
    fireEvent.pointerLeave(grid);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).toContain("5 commits");

    fireEvent.click(focused);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).not.toContain("5 commits");
  });

  it("still opens on keyboard focus after a press was released elsewhere", async () => {
    renderHeatmap(cells);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
    fireEvent.pointerDown(cellByDate("2026-09-21"), { pointerType: "mouse" });
    // No pointerup ever reaches the grid: the press was released outside it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const next = cellByDate("2026-09-22");
    act(() => {
      next.focus();
      fireEvent.focus(next);
    });
    expect(document.body.textContent).toContain("5 commits");
  });
});

describe("PulseHeatmap — a tap is a request for a day's readout", () => {
  const cells: HeatCell[] = [
    { date: "2026-09-21", count: 2, level: 2 },
    { date: "2026-09-22", count: 5, level: 4 },
    { date: "2026-09-23", count: 0, level: 0 },
    { date: "2026-09-24", count: 1, level: 1, isToday: true, isMostRecentActive: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const shown = () => document.body.textContent ?? "";
  const gridEl = () => document.querySelector<HTMLElement>('[data-testid="pulse-heatmap"]')!;

  // The click of a tap is a PointerEvent whose pointerType names the finger;
  // a keyboard activation's is empty and a mouse click's is "mouse".
  function click(el: Element, pointerType: string) {
    fireEvent(el, new PointerEvent("click", { bubbles: true, cancelable: true, pointerType }));
  }

  // pointerdown, the focus the press causes, pointerup, then the click, in the
  // order a touchscreen delivers them: the focus lands after the press's own
  // tick, so it is not the one a mouse press suppresses. The settle after lets
  // Radix register its outside-press listeners, which it attaches on a timer.
  async function tap(el: HTMLElement) {
    // Touch fires pointerover on the way in; the component ignores it.
    fireEvent.pointerOver(el, { pointerType: "touch" });
    fireEvent.pointerDown(el, { pointerType: "touch" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    // A button that already holds focus gets no focus event from a tap.
    if (document.activeElement !== el) {
      act(() => {
        el.focus();
      });
    }
    fireEvent.pointerUp(el, { pointerType: "touch" });
    click(el, "touch");
    // Touch fires pointerleave once the finger lifts.
    fireEvent.pointerLeave(gridEl(), { pointerType: "touch" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }

  async function settle() {
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });
  }

  it("reveals the tapped day's date and count", async () => {
    renderHeatmap(cells);
    await settle();
    expect(shown()).not.toContain("5 commits");

    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("Sep 22");
    expect(shown()).toContain("5 commits");
  });

  it("moves the readout when another day is tapped", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-21"));
    expect(shown()).toContain("Sep 21");
    expect(shown()).toContain("2 commits");
    const anchor = document.querySelector<HTMLElement>(
      '[data-testid="pulse-heatmap-tooltip-anchor"]'
    )!;
    const before = anchor.style.top;

    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("Sep 22");
    expect(shown()).toContain("5 commits");
    expect(shown()).not.toContain("Sep 21");
    expect(shown()).not.toContain("2 commits");
    expect(anchor.style.top).not.toBe(before);
  });

  it("follows a run of taps: open, replace, replace, close", async () => {
    renderHeatmap(cells);
    await settle();
    const first = cellByDate("2026-09-21");
    const second = cellByDate("2026-09-22");

    await tap(first);
    expect(shown()).toContain("2 commits");
    await tap(second);
    expect(shown()).toContain("5 commits");
    expect(shown()).not.toContain("2 commits");
    await tap(first);
    expect(shown()).toContain("2 commits");
    expect(shown()).not.toContain("5 commits");
    await tap(first);
    expect(shown()).not.toContain("2 commits");
  });

  // jsdom has no layout, so say what the finger landed on, top to bottom.
  async function tapCard(card: Element, hit: Element[]) {
    const elementsFromPoint = vi.fn((_x: number, _y: number) => hit);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPoint,
    });
    try {
      fireEvent.pointerDown(card, { pointerType: "touch" });
      fireEvent(
        card,
        new PointerEvent("click", {
          bubbles: true,
          cancelable: true,
          pointerType: "touch",
          clientX: 12,
          clientY: 34,
        })
      );
      // The day is read where the finger came down.
      expect(elementsFromPoint).toHaveBeenCalledWith(12, 34);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    } finally {
      Reflect.deleteProperty(document, "elementsFromPoint");
    }
  }

  const cardOf = (text: string) => screen.getByText(text).closest<HTMLElement>("[data-side]")!;

  it("reads a tap on the card as a tap on the day beneath it", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    await tapCard(cardOf("5 commits"), [cardOf("5 commits"), cellByDate("2026-09-21"), gridEl()]);
    expect(shown()).toContain("2 commits");
    expect(shown()).not.toContain("5 commits");
  });

  it("reads it the same when keyboard focus, not a tap, owns the readout", async () => {
    renderHeatmap(cells);
    await settle();
    const focused = cellByDate("2026-09-22");
    act(() => {
      focused.focus();
      fireEvent.focus(focused);
    });
    expect(shown()).toContain("5 commits");

    await tapCard(cardOf("5 commits"), [cardOf("5 commits"), cellByDate("2026-09-21"), gridEl()]);
    expect(shown()).toContain("2 commits");
    expect(shown()).not.toContain("5 commits");
  });

  it("closes when a tap on the card covers no day", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    await tapCard(cardOf("5 commits"), [cardOf("5 commits"), document.body]);
    expect(shown()).not.toContain("5 commits");
  });

  it("keeps the open day up while a finger presses another, until the click decides", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-21"));
    expect(shown()).toContain("2 commits");

    // The press alone must not close the readout only for the click to put the
    // new day back a moment later.
    fireEvent.pointerOver(cellByDate("2026-09-22"), { pointerType: "touch" });
    fireEvent.pointerDown(cellByDate("2026-09-22"), { pointerType: "touch" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).toContain("2 commits");
  });

  it("names a quiet day too", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-23"));
    expect(shown()).toContain("No commits");
  });

  it("closes when the open day is tapped again", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    await tap(cell);
    expect(shown()).toContain("5 commits");

    await tap(cell);
    expect(shown()).not.toContain("5 commits");
  });

  it("closes when the tap lands on a space in the grid that is not a day", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    // Friday to Sunday of this week are out of range: space held, no cell.
    const gap = gridEl().querySelector<HTMLElement>("span.shrink-0[aria-hidden]")!;
    expect(gap.hasAttribute("data-cell-date")).toBe(false);
    fireEvent.pointerDown(gap, { pointerType: "touch" });
    click(gap, "touch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("closes when the tap lands outside the grid", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    click(document.body, "touch");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("keeps the readout through the pointerleave a lifted finger fires", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    fireEvent.pointerLeave(gridEl(), { pointerType: "touch" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).toContain("5 commits");
  });

  it("closes on Escape", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("closes when the page scrolls under it", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(shown()).toContain("5 commits");

    fireEvent.scroll(document);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("treats a pen as a pointer: it hovers a day open and a press closes it", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    fireEvent.pointerOver(cell, { pointerType: "pen" });
    expect(shown()).toContain("5 commits");

    fireEvent.pointerDown(cell, { pointerType: "pen" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");

    click(cell, "pen");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("leaves a mouse click closing the readout it opened", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    fireEvent.pointerOver(cell, { pointerType: "mouse" });
    expect(shown()).toContain("5 commits");

    click(cell, "mouse");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("leaves a keyboard activation closing a day a tap had opened", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    await tap(cell);
    expect(shown()).toContain("5 commits");

    // Enter or Space on a button arrives as a click with no pointer type.
    click(cell, "");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).not.toContain("5 commits");
  });

  it("hands the readout to keyboard focus when an arrow key moves off a tapped day", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-21"));
    expect(shown()).toContain("2 commits");

    fireEvent.keyDown(cellByDate("2026-09-21"), { key: "ArrowDown" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(shown()).toContain("5 commits");
    expect(shown()).not.toContain("2 commits");
  });

  it("lets a mouse hover take the readout over from a tap", async () => {
    renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-21"));
    expect(shown()).toContain("2 commits");

    fireEvent.pointerOver(cellByDate("2026-09-22"), { pointerType: "mouse" });
    expect(shown()).toContain("5 commits");
    expect(shown()).not.toContain("2 commits");
  });

  it("keeps a tapped day through focus going nowhere, as when the window loses it", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    await tap(cell);

    fireEvent.blur(cell);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).toContain("5 commits");
  });

  it("closes a tapped day when focus moves to a control outside the grid", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    await tap(cell);
    expect(shown()).toContain("5 commits");

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      fireEvent.blur(cell, { relatedTarget: outside });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(shown()).not.toContain("5 commits");
    } finally {
      outside.remove();
    }
  });

  it("closes on one tap after the window hands focus back to the tapped day", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    await tap(cell);

    fireEvent.blur(cell);
    act(() => {
      fireEvent.focus(cell);
    });
    await tap(cell);
    expect(shown()).not.toContain("5 commits");
  });

  it("lets a tap take over a day a mouse hover has open, and the mouse leaving keeps it", async () => {
    renderHeatmap(cells);
    await settle();
    const cell = cellByDate("2026-09-22");
    fireEvent.pointerOver(cell, { pointerType: "mouse" });
    expect(shown()).toContain("5 commits");

    await tap(cell);
    expect(shown()).toContain("5 commits");
    fireEvent.pointerLeave(gridEl(), { pointerType: "mouse" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(shown()).toContain("5 commits");

    await tap(cell);
    expect(shown()).not.toContain("5 commits");
  });

  it("closes when the tapped day leaves the range", async () => {
    const { rerender } = renderHeatmap(cells);
    await settle();
    await tap(cellByDate("2026-09-22"));
    expect(document.querySelector("[data-side]")).not.toBeNull();

    rerender(
      <TooltipProvider>
        <PulseHeatmap cells={cells.filter((c) => c.date !== "2026-09-22")} rangeDays={60} />
      </TooltipProvider>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    // The card, not just its text: an open card with no day to name sits empty.
    expect(document.querySelector("[data-side]")).toBeNull();
  });
});
