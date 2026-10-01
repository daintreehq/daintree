// @vitest-environment jsdom
import { createElement, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

import * as kit from "@daintreehq/plugin-ui";
import { TooltipProvider } from "@/components/ui/tooltip";
import { normalizeRange, schemaFields } from "@/components/PluginKit/PluginKitPickersForms";
import { hexToHsl, hslToHex, normalizeHex, parseColorText } from "@/components/PluginKit/kitColor";
import {
  formatTimeLabel,
  parseIsoDateTime,
  parseIsoTime,
  timeListOptions,
  timeListStep,
} from "@/components/PluginKit/kitTime";
import { sameFormValue } from "@/pluginUi/form";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function withTooltips(child: ReactNode) {
  return createElement(TooltipProvider, null, child);
}

// Props as untyped plugin JS would pass them: wrong types, unknown values.
function renderLoose<P extends object>(component: ComponentType<P>, looseProps: object) {
  const props: P = JSON.parse("{}");
  Object.assign(props, looseProps);
  return render(withTooltips(createElement(component, props)));
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe("colour text", () => {
  it("normalises hex in its short and long forms, with or without the #", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("2f81F7")).toBe("#2f81f7");
    expect(normalizeHex("#12345")).toBeNull();
    expect(normalizeHex(42)).toBeNull();
  });

  it("reads hex, rgb() and hsl() and refuses anything else", () => {
    expect(parseColorText(" #f00 ")).toBe("#ff0000");
    expect(parseColorText("rgb(47, 129, 247)")).toBe("#2f81f7");
    expect(parseColorText("rgb(47 129 247 / 50%)")).toBe("#2f81f7");
    expect(parseColorText("hsl(0, 100%, 50%)")).toBe("#ff0000");
    expect(parseColorText("hsl(120deg 100% 25%)")).toBe("#008000");
    expect(parseColorText("rgb(300, 0, 0)")).toBeNull();
    expect(parseColorText("red")).toBeNull();
  });

  it("round-trips HSL", () => {
    expect(hexToHsl("#ff0000")).toEqual({ h: 0, s: 100, l: 50 });
    expect(hexToHsl("#808080")).toEqual({ h: 0, s: 0, l: 50 });
    expect(hslToHex(210, 50, 40)).toBe("#336699");
  });
});

describe("time text", () => {
  it("reads HH:mm (dropping seconds) and refuses impossible times", () => {
    expect(parseIsoTime("09:30")).toBe(570);
    expect(parseIsoTime("23:59:59")).toBe(1439);
    expect(parseIsoTime("24:00")).toBeNull();
    expect(parseIsoTime("9:30")).toBeNull();
    expect(parseIsoDateTime("2026-09-30T14:05")).toEqual({ date: "2026-09-30", minutes: 845 });
    expect(parseIsoDateTime("2026-02-30T14:05")).toBeNull();
    expect(parseIsoDateTime("2026-09-30")).toBeNull();
  });

  it("spaces the list by a multiple of the step of at least 15 minutes, held to the bounds", () => {
    expect(timeListStep(1)).toBe(15);
    expect(timeListStep(7)).toBe(21);
    expect(timeListStep(30)).toBe(30);
    expect(timeListOptions(30, 9 * 60, 10 * 60)).toEqual([540, 570, 600]);
  });

  it("says a time on either clock", () => {
    expect(formatTimeLabel(0, 24)).toBe("00:00");
    expect(formatTimeLabel(13 * 60 + 5, 12)).toMatch(/^1:05 /);
    expect(formatTimeLabel(0, 12)).toMatch(/^12:00 /);
  });
});

