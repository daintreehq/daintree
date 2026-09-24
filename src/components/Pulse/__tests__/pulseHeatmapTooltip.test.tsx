// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeatCell } from "@shared/types";
import { PulseHeatmap } from "../PulseHeatmap";
import { TooltipProvider } from "../../ui/tooltip";

const CELLS: HeatCell[] = [
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

describe("PulseHeatmap — a day's tooltip is its readout, not a passing hint", () => {
  it("keeps the focused day's date and count on screen past the app's hint window", async () => {
    render(
      <TooltipProvider>
        <PulseHeatmap cells={CELLS} rangeDays={60} />
      </TooltipProvider>
    );
    // Radix loads lazily; let the loader settle before driving focus.
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    const cell = document.querySelector<HTMLElement>('[data-cell-date="2026-09-22"]')!;
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
