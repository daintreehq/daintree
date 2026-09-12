// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as SelectPrimitive from "@radix-ui/react-select";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuRadioItem,
  ContextMenuSubTrigger,
} from "../context-menu";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuRadioItem,
  DropdownMenuSubTrigger,
} from "../dropdown-menu";
import { SelectItem } from "../select";
import { primeRadix } from "../radix-loader";

// jsdom has no `:focus-visible` heuristic and drops `focusVisible` from
// `FocusOptions`, so the painted ring is not observable here. What is
// observable — and what the fix turns on — is which focus calls happen at all,
// in what order, and with which options. The spy lives on the prototype
// deliberately: a row-level spy would install an own `focus` property and trip
// the helper's own-property opt-out.
type RecordedFocus = { row: HTMLElement; options?: FocusOptions };
let recorded: RecordedFocus[];
// Ordering evidence for the one row a test is watching, so "the caller ran
// first" is a claim about the timeline rather than about a lone marker.
let timeline: string[];
let watched: HTMLElement | null;
let originalFocus: typeof HTMLElement.prototype.focus;

beforeAll(async () => {
  await primeRadix();
  originalFocus = HTMLElement.prototype.focus;
});

beforeEach(() => {
  recorded = [];
  timeline = [];
  watched = null;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    // Copied on entry: an implementation that focused first and only then
    // added `focusVisible` to the same object would otherwise read as a pass.
    recorded.push({ row: this, options: options ? { ...options } : undefined });
    if (this === watched) timeline.push("focus");
    originalFocus.call(this, options);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const SUPPRESSED: FocusOptions = { preventScroll: true, focusVisible: false };

function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`Missing ${what}`);
  return value;
}

function focusesOf(row: HTMLElement): RecordedFocus[] {
  return recorded.filter((call) => call.row === row);
}

function hover(row: HTMLElement, init: PointerEventInit = {}) {
  fireEvent.pointerMove(row, { pointerType: "mouse", clientX: 10, clientY: 10, ...init });
}

// Radix's roving focus defers its move to a macrotask, so a keypress is only
// settled once that has run.
async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    fireEvent.keyDown(target, { key });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderDropdown(children: React.ReactNode) {
  render(
    <DropdownMenuPrimitive.Root open>
      <DropdownMenuPrimitive.Trigger>trigger</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content forceMount>{children}</DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

function renderContextMenu(children: React.ReactNode) {
  const { container } = render(
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger data-testid="trigger">trigger</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content forceMount>{children}</ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
  // Radix's context-menu root has no `open` prop; the gesture is what mounts
  // the content into the portal.
  fireEvent.contextMenu(
    must(container.querySelector<HTMLElement>("[data-testid='trigger']"), "trigger")
  );
}

function rows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      "[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']"
    )
  );
}

function rowAt(index: number): HTMLElement {
  return must(rows()[index], `row ${index}`);
}

function optionRow(): HTMLElement {
  return must(document.querySelector<HTMLElement>("[role='option']"), "select option");
}