describe("ColorSwatch", () => {
  it("is a named picture, or a button when it has an onClick", () => {
    const onClick = vi.fn();
    renderLoose(kit.ColorSwatch, { color: "2F81F7" });
    expect(screen.getByRole("img", { name: "#2F81F7" }).style.backgroundColor).not.toBe("");
    cleanup();
    renderLoose(kit.ColorSwatch, { color: "#f00", onClick, "aria-label": "Red", selected: true });
    const button = screen.getByRole("button", { name: "Red" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it("draws an empty chip for a colour that is not hex", () => {
    renderLoose(kit.ColorSwatch, { color: "tomato" });
    expect(screen.getByRole("img", { name: "No colour" })).toBeTruthy();
  });
});

describe("ColorPicker", () => {
  const swatches = [
    { value: "#e5534b", label: "Red" },
    "#57ab5a",
    { value: "#539bf5", label: "Blue" },
    "not a colour",
    "#E5534B",
  ];

  it("shows the colour on the trigger and picks a swatch, closing the popover", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.ColorPicker, {
      defaultValue: "#539BF5",
      swatches,
      onValueChange,
      "aria-label": "Label colour",
    });
    const trigger = screen.getByRole("button", { name: "Label colour" });
    expect(trigger.textContent).toContain("#539bf5");
    expect(trigger.textContent).toContain("Blue");
    await act(async () => {
      fireEvent.click(trigger);
    });
    const dialog = await screen.findByRole("dialog", { name: "Choose a colour" });
    const radios = dialog.querySelectorAll('[role="radio"]');
    // The bad and the repeated swatch are dropped.
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Red" }));
    });
    expect(onValueChange).toHaveBeenCalledWith("#e5534b");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the choice with the arrow keys without closing", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.ColorPicker, {
      value: "#e5534b",
      swatches,
      onValueChange,
      defaultOpen: true,
      "aria-label": "Label colour",
    });
    const red = await screen.findByRole("radio", { name: "Red" });
    expect(red.tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "Blue" }).tabIndex).toBe(-1);
    red.focus();
    fireEvent.keyDown(red, { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenCalledWith("#57ab5a");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("takes a typed rgb() or hsl() colour, and marks text it cannot read", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.ColorPicker, {
      defaultValue: "#539bf5",
      swatches,
      onValueChange,
      defaultOpen: true,
      "aria-label": "Label colour",
    });
    const field = (await screen.findByRole("textbox", {
      name: "Hex, RGB or HSL colour",
    })) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "rgb(255, 0, 0)" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith("#ff0000");
    fireEvent.change(field, { target: { value: "not a colour" } });
    fireEvent.blur(field);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("#FF0000");
  });

  it("leaves the custom controls out when allowCustom is false", async () => {
    renderLoose(kit.ColorPicker, {
      swatches,
      allowCustom: false,
      defaultOpen: true,
      "aria-label": "Label colour",
    });
    await screen.findByRole("radio", { name: "Red" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("joins a FormField and submits its hex under a name", () => {
    renderLoose(kit.FormField, {
      label: "Colour",
      error: "Pick a colour",
      children: createElement(kit.ColorPicker, { name: "color", value: "#57ab5a", swatches }),
    });
    const trigger = screen.getByRole("button", { name: "Colour" });
    expect(trigger.getAttribute("aria-invalid")).toBe("true");
    const hidden = document.querySelector<HTMLInputElement>('input[name="color"]');
    expect(hidden?.value).toBe("#57ab5a");
  });
});

function segment(name: string): HTMLElement {
  return screen.getByRole("spinbutton", { name });
}

describe("TimePicker", () => {
  it("shows the value in segments and steps the minute by step", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "09:30",
      step: 15,
      hourCycle: 24,
      onValueChange,
      "aria-label": "Start",
    });
    expect(screen.getByRole("group", { name: "Start" })).toBeTruthy();
    expect(segment("Hour").textContent).toBe("09");
    expect(segment("Minute").textContent).toBe("30");
    fireEvent.keyDown(segment("Minute"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("09:45");
    fireEvent.keyDown(segment("Minute"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("09:00");
    fireEvent.keyDown(segment("Hour"), { key: "ArrowDown" });
    expect(onValueChange).toHaveBeenLastCalledWith("08:00");
  });

  it("takes typed digits and moves on once the segment is full", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, { hourCycle: 24, onValueChange, "aria-label": "Start" });
    const hour = segment("Hour");
    hour.focus();
    fireEvent.keyDown(hour, { key: "1" });
    fireEvent.keyDown(hour, { key: "4" });
    expect(document.activeElement).toBe(segment("Minute"));
    fireEvent.keyDown(segment("Minute"), { key: "0" });
    fireEvent.keyDown(segment("Minute"), { key: "5" });
    expect(onValueChange).toHaveBeenLastCalledWith("14:05");
  });

  it("uses AM/PM segments on a 12-hour clock", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "13:15",
      hourCycle: 12,
      onValueChange,
      "aria-label": "Start",
    });
    expect(segment("Hour").textContent).toBe("1");
    fireEvent.keyDown(segment("AM/PM"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("01:15");
  });

  it("marks a time outside min and max invalid and keeps the value", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      value: "09:00",
      min: "09:00",
      max: "17:00",
      hourCycle: 24,
      onValueChange,
      "aria-label": "Start",
    });
    fireEvent.keyDown(segment("Hour"), { key: "ArrowDown" });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Start" }).getAttribute("aria-invalid")).toBe("true");
  });

  it("clears with Backspace on every segment, and with the clear button", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "09:30",
      hourCycle: 24,
      onValueChange,
      "aria-label": "Start",
    });
    fireEvent.keyDown(segment("Hour"), { key: "Backspace" });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(segment("Minute"), { key: "Backspace" });
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    cleanup();
    renderLoose(kit.TimePicker, {
      defaultValue: "09:30",
      hourCycle: 24,
      onValueChange,
      "aria-label": "Start",
    });
    onValueChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear time" }));
    expect(onValueChange).toHaveBeenCalledWith(null);
  });

  it("holds a leading 0 on a 12-hour clock until the hour is whole", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "13:15",
      hourCycle: 12,
      onValueChange,
      "aria-label": "Start",
    });
    const hour = segment("Hour");
    hour.focus();
    fireEvent.keyDown(hour, { key: "0" });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(hour.textContent).toBe("0");
    fireEvent.keyDown(hour, { key: "9" });
    expect(onValueChange).toHaveBeenLastCalledWith("21:15");
  });

  it("drops held digits when the value is replaced from outside", () => {
    const view = renderLoose(kit.TimePicker, {
      value: "13:15",
      hourCycle: 12,
      "aria-label": "Start",
    });
    fireEvent.keyDown(segment("Hour"), { key: "0" });
    expect(segment("Hour").textContent).toBe("0");
    view.rerender(
      withTooltips(
        createElement(kit.TimePicker, { value: "16:45", hourCycle: 12, "aria-label": "Start" })
      )
    );
    expect(segment("Hour").textContent).toBe("4");
  });

  it("puts a required time back when it is emptied and left", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "09:30",
      required: true,
      hourCycle: 24,
      name: "start",
      onValueChange,
      "aria-label": "Start",
    });
    fireEvent.keyDown(segment("Hour"), { key: "Backspace" });
    fireEvent.keyDown(segment("Minute"), { key: "Backspace" });
    expect(segment("Minute").textContent).toBe("––");
    fireEvent.blur(screen.getByRole("group", { name: "Start" }));
    expect(segment("Hour").textContent).toBe("09");
    expect(onValueChange).not.toHaveBeenCalled();
    expect(segment("Hour").getAttribute("aria-required")).toBe("true");
  });

  it("drops a half-typed edit when the value is replaced from outside", () => {
    const view = renderLoose(kit.TimePicker, {
      value: "09:30",
      hourCycle: 24,
      "aria-label": "Start",
    });
    fireEvent.keyDown(segment("Minute"), { key: "Backspace" });
    expect(segment("Minute").textContent).toBe("––");
    view.rerender(
      withTooltips(
        createElement(kit.TimePicker, { value: "11:00", hourCycle: 24, "aria-label": "Start" })
      )
    );
    expect(segment("Hour").textContent).toBe("11");
    expect(segment("Minute").textContent).toBe("00");
  });

  it("submits an enclosing form on Enter and reports leaving the field", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    const onBlur = vi.fn();
    const { container } = render(
      withTooltips(
        createElement(
          "form",
          { onSubmit },
          createElement(kit.TimePicker, {
            defaultValue: "09:30",
            hourCycle: 24,
            onBlur,
            "aria-label": "Start",
          }),
          createElement("button", { type: "button" }, "Elsewhere")
        )
      )
    );
    fireEvent.keyDown(segment("Hour"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const field = container.querySelector('[data-slot="time-picker"]')!;
    fireEvent.blur(segment("Hour"), { relatedTarget: segment("Minute") });
    expect(onBlur).not.toHaveBeenCalled();
    fireEvent.blur(field.querySelector('[data-segment="minute"]')!, {
      relatedTarget: screen.getByRole("button", { name: "Elsewhere" }),
    });
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("opens a list of times in range and picks one", async () => {
    const onValueChange = vi.fn();
    renderLoose(kit.TimePicker, {
      defaultValue: "09:30",
      min: "09:00",
      max: "10:00",
      step: 30,
      hourCycle: 24,
      onValueChange,
      "aria-label": "Start",
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose time" }));
    });
    const list = await screen.findByRole("listbox", { name: "Times" });
    const options = [...list.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(["09:00", "09:30", "10:00"]);
    expect(list.getAttribute("aria-activedescendant")).toContain("-1");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
    });
    expect(onValueChange).toHaveBeenCalledWith("10:00");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ignores a value that is not a time", () => {
    renderLoose(kit.TimePicker, { value: "noon", hourCycle: 24, "aria-label": "Start" });
    expect(segment("Hour").getAttribute("aria-valuetext")).toBe("Empty");
  });
});

