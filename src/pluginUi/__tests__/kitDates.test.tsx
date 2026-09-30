// @vitest-environment jsdom
import { createElement, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { timeAgoTick } from "@/components/PluginKit/PluginKitDates";
import {
  addDays,
  addMonths,
  monthWeeks,
  parseDateText,
  parseRangeText,
  toDateRange,
  toIsoDate,
  todayIso,
  weekday,
} from "@/components/PluginKit/kitDateMath";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function withTooltips(child: ReactNode) {
  return createElement(TooltipProvider, null, child);
}

// Props as untyped plugin JS would pass them: wrong types, unknown values.
function renderLoose<P extends object>(component: ComponentType<P>, looseProps: object) {
  const props: P = JSON.parse("{}");
  // Assigned rather than serialised, so callbacks come through.
  Object.assign(props, looseProps);
  return render(withTooltips(createElement(component, props)));
}

function day(iso: string): HTMLButtonElement {
  const cell = document.querySelector<HTMLButtonElement>(`[data-date="${iso}"]`);
  if (!cell) throw new Error(`no cell for ${iso}`);
  return cell;
}

function captions(): string[] {
  return [...document.querySelectorAll('[role="grid"]')].map(
    (grid) => document.getElementById(grid.getAttribute("aria-labelledby") ?? "")?.textContent ?? ""
  );
}

describe("date math", () => {
  it("accepts only real ISO days", () => {
    expect(toIsoDate("2026-02-28")).toBe("2026-02-28");
    expect(toIsoDate("2026-02-30")).toBeNull();
    expect(toIsoDate("2028-02-29")).toBe("2028-02-29");
    expect(toIsoDate("2026-9-30")).toBeNull();
    expect(toIsoDate(20260930)).toBeNull();
    expect(toDateRange({ start: "2026-09-30", end: "2026-09-01" })).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
    });
    expect(toDateRange({ start: "x", end: "2026-09-01" })).toBeNull();
  });

  it("does day arithmetic on the calendar, not the clock", () => {
    // A daylight-saving change sits in both of these spans in most zones.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 12)).toBe("2027-11-15");
    expect(weekday("2026-09-30")).toBe(3);
    expect(weekday("2026-03-29")).toBe(0);
  });

  it("keeps day arithmetic inside the years an ISO date can name", () => {
    expect(addDays("9999-12-31", 1)).toBe("9999-12-31");
    expect(addDays("9999-12-30", 7)).toBe("9999-12-31");
    expect(addDays("0001-01-01", -1)).toBe("0001-01-01");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  });

  it("displays dates in the calendar and digits the parser reads back", async () => {
    // A Thai locale defaults to the Buddhist calendar (2026 is 2569) and,
    // with this extension, Thai digits; neither can be typed back.
    const Native = Intl.DateTimeFormat;
    class ThaiDefault extends Native {
      constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
        super(locales ?? "th-TH-u-nu-thai", options);
      }
    }
    const intl: typeof Intl = Object.create(Intl);
    Object.defineProperty(intl, "DateTimeFormat", { value: ThaiDefault });
    vi.stubGlobal("Intl", intl);
    vi.resetModules();
    try {
      const math = await import("@/components/PluginKit/kitDateMath");
      const shown = math.formatFieldDate("2026-09-30");
      expect(shown).toContain("2026");
      expect(shown).not.toContain("2569");
      expect(math.formatDayNumber("2026-09-30")).toBe("30");
      expect(math.parseDateText(shown, "2026-01-01")).toBe("2026-09-30");
      expect(math.parseDateText("30 กันยายน 2026", "2026-01-01")).toBe("2026-09-30");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("lays a month out in six weeks from the given week start", () => {
    const sundayFirst = monthWeeks("2026-09", 0);
    expect(sundayFirst).toHaveLength(6);
    // 1 September 2026 is a Tuesday.
    expect(sundayFirst[0]!.slice(0, 3)).toEqual([null, null, "2026-09-01"]);
    const mondayFirst = monthWeeks("2026-09", 1);
    expect(mondayFirst[0]!.slice(0, 2)).toEqual([null, "2026-09-01"]);
  });

  it("parses typed dates leniently", () => {
    const today = "2026-06-15";
    expect(parseDateText(" 2026-09-30 ", today)).toBe("2026-09-30");
    expect(parseDateText("2026/9/3", today)).toBe("2026-09-03");
    expect(parseDateText("20260930", today)).toBe("2026-09-30");
    expect(parseDateText("Sep 30, 2026", today)).toBe("2026-09-30");
    expect(parseDateText("30 September 2026", today)).toBe("2026-09-30");
    expect(parseDateText("sept 30th", today)).toBe("2026-09-30");
    expect(parseDateText("2026-02-30", today)).toBeNull();
    expect(parseDateText("tomorrow-ish", today)).toBeNull();
    expect(parseDateText("", today)).toBeNull();
  });

  it("parses typed ranges in either order", () => {
    const today = "2026-06-15";
    expect(parseRangeText("2026-09-01 – 2026-09-07", today)).toEqual({
      start: "2026-09-01",
      end: "2026-09-07",
    });
    expect(parseRangeText("2026-09-07 to 2026-09-01", today)).toEqual({
      start: "2026-09-01",
      end: "2026-09-07",
    });
    expect(parseRangeText("2026-09-01", today)).toEqual({
      start: "2026-09-01",
      end: "2026-09-01",
    });
    expect(parseRangeText("2026-09-01 – nope", today)).toBeNull();
  });
});

describe("Calendar", () => {
  it("draws a month grid with the selection, weekday headers and a today mark", () => {
    const today = todayIso(Date.now());
    renderLoose(kit.Calendar, { defaultMonth: today.slice(0, 7), "data-testid": "cal" });
    expect(screen.getByTestId("cal").getAttribute("data-slot")).toBe("calendar");
    expect(day(today).getAttribute("aria-current")).toBe("date");
    expect(document.querySelectorAll('[role="grid"] th[scope="col"]')).toHaveLength(7);

    cleanup();
    renderLoose(kit.Calendar, { value: "2026-09-30", weekStartsOn: 1 });
    expect(captions()).toEqual(["September 2026"]);
    const selected = day("2026-09-30");
    expect(selected.closest("td")?.getAttribute("aria-selected")).toBe("true");
    expect(selected.tabIndex).toBe(0);
    expect(selected.getAttribute("aria-label")).toContain("2026");
    expect(day("2026-09-29").tabIndex).toBe(-1);
    // Monday first: the header row starts on Monday.
    expect(document.querySelector("th")?.getAttribute("abbr")).toBe("Monday");
    // Selection is the neutral inverse fill, never accent.
    expect(selected.className).toContain("bg-text-primary");
    expect(selected.className).not.toContain("bg-accent");
  });

  it("moves by day, week, month, year and to the week's ends from the keyboard", () => {
    renderLoose(kit.Calendar, { defaultValue: "2026-09-30", weekStartsOn: 1 });
    const start = day("2026-09-30");
    start.focus();
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(day("2026-10-01"));
    expect(captions()).toEqual(["October 2026"]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(day("2026-09-24"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(day("2026-09-21"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(day("2026-09-27"));
    fireEvent.keyDown(document.activeElement!, { key: "PageDown" });
    expect(document.activeElement).toBe(day("2026-10-27"));
    fireEvent.keyDown(document.activeElement!, { key: "PageUp", shiftKey: true });
    expect(document.activeElement).toBe(day("2025-10-27"));
    expect(captions()).toEqual(["October 2025"]);
  });

  it("stops the keyboard and the month arrows at the last ISO day", () => {
    renderLoose(kit.Calendar, { defaultValue: "9999-12-31" });
    const last = day("9999-12-31");
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowRight" });
    expect(document.activeElement).toBe(day("9999-12-31"));
    expect(captions()).toEqual(["December 9999"]);
    const next = screen.getByRole("button", { name: "Next month" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });

  it("chooses a day on click and reports it as ISO", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.Calendar, { defaultMonth: "2026-09", onValueChange });
    fireEvent.click(day("2026-09-15"));
    expect(onValueChange).toHaveBeenCalledWith("2026-09-15");
    expect(day("2026-09-15").closest("td")?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps disabled days and days outside min/max from being chosen", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.Calendar, {
      defaultMonth: "2026-09",
      min: "2026-09-10",
      max: "2026-09-20",
      isDateDisabled: (iso: string) => iso === "2026-09-15",
      onValueChange,
    });
    expect(day("2026-09-15").getAttribute("aria-disabled")).toBe("true");
    expect(day("2026-09-05").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(day("2026-09-15"));
    fireEvent.click(day("2026-09-05"));
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Previous month" }).hasAttribute("disabled")).toBe(
      true
    );
    expect(screen.getByRole("button", { name: "Next month" }).hasAttribute("disabled")).toBe(true);
    // The keyboard stops at the bounds.
    const edge = day("2026-09-20");
    edge.focus();
    fireEvent.keyDown(edge, { key: "PageDown" });
    expect(document.activeElement).toBe(day("2026-09-20"));
  });

  it("picks a range with two presses in either order", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.Calendar, {
      mode: "range",
      defaultMonth: "2026-09",
      numberOfMonths: 2,
      onValueChange,
    });
    expect(captions()).toEqual(["September 2026", "October 2026"]);
    fireEvent.click(day("2026-10-03"));
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.pointerEnter(day("2026-09-28"));
    fireEvent.click(day("2026-09-28"));
    expect(onValueChange).toHaveBeenCalledWith({ start: "2026-09-28", end: "2026-10-03" });
    const inside = day("2026-10-01").closest("td")!;
    expect(inside.getAttribute("aria-selected")).toBe("true");
    expect(inside.className).toContain("bg-overlay-selected");
  });

  it("follows a controlled month", () => {
    const onMonthChange = vi.fn();
    renderLoose(kit.Calendar, { month: "2026-02", onMonthChange });
    expect(captions()).toEqual(["February 2026"]);
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(onMonthChange).toHaveBeenCalledWith("2026-03");
    expect(captions()).toEqual(["February 2026"]);
  });

  it("degrades bad props instead of throwing", () => {
    expect(() =>
      renderLoose(kit.Calendar, {
        mode: "sideways",
        value: 20260930,
        min: "soon",
        max: { year: 2026 },
        weekStartsOn: 9,
        numberOfMonths: 7,
        month: "2026-13",
        isDateDisabled: () => {
          throw new Error("plugin bug");
        },
        onValueChange: "nope",
      })
    ).not.toThrow();
    expect(document.querySelectorAll('[role="grid"]')).toHaveLength(1);
    const first = document.querySelector<HTMLButtonElement>("[data-date]")!;
    expect(first.getAttribute("aria-disabled")).toBeNull();
    expect(() => fireEvent.click(first)).not.toThrow();
  });
});

describe("DatePicker", () => {
  it("shows the value, takes typed dates on Enter and reports ISO", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DatePicker, {
      defaultValue: "2026-09-30",
      onValueChange,
      "aria-label": "Due date",
    });
    const input = screen.getByRole("textbox", { name: "Due date" }) as HTMLInputElement;
    expect(input.value).toContain("2026");
    fireEvent.change(input, { target: { value: "2026-10-05" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("2026-10-05");
    expect(input.value).not.toBe("2026-10-05");
    expect(input.value).toContain("5");
  });

  it("marks text that is not an allowed date invalid and keeps the value", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DatePicker, {
      value: "2026-09-30",
      max: "2026-12-31",
      onValueChange,
      "aria-label": "Due date",
    });
    const input = screen.getByRole("textbox", { name: "Due date" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not a date" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "2027-01-01" } });
    fireEvent.blur(input);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.value).toContain("2026");
  });

  it("clears to null, or not at all when required", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DatePicker, {
      defaultValue: "2026-09-30",
      onValueChange,
      "aria-label": "Due date",
      name: "due",
    });
    const hidden = document.querySelector<HTMLInputElement>('input[type="hidden"][name="due"]');
    expect(hidden?.value).toBe("2026-09-30");
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(onValueChange).toHaveBeenCalledWith(null);
    expect(hidden?.value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear date" })).toBeNull();

    cleanup();
    renderLoose(kit.DatePicker, { value: "2026-09-30", required: true, "aria-label": "Due" });
    expect(screen.queryByRole("button", { name: "Clear date" })).toBeNull();
  });

  it("joins a FormField", () => {
    render(
      withTooltips(
        createElement(kit.FormField, {
          label: "Due date",
          description: "When it ships",
          children: createElement(kit.DatePicker, { value: null }),
        })
      )
    );
    const input = screen.getByRole("textbox", { name: "Due date" });
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("opens a calendar on the chosen day and closes on a pick", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DatePicker, {
      defaultValue: "2026-09-30",
      onValueChange,
      "aria-label": "Due date",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose date" }));
    });
    const dialog = await screen.findByRole("dialog", { name: "Choose date" });
    expect(dialog.querySelector('[data-date="2026-09-30"]')?.getAttribute("tabindex")).toBe("0");
    await act(async () => {
      fireEvent.click(day("2026-09-12"));
    });
    expect(onValueChange).toHaveBeenCalledWith("2026-09-12");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hands focus back to the input when Alt+Down opened the calendar", async () => {
    renderLoose(kit.DatePicker, { defaultValue: "2026-09-30", "aria-label": "Due date" });
    const input = screen.getByRole("textbox", { name: "Due date" });
    input.focus();
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    });
    await screen.findByRole("dialog", { name: "Choose date" });
    expect(document.activeElement).toBe(day("2026-09-30"));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    // Radix hands focus back a task after the panel unmounts.
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("degrades bad props instead of throwing", () => {
    expect(() =>
      renderLoose(kit.DatePicker, {
        value: { day: 1 },
        min: 5,
        clearable: "yes",
        density: "huge",
        placeholder: 42,
        onValueChange: 3,
        isDateDisabled: "no",
      })
    ).not.toThrow();
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Choose a date");
  });
});

describe("DateRangePicker", () => {
  it("takes a typed range and a preset", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateRangePicker, {
      defaultValue: null,
      onValueChange,
      "aria-label": "Period",
      presets: [
        { label: "First week", range: { start: "2026-09-01", end: "2026-09-07" } },
        { label: "Broken", range: { start: "x" } },
      ],
    });
    const input = screen.getByRole("textbox", { name: "Period" });
    fireEvent.change(input, { target: { value: "2026-09-10 to 2026-09-03" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith({ start: "2026-09-03", end: "2026-09-10" });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose dates" }));
    });
    await screen.findByRole("dialog", { name: "Choose dates" });
    expect(captions()).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Broken" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "First week" }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith({ start: "2026-09-01", end: "2026-09-07" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables a preset whose range min, max or isDateDisabled forbids", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateRangePicker, {
      defaultValue: null,
      onValueChange,
      "aria-label": "Period",
      min: "2026-09-05",
      isDateDisabled: (date: string) => date === "2026-09-20",
      presets: [
        { label: "Too early", range: { start: "2026-09-01", end: "2026-09-07" } },
        { label: "Ends on a blocked day", range: { start: "2026-09-14", end: "2026-09-20" } },
        { label: "Allowed", range: { start: "2026-09-07", end: "2026-09-13" } },
      ],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose dates" }));
    });
    await screen.findByRole("dialog", { name: "Choose dates" });
    const early = screen.getByRole("button", { name: "Too early" }) as HTMLButtonElement;
    const blocked = screen.getByRole("button", {
      name: "Ends on a blocked day",
    }) as HTMLButtonElement;
    expect(early.disabled).toBe(true);
    expect(blocked.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(early);
    });
    expect(onValueChange).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Allowed" }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith({ start: "2026-09-07", end: "2026-09-13" });
  });
});

