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