describe("DateTimePicker", () => {
  it("shows a date and a time as one value and names the zone", () => {
    renderLoose(kit.DateTimePicker, {
      defaultValue: "2026-09-30T14:05",
      hourCycle: 24,
      timeZone: "UTC",
      "aria-label": "Starts",
    });
    const group = screen.getByRole("group", { name: "Starts" });
    expect(screen.getByRole("textbox", { name: "Date" })).toBeTruthy();
    expect(segment("Hour").textContent).toBe("14");
    expect(group.textContent).toContain("UTC");
  });

  it("changes the time part and reports the whole value", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateTimePicker, {
      defaultValue: "2026-09-30T14:05",
      hourCycle: 24,
      showTimeZone: false,
      onValueChange,
      "aria-label": "Starts",
    });
    fireEvent.keyDown(segment("Hour"), { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith("2026-09-30T15:05");
  });

  it("fills the earliest allowed time when a day is typed first", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateTimePicker, {
      min: "2026-10-01T08:30",
      hourCycle: 24,
      onValueChange,
      "aria-label": "Starts",
    });
    const date = screen.getByRole("textbox", { name: "Date" });
    fireEvent.change(date, { target: { value: "2026-10-01" } });
    fireEvent.keyDown(date, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith("2026-10-01T08:30");
  });

  it("holds a kept time to the bounds of the day it moves to", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.DateTimePicker, {
      defaultValue: "2026-10-02T02:00",
      min: "2026-10-01T08:30",
      max: "2026-10-03T10:00",
      hourCycle: 24,
      onValueChange,
      "aria-label": "Starts",
    });
    const date = screen.getByRole("textbox", { name: "Date" });
    fireEvent.change(date, { target: { value: "2026-10-01" } });
    fireEvent.keyDown(date, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith("2026-10-01T08:30");
  });

  it("names the zone as it stands on the chosen day, not today", () => {
    // Midwinter in Sydney: today is GMT+10, the chosen day is after daylight saving starts.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:00:00Z"));
    try {
      renderLoose(kit.DateTimePicker, {
        value: "2026-10-05T09:00",
        hourCycle: 24,
        timeZone: "Australia/Sydney",
        "aria-label": "Starts",
      });
      expect(screen.getByRole("group", { name: "Starts" }).textContent).toContain("GMT+11");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the group through a FormField without either part taking its id", () => {
    renderLoose(kit.FormField, {
      label: "Starts",
      children: createElement(kit.DateTimePicker, { hourCycle: 24 }),
    });
    const group = screen.getByRole("group", { name: "Starts" });
    expect(group.id).not.toBe("");
    expect(document.querySelectorAll(`[id="${group.id}"]`)).toHaveLength(1);
  });
});

