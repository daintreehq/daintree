// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { ContextMenuContent, ContextMenuSubContent } from "../context-menu";
import { DropdownMenuContent, DropdownMenuSubContent } from "../dropdown-menu";
import { PopoverContent } from "../popover";
import { primeRadix } from "../radix-loader";

/**
 * Issue #12347 — overlay content portals to `document.body`, outside the
 * toolbar's `app-drag-region` subtree. Chromium derives the OS draggable
 * region geometrically (drag rects minus no-drag rects), so a portaled
 * surface that claims no no-drag rect leaves the toolbar's `drag` showing
 * through wherever the two overlap, and clicks on the items painted there
 * are swallowed as window drags.
 *
 * jsdom resolves no `-webkit-app-region`, so there is no browser-behaviour
 * claim here. What these pin is that the opt-out reaches the DOM node that
 * actually paints over the toolbar, survives `cn()`, and stays wired to a
 * real CSS rule.
 */

const UI_DIR = path.join(__dirname, "..");
const NO_DRAG = "app-no-drag";

beforeAll(async () => {
  await primeRadix();
});

afterEach(cleanup);

function probe(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!(el instanceof HTMLElement)) {
    throw new Error(
      `${selector}: expected a rendered HTMLElement, got ${el === null ? "null" : typeof el}`
    );
  }
  return el;
}

function classTokens(el: HTMLElement): Set<string> {
  return new Set(el.className.split(/\s+/));
}

function renderContextMenu(callerClass = "") {
  const { container } = render(
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger data-testid="trigger">trigger</ContextMenuPrimitive.Trigger>
      <ContextMenuContent className={`probe-content ${callerClass}`}>
        <ContextMenuPrimitive.Sub open>
          <ContextMenuPrimitive.SubTrigger>more</ContextMenuPrimitive.SubTrigger>
          <ContextMenuSubContent className="probe-sub">item</ContextMenuSubContent>
        </ContextMenuPrimitive.Sub>
      </ContextMenuContent>
    </ContextMenuPrimitive.Root>
  );
  // Context menus have no `open` on the root — the gesture is what mounts the
  // portal, so fire it rather than forcing the content.
  fireEvent.contextMenu(probeIn(container, "[data-testid='trigger']"));
}

function renderDropdownMenu(callerClass = "") {
  render(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
      <DropdownMenuContent className={`probe-content ${callerClass}`}>
        <DropdownMenuPrimitive.Sub open>
          <DropdownMenuPrimitive.SubTrigger>more</DropdownMenuPrimitive.SubTrigger>
          <DropdownMenuSubContent className="probe-sub">item</DropdownMenuSubContent>
        </DropdownMenuPrimitive.Sub>
      </DropdownMenuContent>
    </DropdownMenuPrimitive.Root>
  );
}

function renderPopover(callerClass = "") {
  render(
    <PopoverPrimitive.Root open>
      <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
      <PopoverContent forceMount className={`probe-content ${callerClass}`}>
        content
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}

function probeIn(container: HTMLElement, selector: string): HTMLElement {
  const el = container.querySelector(selector);
  if (!(el instanceof HTMLElement)) throw new Error(`${selector} not found`);
  return el;
}

describe("portaled overlay content opts out of the OS drag region — issue #12347", () => {
  it.each([
    ["ContextMenuContent", renderContextMenu, ".probe-content"],
    ["ContextMenuSubContent", renderContextMenu, ".probe-sub"],
    ["DropdownMenuContent", renderDropdownMenu, ".probe-content"],
    ["DropdownMenuSubContent", renderDropdownMenu, ".probe-sub"],
    ["PopoverContent", renderPopover, ".probe-content"],
  ])(
    "%s carries the opt-out on the element that paints over the toolbar",
    (_name, mount, selector) => {
      mount();
      expect(classTokens(probe(selector))).toContain(NO_DRAG);
    }
  );

  it.each([
    ["ContextMenuContent", renderContextMenu],
    ["DropdownMenuContent", renderDropdownMenu],
    ["PopoverContent", renderPopover],
  ])("%s keeps the opt-out when a caller supplies its own classes", (_name, mount) => {
    // `cn()` runs tailwind-merge, which is free to drop a token it believes a
    // later class supersedes. A consumer passing layout classes is the common
    // case, and it must not be able to hand the toolbar back its dead zone.
    mount("w-80 p-0 absolute");
    expect(classTokens(probe(".probe-content"))).toContain(NO_DRAG);
  });
});

describe("the opt-out stays wired to a real rule", () => {
  it("`.app-no-drag` sets both spellings of the OS property, for itself and its descendants", () => {
    // Without this rule the class the primitives stamp is decoration, and
    // every assertion above passes while the bug is fully back. The
    // descendant half is what carries the opt-out to the menu items, which
    // never carry the class themselves.
    const css = readFileSync(path.join(UI_DIR, "..", "..", "index.css"), "utf8");
    const rule = /\.app-no-drag,\s*\n\s*\.app-no-drag \*\s*\{([^}]*)\}/.exec(css);
    expect(rule, "`.app-no-drag, .app-no-drag *` rule missing from src/index.css").not.toBeNull();
    const declarations = rule?.[1] ?? "";
    expect(declarations).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(declarations).toMatch(/(?<!-)\bapp-region:\s*no-drag/);
  });
});

describe("no ui/ primitive portals over the toolbar without opting out", () => {
  // Deliberately exempt. Tooltips are non-interactive, so they have no dead
  // click zone to fix — and marking them no-drag would instead carve a dead
  // *drag* zone out of the title bar for as long as one is showing.
  const EXEMPT = new Set(["tooltip.tsx"]);

  it("every module rendering a Radix Portal stamps the opt-out", () => {
    // The failure this exists for: a sixth anchored surface is added next to
    // these five, portals to `document.body` like the rest, and reintroduces
    // the bug on its own — invisibly, because no existing test renders it.
    const offenders = readdirSync(UI_DIR)
      .filter((file) => file.endsWith(".tsx") && !EXEMPT.has(file))
      .filter((file) => {
        const src = readFileSync(path.join(UI_DIR, file), "utf8");
        return /radix\.\w+\.Portal\b/.test(src) && !src.includes(NO_DRAG);
      });
    expect(offenders, `add "${NO_DRAG}" to the portaled content, or exempt with a reason`).toEqual(
      []
    );
  });
});
