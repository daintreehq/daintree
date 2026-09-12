// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
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
import { menuRowPointerMove } from "../menu-row-hover-focus";
import { primeRadix } from "../radix-loader";

// jsdom has no `:focus-visible` heuristic and drops `focusVisible` from
// `FocusOptions`, so the ring itself is not observable here. What is observable
// — and what the fix turns on — is the options Radix's own hover focus lands
// with, so every assertion is about the recorded focus call.
type RecordedFocus = { row: HTMLElement; options?: FocusOptions };
let recorded: RecordedFocus[];
let originalFocus: typeof HTMLElement.prototype.focus;

beforeAll(async () => {
  await primeRadix();
  originalFocus = HTMLElement.prototype.focus;
});

beforeEach(() => {
  recorded = [];
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions
  ) {
    recorded.push({ row: this, options });
    originalFocus.call(this, options);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

function focusesOf(row: HTMLElement): RecordedFocus[] {
  return recorded.filter((call) => call.row === row);
}

function hover(row: HTMLElement, init: PointerEventInit = {}) {
  fireEvent.pointerMove(row, { pointerType: "mouse", clientX: 10, clientY: 10, ...init });
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
  fireEvent.contextMenu(container.querySelector("[data-testid='trigger']") as HTMLElement);
}

function row(selector: string): HTMLElement {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`No row matched ${selector}`);
  return found as HTMLElement;
}

describe("menu row hover focus — issue #12383", () => {
  it("lands Radix's hover focus with focusVisible: false", () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = row("[role='menuitem']");

    hover(item);

    const calls = focusesOf(item);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
    expect(document.activeElement).toBe(item);
    // The hover highlight is what should paint instead, and Radix drives it
    // from the same focus — suppressing the ring must not cost the background.
    expect(item.hasAttribute("data-highlighted")).toBe(true);
  });

  it("runs a caller's onPointerMove first and still suppresses the ring", () => {
    const order: string[] = [];
    renderDropdown(
      <DropdownMenuItem onPointerMove={() => order.push("caller")}>Preview</DropdownMenuItem>
    );
    const item = row("[role='menuitem']");
    recorded = [];

    hover(item);

    expect(order).toEqual(["caller"]);
    expect(focusesOf(item)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
  });

  it("leaves focus alone when the caller cancels the event", () => {
    renderDropdown(
      <DropdownMenuItem onPointerMove={(event) => event.preventDefault()}>Preview</DropdownMenuItem>
    );
    const item = row("[role='menuitem']");
    recorded = [];

    hover(item);

    expect(focusesOf(item)).toHaveLength(0);
  });

  it("ignores non-mouse pointers, matching Radix's own gate", () => {
    renderDropdown(<DropdownMenuItem>Tap target</DropdownMenuItem>);
    const item = row("[role='menuitem']");
    recorded = [];

    hover(item, { pointerType: "touch" });

    expect(focusesOf(item)).toHaveLength(0);
  });

  it("never focuses a disabled row", () => {
    renderDropdown(<DropdownMenuItem disabled>Unavailable</DropdownMenuItem>);
    const item = row("[role='menuitem']");
    recorded = [];

    hover(item);

    expect(focusesOf(item)).toHaveLength(0);
    expect(item.hasAttribute("data-highlighted")).toBe(false);
  });

  it("stops decorating the row once the pointer event has been dispatched", async () => {
    renderDropdown(<DropdownMenuItem>Copy full context</DropdownMenuItem>);
    const item = row("[role='menuitem']");
    hover(item);

    await Promise.resolve();
    expect(Object.hasOwn(item, "focus")).toBe(false);

    recorded = [];
    item.focus({ preventScroll: true });
    expect(focusesOf(item)[0]?.options).toEqual({ preventScroll: true });
  });

  it("leaves keyboard focus untouched so arrow keys still ring", () => {
    renderDropdown(
      <>
        <DropdownMenuItem>First</DropdownMenuItem>
        <DropdownMenuItem>Second</DropdownMenuItem>
      </>
    );
    const content = row("[role='menu']");
    const first = row("[role='menuitem']");
    recorded = [];

    fireEvent.keyDown(content, { key: "ArrowDown" });

    const calls = focusesOf(first);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.options?.focusVisible).not.toBe(false);
    }
  });
});