describe("menu row hover focus — issue #12383", () => {
  it("lands Radix's hover focus with focusVisible: false, exactly once", () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = rowAt(0);
    recorded = [];

    hover(item);

    // Exactly one focus call for this row: Radix's. A fix that focused the row
    // itself before Radix would produce two, and one that focused it INSTEAD of
    // Radix would leave Radix's grace-area veto without a say.
    expect(focusesOf(item)).toEqual([{ row: item, options: SUPPRESSED }]);
    expect(document.activeElement).toBe(item);
    // The hover highlight is what should paint instead, and Radix drives it
    // from the same focus — suppressing the ring must not cost the background.
    expect(item.hasAttribute("data-highlighted")).toBe(true);
  });

  it("runs a caller's onPointerMove before the focus it suppresses", () => {
    renderDropdown(
      <DropdownMenuItem onPointerMove={() => timeline.push("caller")}>Preview</DropdownMenuItem>
    );
    const item = rowAt(0);
    watched = item;
    recorded = [];
    timeline = [];

    hover(item);

    expect(timeline).toEqual(["caller", "focus"]);
    expect(focusesOf(item)).toEqual([{ row: item, options: SUPPRESSED }]);
  });

  it("leaves focus alone when the caller cancels the event", () => {
    renderDropdown(
      <>
        <DropdownMenuItem onPointerMove={(event) => event.preventDefault()}>
          Cancelled
        </DropdownMenuItem>
        <DropdownMenuItem>Control</DropdownMenuItem>
      </>
    );
    const cancelled = rowAt(0);
    const control = rowAt(1);
    recorded = [];

    hover(cancelled);

    expect(focusesOf(cancelled)).toHaveLength(0);
    expect(Object.hasOwn(cancelled, "focus")).toBe(false);
    // Control: the same fixture must still suppress an ordinary hover, so a
    // silently unwired primitive cannot pass this test.
    hover(control);
    expect(focusesOf(control)).toEqual([{ row: control, options: SUPPRESSED }]);
  });

  it.each(["touch", "pen"])("ignores %s pointers, matching Radix's own gate", (pointerType) => {
    const seen: string[] = [];
    renderDropdown(
      <>
        <DropdownMenuItem onPointerMove={() => seen.push("caller")}>Tap target</DropdownMenuItem>
        <DropdownMenuItem>Control</DropdownMenuItem>
      </>
    );
    const target = rowAt(0);
    const control = rowAt(1);
    recorded = [];

    hover(target, { pointerType });

    expect(seen).toEqual(["caller"]);
    expect(focusesOf(target)).toHaveLength(0);
    expect(Object.hasOwn(target, "focus")).toBe(false);
    hover(control);
    expect(focusesOf(control)).toEqual([{ row: control, options: SUPPRESSED }]);
  });

  it("never focuses a disabled row", () => {
    renderDropdown(
      <>
        <DropdownMenuItem disabled>Unavailable</DropdownMenuItem>
        <DropdownMenuItem>Control</DropdownMenuItem>
      </>
    );
    const disabled = rowAt(0);
    const control = rowAt(1);
    recorded = [];

    hover(disabled);

    // The helper never focuses anything itself — Radix decides, and it routes a
    // disabled row to `onItemLeave` instead. Anything that pre-empted Radix
    // would light this row up.
    expect(focusesOf(disabled)).toHaveLength(0);
    expect(disabled.hasAttribute("data-highlighted")).toBe(false);
    hover(control);
    expect(focusesOf(control)).toEqual([{ row: control, options: SUPPRESSED }]);
  });

  it("stops decorating the row once the pointer event has been dispatched", async () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = rowAt(0);
    recorded = [];

    hover(item);
    expect(focusesOf(item)).toEqual([{ row: item, options: SUPPRESSED }]);
    expect(Object.hasOwn(item, "focus")).toBe(true);

    await Promise.resolve();
    expect(Object.hasOwn(item, "focus")).toBe(false);

    recorded = [];
    item.focus({ preventScroll: true });
    expect(focusesOf(item)).toEqual([{ row: item, options: { preventScroll: true } }]);
  });

  it("leaves keyboard focus untouched, including back onto a row it suppressed", async () => {
    renderDropdown(
      <>
        <DropdownMenuItem>First</DropdownMenuItem>
        <DropdownMenuItem>Second</DropdownMenuItem>
      </>
    );
    const first = rowAt(0);
    const second = rowAt(1);

    hover(first);
    await Promise.resolve();
    await pressKey(first, "ArrowDown");
    expect(document.activeElement).toBe(second);

    recorded = [];
    await pressKey(second, "ArrowUp");

    // Coming back by keyboard is a real focus transition, and it must be free
    // to ring: the decoration is gone and nothing forces `focusVisible`.
    expect(document.activeElement).toBe(first);
    const calls = focusesOf(first);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.options?.focusVisible).not.toBe(false);
    }
  });
});

