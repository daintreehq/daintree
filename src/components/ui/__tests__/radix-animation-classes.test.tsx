// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { PopoverContent } from "../popover";
import { DropdownMenuContent, DropdownMenuSubContent } from "../dropdown-menu";

afterEach(cleanup);

const ENTER_EXIT_CLASSES = [
  "data-[state=open]:animate-in",
  "data-[state=closed]:animate-out",
  "data-[state=open]:fade-in-0",
  "data-[state=closed]:fade-out-0",
  "data-[state=open]:zoom-in-95",
  "data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-2",
  "data-[side=left]:slide-in-from-right-2",
  "data-[side=right]:slide-in-from-left-2",
  "data-[side=top]:slide-in-from-bottom-2",
];

const UI_DURATION_CLASSES = [
  "data-[state=open]:duration-200",
  "data-[state=closed]:duration-[120ms]",
];

const TOOLTIP_CLASSES = [
  "animate-in",
  "fade-in-0",
  "zoom-in-95",
  "duration-150",
  "data-[state=closed]:animate-out",
  "data-[state=closed]:duration-[100ms]",
  "data-[state=closed]:fade-out-0",
  "data-[state=closed]:zoom-out-95",
  "data-[side=bottom]:slide-in-from-top-2",
  "data-[side=left]:slide-in-from-right-2",
  "data-[side=right]:slide-in-from-left-2",
  "data-[side=top]:slide-in-from-bottom-2",
];

function expectAllInString(haystack: string, needles: string[], label: string) {
  for (const needle of needles) {
    expect(haystack, `${label} missing class: ${needle}`).toContain(needle);
  }
}

function readWrapperSource(file: string): string {
  return readFileSync(path.join(__dirname, "..", file), "utf8");
}

describe("Radix overlay animation classes — runtime render", () => {
  it("PopoverContent renders with full enter/exit class set and UI durations", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    const el = document.querySelector("[data-radix-popper-content-wrapper] > *") as HTMLElement;
    expect(el).toBeTruthy();
    expectAllInString(el.className, ENTER_EXIT_CLASSES, "PopoverContent");
    expectAllInString(el.className, UI_DURATION_CLASSES, "PopoverContent");
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
    const el = document.querySelector("[role='menu']") as HTMLElement;
    expect(el).toBeTruthy();
    expectAllInString(el.className, ENTER_EXIT_CLASSES, "DropdownMenuContent");
    expectAllInString(el.className, UI_DURATION_CLASSES, "DropdownMenuContent");
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
    const sub = menus[menus.length - 1] as HTMLElement;
    expect(sub).toBeTruthy();
    expectAllInString(sub.className, ENTER_EXIT_CLASSES, "DropdownMenuSubContent");
    expectAllInString(sub.className, UI_DURATION_CLASSES, "DropdownMenuSubContent");
  });
});

describe("Radix overlay animation classes — wrapper source", () => {
  it("popover.tsx contains the full enter/exit set and UI durations", () => {
    const src = readWrapperSource("popover.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "popover.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "popover.tsx");
  });

  it("dropdown-menu.tsx contains the full enter/exit set and UI durations on Content and SubContent", () => {
    const src = readWrapperSource("dropdown-menu.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "dropdown-menu.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "dropdown-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
  });

  it("context-menu.tsx contains the full enter/exit set and UI durations on Content and SubContent", () => {
    const src = readWrapperSource("context-menu.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "context-menu.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "context-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
  });

  it("select.tsx contains the full enter/exit set and UI durations", () => {
    const src = readWrapperSource("select.tsx");
    expectAllInString(src, ENTER_EXIT_CLASSES, "select.tsx");
    expectAllInString(src, UI_DURATION_CLASSES, "select.tsx");
  });

  it("tooltip.tsx contains palette enter/exit set with palette durations", () => {
    const src = readWrapperSource("tooltip.tsx");
    expectAllInString(src, TOOLTIP_CLASSES, "tooltip.tsx");
  });
});