describe("RangeSlider", () => {
  it("keeps a pair in order, on steps and apart", () => {
    expect(normalizeRange([80, 20], 0, 100, 10, 0)).toEqual([20, 80]);
    expect(normalizeRange([23, 27], 0, 100, 5, 10)).toEqual([25, 35]);
    expect(normalizeRange([95, 100], 0, 100, 5, 20)).toEqual([80, 100]);
    // A gap off the step grid rounds up to whole steps, never down.
    expect(normalizeRange([20, 20], 0, 100, 10, 14)).toEqual([20, 40]);
    expect(normalizeRange([95, 100], 0, 100, 5, 7)).toEqual([90, 100]);
    // A scientific-notation step keeps its mantissa's places.
    expect(normalizeRange([2.5e-7, 5e-7], 0, 1e-6, 2.5e-7, 0)).toEqual([2.5e-7, 5e-7]);
  });

  it("is two sliders, each stepping by key and never crossing the other", () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();
    renderLoose(kit.RangeSlider, {
      defaultValue: [20, 30],
      step: 5,
      minDistance: 5,
      formatValue: (value: number) => `P${value}`,
      onValueChange,
      onValueCommit,
      "aria-label": "Priority",
    });
    const low = screen.getByRole("slider", { name: "Minimum" });
    const high = screen.getByRole("slider", { name: "Maximum" });
    expect(low.getAttribute("aria-valuenow")).toBe("20");
    expect(low.getAttribute("aria-valuemax")).toBe("25");
    expect(high.getAttribute("aria-valuetext")).toBe("P30");
    fireEvent.keyDown(low, { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenLastCalledWith([25, 30]);
    fireEvent.keyUp(low, { key: "ArrowRight" });
    expect(onValueCommit).toHaveBeenLastCalledWith([25, 30]);
    // Already as close as minDistance allows.
    onValueChange.mockClear();
    fireEvent.keyDown(low, { key: "ArrowRight" });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.keyDown(high, { key: "End" });
    expect(onValueChange).toHaveBeenLastCalledWith([25, 100]);
    fireEvent.keyDown(low, { key: "Home" });
    expect(onValueChange).toHaveBeenLastCalledWith([0, 100]);
  });

  it("draws labelled marks, the readout and two named hidden fields", () => {
    renderLoose(kit.RangeSlider, {
      value: [1, 3],
      min: 0,
      max: 4,
      marks: [0, { value: 2, label: "Mid" }, 9, "x"],
      showValue: true,
      name: "priority",
      "aria-label": "Priority",
    });
    expect(screen.getByText("Mid")).toBeTruthy();
    expect(screen.getByText("1 – 3").getAttribute("aria-hidden")).toBe("true");
    const hidden = [...document.querySelectorAll<HTMLInputElement>('input[name="priority"]')];
    expect(hidden.map((input) => input.value)).toEqual(["1", "3"]);
  });

  it("reaches as far as an off-grid gap allows and says so", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.RangeSlider, {
      defaultValue: [0, 40],
      step: 10,
      minDistance: 14,
      onValueChange,
      "aria-label": "Priority",
    });
    const low = screen.getByRole("slider", { name: "Minimum" });
    expect(low.getAttribute("aria-valuemax")).toBe("20");
    fireEvent.keyDown(low, { key: "End" });
    expect(onValueChange).toHaveBeenLastCalledWith([20, 40]);
  });

  it("reads a throwing formatter as the number", () => {
    renderLoose(kit.RangeSlider, {
      defaultValue: [10, 90],
      showValue: true,
      formatValue: () => {
        throw new Error("nope");
      },
      "aria-label": "Priority",
    });
    expect(screen.getByText("10 – 90")).toBeTruthy();
  });

  it("falls back to its defaults on bad props", () => {
    renderLoose(kit.RangeSlider, { value: "wide", min: 10, max: 5, "aria-label": "Priority" });
    expect(screen.getByRole("slider", { name: "Minimum" }).getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByRole("slider", { name: "Maximum" }).getAttribute("aria-valuenow")).toBe(
      "100"
    );
  });

  it("shows the value over a thumb with keyboard focus", () => {
    renderLoose(kit.RangeSlider, {
      defaultValue: [10, 90],
      formatValue: (value: number) => `${value}%`,
      "aria-label": "Priority",
    });
    const low = screen.getByRole("slider", { name: "Minimum" });
    act(() => low.focus());
    expect(low.textContent).toBe("10%");
    act(() => low.blur());
    expect(low.textContent).toBe("");
  });
});

