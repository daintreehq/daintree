// @vitest-environment jsdom
import { createElement, type ComponentType, type ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(() => Promise.resolve()) },
}));

// The emoji grid loads its data over the network; the picker's wiring is what
// is under test here, so the grid is one button that picks a fixed emoji.
vi.mock("frimousse", () => {
  type Children = { children?: ReactNode };
  const pass = ({ children }: Children) => children ?? null;
  return {
    EmojiPicker: {
      Root: ({
        onEmojiSelect,
        children,
      }: Children & { onEmojiSelect: (emoji: { emoji: string; label: string }) => void }) =>
        createElement(
          "div",
          null,
          createElement(
            "button",
            { type: "button", onClick: () => onEmojiSelect({ emoji: "🚀", label: "rocket" }) },
            "Pick rocket"
          ),
          children
        ),
      Search: () => null,
      Viewport: pass,
      Loading: () => null,
      Empty: () => null,
      List: () => null,
      ActiveEmoji: () => null,
    },
  };
});

import * as kit from "@daintreehq/plugin-ui";
import {
  fileMatchesAccept,
  fitChipCount,
  formatNumberField,
  parseNumberText,
  pickerRows,
  snapToStep,
  stepperRoom,
} from "@/components/PluginKit/PluginKitInputs";
import { normalizeSelectOptions } from "@/components/PluginKit/kitOptions";

beforeAll(async () => {
  await kit.whenPluginUiReady();
});

afterEach(cleanup);

function inViewport(children: ReactNode, viewportHeight = 280) {
  return createElement(
    VirtuosoMockContext.Provider,
    { value: { viewportHeight, itemHeight: 28 } },
    children
  );
}

function renderLoose<P extends object>(component: ComponentType<P>, looseProps: object) {
  // Untyped JS, as a hand-written view sends it.
  const props: P = JSON.parse(JSON.stringify(looseProps));
  return render(createElement(component, props));
}

function optionNames(): string[] {
  return screen
    .getAllByRole("option", { hidden: true })
    .map((option) => option.getAttribute("aria-label") ?? option.textContent ?? "");
}

async function openPicker(name: string) {
  const trigger = screen.getByRole("combobox", { name });
  await act(async () => {
    fireEvent.click(trigger);
  });
  return screen.findByRole("combobox", { name: `Search ${name}` });
}

describe("RadioGroup", () => {
  const options = [
    { value: "merge", label: "Merge commit", description: "Keeps every commit" },
    { value: "squash", label: "Squash" },
    { value: "rebase", label: "Rebase", disabled: true },
  ];

  it("renders native radios in a named group and reports the choice", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.RadioGroup, {
        options,
        defaultValue: "merge",
        onValueChange,
        "aria-label": "Merge method",
        "data-testid": "method",
      })
    );
    const group = screen.getByRole("radiogroup", { name: "Merge method" });
    expect(group.getAttribute("data-testid")).toBe("method");
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios[2]!.disabled).toBe(true);
    const merge = screen.getByRole("radio", { name: "Merge commit" });
    expect(merge.getAttribute("aria-describedby")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Squash" }));
    expect(onValueChange).toHaveBeenCalledWith("squash");
    expect((screen.getByRole("radio", { name: "Squash" }) as HTMLInputElement).checked).toBe(true);
  });

  it("joins a FormField and stays controlled", () => {
    render(
      createElement(kit.FormField, {
        label: "Merge method",
        description: "How pull requests land",
        children: createElement(kit.RadioGroup, { options, value: "squash" }),
      })
    );
    const group = screen.getByRole("radiogroup", { name: "Merge method" });
    expect(group.getAttribute("aria-describedby")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Merge commit" }));
    expect((screen.getByRole("radio", { name: "Squash" }) as HTMLInputElement).checked).toBe(true);
  });

  it("makes an empty required group fail native form validation", () => {
    const { container } = render(
      createElement(
        "form",
        null,
        createElement(kit.RadioGroup, { options, required: true, "aria-label": "Merge method" })
      )
    );
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every((radio) => radio.required)).toBe(true);
    expect(container.querySelector("form")!.checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Squash" }));
    expect(container.querySelector("form")!.checkValidity()).toBe(true);
  });

  it("drops malformed options and props without throwing", () => {
    renderLoose(kit.RadioGroup, {
      options: [{ value: "" }, "nope", { value: "a", label: "A" }, { value: "a", label: "Again" }],
      orientation: "diagonal",
      variant: 7,
    });
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });
});

