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

  it("composes the opt-out with a caller className rather than being replaced by it", () => {
    // Deliberately not a tailwind-merge claim: `app-no-drag` belongs to no
    // conflict group, so twMerge would never drop it and such a test could not
    // fail. What this pins is the composition — a primitive rewritten to use
    // the caller's `className` in place of its own base list, rather than
    // merging the two, hands the toolbar back its dead zone.
    renderPopover("w-80 p-0 absolute");
    const tokens = classTokens(probe(".probe-content"));
    expect(tokens).toContain(NO_DRAG);
    expect(tokens).toContain("w-80");
  });
});

describe("the opt-out stays wired to a real rule", () => {
  it("`.app-no-drag` sets both spellings of the OS property, for itself and its descendants", () => {
    // Without this rule the class the primitives stamp is decoration, and
    // every assertion above passes while the bug is fully back. The
    // descendant half is what carries the opt-out to the menu items, which
    // never carry the class themselves.
    const css = readFileSync(path.join(UI_DIR, "..", "..", "index.css"), "utf8");
    // Built from NO_DRAG, not spelled again: renaming the class in the
    // primitives and here, but not in the stylesheet, would otherwise ship a
    // class with no rule behind it and leave this suite green.
    const rule = new RegExp(`\\.${NO_DRAG},\\s*\\n\\s*\\.${NO_DRAG} \\*\\s*\\{([^}]*)\\}`).exec(
      css
    );
    expect(rule, `\`.${NO_DRAG}, .${NO_DRAG} *\` rule missing from src/index.css`).not.toBeNull();
    const declarations = rule?.[1] ?? "";
    expect(declarations).toMatch(/-webkit-app-region:\s*no-drag/);
    expect(declarations).toMatch(/(?<!-)\bapp-region:\s*no-drag/);
  });
});

describe("no ui/ surface portals over the toolbar without opting out", () => {
  // Every exemption is a geometry claim, and each one is why this list is
  // spelled out rather than inferred.
  const EXEMPT: Record<string, string> = {
    "tooltip.tsx":
      "non-interactive, so there is no dead click zone to fix — and opting it out would carve a dead *drag* zone out of the title bar for as long as one shows",
    "ShortcutHint.tsx": "pointer-events-none and aria-hidden — nothing in it is clickable",
    "AppDialog.tsx":
      "centred modal panel; it only reaches the drag band on a short window with a global banner up, and whether a window should drag at all behind an open modal is a separate call",
    "AppPaletteDialog.tsx": "same as AppDialog.tsx — pt-[15vh] panel, modal",
  };

  // Named, not counted, so extending one of these files is a deliberate edit
  // here rather than a number that silently still matches.
  const STAMPED: Record<string, string[]> = {
    "context-menu.tsx": ["ContextMenuContent", "ContextMenuSubContent"],
    "dropdown-menu.tsx": ["DropdownMenuContent", "DropdownMenuSubContent"],
    "popover.tsx": ["PopoverContent"],
    "select.tsx": ["SelectContent"],
    "fixed-dropdown.tsx": ["FixedDropdown panel"],
    "toaster.tsx": ["Toast", "OverflowPill"],
    "ReEntrySummary.tsx": ["summary card"],
  };

  function readModule(file: string): string {
    return readFileSync(path.join(UI_DIR, file), "utf8");
  }

  // Comments are stripped before counting. The stamp sites carry a `#12347`
  // note that names the class, and a substring search over raw source is
  // satisfied by that prose alone — the class could be deleted outright and
  // the scan would stay green.
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  }

  function stampCount(file: string): number {
    const code = stripComments(readModule(file));
    // Only inside a string literal, which is the only place a class can take
    // effect — matched loosely enough to survive being folded into a longer
    // class list.
    // Delimited by quote or space, so `data-testid="app-no-drag-probe"` does
    // not read as a stamp, and never an attribute value (`="…"`), which is the
    // only false-green direction — the misses all under-count and fail loudly.
    return (
      code.match(new RegExp(`(?<![=\\w])"(?:[^"\n]* )?${NO_DRAG}(?: [^"\n]*)?"`, "g"))?.length ?? 0
    );
  }

  const portaling = readdirSync(UI_DIR)
    .filter((file) => file.endsWith(".tsx"))
    .filter((file) => {
      const code = stripComments(readModule(file));
      // Both idioms: the deferred Radix loader, and raw react-dom portals.
      return /radix\.\w+\.Portal\b/.test(code) || /\bcreatePortal\(/.test(code);
    });

  it("scans a non-empty set of portaling modules", () => {
    // Without this the guard below is one refactor away from silently
    // scanning nothing and passing forever.
    expect(portaling.length).toBeGreaterThan(0);
    const unaccounted = portaling.filter((file) => !(file in EXEMPT) && !(file in STAMPED));
    expect(unaccounted, "new portaling module: stamp it, or exempt it with a reason").toEqual([]);
    const vanished = [...Object.keys(STAMPED), ...Object.keys(EXEMPT)].filter(
      (file) => !portaling.includes(file)
    );
    expect(vanished, "listed here but no longer portals — drop the entry").toEqual([]);
  });

  it("stamps every portaled surface that is not exempt", () => {
    const offenders = portaling.filter((file) => !(file in EXEMPT) && stampCount(file) === 0);
    expect(
      offenders,
      `add "${NO_DRAG}" to the portaled content, or exempt it with a reason`
    ).toEqual([]);
  });

  it.each(Object.entries(STAMPED))("%s stamps each of its portaled surfaces", (file, surfaces) => {
    // A deletion ratchet, and only that: it fails if one of the named surfaces
    // loses its stamp. A newly *added* portaled surface in an already-listed
    // file still needs the author to extend the table above — which is why the
    // surfaces are named rather than counted.
    expect(stampCount(file), `expected one stamp per surface: ${surfaces.join(", ")}`).toBe(
      surfaces.length
    );
  });
});
