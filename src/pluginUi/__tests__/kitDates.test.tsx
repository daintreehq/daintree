// @vitest-environment jsdom
import { createElement, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { timeAgoTick } from "@/components/PluginKit/PluginKitDates";
import {
  addDays,
  addMonths,
  fitMonthsToMax,
  formatEditableRange,
  formatFieldRange,
  monthWeeks,
  parseDateText,
  parseRangeText,
  toDateRange,
  toIsoDate,
  todayIso,
  weekday,
} from "@/pluginUi/dateMath";
import { TooltipProvider } from "@/components/ui/tooltip";
import { inputVariants } from "@/components/ui/input";
import { selectTriggerVariants } from "@/components/ui/select";

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
      const math = await import("@/pluginUi/dateMath");
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

  it("says each part two range ends share once, and edits the range in full", () => {
    const month = (iso: string) =>
      new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(
        new Date(`${iso}T00:00:00Z`)
      );
    const count = (text: string, part: string) => text.split(part).length - 1;
    const sameMonth = { start: "2026-09-24", end: "2026-09-30" };
    const sameYear = { start: "2026-09-24", end: "2026-10-03" };
    const twoYears = { start: "2026-12-28", end: "2027-01-03" };

    expect(count(formatFieldRange(sameMonth), "2026")).toBe(1);
    expect(count(formatFieldRange(sameMonth), month("2026-09-24"))).toBe(1);
    expect(count(formatFieldRange(sameYear), "2026")).toBe(1);
    expect(count(formatFieldRange(sameYear), month("2026-10-03"))).toBe(1);
    expect(count(formatFieldRange(twoYears), "2026")).toBe(1);
    expect(count(formatFieldRange(twoYears), "2027")).toBe(1);
    // Shorter than both ends written out, whenever a part is shared.
    expect(formatFieldRange(sameMonth).length).toBeLessThan(formatEditableRange(sameMonth).length);
    expect(formatFieldRange({ start: "2026-09-30", end: "2026-09-30" })).toBe(
      formatEditableRange({ start: "2026-09-30", end: "2026-09-30" }).split(" – ")[0]
    );

    // The form a user edits is the one the parser reads back.
    for (const range of [sameMonth, sameYear, twoYears]) {
      expect(parseRangeText(formatEditableRange(range), "2020-01-01")).toEqual(range);
    }
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

  it("sizes its box as the kit Input and Select do at both densities", () => {
    const classes = (value: string) => value.split(/\s+/).filter(Boolean);
    const vertical = (value: string) => classes(value).filter((name) => /^(py|h)-/.test(name));
    const typeSize = (value: string) =>
      classes(value).filter((name) => /^text-(xs|sm|base)$/.test(name));

    renderLoose(kit.DatePicker, {
      value: "2026-09-30",
      "aria-label": "Due",
      "data-testid": "field",
    });
    let box = screen.getByTestId("field");
    let input = screen.getByRole("textbox", { name: "Due" });
    const inputDefault = inputVariants({ density: "default" });
    // A percentage height on the text resolves short against the box's auto
    // height, so the text sizes the box through the Input's own padding.
    expect(classes(input.className).some((name) => /^h-/.test(name))).toBe(false);
    expect(vertical(input.className)).toEqual(vertical(inputDefault));
    expect(typeSize(box.className)).toEqual(typeSize(inputDefault));
    expect(vertical(box.className)).toEqual([]);

    cleanup();
    renderLoose(kit.DateRangePicker, {
      value: { start: "2026-09-01", end: "2026-09-30" },
      density: "compact",
      "aria-label": "Period",
      "data-testid": "field",
    });
    box = screen.getByTestId("field");
    input = screen.getByRole("textbox", { name: "Period" });
    const compactTrigger = selectTriggerVariants({ density: "compact" });
    expect(classes(input.className).some((name) => /^h-/.test(name))).toBe(false);
    // The compact control step every compact field shares.
    expect(vertical(box.className)).toEqual(
      vertical(compactTrigger).filter((n) => n.startsWith("h-"))
    );
    expect(typeSize(box.className)).toEqual(typeSize(compactTrigger));
  });

  it("keeps its calendar modal: focus stays inside and Escape hands it back", async () => {
    const { container } = renderLoose(kit.DatePicker, {
      defaultValue: "2026-09-30",
      "aria-label": "Due date",
    });
    const input = screen.getByRole("textbox", { name: "Due date" });
    const trigger = screen.getByRole("button", { name: "Choose date" });
    trigger.focus();
    await act(async () => {
      fireEvent.click(trigger);
    });
    const dialog = await screen.findByRole("dialog", { name: "Choose date" });
    const cell = day("2026-09-30");
    await waitFor(() => expect(document.activeElement).toBe(cell));
    // The day is the panel's last tab stop; Tab wraps to its first, not out.
    await act(async () => {
      fireEvent.keyDown(cell, { key: "Tab" });
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Previous month" }));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(cell);
    // The page behind is out of reach: hidden from assistive tech, and focus
    // sent there comes straight back without closing the calendar.
    expect(container.getAttribute("aria-hidden")).toBe("true");
    await act(async () => {
      input.focus();
    });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("dialog", { name: "Choose date" })).toBe(dialog);
    await act(async () => {
      fireEvent.keyDown(cell, { key: "Escape" });
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.hasAttribute("aria-hidden")).toBe(false);
  });

  it("closes only its calendar on Escape inside a Sheet", async () => {
    // The sheet's scroll shadows measure their body.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const onOpenChange = vi.fn();
    render(
      withTooltips(
        createElement(kit.Sheet, {
          open: true,
          onOpenChange,
          title: "Contract",
          children: createElement(kit.DatePicker, {
            defaultValue: "2026-09-30",
            "aria-label": "Start",
          }),
        })
      )
    );
    const trigger = await screen.findByRole("button", { name: "Choose date" });
    // Let the sheet take its initial focus first, as it does before a user can click.
    const sheet = screen.getByRole("dialog", { name: "Contract" });
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    trigger.focus();
    await act(async () => {
      fireEvent.click(trigger);
    });
    const picker = await screen.findByRole("dialog", { name: "Choose date" });
    const cell = day("2026-09-30");
    await waitFor(() => expect(document.activeElement).toBe(cell));
    await act(async () => {
      fireEvent.keyDown(cell, { key: "Tab" });
    });
    expect(picker.contains(document.activeElement)).toBe(true);
    // Focus sent back into the sheet stays in the calendar layered over it.
    await act(async () => {
      screen.getByRole("textbox", { name: "Start", hidden: true }).focus();
    });
    expect(picker.contains(document.activeElement)).toBe(true);
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole("dialog", { name: "Choose date" })).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
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

  it("shows a range collapsed and ellipsised at rest, and in full while edited", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateRangePicker, {
      defaultValue: { start: "2026-09-24", end: "2026-09-30" },
      onValueChange,
      "aria-label": "Period",
    });
    const input = screen.getByRole("textbox", { name: "Period" }) as HTMLInputElement;
    const range = { start: "2026-09-24", end: "2026-09-30" };
    expect(input.value).toBe(formatFieldRange(range));
    // Too long for the field, it ends in an ellipsis rather than mid-date.
    expect(input.className.split(" ")).toContain("truncate");
    fireEvent.focus(input);
    expect(input.value).toBe(formatEditableRange(range));
    // Editing an end of the full text parses back.
    fireEvent.change(input, { target: { value: input.value.replace("30", "29") } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith({ start: "2026-09-24", end: "2026-09-29" });
    fireEvent.blur(input);
    expect(input.value).toBe(formatFieldRange({ start: "2026-09-24", end: "2026-09-29" }));
  });

  it("shows the month a range ends in when the next one is wholly past max", async () => {
    renderLoose(kit.DateRangePicker, {
      defaultValue: { start: "2026-09-01", end: "2026-09-30" },
      max: "2026-09-30",
      "aria-label": "Period",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose dates" }));
    });
    await screen.findByRole("dialog", { name: "Choose dates" });
    expect(captions()).toEqual(["August 2026", "September 2026"]);
  });
});

describe("fitMonthsToMax", () => {
  it("moves a two-month view back only as far as max and min allow", () => {
    expect(fitMonthsToMax("2026-09", 2, null, "2026-09-30")).toBe("2026-08");
    expect(fitMonthsToMax("2026-09", 2, null, "2026-10-01")).toBe("2026-09");
    expect(fitMonthsToMax("2026-09", 2, null, null)).toBe("2026-09");
    expect(fitMonthsToMax("2026-09", 1, null, "2026-09-30")).toBe("2026-09");
    expect(fitMonthsToMax("2026-09", 2, "2026-09-10", "2026-09-30")).toBe("2026-09");
    expect(fitMonthsToMax("2027-01", 2, null, "2027-01-15")).toBe("2026-12");
  });

  it("keeps a month the plugin named with defaultMonth", () => {
    renderLoose(kit.Calendar, {
      mode: "range",
      defaultMonth: "2026-09",
      numberOfMonths: 2,
      max: "2026-09-30",
    });
    expect(captions()).toEqual(["September 2026", "October 2026"]);
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
