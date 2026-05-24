// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as SelectPrimitive from "@radix-ui/react-select";
import { PopoverContent } from "../popover";
import { DropdownMenuContent, DropdownMenuSubContent } from "../dropdown-menu";
import { SelectContent } from "../select";
import { primeRadix } from "../radix-loader";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

const ENTER_EXIT_CLASSES = [
  "data-[state=open]:animate-in",
  "data-[state=closed]:animate-out",
  "data-[state=open]:fade-in-0",
  "data-[state=closed]:fade-out-0",
  "data-[state=open]:zoom-in-97",
  "data-[state=closed]:zoom-out-97",
  "data-[side=bottom]:slide-in-from-top-1",
  "data-[side=left]:slide-in-from-right-1",
  "data-[side=right]:slide-in-from-left-1",
  "data-[side=top]:slide-in-from-bottom-1",
];

const UI_DURATION_CLASSES = [
  "data-[state=open]:duration-200",
  "data-[state=closed]:duration-[120ms]",
];

const SELECT_CLASSES = [
  "data-[state=open]:animate-in",
  "data-[state=closed]:animate-out",
  "data-[state=open]:fade-in-0",
  "data-[state=closed]:fade-out-0",
  "data-[state=open]:zoom-in-98",
  "data-[state=closed]:zoom-out-98",
  "data-[side=bottom]:slide-in-from-top-1",
  "data-[side=left]:slide-in-from-right-1",
  "data-[side=right]:slide-in-from-left-1",
  "data-[side=top]:slide-in-from-bottom-1",
];

const TRANSFORM_ORIGIN_VARS: Record<string, string> = {
  popover: "var(--radix-popover-content-transform-origin)",
  dropdownContent: "var(--radix-dropdown-menu-content-transform-origin)",
  dropdownSubContent: "var(--radix-dropdown-menu-content-transform-origin)",
  contextContent: "var(--radix-context-menu-content-transform-origin)",
  contextSubContent: "var(--radix-context-menu-content-transform-origin)",
  select: "var(--radix-select-content-transform-origin)",
};

const TOOLTIP_CLASSES = [
  "animate-in",
  "fade-in-0",
  "duration-150",
  "data-[state=closed]:animate-out",
  "data-[state=closed]:duration-[100ms]",
  "data-[state=closed]:fade-out-0",
  "data-[side=bottom]:slide-in-from-top-1",
  "data-[side=left]:slide-in-from-right-1",
  "data-[side=right]:slide-in-from-left-1",
  "data-[side=top]:slide-in-from-bottom-1",
];

function expectAllInString(haystack: string, needles: string[], label: string) {
  for (const needle of needles) {
    expect(haystack, `${label} missing class: ${needle}`).toContain(needle);
  }
}

function readWrapperSource(file: string): string {
  return readFileSync(path.join(__dirname, "..", file), "utf8");
}

function assertHTMLElement(el: Element | null | undefined, label: string): HTMLElement {
  if (!(el instanceof HTMLElement)) {
    throw new Error(`${label}: expected HTMLElement, got ${el === null ? "null" : typeof el}`);
  }
  return el;
}

describe("Radix overlay animation classes — runtime render", () => {
  it("PopoverContent renders with full enter/exit class set and UI durations", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    const el = assertHTMLElement(
      document.querySelector("[data-radix-popper-content-wrapper] > *"),
      "PopoverContent"
    );
    expectAllInString(el.className, ENTER_EXIT_CLASSES, "PopoverContent");
    expectAllInString(el.className, UI_DURATION_CLASSES, "PopoverContent");
    expect(el.style.transformOrigin).toBe(TRANSFORM_ORIGIN_VARS.popover);
  });

  it("DropdownMenuContent renders with full enter/exit class set and UI durations", () => {
    render(
      <DropdownMenuPrimitive.Root open>
        <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
        <DropdownMenuContent forceMount>
          <DropdownMenuPrimitive.Item>item</DropdownMenuPrimitive.Item>
        </DropdownMenuContent>
      </DropdownMenuPrimitive.Root>
    );
    const el = assertHTMLElement(document.querySelector("[role='menu']"), "DropdownMenuContent");
    expectAllInString(el.className, ENTER_EXIT_CLASSES, "DropdownMenuContent");
    expectAllInString(el.className, UI_DURATION_CLASSES, "DropdownMenuContent");
    expect(el.style.transformOrigin).toBe(TRANSFORM_ORIGIN_VARS.dropdownContent);
  });

  it("DropdownMenuSubContent renders with full enter/exit class set and UI durations", () => {
    render(
      <DropdownMenuPrimitive.Root open>
        <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
        <DropdownMenuContent forceMount>
          <DropdownMenuPrimitive.Sub open>
            <DropdownMenuPrimitive.SubTrigger>sub</DropdownMenuPrimitive.SubTrigger>
            <DropdownMenuSubContent forceMount>
              <DropdownMenuPrimitive.Item>sub-item</DropdownMenuPrimitive.Item>
            </DropdownMenuSubContent>
          </DropdownMenuPrimitive.Sub>
        </DropdownMenuContent>
      </DropdownMenuPrimitive.Root>
    );
    const menus = document.querySelectorAll("[role='menu']");
    const sub = assertHTMLElement(menus[menus.length - 1], "DropdownMenuSubContent");
    expectAllInString(sub.className, ENTER_EXIT_CLASSES, "DropdownMenuSubContent");
    expectAllInString(sub.className, UI_DURATION_CLASSES, "DropdownMenuSubContent");
    expect(sub.style.transformOrigin).toBe(TRANSFORM_ORIGIN_VARS.dropdownSubContent);
  });

  it("PopoverContent respects caller-provided transformOrigin override", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount style={{ transformOrigin: "center" } as React.CSSProperties}>
          content
        </PopoverContent>
      </PopoverPrimitive.Root>
    );
    const el = assertHTMLElement(
      document.querySelector("[data-radix-popper-content-wrapper] > *"),
      "PopoverContent"
    );
    expect(el.style.transformOrigin).toBe("center");
  });
});

