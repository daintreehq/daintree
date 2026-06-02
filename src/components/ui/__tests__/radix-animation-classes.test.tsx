// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { PopoverContent } from "../popover";
import { primeRadix } from "../radix-loader";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

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
  it("dropdown-menu.tsx applies enter/exit duration and transformOrigin on both Content and SubContent", () => {
    const src = readWrapperSource("dropdown-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
    const originOccurrences =
      src.split("var(--radix-dropdown-menu-content-transform-origin)").length - 1;
    expect(originOccurrences, "transformOrigin must appear on both Content and SubContent").toBe(2);
  });

  it("context-menu.tsx applies enter/exit duration and transformOrigin on both Content and SubContent", () => {
    const src = readWrapperSource("context-menu.tsx");
    const occurrences = src.split("data-[state=open]:duration-200").length - 1;
    expect(occurrences, "duration-200 must appear on both Content and SubContent").toBe(2);
    const originOccurrences =
      src.split("var(--radix-context-menu-content-transform-origin)").length - 1;
    expect(originOccurrences, "transformOrigin must appear on both Content and SubContent").toBe(2);
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

  it("DockedTerminalItem.tsx does not contain stale animation classes", () => {
    const src = readWrapperSource("../Layout/DockedTerminalItem.tsx");
    expect(src).not.toContain("slide-in-from-top-2");
    expect(src).not.toContain("slide-in-from-right-2");
    expect(src).not.toContain("slide-in-from-left-2");
    expect(src).not.toContain("slide-in-from-bottom-2");
    expect(src).not.toContain("zoom-in-95");
    expect(src).not.toContain("zoom-out-95");
  });
});
