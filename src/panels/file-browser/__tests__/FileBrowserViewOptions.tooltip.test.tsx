// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ReactNode } from "react";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { NO_HIDDEN_ROWS } from "../fileBrowserTree";

/**
 * Captures the props the component hands Radix, so the close behaviour can be
 * driven directly. Radix's own focus restoration is not reproducible in jsdom —
 * what is testable, and what actually matters, is that this component wires the
 * dismiss and the pointer/keyboard split at all.
 */
const captured: {
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
  onPointerDownOutside?: () => void;
  tooltipOpen?: boolean;
  tooltipOnOpenChange?: (open: boolean) => void;
} = {};

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Tooltip: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => {
    captured.tooltipOpen = open;
    captured.tooltipOnOpenChange = onOpenChange;
    return <>{children}</>;
  },
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => {
    captured.onOpenChange = onOpenChange;
    return <>{children}</>;
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
    onPointerDownOutside,
  }: {
    children: ReactNode;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
    onPointerDownOutside?: () => void;
  }) => {
    captured.onCloseAutoFocus = onCloseAutoFocus;
    captured.onPointerDownOutside = onPointerDownOutside;
    return <div>{children}</div>;
  },
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const { FileBrowserViewOptions } = await import("../FileBrowserViewOptions");

function renderMenu() {
  return render(
    <FileBrowserViewOptions
      sort={{ key: "name", direction: "asc" }}
      onSortChange={vi.fn()}
      hideDotfiles={false}
      onHideDotfilesChange={vi.fn()}
      hiddenCounts={NO_HIDDEN_ROWS}
      onRefresh={vi.fn()}
      isRefreshing={false}
      onCollapseAll={vi.fn()}
      canCollapseAll={false}
    />
  );
}

afterEach(cleanup);

describe("FileBrowserViewOptions tooltip and focus on close", () => {
  it("closes its own tooltip as focus returns to the trigger", () => {
    // Radix restores focus to the trigger and opens tooltips on focus, so
    // without this the tooltip reappears with the pointer nowhere near it.
    renderMenu();
    act(() => {
      captured.tooltipOnOpenChange?.(true);
    });
    expect(captured.tooltipOpen).toBe(true);

    act(() => {
      captured.onCloseAutoFocus?.({ preventDefault: vi.fn() });
    });
    expect(captured.tooltipOpen).toBe(false);
  });

  it("swallows the focus-driven re-open that follows the close", () => {
    // Closing alone is not enough: the focus move happens AFTER it and asks the
    // tooltip to open again.
    renderMenu();
    act(() => {
      captured.onCloseAutoFocus?.({ preventDefault: vi.fn() });
    });
    act(() => {
      captured.tooltipOnOpenChange?.(true);
    });
    expect(captured.tooltipOpen).toBe(false);
  });

  it("still opens on a genuine hover afterwards", () => {
    // The suppression must not outlive the restoration — pointerenter on the
    // trigger means the user really is hovering it.
    renderMenu();
    act(() => {
      captured.onCloseAutoFocus?.({ preventDefault: vi.fn() });
    });

    const trigger = document.querySelector("button");
    expect(trigger).toBeTruthy();
    // fireEvent, not a raw dispatch: React routes onPointerEnter through its own
    // synthetic delegation, so a hand-built `pointerenter` never reaches it.
    act(() => {
      fireEvent.pointerEnter(trigger!);
    });
    act(() => {
      captured.tooltipOnOpenChange?.(true);
    });
    expect(captured.tooltipOpen).toBe(true);
  });

  it("KEEPS focus restoration when an item was clicked", () => {
    // The regression this shape exists to avoid. Radix has already unmounted the
    // clicked item, so preventing restoration does not mean "focus without a
    // ring" — it means focus falls to document.body and the keyboard user is
    // stranded with no way back to the control they just used.
    renderMenu();
    const event = { preventDefault: vi.fn() };
    act(() => {
      captured.onCloseAutoFocus?.(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("skips focus restoration only when the user clicked away", () => {
    // An outside click has its own target to take focus, so there is nothing to
    // strand and no reason to leave a ring on the trigger.
    renderMenu();
    act(() => {
      captured.onPointerDownOutside?.();
    });
    const event = { preventDefault: vi.fn() };
    act(() => {
      captured.onCloseAutoFocus?.(event);
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not let a stranded outside-click flag decide the next close", () => {
    // The flag is per-interaction. Consuming it in onCloseAutoFocus is not
    // enough on its own: a close that skips that callback would strand it onto
    // the next one, which might be an item click that must keep its focus.
    renderMenu();
    act(() => {
      captured.onPointerDownOutside?.();
    });

    act(() => {
      captured.onOpenChange?.(true);
    });
    const event = { preventDefault: vi.fn() };
    act(() => {
      captured.onCloseAutoFocus?.(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
