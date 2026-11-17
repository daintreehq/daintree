// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { choiceFromCron } from "../cadenceChoice";
import { CadencePicker } from "../CadencePicker";
import { formatNextRunRelative, formatRunColumn } from "../runTime";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 11, 31, 12);
const RUNS = [NOW + 9 * HOUR, NOW + 33 * HOUR, NOW + 57 * HOUR];
const ZONE = "Asia/Tokyo";

function stubMachineZone(timeZone: string) {
  let reported = timeZone;
  const real = Intl.DateTimeFormat.prototype.resolvedOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat
  ) {
    return { ...real.call(this), timeZone: reported };
  });
  return (next: string) => {
    reported = next;
  };
}

function picker(now: number) {
  return (
    <CadencePicker
      choice={choiceFromCron("0 9 * * *")}
      onChange={() => {}}
      errorRowId="cadence"
      error={undefined}
      onCustomBlur={() => {}}
      words="Every day at 9:00 AM"
      runs={RUNS}
      timeZone={ZONE}
      now={now}
    />
  );
}

function preview(): HTMLElement {
  return screen.getByTestId("schedule-cadence-preview");
}

function shownRows(): string[][] {
  return Array.from(preview().querySelectorAll("ol > li"), (row) =>
    Array.from(row.querySelectorAll("span"), (cell) => cell.textContent ?? "")
  );
}

function expectedRows(now: number): string[][] {
  return formatRunColumn(RUNS, ZONE, now).rows.map((row, index) =>
    index === 0
      ? [row.day, row.time, formatNextRunRelative(row.at, now, ZONE)]
      : [row.day, row.time]
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CadencePicker preview", () => {
  it("lists each run's day and time in order, with how soon only on the first", () => {
    stubMachineZone(ZONE);
    render(picker(NOW));
    expect(shownRows()).toEqual(expectedRows(NOW));
    expect(preview().textContent).toContain(`Times in ${ZONE}`);
    expect(preview().textContent).not.toContain("where this schedule was made");
  });

  it("names the schedule's zone in the caption and the times together once the machine moves", () => {
    const move = stubMachineZone(ZONE);
    const { rerender } = render(picker(NOW));
    const before = shownRows();

    move("America/New_York");
    rerender(picker(NOW + 60_000));
    expect(preview().textContent).toContain(`Times in ${ZONE}, where this schedule was made`);
    expect(shownRows()).toEqual(expectedRows(NOW + 60_000));
    expect(shownRows()[0]?.[1]).not.toBe(before[0]?.[1]);
  });
});