describe("NumberInput", () => {
  it("parses typed numbers, units and grouped thousands, and rejects garbage", () => {
    expect(parseNumberText(" 42 ")).toBe(42);
    expect(parseNumberText("250ms", "ms")).toBe(250);
    expect(parseNumberText("1,500")).toBe(1500);
    expect(parseNumberText("-.5")).toBe(-0.5);
    expect(parseNumberText("")).toBeNull();
    expect(parseNumberText("12abc")).toBeUndefined();
    expect(parseNumberText("1,5")).toBeUndefined();
    expect(parseNumberText("Infinity")).toBeUndefined();
  });

  it("commits on blur, clamped and rounded, and reverts garbage", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Timeout",
        defaultValue: 5,
        min: 0,
        max: 10,
        step: 0.5,
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Timeout" }) as HTMLInputElement;
    expect(field.value).toBe("5");
    fireEvent.change(field, { target: { value: "99" } });
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(onValueChange).toHaveBeenLastCalledWith(10);
    expect(field.value).toBe("10");

    fireEvent.change(field, { target: { value: "2.26" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith(2.3);

    fireEvent.change(field, { target: { value: "lots" } });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    fireEvent.blur(field);
    expect(field.value).toBe("2.3");
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(onValueChange).toHaveBeenCalledTimes(2);
  });

  it("steps with the arrow keys, ten at a time with Shift, and with the buttons", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Retries",
        defaultValue: 3,
        max: 20,
        unit: "x",
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Retries" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith(4);
    fireEvent.keyDown(field, { key: "ArrowUp", shiftKey: true });
    expect(onValueChange).toHaveBeenLastCalledWith(14);
    fireEvent.keyDown(field, { key: "End" });
    expect(onValueChange).toHaveBeenLastCalledWith(20);
    expect(field.getAttribute("aria-valuetext")).toBe("20 x");
    const increase = screen.getByRole("button", { name: "Increase" }) as HTMLButtonElement;
    expect(increase.disabled).toBe(true);
    expect(increase.tabIndex).toBe(-1);
    fireEvent.click(screen.getByRole("button", { name: "Decrease" }));
    expect(onValueChange).toHaveBeenLastCalledWith(19);
  });

  it("keeps a rounded commit inside a bound finer than the step", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Scale",
        defaultValue: 1,
        min: 0.25,
        step: 1,
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Scale" });
    fireEvent.keyDown(field, { key: "Home" });
    expect(onValueChange).toHaveBeenLastCalledWith(0.25);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("sets the stepper limits from the typed value it steps from", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Workers",
        defaultValue: 10,
        max: 10,
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Workers" });
    const increase = screen.getByRole("button", { name: "Increase" }) as HTMLButtonElement;
    expect(increase.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "5" } });
    expect(increase.disabled).toBe(false);
    fireEvent.click(increase);
    expect(onValueChange).toHaveBeenLastCalledWith(6);
  });

  it("commits an empty field as null unless required", () => {
    const onValueChange = vi.fn();
    render(
      createElement(
        "div",
        null,
        createElement(kit.NumberInput, { "aria-label": "Optional", value: 4, onValueChange }),
        createElement(kit.NumberInput, { "aria-label": "Needed", value: 4, required: true })
      )
    );
    const optional = screen.getByRole("spinbutton", { name: "Optional" });
    fireEvent.change(optional, { target: { value: "" } });
    fireEvent.blur(optional);
    expect(onValueChange).toHaveBeenCalledWith(null);
    const needed = screen.getByRole("spinbutton", { name: "Needed" }) as HTMLInputElement;
    fireEvent.change(needed, { target: { value: "" } });
    fireEvent.blur(needed);
    expect(needed.value).toBe("4");
  });

  it("joins a FormField and a SettingsRow", () => {
    render(
      createElement(kit.FormField, {
        label: "Port",
        error: "Taken",
        children: createElement(kit.NumberInput, { stepper: false }),
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Port" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    cleanup();
    render(
      createElement(kit.SettingsRow, {
        label: "Port",
        control: (ids: { labelId: string }) =>
          createElement(kit.NumberInput, { "aria-labelledby": ids.labelId }),
      })
    );
    expect(screen.getByRole("spinbutton", { name: "Port" })).toBeTruthy();
  });

  it("lays the value, unit and buttons side by side, and gives way at the unit, never past the frame", () => {
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Seats",
        defaultValue: 240000,
        unit: "seats",
      })
    );
    const value = screen.getByRole("spinbutton", { name: "Seats" });
    const frame = value.parentElement!;
    const unit = frame.querySelector("[data-number-unit]")!;
    const stepper = frame.querySelector("[data-number-stepper]")!;
    const classes = (el: Element) => el.className.split(" ");
    // One flex row in the frame, in reading order; nothing is drawn over the text.
    expect(classes(frame)).toContain("flex");
    expect(Array.from(frame.children)).toEqual([value, unit, stepper]);
    for (const part of [value, unit, stepper]) {
      expect(part.className).not.toMatch(/\babsolute\b/);
      expect(part.getAttribute("style")).toBeNull();
    }
    // Nothing paints outside the field's border, however narrow the column.
    expect(classes(frame)).toContain("overflow-hidden");
    // The text takes the room left over and keeps a digit floor of its own.
    expect(classes(value)).toContain("flex-1");
    expect(value.className).toMatch(/min-w-\[calc\(\d+ch\+/);
    // The unit is the part that gives way, with an ellipsis; the buttons never do.
    expect(classes(unit)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(classes(unit)).not.toContain("shrink-0");
    expect(classes(stepper)).toContain("shrink-0");
  });

  it("hides both steppers once they no longer fit, and brings them back only when the room they need returns", () => {
    // Shown and fitting: stays shown.
    expect(stepperRoom(200, 150, null)).toBeNull();
    // Subpixel rounding is not an overflow.
    expect(stepperRoom(200, 200.4, null)).toBeNull();
    // Shown and overflowing: hidden, remembering the width the parts needed.
    expect(stepperRoom(120, 150, null)).toBe(150);
    // Hidden, the frame's freed room never flips it straight back: only the
    // remembered width does, whatever the parts measure now.
    expect(stepperRoom(149, 90, 150)).toBe(150);
    expect(stepperRoom(150, 90, 150)).toBeNull();
    expect(stepperRoom(400, 90, 150)).toBeNull();
  });

  it("drops both stepper buttons in a column too narrow for them, keeps stepping from the keys, and restores them with room", () => {
    type Box = { inlineSize: number; blockSize: number };
    type Entry = { target: Element; borderBoxSize: Box[]; contentBoxSize: Box[] };
    let report: ((entries: Entry[]) => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: Entry[]) => void) {
          report = callback;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      }
    );
    try {
      const onValueChange = vi.fn();
      render(
        createElement(kit.NumberInput, {
          "aria-label": "Seats",
          defaultValue: 240,
          unit: "seats",
          onValueChange,
        })
      );
      const value = screen.getByRole("spinbutton", { name: "Seats" });
      const frame = value.parentElement!;
      const box = (target: Element, outer: number, inner = outer): Entry => ({
        target,
        borderBoxSize: [{ inlineSize: outer, blockSize: 32 }],
        contentBoxSize: [{ inlineSize: inner, blockSize: 30 }],
      });
      const buttons = () => frame.querySelectorAll("button");
      const layout = (frameWidth: number, valueWidth: number, unitWidth: number) => {
        const [input, unit, stepper] = Array.from(frame.children);
        act(() => {
          report!([
            box(frame, frameWidth, frameWidth - 6),
            box(input!, valueWidth),
            box(unit!, unitWidth),
            box(stepper!, 50),
          ]);
        });
      };
      // Room for everything: both buttons show.
      layout(200, 100, 44);
      expect(buttons()).toHaveLength(2);
      // The value at its floor, the unit down to its padding, and the pair
      // need 6 + 48 + 4 + 50 = 108 in a 90px frame: both go, together.
      layout(90, 48, 4);
      expect(buttons()).toHaveLength(0);
      expect(frame.querySelector("[data-number-stepper]")).toBeNull();
      // The keys still step with the buttons gone.
      fireEvent.keyDown(value, { key: "ArrowUp" });
      expect(onValueChange).toHaveBeenLastCalledWith(241);
      fireEvent.keyDown(value, { key: "PageDown" });
      expect(onValueChange).toHaveBeenLastCalledWith(231);
      // Wider, but short of what the pair needed: still hidden, no flicker.
      act(() => {
        report!([box(frame, 107, 101)]);
      });
      expect(buttons()).toHaveLength(0);
      // The room they needed is back: both return.
      act(() => {
        report!([box(frame, 108, 102)]);
      });
      expect(buttons()).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the Input's height at both densities", () => {
    for (const density of ["default", "compact"] as const) {
      render(
        createElement(
          "div",
          null,
          createElement(kit.Input, { "aria-label": "Plain", density }),
          createElement(kit.NumberInput, { "aria-label": "Number", unit: "ms", density })
        )
      );
      const plain = screen.getByRole("textbox", { name: "Plain" });
      const value = screen.getByRole("spinbutton", { name: "Number" });
      const frame = value.parentElement!;
      const py = (el: Element) => el.className.split(" ").filter((c) => /^py-/.test(c));
      // The frame draws the same border with no padding of its own, and the text
      // carries the Input's vertical padding and type size, so the two stand as tall.
      expect(py(frame)).toEqual(["py-0"]);
      expect(py(value)).toEqual(py(plain));
      const size = (el: Element) => el.className.split(" ").filter((c) => /^text-(xs|sm)$/.test(c));
      expect(size(frame)).toEqual(size(plain));
      // Each button is a 24px pointer target at either density, and still sits
      // inside the text's line box, so the frame keeps the Input's height.
      const spacing = (el: Element, prefix: string) =>
        el.className
          .split(" ")
          .filter((c) => c.startsWith(prefix))
          .map((c) => Number(c.slice(prefix.length)) * 4);
      const lineHeight = size(frame)[0] === "text-xs" ? 16 : 20;
      const lineBox = 2 * spacing(value, "py-")[0]! + lineHeight;
      for (const name of ["Increase", "Decrease"]) {
        const button = screen.getByRole("button", { name });
        for (const axis of ["h-", "w-"]) {
          const sizes = spacing(button, axis);
          expect(sizes.length).toBeGreaterThan(0);
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(24);
          expect(Math.max(...sizes)).toBeLessThanOrEqual(lineBox);
        }
      }
      cleanup();
    }
  });

  it("shows no stepper when read-only, and a dimmed one when disabled", () => {
    render(
      createElement(
        "div",
        null,
        createElement(kit.NumberInput, { "aria-label": "Fixed", value: 240, readOnly: true }),
        createElement(kit.NumberInput, { "aria-label": "Off", value: 58, disabled: true })
      )
    );
    const fixed = screen.getByRole("spinbutton", { name: "Fixed" });
    expect(fixed.parentElement!.querySelector("button")).toBeNull();
    const off = screen.getByRole("spinbutton", { name: "Off" });
    const buttons = Array.from(off.parentElement!.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("speaks the number in the field while it is edited, and none while there is none", () => {
    render(createElement(kit.NumberInput, { "aria-label": "Retries", defaultValue: 3, unit: "x" }));
    const field = screen.getByRole("spinbutton", { name: "Retries" });
    expect(field.getAttribute("aria-valuenow")).toBe("3");
    expect(field.getAttribute("aria-valuetext")).toBe("3 x");
    fireEvent.change(field, { target: { value: "1,200" } });
    expect(field.getAttribute("aria-valuenow")).toBe("1200");
    expect(field.getAttribute("aria-valuetext")).toBe("1200 x");
    fireEvent.change(field, { target: { value: "" } });
    expect(field.hasAttribute("aria-valuenow")).toBe(false);
    expect(field.getAttribute("aria-valuetext")).toBe("");
    fireEvent.change(field, { target: { value: "12a" } });
    expect(field.hasAttribute("aria-valuenow")).toBe(false);
    expect(field.getAttribute("aria-valuetext")).toBe("");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    // Committing garbage still reverts to the last value, and speaks it again.
    fireEvent.blur(field);
    expect(field.getAttribute("aria-valuenow")).toBe("3");
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });

  it("formats a value at rest: fixed or trimmed decimals, grouped into the same digits", () => {
    // Nothing asked for is the plain value, as the field has always shown it.
    expect(formatNumberField(2.5, {})).toBe(String(2.5));
    expect(formatNumberField(2.5, { places: 2 })).toBe((2.5).toFixed(2));
    expect(formatNumberField(-0.001, { places: 2 })).toBe((-0.001).toFixed(2));
    expect(formatNumberField(null, { places: 2, grouping: true })).toBe("");

    expect(formatNumberField(2.5, { places: 2, trimZeros: true })).toBe("2.5");
    expect(formatNumberField(1200, { places: 2, trimZeros: true })).toBe("1200");
    expect(formatNumberField(-0.001, { places: 2, trimZeros: true })).toBe("0");

    expect(formatNumberField(1234567.5, { places: 2, grouping: true }, "en-US")).toBe(
      "1,234,567.50"
    );
    expect(formatNumberField(-1234.5, { grouping: true, trimZeros: true }, "de-DE")).toBe(
      "-1.234,5"
    );
    // Grouping never rounds again: toFixed's digits are the ones shown.
    const quantity = 12345.12345678;
    expect(formatNumberField(quantity, { grouping: true }, "en-US").replace(/,/g, "")).toBe(
      String(quantity)
    );
    expect(formatNumberField(1.005, { places: 2, grouping: true }, "en-US")).toBe(
      (1.005).toFixed(2)
    );
    // An exponent form has no digits to group.
    expect(formatNumberField(1e21, { grouping: true }, "en-US")).toBe(String(1e21));
  });

  it("keeps a typed quantity as typed with step any, and still steps by one", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Units",
        defaultValue: 0.07,
        step: "any",
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Units" }) as HTMLInputElement;
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith(1.07);
    fireEvent.change(field, { target: { value: "0.12345678" } });
    fireEvent.blur(field);
    expect(onValueChange).toHaveBeenLastCalledWith(0.12345678);
    expect(field.value).toBe("0.12345678");
  });

  it("keeps every decimal a value has when step any steps it", () => {
    const onValueChange = vi.fn();
    const { rerender } = render(
      createElement(kit.NumberInput, {
        "aria-label": "Units",
        value: 0.123456789012345,
        step: "any",
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Units" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith(1.123456789012345);
    rerender(
      createElement(kit.NumberInput, {
        "aria-label": "Units",
        value: 1.23456789e-7,
        step: "any",
        onValueChange,
      })
    );
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(onValueChange).toHaveBeenLastCalledWith(1.000000123456789);
  });

  it("still rounds to an explicit precision with step any", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Price",
        step: "any",
        precision: 2,
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Price" });
    fireEvent.change(field, { target: { value: "3.14159" } });
    fireEvent.blur(field);
    expect(onValueChange).toHaveBeenLastCalledWith(3.14);
  });

  it("groups thousands only while the field is not being edited, and round-trips exactly", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.NumberInput, {
        "aria-label": "Balance",
        defaultValue: 1234567.5,
        precision: 2,
        grouping: true,
        fixedDecimals: false,
        onValueChange,
      })
    );
    const field = screen.getByRole("spinbutton", { name: "Balance" }) as HTMLInputElement;
    const rest = field.value;
    expect(rest).toBe(formatNumberField(1234567.5, { places: 2, grouping: true, trimZeros: true }));
    expect(rest).not.toBe("1234567.5");
    fireEvent.focus(field);
    expect(field.value).toBe("1234567.5");
    fireEvent.blur(field);
    expect(field.value).toBe(rest);
    expect(onValueChange).not.toHaveBeenCalled();
    // An edit is typed in plain digits and shows grouped again once committed.
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "2500000.25" } });
    fireEvent.blur(field);
    expect(onValueChange).toHaveBeenLastCalledWith(2500000.25);
    expect(field.value).toBe(
      formatNumberField(2500000.25, { places: 2, grouping: true, trimZeros: true })
    );
  });

  it("regroups a controlled value that changes while the field is at rest", () => {
    const field = (value: number) =>
      createElement(kit.NumberInput, { "aria-label": "Total", value, grouping: true });
    const { rerender } = render(field(1000));
    const input = screen.getByRole("spinbutton", { name: "Total" }) as HTMLInputElement;
    expect(input.value).toBe(formatNumberField(1000, { grouping: true }));
    rerender(field(98765.4321));
    expect(input.value).toBe(formatNumberField(98765.4321, { grouping: true }));
    expect(input.value.replace(/\D/g, "")).toBe("987654321");
  });

  it("degrades bad props rather than throwing", () => {
    renderLoose(kit.NumberInput, {
      "aria-label": "Loose",
      value: "12",
      min: "a",
      step: -1,
      precision: 1.5,
      unit: {},
    });
    expect((screen.getByRole("spinbutton", { name: "Loose" }) as HTMLInputElement).value).toBe("");
  });
});