describe("ToggleGroup", () => {
  const days = [
    { value: "mon", label: "M", "aria-label": "Monday" },
    { value: "tue", label: "T", "aria-label": "Tuesday" },
    { value: "wed", label: "W", "aria-label": "Wednesday", disabled: true },
    { value: "thu", label: "T", "aria-label": "Thursday" },
    { value: "mon", label: "dupe" },
    { value: "" },
    { value: "icon-only", icon: "tag" },
  ];

  it("turns any number on in the items' order", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.ToggleGroup, {
      items: days,
      defaultValue: ["thu"],
      onValueChange,
      "aria-label": "Days",
    });
    const group = screen.getByRole("group", { name: "Days" });
    expect(group.querySelectorAll("button")).toHaveLength(4);
    const monday = screen.getByRole("button", { name: "Monday" });
    expect(monday.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(monday);
    expect(onValueChange).toHaveBeenLastCalledWith(["mon", "thu"]);
    expect(monday.getAttribute("aria-pressed")).toBe("true");
  });

  it("draws an on button with the kit Button's own pressed look", () => {
    renderLoose(kit.ToggleGroup, { items: days, defaultValue: ["mon"], "aria-label": "Days" });
    const toggle = screen.getByRole("button", { name: "Monday" });
    cleanup();
    render(createElement(kit.Button, { pressed: true, children: "Reference" }));
    const reference = screen.getByRole("button", { name: "Reference" });
    const pressedLook = (el: Element) =>
      [...el.classList].filter((name) => name.startsWith("aria-pressed:")).sort();
    expect(pressedLook(reference).length).toBeGreaterThan(0);
    expect(pressedLook(toggle)).toEqual(pressedLook(reference));
  });

  it("shows at most one on in single mode, whatever it is handed", () => {
    renderLoose(kit.ToggleGroup, {
      items: days,
      type: "single",
      value: ["mon", "tue"],
      "aria-label": "Days",
    });
    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed.map((button) => button.getAttribute("aria-label"))).toEqual(["Monday"]);
  });

  it("turns at most one on in single mode, and lets it go again", () => {
    const onValueChange = vi.fn();
    renderLoose(kit.ToggleGroup, {
      items: days,
      type: "single",
      value: ["mon"],
      onValueChange,
      "aria-label": "Days",
    });
    fireEvent.click(screen.getByRole("button", { name: "Tuesday" }));
    expect(onValueChange).toHaveBeenLastCalledWith(["tue"]);
    fireEvent.click(screen.getByRole("button", { name: "Monday" }));
    expect(onValueChange).toHaveBeenLastCalledWith([]);
  });

  it("is one tab stop with arrow keys skipping disabled items", () => {
    renderLoose(kit.ToggleGroup, { items: days, defaultValue: ["tue"], "aria-label": "Days" });
    const tuesday = screen.getByRole("button", { name: "Tuesday" });
    expect(tuesday.tabIndex).toBe(0);
    expect(screen.getByRole("button", { name: "Monday" }).tabIndex).toBe(-1);
    tuesday.focus();
    fireEvent.keyDown(tuesday, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Thursday" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Monday" }));
  });

  it("leaves the arrows to an enclosing Toolbar", () => {
    renderLoose(kit.Toolbar, {
      "aria-label": "Format",
      children: createElement(kit.ToggleGroup, {
        items: [
          { value: "b", icon: "tag", "aria-label": "Bold" },
          { value: "i", icon: "star", "aria-label": "Italic" },
        ],
        "aria-label": "Style",
      }),
    });
    const bold = screen.getByRole("button", { name: "Bold" });
    const stops = () => screen.getAllByRole("button").filter((button) => button.tabIndex === 0);
    // The toolbar keeps its one tab stop through the group's own mount.
    expect(stops()).toHaveLength(1);
    bold.focus();
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Italic" }));
  });
});