describe("menu row hover focus — every row primitive", () => {
  // Every wrapper gets the caller-handler half of the contract too: dropping
  // `onPointerMove` on the floor, or letting the spread clobber the helper, is
  // the failure mode that `FleetArmingRibbon`'s preview handlers would hit.
  function expectSuppressedHover(target: HTMLElement, seen: string[]) {
    recorded = [];
    seen.length = 0;
    hover(target);
    expect(seen).toEqual(["caller"]);
    expect(focusesOf(target)).toEqual([{ row: target, options: SUPPRESSED }]);
  }

  it("covers the dropdown item, sub-trigger, checkbox and radio rows", () => {
    const seen: string[] = [];
    const spy = () => seen.push("caller");
    renderDropdown(
      <>
        <DropdownMenuItem onPointerMove={spy}>Reveal</DropdownMenuItem>
        <DropdownMenuPrimitive.Sub>
          <DropdownMenuSubTrigger onPointerMove={spy}>More</DropdownMenuSubTrigger>
        </DropdownMenuPrimitive.Sub>
        <DropdownMenuCheckboxItem checked onPointerMove={spy}>
          Wrap lines
        </DropdownMenuCheckboxItem>
        <DropdownMenuPrimitive.RadioGroup value="a">
          <DropdownMenuRadioItem value="a" onPointerMove={spy}>
            A
          </DropdownMenuRadioItem>
        </DropdownMenuPrimitive.RadioGroup>
      </>
    );
    const targets = rows();
    expect(targets).toHaveLength(4);
    for (const target of targets) expectSuppressedHover(target, seen);
  });

  it("covers the context-menu item, sub-trigger, checkbox and radio rows", () => {
    const seen: string[] = [];
    const spy = () => seen.push("caller");
    renderContextMenu(
      <>
        <ContextMenuItem onPointerMove={spy}>Reveal</ContextMenuItem>
        <ContextMenuPrimitive.Sub>
          <ContextMenuSubTrigger onPointerMove={spy}>More</ContextMenuSubTrigger>
        </ContextMenuPrimitive.Sub>
        <ContextMenuCheckboxItem checked onPointerMove={spy}>
          Wrap lines
        </ContextMenuCheckboxItem>
        <ContextMenuPrimitive.RadioGroup value="a">
          <ContextMenuRadioItem value="a" onPointerMove={spy}>
            A
          </ContextMenuRadioItem>
        </ContextMenuPrimitive.RadioGroup>
      </>
    );
    const targets = rows();
    expect(targets).toHaveLength(4);
    for (const target of targets) expectSuppressedHover(target, seen);
  });

  it("covers the select option row", () => {
    const seen: string[] = [];
    render(
      <SelectPrimitive.Root open value="a">
        <SelectPrimitive.Trigger>trigger</SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content position="popper">
            <SelectPrimitive.Viewport>
              <SelectItem value="a" onPointerMove={() => seen.push("caller")}>
                Option A
              </SelectItem>
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    );

    expectSuppressedHover(optionRow(), seen);
  });
});

describe("menu row hover focus — the decoration itself", () => {
  it("overrides focusVisible without disturbing the caller's other options", () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = rowAt(0);
    hover(item);
    recorded = [];

    const asked = Object.freeze({ preventScroll: false, focusVisible: true });
    item.focus(asked);

    // `preventScroll` is the caller's to decide; only visibility is ours. A
    // reversed spread would hand back `focusVisible: true` here.
    expect(focusesOf(item)).toEqual([
      { row: item, options: { preventScroll: false, focusVisible: false } },
    ]);
    expect(asked).toEqual({ preventScroll: false, focusVisible: true });
  });

  it("leaves a row that already owns a focus implementation alone", () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = rowAt(0);
    const own = vi.fn();
    Object.defineProperty(item, "focus", { configurable: true, value: own });
    recorded = [];

    hover(item);

    // An instance override — a per-element spy, say — keeps its own behaviour
    // rather than being silently swapped out and then deleted.
    expect(own).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusesOf(item)).toHaveLength(0);
  });

  it("keeps one decoration across repeated hovers in the same task", async () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = rowAt(0);

    hover(item);
    const decorated = Object.getOwnPropertyDescriptor(item, "focus")?.value;
    expect(decorated).toBeTypeOf("function");
    hover(item);
    expect(Object.getOwnPropertyDescriptor(item, "focus")?.value).toBe(decorated);

    // One teardown for one decoration, and a later event can decorate again.
    await Promise.resolve();
    expect(Object.hasOwn(item, "focus")).toBe(false);
    hover(item);
    expect(Object.hasOwn(item, "focus")).toBe(true);
  });
});
