// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { primeRadix } from "../radix-loader";

// The shape that broke every Copy item on the file browser's rows: a React
// ancestor of the menu pulls focus on pointerdown, and React bubbles the
// portalled item's pointerdown up to it. Radix read the focus move as the user
// leaving and closed the submenu before the click could select the item.
function FocusStealingAncestor({ children }: { children: React.ReactNode }) {
  const stealerRef = React.useRef<HTMLDivElement>(null);
  return (
    <div onPointerDown={() => stealerRef.current?.focus()}>
      <div ref={stealerRef} tabIndex={-1} data-testid="stealer" />
      {children}
    </div>
  );
}

beforeAll(async () => {
  await primeRadix();
});

afterEach(() => {
  cleanup();
});

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing element");
  return value;
}

/**
 * A real mouse press on `target`, in the order Chromium dispatches it. The
 * release waits for React to settle, as a human's would: a layer that closed
 * on the press is gone by the time the click arrives.
 */
async function pressAndRelease(target: HTMLElement) {
  await act(async () => {
    fireEvent.pointerDown(target, { pointerType: "mouse", button: 0, pointerId: 1 });
    fireEvent.mouseDown(target, { button: 0 });
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    fireEvent.pointerUp(target, { pointerType: "mouse", button: 0, pointerId: 1 });
    fireEvent.mouseUp(target, { button: 0 });
    fireEvent.click(target, { button: 0, detail: 1 });
  });
}

async function openSubmenu(name: string) {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("menuitem", { name }), { key: "ArrowRight" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderContextMenu(onSelect: () => void) {
  render(
    <FocusStealingAncestor>
      <ContextMenu>
        <ContextMenuTrigger data-testid="trigger">row</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Open</ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>Copy</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={onSelect}>Copy path</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    </FocusStealingAncestor>
  );
  fireEvent.contextMenu(screen.getByTestId("trigger"));
}

function renderDropdown(onSelect: () => void) {
  render(
    <FocusStealingAncestor>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Copy</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={onSelect}>Copy path</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </FocusStealingAncestor>
  );
}

describe.each([
  ["context menu", renderContextMenu],
  ["dropdown menu", renderDropdown],
])("%s submenu under an ancestor that pulls focus on pointerdown", (_name, renderMenu) => {
  it("selects the pressed submenu item", async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);
    await openSubmenu("Copy");

    await pressAndRelease(screen.getByRole("menuitem", { name: "Copy path" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("still closes the submenu when focus leaves without a press inside it", async () => {
    renderMenu(vi.fn());
    await openSubmenu("Copy");
    expect(screen.queryByRole("menuitem", { name: "Copy path" })).not.toBeNull();

    await act(async () => {
      screen.getByTestId("stealer").focus();
    });

    expect(screen.queryByRole("menuitem", { name: "Copy path" })).toBeNull();
  });
});

describe.each([
  [
    "context menu",
    (onSelect: () => void) => {
      render(
        <FocusStealingAncestor>
          <ContextMenu modal={false}>
            <ContextMenuTrigger data-testid="trigger">row</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={onSelect}>Copy path</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </FocusStealingAncestor>
      );
      fireEvent.contextMenu(screen.getByTestId("trigger"));
    },
  ],
  [
    "dropdown menu",
    (onSelect: () => void) => {
      render(
        <FocusStealingAncestor>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>menu</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={onSelect}>Copy path</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </FocusStealingAncestor>
      );
    },
  ],
])("non-modal %s under an ancestor that pulls focus on pointerdown", (_name, renderMenu) => {
  it("selects the pressed item", async () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    await pressAndRelease(screen.getByRole("menuitem", { name: "Copy path" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe("popover under an ancestor that pulls focus on pointerdown", () => {
  function renderPopover(onClick: () => void) {
    render(
      <FocusStealingAncestor>
        <Popover defaultOpen>
          <PopoverTrigger>open</PopoverTrigger>
          <PopoverContent>
            <button type="button" onClick={onClick}>
              Apply
            </button>
          </PopoverContent>
        </Popover>
      </FocusStealingAncestor>
    );
  }

  it("stays open long enough for the pressed button's click", async () => {
    const onClick = vi.fn();
    renderPopover(onClick);

    await pressAndRelease(screen.getByRole("button", { name: "Apply" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("still closes when focus leaves without a press inside it", async () => {
    renderPopover(vi.fn());
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeNull();

    await act(async () => {
      screen.getByTestId("stealer").focus();
    });

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("hands focus back when the press ends without a click, then dismisses normally", async () => {
    // A cancelled gesture never produces the closing click, so the vetoed focus
    // move would otherwise leave the popover open with focus stranded behind it.
    renderPopover(vi.fn());
    const apply = screen.getByRole("button", { name: "Apply" });
    const content = must(apply.closest<HTMLElement>("[data-radix-popper-content-wrapper]"));

    await act(async () => {
      fireEvent.pointerDown(apply, { pointerType: "mouse", button: 0, pointerId: 1 });
    });
    expect(document.activeElement).toBe(screen.getByTestId("stealer"));
    await act(async () => {
      fireEvent.pointerCancel(apply, { pointerType: "mouse", pointerId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(content.contains(document.activeElement)).toBe(true);

    await act(async () => {
      screen.getByTestId("stealer").focus();
    });
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("keeps the press held until the pointer that started it is released", async () => {
    renderPopover(vi.fn());
    const apply = screen.getByRole("button", { name: "Apply" });

    await act(async () => {
      fireEvent.pointerDown(apply, { pointerType: "touch", button: 0, pointerId: 1 });
      fireEvent.pointerUp(apply, { pointerType: "touch", button: 0, pointerId: 2 });
    });
    await act(async () => {
      screen.getByTestId("stealer").focus();
    });
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeNull();

    await act(async () => {
      fireEvent.pointerUp(apply, { pointerType: "touch", button: 0, pointerId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});

describe("a press on a sibling submenu trigger", () => {
  it("still closes the open submenu", async () => {
    // The press belongs to the parent menu, not to the open submenu, so the
    // focus move to the sibling is a genuine departure from the submenu.
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>First</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>First item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Second</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Second item</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    await openSubmenu("First");
    expect(screen.queryByRole("menuitem", { name: "First item" })).not.toBeNull();

    const second = screen.getByRole("menuitem", { name: "Second" });
    await act(async () => {
      fireEvent.pointerDown(second, { pointerType: "mouse", button: 0, pointerId: 1 });
      // Chromium's mousedown default action; jsdom doesn't perform it.
      second.focus();
    });
    await act(async () => {
      fireEvent.pointerUp(second, { pointerType: "mouse", button: 0, pointerId: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("menuitem", { name: "First item" })).toBeNull();
  });
});