describe("SplitButton", () => {
  it("runs the primary action and opens the menu from a separate chevron", async () => {
    const onClick = vi.fn();
    const onTemplate = vi.fn();
    renderLoose(kit.SplitButton, {
      children: "Save",
      onClick,
      variant: "contrast",
      size: "sm",
      menuLabel: "More save options",
      items: [
        {
          label: "Save as template",
          description: "Reuse these settings",
          onSelect: onTemplate,
        },
      ],
    });
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    expect(onClick).toHaveBeenCalled();
    const chevron = screen.getByRole("button", { name: "More save options" });
    expect(chevron).not.toBe(save);
    expect(chevron.tabIndex).not.toBe(-1);
    await act(async () => {
      fireEvent.keyDown(chevron, { key: "Enter" });
    });
    const item = await screen.findByRole("menuitem", { name: /Save as template/ });
    expect(item.textContent).toContain("Reuse these settings");
    fireEvent.click(item);
    expect(onTemplate).toHaveBeenCalled();
  });

  it("disables both halves while loading and the menu alone with menuDisabled", () => {
    renderLoose(kit.SplitButton, {
      children: "Save",
      loading: true,
      items: [{ label: "Save as template", onSelect: () => {} }],
    });
    expect(
      (screen.getByRole("button", { name: "More options" }) as HTMLButtonElement).disabled
    ).toBe(true);
    cleanup();
    renderLoose(kit.SplitButton, {
      children: "Save",
      menuDisabled: true,
      items: [{ label: "x", onSelect: () => {} }],
    });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false
    );
    expect(
      (screen.getByRole("button", { name: "More options" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});

describe("useForm", () => {
  it("compares values structurally", () => {
    expect(sameFormValue({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameFormValue([1, 2], [2, 1])).toBe(false);
    expect(sameFormValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it("tracks dirty fields against the clean state and resets to it", () => {
    const { result } = renderHook(() =>
      kit.useForm({ initialValues: { name: "", days: ["mon"] }, onSubmit: () => {} })
    );
    expect(result.current.status).toBe("clean");
    expect(result.current.statusMessage).toBeUndefined();
    act(() => result.current.setValue("days", ["mon", "tue"]));
    expect(result.current.dirtyFields).toEqual(["days"]);
    expect(result.current.statusMessage).toBe("Unsaved changes");
    act(() => result.current.setValue("days", ["mon"]));
    expect(result.current.isDirty).toBe(false);
    act(() => result.current.setValue("name", "x"));
    act(() => result.current.reset());
    expect(result.current.values).toEqual({ name: "", days: ["mon"] });
    expect(result.current.isDirty).toBe(false);
  });

  it("checks a field once it is left, then on every change", () => {
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "" },
        validators: { name: (value: string) => (value === "" ? "Enter a name" : undefined) },
        onSubmit: () => {},
      })
    );
    expect(result.current.errors.name).toBeUndefined();
    act(() => result.current.field("name").onBlur());
    expect(result.current.errors.name).toBe("Enter a name");
    expect(result.current.field("name").invalid).toBe(true);
    expect(result.current.status).toBe("invalid");
    expect(result.current.statusMessage).toBe("Fix 1 field");
    act(() => result.current.field("name").onValueChange("bug"));
    expect(result.current.errors.name).toBeUndefined();
  });

  it("drops an async check that finishes after a newer one", async () => {
    const pending: ((value: string | undefined) => void)[] = [];
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "" },
        validateOn: "change",
        validators: {
          name: () => new Promise<string | undefined>((resolve) => pending.push(resolve)),
        },
        onSubmit: () => {},
      })
    );
    act(() => result.current.setValue("name", "a"));
    act(() => result.current.setValue("name", "ab"));
    expect(result.current.isValidating).toBe(true);
    await act(async () => pending[1]!(undefined));
    await act(async () => pending[0]!("Taken"));
    expect(result.current.errors.name).toBeUndefined();
    expect(result.current.isValidating).toBe(false);
  });

  it("submits once the checks pass, then reads Saved and clean", async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "" },
        validate: (values: { name: string }) =>
          values.name.length < 3 ? { name: "At least 3 characters" } : {},
        onSubmit,
      })
    );
    act(() => result.current.setValue("name", "ab"));
    let ok = true;
    await act(async () => {
      ok = await result.current.submit();
    });
    expect(ok).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(result.current.errors.name).toBe("At least 3 characters");
    act(() => result.current.setValue("name", "abc"));
    await act(async () => {
      ok = await result.current.submit();
    });
    expect(ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({ name: "abc" });
    expect(result.current.status).toBe("saved");
    expect(result.current.statusMessage).toBe("Saved");
    expect(result.current.isDirty).toBe(false);
  });

  it("keeps the form dirty and shows the message when the submit throws", async () => {
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "a" },
        onSubmit: () => Promise.reject(new Error("Server said no")),
      })
    );
    act(() => result.current.setValue("name", "b"));
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.status).toBe("error");
    expect(result.current.statusMessage).toBe("Server said no");
    expect(result.current.submitError).toBe("Server said no");
    expect(result.current.isDirty).toBe(true);
  });

  it("holds an error set by hand until the field changes", () => {
    const { result } = renderHook(() =>
      kit.useForm({ initialValues: { name: "a" }, onSubmit: () => {} })
    );
    act(() => result.current.setError("name", "Already exists"));
    expect(result.current.errors.name).toBe("Already exists");
    act(() => result.current.setValue("name", "b"));
    expect(result.current.errors.name).toBeUndefined();
  });
});