describe("Slider", () => {
  it("is a native range with a spoken value and a readout", () => {
    const onValueChange = vi.fn();
    const onValueCommit = vi.fn();
    render(
      createElement(kit.Slider, {
        "aria-label": "Opacity",
        defaultValue: 40,
        step: 10,
        formatValue: (value: number) => `${value}%`,
        showValue: true,
        onValueChange,
        onValueCommit,
      })
    );
    const slider = screen.getByRole("slider", { name: "Opacity" }) as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.getAttribute("aria-valuetext")).toBe("40%");
    fireEvent.change(slider, { target: { value: "70" } });
    expect(onValueChange).toHaveBeenCalledWith(70);
    expect(slider.getAttribute("aria-valuetext")).toBe("70%");
    expect(screen.getByText("70%").getAttribute("aria-hidden")).toBe("true");
    fireEvent.pointerUp(slider);
    expect(onValueCommit).toHaveBeenCalledWith(70);
  });

  it("draws the thumb with a boundary of its own against the fill and the empty track, in neutral inks", () => {
    render(createElement(kit.Slider, { "aria-label": "Mix", min: 0, max: 200, defaultValue: 50 }));
    const slider = screen.getByRole("slider", { name: "Mix" }) as HTMLInputElement;
    const classes = slider.className.split(" ");
    const thumb = classes.filter((c) => c.startsWith("[&::-webkit-slider-thumb]:"));
    const track = classes.filter((c) => c.startsWith("[&::-webkit-slider-runnable-track]:"));
    // The platform thumb is replaced, so it can be drawn.
    expect(classes).toContain("appearance-none");
    expect(thumb).toContain("[&::-webkit-slider-thumb]:appearance-none");
    // The thumb is a surface-coloured disc with a ring: its fill is not the
    // ink the track fills with, so it never melts into the filled part.
    const thumbFill = thumb.find((c) => /:bg-/.test(c));
    expect(thumbFill).toMatch(/:bg-surface-/);
    expect(thumb).toContain("[&::-webkit-slider-thumb]:border-2");
    expect(thumb.some((c) => /:border-(text-primary|border-strong)$/.test(c))).toBe(true);
    const trackFill = track.find((c) => /:bg-\[/.test(c))!;
    expect(trackFill).toContain("var(--color-text-primary)");
    expect(trackFill).toContain("var(--kit-slider-fill");
    // The empty part of the track is a control edge, on the theme's 3:1 ink.
    expect(trackFill).toContain("var(--color-selection-outline)");
    expect(trackFill).not.toContain(thumbFill!.split(":bg-")[1]!);
    // Neutral throughout: the focus ring is the only accent on it.
    expect(slider.className.replace(/focus-visible:outline-accent-primary/g, "")).not.toMatch(
      /accent/
    );
    // The fill follows the value as a fraction of the range.
    const fill = () => Number(slider.style.getPropertyValue("--kit-slider-fill"));
    expect(fill()).toBe(0.25);
    fireEvent.change(slider, { target: { value: "150" } });
    expect(fill()).toBe(0.75);
  });

  it("snaps to the step the way the native range does", () => {
    expect(snapToStep(50, 0, 100, 20)).toBe(60);
    expect(snapToStep(49, 0, 100, 20)).toBe(40);
    expect(snapToStep(95, 0, 100, 30)).toBe(90);
    expect(snapToStep(0.45, 0.1, 1, 0.2)).toBe(0.5);
    expect(snapToStep(0.2, 0.1, 1, 0.2)).toBe(0.3);
    expect(snapToStep(-4, 0, 100, 20)).toBe(0);
  });

  it("describes the value the thumb is on, not an off-step default", () => {
    render(
      createElement(kit.Slider, {
        "aria-label": "Zoom",
        defaultValue: 50,
        step: 20,
        showValue: true,
        formatValue: (value: number) => `${value}%`,
      })
    );
    const slider = screen.getByRole("slider", { name: "Zoom" }) as HTMLInputElement;
    expect(slider.value).toBe("60");
    expect(slider.getAttribute("aria-valuetext")).toBe("60%");
    expect(screen.getByText("60%")).toBeTruthy();
  });

  it("joins a FormField and falls back to 0–100 on a bad range", () => {
    render(
      createElement(kit.FormField, {
        label: "Volume",
        children: createElement(kit.Slider, { min: 10, max: 5, value: 500 }),
      })
    );
    const slider = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.value).toBe("100");
  });
});