describe("Radix overlay animation classes — wrapper source", () => {
  it("popover.tsx contains the full enter/exit set and UI durations", () => {
    const src = readWrapperSource("popover.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "popover.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "popover.tsx");
    expect(src).toContain("var(--radix-popover-content-transform-origin)");
  });

  it("dropdown-menu.tsx contains the full enter/exit set and UI durations on Content and SubContent", () => {
    const src = readWrapperSource("dropdown-menu.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "dropdown-menu.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "dropdown-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
    const originOccurrences =
      src.split("var(--radix-dropdown-menu-content-transform-origin)").length - 1;
    expect(originOccurrences, "transformOrigin must appear on both Content and SubContent").toBe(2);
  });

  it("context-menu.tsx contains the full enter/exit set and UI durations on Content and SubContent", () => {
    const src = readWrapperSource("context-menu.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "context-menu.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "context-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
    const originOccurrences =
      src.split("var(--radix-context-menu-content-transform-origin)").length - 1;
    expect(originOccurrences, "transformOrigin must appear on both Content and SubContent").toBe(2);
  });

  it("select.tsx contains the full enter/exit set and UI durations", () => {
    const src = readWrapperSource("select.tsx");
    expectAllInString(src, SELECT_CLASSES, "select.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "select.tsx");
    expect(src).toContain("var(--radix-select-content-transform-origin)");
  });

  it("SelectContent renders with select-specific enter/exit class set and UI durations", () => {
    render(
      <SelectPrimitive.Root open>
        <SelectPrimitive.Trigger>trigger</SelectPrimitive.Trigger>
        <SelectContent forceMount>
          <SelectPrimitive.Item value="a">a</SelectPrimitive.Item>
        </SelectContent>
      </SelectPrimitive.Root>
    );
    const el = assertHTMLElement(
      document.querySelector("[data-radix-popper-content-wrapper] > *"),
      "SelectContent"
    );
    expectAllInString(el.className, SELECT_CLASSES, "SelectContent");
    expectAllInString(el.className, UI_DURATION_CLASSES, "SelectContent");
    expect(el.style.transformOrigin).toBe(TRANSFORM_ORIGIN_VARS.select);
  });

  it("tooltip.tsx contains palette enter/exit set with palette durations", () => {
    const src = readWrapperSource("tooltip.tsx");
    expectAllInString(src, TOOLTIP_CLASSES, "tooltip.tsx");
    expect(src).toContain("var(--radix-tooltip-content-transform-origin)");
  });

  it("tooltip.tsx defaults to viewport-aware collisionPadding and width cap (issue #8008)", () => {
    const src = readWrapperSource("tooltip.tsx");
    expect(src).toContain("collisionPadding = 8");
    expect(src).toContain("collisionPadding={collisionPadding}");
    expect(src).toContain("max-w-xs");
  });

  it("tooltip.tsx wires a pointerActiveRef focus-visible filter (issue #8008)", () => {
    const src = readWrapperSource("tooltip.tsx");
    expect(src).toContain("pointerActiveRef");
    expect(src).toContain("onPointerDown");
    expect(src).toContain("onPointerUp");
    // The focus-capture handler must early-return when the ref is set —
    // otherwise the click-to-focus path opens the tooltip and it strands
    // until the next pointer move.
    expect(src).toMatch(/if \(pointerActiveRef\.current\) return/);
  });
});