describe("useForm under concurrency and odd input", () => {
  function deferred() {
    let resolve: (value: string | undefined) => void = () => {};
    const promise = new Promise<string | undefined>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("refuses a second submit while the first is still checking", async () => {
    const check = deferred();
    const onSubmit = vi.fn();
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "a" },
        validators: { name: () => check.promise },
        onSubmit,
      })
    );
    let first: Promise<boolean> = Promise.resolve(false);
    let second = true;
    await act(async () => {
      first = result.current.submit();
      second = await result.current.submit();
    });
    expect(second).toBe(false);
    expect(result.current.isSubmitting).toBe(true);
    await act(async () => {
      check.resolve(undefined);
      await first;
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("lets nothing started before a reset land after it", async () => {
    const check = deferred();
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "" },
        validateOn: "change",
        validators: { name: () => check.promise },
        onSubmit: () => {},
      })
    );
    act(() => result.current.setValue("name", "taken"));
    act(() => result.current.reset());
    await act(async () => check.resolve("Taken"));
    expect(result.current.errors.name).toBeUndefined();
    expect(result.current.isValidating).toBe(false);
  });

  it("rechecks a field edited while its first blur check runs", async () => {
    const checks: ReturnType<typeof deferred>[] = [];
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "taken" },
        validators: {
          name: () => {
            const next = deferred();
            checks.push(next);
            return next.promise;
          },
        },
        onSubmit: () => {},
      })
    );
    act(() => result.current.field("name").onBlur());
    act(() => result.current.setValue("name", "free"));
    await act(async () => checks[0]!.resolve("Taken"));
    expect(result.current.errors.name).toBeUndefined();
    await act(async () => checks[1]!.resolve(undefined));
    expect(result.current.errors.name).toBeUndefined();
  });

  it("checks a batch of values against the whole new row", () => {
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { password: "a", confirm: "a" },
        validateOn: "change",
        validators: {
          password: (value: string, values: { confirm: string }) =>
            value === values.confirm ? undefined : "Passwords differ",
        },
        onSubmit: () => {},
      })
    );
    act(() => result.current.setValues({ password: "b", confirm: "b" }));
    expect(result.current.errors.password).toBeUndefined();
  });

  it("shows an error for a field the values never held, and one named like a prototype key", async () => {
    const { result } = renderHook(() =>
      kit.useForm<Record<string, unknown>>({
        initialValues: {},
        validate: () => ({ name: "Enter a name" }),
        onSubmit: () => {},
      })
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.errors.name).toBe("Enter a name");
    expect(result.current.status).toBe("invalid");
    expect(result.current.errors.constructor).toBeUndefined();
    act(() => result.current.setValue("constructor", "x"));
    expect(result.current.values.constructor).toBe("x");
  });

  it("ends a comparison of cyclic values", () => {
    const a: unknown[] = [];
    a.push(a);
    const b: unknown[] = [];
    b.push(b);
    expect(sameFormValue(a, a)).toBe(true);
    // A child shared twice still compares by content.
    const child = { x: 1 };
    expect(sameFormValue({ p: child, q: child }, { p: { x: 1 }, q: { x: 1 } })).toBe(true);
    expect(sameFormValue({ p: child, q: child }, { p: { x: 1 }, q: { x: 2 } })).toBe(false);
  });

  it("sends nothing when reset lands between the checks and the send", async () => {
    const check = deferred();
    const onSubmit = vi.fn();
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "a" },
        validators: { name: () => check.promise },
        onSubmit,
      })
    );
    let sent: Promise<boolean> = Promise.resolve(true);
    act(() => {
      sent = result.current.submit();
    });
    await act(async () => {
      check.resolve(undefined);
      // The checks settle on this tick; the send is queued behind them.
      await Promise.resolve();
      result.current.reset();
      expect(await sent).toBe(false);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(result.current.isSubmitting).toBe(false);
  });

  it("releases the submit lock when the form check's result throws", async () => {
    const { result } = renderHook(() =>
      kit.useForm({
        initialValues: { name: "a" },
        validate: () => ({
          get name(): string {
            throw new Error("bad getter");
          },
        }),
        onSubmit: () => {},
      })
    );
    await act(async () => {
      await result.current.submit();
    });
    expect(result.current.isSubmitting).toBe(false);
    expect(result.current.isValidating).toBe(false);
  });
});