describe("Combobox", () => {
  const options = [
    { value: "ts", label: "TypeScript" },
    { value: "js", label: "JavaScript", description: "Plain" },
    {
      label: "Systems",
      options: [
        { value: "rs", label: "Rust" },
        { value: "go", label: "Go" },
      ],
    },
    { value: "py", label: "Python", disabled: true },
  ];

  it("filters rows by label and description, keeping group labels only over their matches", () => {
    const entries = normalizeSelectOptions(options);
    const labels = (query: string) =>
      pickerRows(entries, query, true).map((row) =>
        row.kind === "label" ? `#${row.label}` : row.kind === "option" ? row.option.label : ""
      );
    expect(labels("")).toEqual(["TypeScript", "JavaScript", "#Systems", "Rust", "Go", "Python"]);
    expect(labels("rust")).toEqual(["#Systems", "Rust"]);
    expect(labels("plain")).toEqual(["JavaScript"]);
    expect(pickerRows(entries, "zzz", false)).toHaveLength(6);
  });

  it("opens a searchable list, filters as you type and picks with the keyboard", async () => {
    const onValueChange = vi.fn();
    const onSearchChange = vi.fn();
    render(
      inViewport(
        createElement(kit.Combobox, {
          "aria-label": "Language",
          options,
          placeholder: "Pick one",
          onValueChange,
          onSearchChange,
        })
      )
    );
    const trigger = screen.getByRole("combobox", { name: "Language" });
    expect(trigger.textContent).toContain("Pick one");
    expect(trigger.hasAttribute("data-placeholder")).toBe(true);
    const search = await openPicker("Language");
    expect(screen.getByRole("listbox", { name: "Language" })).toBeTruthy();
    expect(optionNames()).toContain("Systems");

    fireEvent.change(search, { target: { value: "ru" } });
    expect(onSearchChange).toHaveBeenLastCalledWith("ru");
    expect(optionNames()).toEqual(["Systems", "Rust"]);
    const rust = screen.getByRole("option", { name: "Rust" });
    expect(rust.getAttribute("aria-selected")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe(rust.id);

    await act(async () => {
      fireEvent.keyDown(search, { key: "Enter" });
    });
    expect(onValueChange).toHaveBeenCalledWith("rs");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.textContent).toContain("Rust");
  });

  it("skips disabled options and group labels with the arrow keys", async () => {
    render(inViewport(createElement(kit.Combobox, { "aria-label": "Language", options })));
    const search = await openPicker("Language");
    const active = () =>
      document.getElementById(search.getAttribute("aria-activedescendant") ?? "")?.textContent;
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(active()).toBe("TypeScript");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(active()).toBe("Rust");
    fireEvent.keyDown(search, { key: "End" });
    expect(active()).toBe("Go");
  });

  it("offers the typed text as a custom value", async () => {
    const onValueChange = vi.fn();
    render(
      inViewport(
        createElement(kit.Combobox, {
          "aria-label": "Branch",
          options: [{ value: "main", label: "main" }],
          allowCustomValue: true,
          value: "",
          onValueChange,
        })
      )
    );
    const search = await openPicker("Branch");
    fireEvent.change(search, { target: { value: "feature/x" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Use “feature/x”" }));
    });
    expect(onValueChange).toHaveBeenCalledWith("feature/x");
  });

  it("shows the empty message, and holds it back while options load", async () => {
    const { rerender } = render(
      inViewport(
        createElement(kit.Combobox, {
          "aria-label": "User",
          options: [],
          filter: "none",
          emptyMessage: "No users",
        })
      )
    );
    await openPicker("User");
    expect(screen.getByRole("status").textContent).toBe("No users");
    rerender(
      inViewport(
        createElement(kit.Combobox, {
          "aria-label": "User",
          options: [],
          filter: "none",
          loading: true,
          emptyMessage: "No users",
        })
      )
    );
    expect(screen.queryByText("No users")).toBeNull();
  });

  it("joins a FormField, and keeps the label of a pick its options no longer list", async () => {
    const { rerender } = render(
      inViewport(
        createElement(kit.FormField, {
          label: "Assignee",
          children: createElement(kit.Combobox, {
            options: [{ value: "u1", label: "Ada" }],
            filter: "none",
          }),
        })
      )
    );
    const trigger = screen.getByRole("combobox", { name: "Assignee" });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "Ada" }));
    });
    rerender(
      inViewport(
        createElement(kit.FormField, {
          label: "Assignee",
          children: createElement(kit.Combobox, { options: [], filter: "none" }),
        })
      )
    );
    expect(screen.getByRole("combobox", { name: "Assignee" }).textContent).toContain("Ada");
  });

  it("submits nothing while disabled, as a native field does", () => {
    const { container } = render(
      createElement(
        "form",
        null,
        createElement(kit.Combobox, {
          "aria-label": "Assignee",
          name: "assignee",
          value: "u1",
          options: [{ value: "u1", label: "Ada" }],
          disabled: true,
        }),
        createElement(kit.MultiSelect, {
          "aria-label": "Labels",
          name: "labels",
          value: ["bug"],
          options: [{ value: "bug", label: "bug" }],
          disabled: true,
        })
      )
    );
    const data = new FormData(container.querySelector("form")!);
    expect(data.has("assignee")).toBe(false);
    expect(data.has("labels")).toBe(false);
  });

  it("closes its list and takes no picks once disabled while open", async () => {
    const onValueChange = vi.fn();
    const props = {
      "aria-label": "Labels",
      options: [{ value: "bug", label: "bug" }],
      onValueChange,
    };
    const { rerender } = render(inViewport(createElement(kit.MultiSelect, props)));
    const search = await openPicker("Labels");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    rerender(inViewport(createElement(kit.MultiSelect, { ...props, disabled: true })));
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();
    await act(async () => {});
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("degrades bad props rather than throwing", () => {
    renderLoose(kit.Combobox, { "aria-label": "Loose", options: "nope", density: 3, value: 7 });
    expect(screen.getByRole("combobox", { name: "Loose" })).toBeTruthy();
  });
});

