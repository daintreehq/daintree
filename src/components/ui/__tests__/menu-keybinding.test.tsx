// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { primeRadix } from "../radix-loader";
import { keybindingService } from "@/services/KeybindingService";
import { comboToAriaKeyshortcuts, parseChord } from "@/lib/kbdShortcut";
import { isMac } from "@/lib/platform";

const BOUND = "app.settings";
const UNBOUND = "preview.noSuchAction";

type ElectronWindow = { electron?: unknown };
let previousElectron: unknown;

beforeAll(async () => {
  await primeRadix();
  const win = window as unknown as ElectronWindow;
  previousElectron = win.electron;
  // setOverride only commits once the bridge accepts it.
  win.electron = {
    keybinding: { setOverride: async () => {}, removeOverride: async () => {} },
  };
});

afterAll(() => {
  (window as unknown as ElectronWindow).electron = previousElectron;
});

afterEach(async () => {
  await act(() => keybindingService.removeOverride(BOUND));
  cleanup();
});

/** The keys a row draws, one token per key, read off the chips. */
function drawnKeys(row: Element): string[] {
  return Array.from(row.querySelectorAll("kbd")).map((k) => k.textContent ?? "");
}

function expectedKeys(combo: string): string[] {
  return parseChord(combo, isMac()).flat();
}

function renderDropdown() {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem keybinding={BOUND}>Settings</DropdownMenuItem>
        <DropdownMenuItem keybinding={UNBOUND}>Nothing bound</DropdownMenuItem>
        <DropdownMenuItem>
          Archive
          <DropdownMenuShortcut shortcut="E" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const rows = Array.from(document.querySelectorAll('[role="menuitem"]'));
  return { bound: rows[0]!, unbound: rows[1]!, fixed: rows[2]! };
}

describe("menu keybinding column", () => {
  it("draws the action's live binding as KbdChord keys and announces the same combo", () => {
    const { bound } = renderDropdown();
    const combo = keybindingService.getEffectiveCombo(BOUND)!;
    expect(combo).toBeTruthy();
    expect(drawnKeys(bound)).toEqual(expectedKeys(combo));
    expect(bound.getAttribute("aria-keyshortcuts")).toBe(comboToAriaKeyshortcuts(combo, isMac()));
  });

  it("keeps the keys out of the row's accessible name", () => {
    const { bound, fixed } = renderDropdown();
    for (const [row, label] of [
      [bound, "Settings"],
      [fixed, "Archive"],
    ] as const) {
      // What assistive tech reads is everything outside aria-hidden — which
      // must be the label alone: not the glyphs, and not KbdChord's spoken
      // copy either, since the keys already ride aria-keyshortcuts.
      const clone = row.cloneNode(true) as Element;
      clone.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
      expect(clone.textContent?.trim()).toBe(label);
    }
  });

  it("follows a rebind while the menu is open", async () => {
    const { bound } = renderDropdown();
    await act(() => keybindingService.setOverride(BOUND, ["Cmd+Alt+J"]));
    expect(drawnKeys(bound)).toEqual(expectedKeys("Cmd+Alt+J"));
    expect(bound.getAttribute("aria-keyshortcuts")).toBe(
      comboToAriaKeyshortcuts("Cmd+Alt+J", isMac())
    );
  });

  it("draws nothing and announces nothing for an unbound action", () => {
    const { unbound } = renderDropdown();
    expect(drawnKeys(unbound)).toEqual([]);
    expect(unbound.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("draws a context-menu row exactly like a dropdown row", () => {
    const dropdown = renderDropdown().bound;
    const dropdownSlot = dropdown.querySelector("kbd")!.closest('[aria-hidden="true"]')!;
    const dropdownMarkup = dropdownSlot.outerHTML;
    cleanup();

    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div data-testid="target">target</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem keybinding={BOUND}>Settings</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
    const target = document.querySelector('[data-testid="target"]')!;
    act(() => {
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })
      );
    });
    const row = document.querySelector('[role="menuitem"]')!;
    const slot = row.querySelector("kbd")!.closest('[aria-hidden="true"]')!;
    expect(slot.outerHTML).toBe(dropdownMarkup);
  });

  it("renders nothing for an empty shortcut", () => {
    const { container } = render(
      <>
        <DropdownMenuShortcut shortcut="" />
        <ContextMenuShortcut shortcut={undefined} />
      </>
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("menu keybinding with asChild", () => {
  it("appends the key column inside the slotted child", () => {
    render(
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem asChild keybinding={BOUND}>
            <a href="#settings">Settings</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const row = document.querySelector('[role="menuitem"]')!;
    expect(row.tagName).toBe("A");
    expect(row.querySelectorAll("kbd").length).toBeGreaterThan(0);
    expect(row.getAttribute("aria-keyshortcuts")).toBeTruthy();
  });
});

// Both primitives are plain spans around a KbdChord with no `useRadixPrimitives()`
// call, so they render standalone.
const SHORTCUT_PRIMITIVES = [
  { name: "ContextMenuShortcut", Shortcut: ContextMenuShortcut },
  { name: "DropdownMenuShortcut", Shortcut: DropdownMenuShortcut },
] as const;

const COMBO = "Cmd+I";

// An inline-start padding utility at a non-zero scale. `pl-0`/`px-0` would
// satisfy a bare `p[lx]-` match while leaving the hint flush, so they have to
// fail this.
const GUTTER = /^p[lx]-(?!0$)/;

function renderShortcut(Shortcut: (typeof SHORTCUT_PRIMITIVES)[number]["Shortcut"]): HTMLElement {
  const { container } = render(<Shortcut shortcut={COMBO} />);
  return container.firstElementChild as HTMLElement;
}

function classesOf(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe("menu shortcut gutter — issue #11598", () => {
  it.each(SHORTCUT_PRIMITIVES)(
    "$name separates the hint from the label with padding, which flex cannot collapse",
    ({ Shortcut }) => {
      // `ml-auto` distributes leftover space, so it renders a gap only on rows
      // that have some. Menu width is set by the widest row, and a row carrying
      // both a label and a hint is typically that row — leaving it zero slack,
      // collapsing its auto margin to 0, and butting the hint against the
      // label. The separation therefore has to come from a box-model layer flex
      // cannot redistribute.
      //
      // jsdom has no compiled Tailwind and no flex layout, so this asserts the
      // utility is present and non-zero, not the rendered pixel gap. The gap
      // itself is a visual check.
      expect(
        classesOf(renderShortcut(Shortcut)).some((c) => GUTTER.test(c)),
        "shortcut needs a non-zero inline-start padding, not just `ml-auto`"
      ).toBe(true);
    }
  );

  it("keeps both menu families visually identical", () => {
    // #11598 reported the context menu, but `DropdownMenuShortcut` carried the
    // same class string and the same defect. These are duplicated wrappers kept
    // in sync by hand, so fixing one and missing the other is the realistic
    // regression — and it can only be resolved by editing the other primitive,
    // never by editing this test.
    const context = classesOf(renderShortcut(ContextMenuShortcut)).sort();
    cleanup();
    const dropdown = classesOf(renderShortcut(DropdownMenuShortcut)).sort();

    expect(dropdown).toEqual(context);
  });
});