describe("Form and FormStatus", () => {
  function Harness({ onSubmit }: { onSubmit: (values: { title: string }) => void }) {
    const form = kit.useForm({
      initialValues: { title: "" },
      validators: { title: (value: string) => (value.trim() === "" ? "Enter a title" : undefined) },
      onSubmit,
    });
    return createElement(
      kit.Form,
      { form, "aria-label": "New label" },
      createElement(kit.FormField, {
        label: "Title",
        error: form.errors.title,
        children: createElement(kit.Input, form.field("title")),
      }),
      createElement(kit.SettingsActions, {
        status: createElement(kit.FormStatus, { form }),
        children: [
          createElement(kit.Button, { key: "r", type: "reset", children: "Discard" }),
          createElement(kit.Button, { key: "s", type: "submit", children: "Save" }),
        ],
      })
    );
  }

  it("submits on the submit button and focuses the first invalid control", async () => {
    const onSubmit = vi.fn();
    render(withTooltips(createElement(Harness, { onSubmit })));
    const form = screen.getByRole("form", { name: "New label" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await flush();
    const input = screen.getByRole("textbox", { name: "Title" });
    expect(document.activeElement).toBe(input);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(form.querySelector('[data-slot="form-status"]')?.textContent).toBe("Fix 1 field");
    fireEvent.change(input, { target: { value: "Bug" } });
    expect(form.querySelector('[data-slot="form-status"]')?.getAttribute("data-status")).toBe(
      "dirty"
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    await flush();
    expect(onSubmit).toHaveBeenCalledWith({ title: "Bug" });
    expect(form.querySelector('[data-slot="form-status"]')?.textContent).toBe("Saved");
  });

  it("resets on a reset button", async () => {
    render(withTooltips(createElement(Harness, { onSubmit: () => {} })));
    const input = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bug" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    });
    expect(input.value).toBe("");
  });
});

describe("SchemaForm", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", title: "Name", description: "Shown on the card" },
      token: { type: "string", title: "Token", format: "password" },
      retries: { type: "integer", title: "Retries", minimum: 0, maximum: 5, default: 2 },
      mode: { type: "string", title: "Mode", enum: ["fast", "safe"] },
      notify: { type: "boolean", title: "Notify" },
      extra: { type: "object", title: "Extra" },
      when: { type: "string", format: "date-time", pattern: "x" },
      nothing: { type: "null" },
    },
  };

  it("maps a schema onto the settings generator's field types", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fields = schemaFields(schema);
    expect(fields.map((f) => [f.def.id, f.def.type, f.masked])).toEqual([
      ["name", "string", false],
      ["token", "string", true],
      ["retries", "number", false],
      ["mode", "enum", false],
      ["notify", "boolean", false],
      ["extra", "json", false],
      ["when", "string", false],
    ]);
    expect(fields[0]!.def.required).toBe(true);
    expect(fields[2]!.def).toMatchObject({ min: 0, max: 5, default: 2 });
    expect(fields[2]!.integer).toBe(true);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/pattern/);
    expect(schemaFields({ type: "array" })).toEqual([]);
    expect(schemaFields("nope")).toEqual([]);
  });

  it("renders a settings row per field and commits edits into the value", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onValueChange = vi.fn();
    renderLoose(kit.SchemaForm, { schema, defaultValue: { name: "Bug" }, onValueChange });
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Bug");
    expect(screen.getByText("Required")).toBeTruthy();
    fireEvent.change(name, { target: { value: "Feature" } });
    fireEvent.blur(name);
    expect(onValueChange).toHaveBeenLastCalledWith({ name: "Feature" });
    const retries = screen.getByRole("textbox", { name: "Retries" }) as HTMLInputElement;
    expect(retries.value).toBe("2");
    fireEvent.change(retries, { target: { value: "9" } });
    fireEvent.blur(retries);
    expect(screen.getByText("Must be at most 5")).toBeTruthy();
    fireEvent.change(retries, { target: { value: "1.5" } });
    fireEvent.blur(retries);
    expect(screen.getByText("Enter a whole number")).toBeTruthy();
    fireEvent.change(retries, { target: { value: "3" } });
    fireEvent.blur(retries);
    expect(onValueChange).toHaveBeenLastCalledWith({ name: "Feature", retries: 3 });
    fireEvent.click(screen.getByRole("radio", { name: "safe" }));
    expect(onValueChange).toHaveBeenLastCalledWith({ name: "Feature", retries: 3, mode: "safe" });
    fireEvent.click(screen.getByRole("switch", { name: "Notify" }));
    expect(onValueChange).toHaveBeenLastCalledWith({
      name: "Feature",
      retries: 3,
      mode: "safe",
      notify: true,
    });
    expect((screen.getByLabelText("Token", { selector: "input" }) as HTMLInputElement).type).toBe(
      "password"
    );
  });

  it("commits a text field on Enter before the enclosing form submits", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onValueChange = vi.fn();
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(
      withTooltips(
        createElement(
          "form",
          { onSubmit },
          createElement(kit.SchemaForm, { schema, value: { name: "Bug" }, onValueChange })
        )
      )
    );
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Feature" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith({ name: "Feature" });
    const retries = screen.getByRole("textbox", { name: "Retries" });
    fireEvent.change(retries, { target: { value: "99" } });
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    retries.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });

  it("drops an edit when the value is replaced from outside, and reads odd values safely", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const odd = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", default: { toString: null } },
        count: { type: "number", title: "Count", default: "many" },
        big: { type: BigInt(1), title: "Big" },
      },
    };
    const view = renderLoose(kit.SchemaForm, { schema: odd, value: { name: "a" } });
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "edited" } });
    view.rerender(
      withTooltips(createElement(kit.SchemaForm, { schema: odd, value: { name: "reset" } }))
    );
    expect(name.value).toBe("reset");
    expect((screen.getByRole("textbox", { name: "Count" }) as HTMLInputElement).value).toBe("");
  });

  it("shows errors handed in beside its own", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderLoose(kit.SchemaForm, { schema, value: {}, errors: { name: "Enter a name" } });
    expect(screen.getByText("Enter a name")).toBeTruthy();
  });
});