describe("MultiSelect", () => {
  const options = [
    { value: "bug", label: "bug" },
    { value: "docs", label: "docs" },
    { value: "perf", label: "perf" },
    { value: "ui", label: "ui" },
    { value: "ci", label: "ci" },
  ];

  it("toggles checkable options, stays open, and collapses extra chips into +N", async () => {
    const onValueChange = vi.fn();
    render(
      inViewport(
        createElement(kit.MultiSelect, {
          "aria-label": "Labels",
          options,
          defaultValue: ["bug", "docs", "perf"],
          maxChips: 2,
          onValueChange,
        })
      )
    );
    const trigger = screen.getByRole("combobox", { name: "Labels" });
    expect(trigger.textContent).toContain("+1");
    expect(trigger.querySelector(".sr-only")?.textContent).toBe("bug, docs, perf");
    await openPicker("Labels");
    expect(screen.getByRole("listbox").getAttribute("aria-multiselectable")).toBe("true");
    const bug = screen.getByRole("option", { name: "bug" });
    expect(bug.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "ui" }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith(["bug", "docs", "perf", "ui"]);
    expect(screen.getByRole("listbox")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "bug" }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith(["docs", "perf", "ui"]);
  });

  it("marks membership with aria-checked alone and draws the cursor from data-selected", async () => {
    render(
      inViewport(
        createElement(kit.MultiSelect, {
          "aria-label": "Labels",
          options,
          defaultValue: ["bug", "docs"],
        })
      )
    );
    const search = await openPicker("Labels");
    fireEvent.keyDown(search, { key: "End" });
    const ci = screen.getByRole("option", { name: "ci" });
    expect(search.getAttribute("aria-activedescendant")).toBe(ci.id);
    expect(ci.getAttribute("data-selected")).toBe("true");
    expect(ci.getAttribute("aria-checked")).toBe("false");
    for (const option of screen.getAllByRole("option")) {
      expect(option.hasAttribute("aria-selected")).toBe(false);
    }
    const bug = screen.getByRole("option", { name: "bug" });
    expect(bug.getAttribute("aria-checked")).toBe("true");
    expect(bug.hasAttribute("data-selected")).toBe(false);
  });

  it("shows a value named like an Object.prototype key as text", () => {
    render(
      createElement(kit.MultiSelect, {
        "aria-label": "Keys",
        options: [],
        value: ["__proto__", "constructor"],
      })
    );
    const trigger = screen.getByRole("combobox", { name: "Keys" });
    expect(trigger.querySelector(".sr-only")?.textContent).toBe("__proto__, constructor");
  });

  it("disables the rest of the list once max is reached", async () => {
    render(
      inViewport(
        createElement(kit.MultiSelect, {
          "aria-label": "Reviewers",
          options,
          value: ["bug", "docs"],
          max: 2,
        })
      )
    );
    await openPicker("Reviewers");
    expect(screen.getByRole("option", { name: "perf" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("option", { name: "bug" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("fits as many chips as the trigger holds, keeping room for the +N", () => {
    // Room for all three: no badge.
    expect(fitChipCount(300, [60, 60, 60], 3, 3, 4, 24)).toBe(3);
    // Five values, room for two chips and the badge but not a third chip.
    expect(fitChipCount(160, [60, 60, 60], 5, 3, 4, 24)).toBe(2);
    // The badge's room is kept: two chips would fit alone, not beside "+N".
    expect(fitChipCount(124, [60, 60, 60], 3, 3, 4, 24)).toBe(1);
    // Never more than maxChips, however wide.
    expect(fitChipCount(1000, [60, 60, 60, 60], 4, 2, 4, 24)).toBe(2);
    // Too narrow for even one chip at full width: one is still drawn, to truncate.
    expect(fitChipCount(40, [120, 60], 2, 3, 4, 24)).toBe(1);
    expect(fitChipCount(40, [], 0, 3, 4, 24)).toBe(0);
  });

  it("lets chips truncate before the +N or the chevron gives way", () => {
    render(
      createElement(kit.MultiSelect, {
        "aria-label": "Owners",
        options,
        value: ["bug", "docs", "perf", "ui"],
      })
    );
    const trigger = screen.getByRole("combobox", { name: "Owners" });
    const row = trigger.querySelector("[data-chip-row]")!;
    expect(row.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
    const chips = Array.from(row.querySelectorAll("[data-chip]"));
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      const classes = chip.className.split(" ");
      expect(classes).toEqual(expect.arrayContaining(["min-w-0", "shrink"]));
      expect(classes).not.toContain("shrink-0");
      expect(chip.firstElementChild!.className.split(" ")).toContain("truncate");
    }
    const badge = row.querySelector("[data-chip-overflow]")!;
    expect(badge.textContent).toBe("+1");
    expect(badge.className.split(" ")).toContain("shrink-0");
    expect(trigger.querySelector("svg")!.getAttribute("class")).toContain("shrink-0");
  });

  it("recounts the chips and the +N from the trigger's measured room", () => {
    type Entry = { target: Element; borderBoxSize: { inlineSize: number; blockSize: number }[] };
    let report: ((entries: Entry[]) => void) | undefined;
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: (entries: Entry[]) => void) {
          report = callback;
        }
        observe(target: Element) {
          observed.push(target);
        }
        disconnect() {}
        unobserve() {}
      }
    );
    try {
      render(
        createElement(kit.MultiSelect, {
          "aria-label": "Owners",
          options,
          value: ["bug", "docs", "perf", "ui", "ci"],
        })
      );
      const trigger = screen.getByRole("combobox", { name: "Owners" });
      const row = trigger.querySelector("[data-chip-row]")!;
      const ruler = trigger.querySelector("[data-chip-ruler]")!;
      expect(observed).toContain(row);
      const size = (target: Element, inlineSize: number): Entry => ({
        target,
        borderBoxSize: [{ inlineSize, blockSize: 20 }],
      });
      const [a, b, c, plus] = Array.from(ruler.children);
      act(() => {
        report!([size(row, 150), size(a!, 60), size(b!, 60), size(c!, 60), size(plus!, 24)]);
      });
      expect(row.querySelectorAll("[data-chip]")).toHaveLength(1);
      expect(row.querySelector("[data-chip-overflow]")!.textContent).toBe("+4");
      act(() => {
        report!([size(row, 400)]);
      });
      expect(row.querySelectorAll("[data-chip]")).toHaveLength(3);
      expect(row.querySelector("[data-chip-overflow]")!.textContent).toBe("+2");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("edges the trigger in the error ink inside a FormField with an error", () => {
    const pickers = [
      () => createElement(kit.Combobox, { options }),
      () => createElement(kit.MultiSelect, { options }),
    ];
    for (const picker of pickers) {
      render(
        createElement(
          "div",
          null,
          createElement(kit.FormField, {
            label: "Owner",
            error: "Pick someone",
            children: picker(),
          }),
          createElement(kit.FormField, { label: "Backup", children: picker() })
        )
      );
      const owner = screen.getByRole("combobox", { name: "Owner" });
      expect(owner.getAttribute("aria-invalid")).toBe("true");
      expect(owner.className.split(" ")).toContain("border-status-error");
      const backup = screen.getByRole("combobox", { name: "Backup" });
      expect(backup.className.split(" ")).not.toContain("border-status-error");
      cleanup();
    }
  });
});

describe("TagInput", () => {
  it("adds on Enter and comma, dedupes ignoring case, and removes with Backspace", () => {
    const onValueChange = vi.fn();
    render(createElement(kit.TagInput, { "aria-label": "Tags", onValueChange }));
    const field = screen.getByRole("textbox", { name: "Tags" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "alpha" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith(["alpha"]);
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "Beta" } });
    fireEvent.keyDown(field, { key: "," });
    fireEvent.change(field, { target: { value: "ALPHA" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onValueChange).toHaveBeenLastCalledWith(["alpha", "Beta"]);
    expect(onValueChange).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(onValueChange).toHaveBeenLastCalledWith(["alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
    expect(onValueChange).toHaveBeenLastCalledWith([]);
  });

  it("splits a pasted list and keeps what validate refuses in the field", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.TagInput, {
        "aria-label": "Emails",
        validate: (tag: string) => tag.includes("@"),
        onValueChange,
      })
    );
    const field = screen.getByRole("textbox", { name: "Emails" }) as HTMLInputElement;
    fireEvent.paste(field, {
      clipboardData: { getData: () => "a@x.dev, nope\nb@x.dev" },
    });
    expect(onValueChange).toHaveBeenLastCalledWith(["a@x.dev", "b@x.dev"]);
    expect(field.value).toBe("nope");
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("pastes a list over the selected text rather than after it", () => {
    const onValueChange = vi.fn();
    render(createElement(kit.TagInput, { "aria-label": "Tags", onValueChange }));
    const field = screen.getByRole("textbox", { name: "Tags" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "old" } });
    field.setSelectionRange(0, 3);
    fireEvent.paste(field, { clipboardData: { getData: () => "alpha,beta" } });
    expect(onValueChange).toHaveBeenLastCalledWith(["alpha", "beta"]);
    fireEvent.change(field, { target: { value: "ab" } });
    field.setSelectionRange(1, 1);
    fireEvent.paste(field, { clipboardData: { getData: () => "x,y" } });
    expect(onValueChange).toHaveBeenLastCalledWith(["alpha", "beta", "ax", "yb"]);
  });

  it("moves focus to the next tag, then the field, as the focused remove button goes", () => {
    render(createElement(kit.TagInput, { "aria-label": "Tags", defaultValue: ["a", "b"] }));
    const removeA = screen.getByRole("button", { name: "Remove a" });
    removeA.focus();
    fireEvent.click(removeA);
    const removeB = screen.getByRole("button", { name: "Remove b" });
    expect(document.activeElement).toBe(removeB);
    fireEvent.click(removeB);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Tags" }));
  });

  it("gives each remove button a 24px target that never reaches a neighbouring target, keeping the chip compact", () => {
    render(createElement(kit.TagInput, { "aria-label": "Tags", defaultValue: ["alpha", "beta"] }));
    const field = screen.getByRole("textbox", { name: "Tags" });
    const box = field.parentElement!;
    const px = (el: Element, prefix: string) => {
      const hit = el.className.split(" ").find((c) => c.startsWith(prefix));
      return hit === undefined ? undefined : Number(hit.slice(prefix.length)) * 4;
    };
    const gap = px(box, "gap-")!;
    const rowHeight = px(field, "h-")!;
    for (const name of ["Remove alpha", "Remove beta"]) {
      const button = screen.getByRole("button", { name });
      const chip = button.parentElement!;
      const classes = button.className.split(" ");
      const glyph = px(button, "h-")!;
      expect(px(button, "w-")).toBe(glyph);
      // The hit area is an absolutely placed pseudo-element on the button,
      // pushed out past the glyph on every side.
      expect(classes).toContain("relative");
      expect(classes).toContain("after:absolute");
      expect(classes).toContain("after:content-['']");
      const reach = px(button, "after:-inset-")!;
      expect(glyph + 2 * reach).toBeGreaterThanOrEqual(24);
      // The glyph itself stays chip-sized: no taller than the text line.
      expect(glyph).toBeLessThanOrEqual(16);
      // Sideways it passes the chip's edge by no more than half the gap, so it
      // cannot meet the next chip's text or target, or the field.
      expect(reach - px(chip, "pr-")!).toBeLessThanOrEqual(gap / 2);
      // Upright it stays inside the row the field sets, so wrapped rows' targets
      // are held apart by the gap between rows.
      expect(glyph + 2 * reach).toBeLessThanOrEqual(rowHeight);
    }
  });

  it("joins a FormField and honours max", () => {
    const onValueChange = vi.fn();
    render(
      createElement(kit.FormField, {
        label: "Topics",
        children: createElement(kit.TagInput, { defaultValue: ["a"], max: 1, onValueChange }),
      })
    );
    const field = screen.getByRole("textbox", { name: "Topics" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "b" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onValueChange).not.toHaveBeenCalled();
    expect(field.value).toBe("b");
  });
});

describe("FileDropzone", () => {
  function file(name: string, type = "") {
    return new File(["x"], name, { type });
  }

  it("matches accept like a file input does", () => {
    expect(fileMatchesAccept(file("a.MD"), ".md,.txt")).toBe(true);
    expect(fileMatchesAccept(file("a.png", "image/png"), "image/*")).toBe(true);
    expect(fileMatchesAccept(file("a.pdf", "application/pdf"), "image/*,.md")).toBe(false);
    expect(fileMatchesAccept(file("a.pdf", "application/pdf"), "application/pdf")).toBe(true);
    expect(fileMatchesAccept(file("anything"), undefined)).toBe(true);
  });

  it("hands over dropped files, splitting out what accept refuses", () => {
    const onFiles = vi.fn();
    const onReject = vi.fn();
    render(
      createElement(kit.FileDropzone, {
        onFiles,
        onReject,
        accept: ".md",
        multiple: true,
        "data-testid": "zone",
      })
    );
    const zone = screen.getByTestId("zone");
    const files = [file("a.md"), file("b.png"), file("c.md")];
    const dataTransfer = { types: ["Files"], files, dropEffect: "none" };
    // At rest the edge is the theme's 3:1 control-edge ink; a drag steps it up
    // and adds a fill.
    expect(zone.className).toContain("border-selection-outline");
    fireEvent.dragEnter(zone, { dataTransfer });
    expect(zone.hasAttribute("data-drag-over")).toBe(true);
    expect(zone.className).toContain("border-text-secondary");
    expect(zone.className).toContain("bg-overlay-soft");
    expect(zone.className).not.toContain("accent");
    fireEvent.drop(zone, { dataTransfer });
    expect(zone.hasAttribute("data-drag-over")).toBe(false);
    expect(zone.className).toContain("border-selection-outline");
    expect(onFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(["a.md", "c.md"]);
    expect(onReject.mock.calls[0]![0].map((f: File) => f.name)).toEqual(["b.png"]);
  });

  it("keeps one file without multiple, and ignores drags that carry no files", () => {
    const onFiles = vi.fn();
    render(createElement(kit.FileDropzone, { onFiles, "data-testid": "zone" }));
    const zone = screen.getByTestId("zone");
    fireEvent.drop(zone, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [file("a.txt"), file("b.txt")] },
    });
    expect(onFiles.mock.calls[0]![0].map((f: File) => f.name)).toEqual(["a.txt"]);
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeTruthy();
  });

  it("opens the file dialog from its button and delivers the input's files", () => {
    const onFiles = vi.fn();
    const { container } = render(
      createElement(kit.FormField, {
        label: "Attachments",
        children: createElement(kit.FileDropzone, { onFiles, multiple: true, accept: "image/*" }),
      })
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, "click");
    const button = screen.getByRole("button", { name: "Attachments Choose files…" });
    fireEvent.click(button);
    expect(click).toHaveBeenCalled();
    fireEvent.change(input, { target: { files: [file("a.png", "image/png")] } });
    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled", () => {
    const onFiles = vi.fn();
    render(createElement(kit.FileDropzone, { onFiles, disabled: true, "data-testid": "zone" }));
    fireEvent.drop(screen.getByTestId("zone"), {
      dataTransfer: { types: ["Files"], files: [file("a.txt")] },
    });
    expect(onFiles).not.toHaveBeenCalled();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("EmojiPicker", () => {
  it("opens from its trigger and reports the pick, then closes", async () => {
    const onSelect = vi.fn();
    render(
      createElement(kit.EmojiPicker, {
        trigger: createElement(kit.Button, { children: "Icon" }),
        onSelect,
        value: "🙂",
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Icon" }));
    });
    const panel = await screen.findByRole("dialog", { name: "Choose emoji" });
    expect(panel).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pick rocket" }));
    });
    expect(onSelect).toHaveBeenCalledWith("🚀");
    expect(screen.queryByRole("dialog", { name: "Choose emoji" })).toBeNull();
  });

  it("renders nothing without a trigger element", () => {
    const { container } = renderLoose(kit.EmojiPicker, { trigger: "nope" });
    expect(container.innerHTML).toBe("");
  });
});
