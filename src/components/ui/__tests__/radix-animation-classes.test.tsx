// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { PopoverContent } from "../popover";
import { primeRadix } from "../radix-loader";
import { OVERLAY_MOTION_CLASS, TOOLTIP_MOTION_CLASS } from "../overlayMotion";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
} from "@/lib/animationUtils";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

const SRC_ROOT = path.join(__dirname, "..", "..", "..");

function readWrapperSource(file: string): string {
  return readFileSync(path.join(__dirname, "..", file), "utf8");
}

function assertHTMLElement(el: Element | null | undefined, label: string): HTMLElement {
  if (!(el instanceof HTMLElement)) {
    throw new Error(`${label}: expected HTMLElement, got ${el === null ? "null" : typeof el}`);
  }
  return el;
}

function renderPopoverContent(): HTMLElement {
  render(
    <PopoverPrimitive.Root open>
      <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
      <PopoverContent forceMount>content</PopoverContent>
    </PopoverPrimitive.Root>
  );
  return assertHTMLElement(
    document.querySelector("[data-radix-popper-content-wrapper] > *"),
    "PopoverContent"
  );
}

describe("Radix overlay animation classes — runtime render", () => {
  it("PopoverContent respects caller-provided transformOrigin override", () => {
    // Load-bearing for the zoom, not incidental: the scale grows from this
    // origin, so a surface that lost it would zoom from its centre instead of
    // from the anchor it is attached to.
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

  it("every token of the shared motion survives cn() into the rendered className", () => {
    // Counting the constant's name in the source proves only that it was
    // imported. This proves it was actually applied AND that `tailwind-merge`
    // did not quietly drop a token on the way — the two ways the shared
    // definition can stop reaching the DOM while every other test passes.
    const rendered = new Set(renderPopoverContent().className.split(/\s+/));
    const missing = OVERLAY_MOTION_CLASS.split(" ").filter((token) => !rendered.has(token));
    expect(missing, "tokens absent from the rendered PopoverContent").toEqual([]);
  });

  it("a caller className cannot silently strip the motion", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount className="w-80 p-0">
          content
        </PopoverContent>
      </PopoverPrimitive.Root>
    );
    const el = assertHTMLElement(
      document.querySelector("[data-radix-popper-content-wrapper] > *"),
      "PopoverContent"
    );
    const rendered = new Set(el.className.split(/\s+/));
    const missing = OVERLAY_MOTION_CLASS.split(" ").filter((token) => !rendered.has(token));
    expect(missing, "caller classes must not displace the shared motion").toEqual([]);
  });
});

describe("Radix overlay animation classes — wrapper source", () => {
  // The count is of references BEYOND the import line: an import alone satisfies
  // a naive occurrence count while the component renders no motion at all.
  it.each([
    ["popover.tsx", "OVERLAY_MOTION_CLASS", 1],
    ["select.tsx", "OVERLAY_MOTION_CLASS", 1],
    ["dropdown-menu.tsx", "OVERLAY_MOTION_CLASS", 2],
    ["context-menu.tsx", "OVERLAY_MOTION_CLASS", 2],
    ["tooltip.tsx", "TOOLTIP_MOTION_CLASS", 1],
  ])("%s applies %s to each of its content components", (file, constant, expected) => {
    const applications = readWrapperSource(file)
      .split("\n")
      .filter((line) => line.includes(constant) && !line.trimStart().startsWith("import"));
    expect(applications.length, `${constant} must be applied ${expected}x in ${file}`).toBe(
      expected
    );
  });

  it.each([
    ["dropdown-menu.tsx", "--radix-dropdown-menu-content-transform-origin"],
    ["context-menu.tsx", "--radix-context-menu-content-transform-origin"],
  ])("%s sets transformOrigin on both Content and SubContent", (file, variable) => {
    const src = readWrapperSource(file);
    expect(src.split(`var(${variable})`).length - 1).toBe(2);
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

/**
 * What this family is allowed to look like.
 *
 * There is no browser-behaviour claim here on purpose. jsdom resolves neither
 * `@keyframes` nor `transform` grammar, so an assertion about what Chromium
 * accepts would be a guess dressed as a guard. What these DO pin is that the
 * motion has exactly one home, that the two duration tiers stay tied to
 * `animationUtils.ts`, and that the slide keeps its direction and distance.
 */
describe("overlay motion is defined once and stays on its tiers", () => {
  it.each([
    ["open", UI_ENTER_DURATION],
    ["closed", UI_EXIT_DURATION],
  ])("times its %s state on the shared entry/exit tier", (state, duration) => {
    // Not a tautology: these are two independent spellings of one value — a JS
    // constant the dialogs animate on, and a Tailwind class a utility cannot
    // read it from. Deriving the class here is what makes retiming
    // `animationUtils.ts` fail loudly instead of desyncing the overlays.
    expect(OVERLAY_MOTION_CLASS).toContain(`data-[state=${state}]:duration-${duration}`);
  });

  it.each([
    ["enter", UI_PALETTE_ENTER_DURATION, "duration-"],
    ["exit", UI_PALETTE_EXIT_DURATION, "data-[state=closed]:duration-"],
  ])("times its tooltip %s on the palette/tooltip tier", (_phase, duration, prefix) => {
    expect(TOOLTIP_MOTION_CLASS).toContain(`${prefix}${duration}`);
  });

  it("leaves the tooltip unscaled", () => {
    // Not drift: a 3% scale on a one-line chip is subpixel blur and no signal.
    expect(TOOLTIP_MOTION_CLASS).not.toMatch(/zoom-(?:in|out)/);
  });

  it.each([
    ["bottom", "top"],
    ["top", "bottom"],
    ["left", "right"],
    ["right", "left"],
  ])("slides a %s-placed surface in from the %s, at the same distance", (side, from) => {
    // Direction AND distance: a surface that slid in from the wrong side, or
    // eight times as far as its neighbours, satisfies a prefix-only check.
    for (const motion of [OVERLAY_MOTION_CLASS, TOOLTIP_MOTION_CLASS]) {
      expect(motion).toContain(`data-[side=${side}]:slide-in-from-${from}-1`);
    }
  });

  it("is the only module in src/ that spells the motion out", () => {
    // The failure mode this exists for: someone adds a sixth anchored surface
    // and pastes the class list in rather than importing it, and the whole set
    // is back to being edited in N places. Scoped to the state/side-qualified
    // vocabulary, so an ordinary `motion-safe:animate-in fade-in` content fade
    // stays legal anywhere, as do the transition-based dialogs and
    // `FixedDropdown`, which are a different mechanism entirely.
    const INLINE_MOTION =
      /data-\[(?:state|side)=[a-z]+\]:(?:animate-(?:in|out)|zoom-|slide-in-from-)/;
    const allowed = new Set([
      path.join(SRC_ROOT, "components", "ui", "overlayMotion.ts"),
      path.join(SRC_ROOT, "components", "ui", "__tests__", "radix-animation-classes.test.tsx"),
    ]);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (/\.tsx?$/.test(entry) && !allowed.has(full)) {
          if (INLINE_MOTION.test(readFileSync(full, "utf8"))) {
            offenders.push(path.relative(SRC_ROOT, full));
          }
        }
      }
    };
    walk(SRC_ROOT);

    expect(offenders, "import OVERLAY_MOTION_CLASS instead of inlining the class list").toEqual([]);
  });
});