describe("menu row hover focus — every row primitive", () => {
  it("covers the dropdown sub-trigger", () => {
    renderDropdown(
      <DropdownMenuPrimitive.Sub>
        <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
      </DropdownMenuPrimitive.Sub>
    );
    const trigger = row("[role='menuitem']");
    recorded = [];

    hover(trigger);

    expect(focusesOf(trigger)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
  });

  it("covers the dropdown checkbox and radio rows", () => {
    renderDropdown(
      <>
        <DropdownMenuCheckboxItem checked>Wrap lines</DropdownMenuCheckboxItem>
        <DropdownMenuPrimitive.RadioGroup value="a">
          <DropdownMenuRadioItem value="a">A</DropdownMenuRadioItem>
        </DropdownMenuPrimitive.RadioGroup>
      </>
    );
    const checkbox = row("[role='menuitemcheckbox']");
    const radio = row("[role='menuitemradio']");
    recorded = [];

    hover(checkbox);
    hover(radio);

    expect(focusesOf(checkbox)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
    expect(focusesOf(radio)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
  });

  it("covers the context-menu item, sub-trigger, checkbox and radio rows", () => {
    renderContextMenu(
      <>
        <ContextMenuItem>Reveal</ContextMenuItem>
        <ContextMenuPrimitive.Sub>
          <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
        </ContextMenuPrimitive.Sub>
        <ContextMenuCheckboxItem checked>Wrap lines</ContextMenuCheckboxItem>
        <ContextMenuPrimitive.RadioGroup value="a">
          <ContextMenuRadioItem value="a">A</ContextMenuRadioItem>
        </ContextMenuPrimitive.RadioGroup>
      </>
    );
    const rows = Array.from(
      document.querySelectorAll(
        "[role='menuitem'],[role='menuitemcheckbox'],[role='menuitemradio']"
      )
    ) as HTMLElement[];
    expect(rows).toHaveLength(4);

    for (const target of rows) {
      recorded = [];
      hover(target);
      expect(focusesOf(target)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
    }
  });

  it("covers the select option row", () => {
    render(
      <SelectPrimitive.Root open value="a">
        <SelectPrimitive.Trigger>trigger</SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Content position="popper">
            <SelectPrimitive.Viewport>
              <SelectItem value="a">Option A</SelectItem>
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    );
    const option = row("[role='option']");
    recorded = [];

    hover(option);

    expect(focusesOf(option)[0]?.options).toEqual({ preventScroll: true, focusVisible: false });
  });
});

describe("menuRowPointerMove", () => {
  function pointerEvent(target: HTMLElement, pointerType = "mouse") {
    let prevented = false;
    return {
      currentTarget: target,
      pointerType,
      get defaultPrevented() {
        return prevented;
      },
      preventDefault() {
        prevented = true;
      },
    } as unknown as React.PointerEvent<HTMLElement>;
  }

  it("injects focusVisible: false into whatever options the caller of focus passes", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    menuRowPointerMove(pointerEvent(el), undefined);
    el.focus();

    expect(focusesOf(el)[0]?.options).toEqual({ focusVisible: false });
    el.remove();
  });

  it("does not double-decorate a row hovered twice in one task", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    menuRowPointerMove(pointerEvent(el), undefined);
    const decorated = Object.getOwnPropertyDescriptor(el, "focus")?.value;
    menuRowPointerMove(pointerEvent(el), undefined);

    expect(Object.getOwnPropertyDescriptor(el, "focus")?.value).toBe(decorated);
    el.remove();
  });
});