describe("TimeAgo", () => {
  it("renders the age in a <time> with its instant", () => {
    const at = Date.now() - 5 * 60_000 - 1000;
    renderLoose(kit.TimeAgo, { value: at, "data-testid": "age", prefix: "Updated " });
    const time = screen.getByTestId("age");
    expect(time.tagName).toBe("TIME");
    expect(time.textContent).toBe("Updated 5m ago");
    expect(time.getAttribute("datetime")).toBe(new Date(at).toISOString());
  });

  it("spells the age out when verbose and puts the date in a title without a tooltip", () => {
    const at = new Date(Date.now() - 3 * 3_600_000 - 1000);
    renderLoose(kit.TimeAgo, { value: at, verbose: true, tooltip: false, "data-testid": "age" });
    const time = screen.getByTestId("age");
    expect(time.textContent).toBe("3 hours ago");
    expect(time.getAttribute("title")).toBe(at.toLocaleString());
  });

  it("reads Unknown for a bad value", () => {
    renderLoose(kit.TimeAgo, { value: { when: "now" }, "data-testid": "age" });
    const time = screen.getByTestId("age");
    expect(time.textContent).toBe("Unknown");
    expect(time.hasAttribute("datetime")).toBe(false);
  });

  it("ticks less often as the time recedes", () => {
    expect(timeAgoTick(10_000, true)).toBe(1000);
    expect(timeAgoTick(10_000, false)).toBe(30_000);
    expect(timeAgoTick(-10_000, true)).toBe(1000);
    expect(timeAgoTick(2 * 3_600_000, false)).toBe(5 * 60_000);
    expect(timeAgoTick(3 * 86_400_000, false)).toBe(3_600_000);
  });

  it("keeps itself current", () => {
    vi.useFakeTimers();
    const at = Date.now() - 50_000;
    renderLoose(kit.TimeAgo, { value: at, "data-testid": "age" });
    const time = screen.getByTestId("age");
    expect(time.textContent).toBe("just now");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(time.textContent).toBe("1m ago");
  });
});
