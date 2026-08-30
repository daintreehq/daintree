// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetTooltipFocusSuppressionForTests } from "@/lib/tooltipFocusSuppression";
import { useOverlayFocusRestore, type OverlayFocusRestore } from "../overlay-focus-restore";

/**
 * The close-time focus policy every anchored overlay now shares, driven through
 * the real wrappers.
 *
 * Radix's own focus restoration is not reproducible in jsdom — there is no
 * exit animation, no focus scope unmount, and `:focus-visible` is not painted.
 * What is testable, and what the bug was actually about, is the decision: which
 * closes cancel Radix's restoration, which take it over, and which are left
 * alone. So the stubs hand the content's props straight back and the gestures
 * are driven directly.
 */
const captured: {
  content?: Record<string, unknown>;
  contextContent?: Record<string, unknown>;
  popoverContent?: Record<string, unknown>;
  rootOnOpenChange?: (open: boolean) => void;
} = {};

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

function stubMenu(store: "content" | "contextContent" | "popoverContent") {
  return {
    Root: ({ children, ...rest }: AnyProps) => {
      captured.rootOnOpenChange = rest.onOpenChange as (open: boolean) => void;
      return <>{children}</>;
    },
    Trigger: React.forwardRef<HTMLButtonElement, AnyProps>(function Trigger(
      { children, asChild: _asChild, ...rest },
      ref
    ) {
      return (
        <button type="button" ref={ref} {...(rest as React.ComponentProps<"button">)}>
          {children as React.ReactNode}
        </button>
      );
    }),
    Portal: ({ children }: AnyProps) => <>{children}</>,
    Content: ({ children, ...rest }: AnyProps) => {
      captured[store] = rest;
      return <div>{children}</div>;
    },
  };
}

vi.mock("../radix-loader", () => ({
  primeOnEvent: vi.fn(),
  primeRadix: vi.fn(),
  useRadixPrimitives: () => ({
    DropdownMenuPrimitive: stubMenu("content"),
    ContextMenuPrimitive: stubMenu("contextContent"),
    PopoverPrimitive: stubMenu("popoverContent"),
  }),
}));

const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import("../dropdown-menu");
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import("../context-menu");
const { Popover, PopoverContent, PopoverTrigger } = await import("../popover");

/** A picked row, as `closest()` will see it. */
function pickClick(role: string, detail: number) {
  const item = document.createElement("div");
  item.setAttribute("role", role);
  document.body.appendChild(item);
  return { target: item, detail } as unknown as React.MouseEvent;
}

const itemClick = (detail: number) => pickClick("menuitem", detail);
const optionClick = (detail: number) => pickClick("option", detail);

function closeEvent() {
  return { preventDefault: vi.fn(), defaultPrevented: false };
}

function contentProps() {
  return captured.content as {
    onPointerDown: () => void;
    onPointerDownOutside: () => void;
    onInteractOutside: (event: { defaultPrevented: boolean }) => void;
    onKeyDown: () => void;
    onClick: (event: React.MouseEvent) => void;
    onCloseAutoFocus: (event: { preventDefault: () => void; defaultPrevented: boolean }) => void;
  };
}

beforeEach(() => {
  captured.content = undefined;
  captured.contextContent = undefined;
  captured.popoverContent = undefined;
  captured.rootOnOpenChange = undefined;
  _resetTooltipFocusSuppressionForTests();
});

afterEach(cleanup);

function renderDropdown(contentProps: Record<string, unknown> = {}) {
  render(
    <DropdownMenu>
      <DropdownMenuTrigger>trigger</DropdownMenuTrigger>
      <DropdownMenuContent {...contentProps}>item</DropdownMenuContent>
    </DropdownMenu>
  );
  return document.querySelector("button") as HTMLButtonElement;
}

describe("dropdown close-time focus policy", () => {
  it("returns focus to the trigger after a pointer click, WITHOUT the focus ring", () => {
    // Two things have to hold at once. Focus must come back, or it falls to
    // document.body and a keyboard user is stranded with no way back to the
    // control they just used. And it must come back unringed, because a mouse
    // user never asked for one — Radix's own restoration is a bare .focus(),
    // which Chromium paints as :focus-visible.
    const trigger = renderDropdown();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => contentProps().onClick(itemClick(1)));
    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("leaves keyboard selection to Radix, ring and all", () => {
    // Radix implements Enter/Space by calling .click() on the item, and a
    // synthetic click carries detail 0. Someone driving from the keyboard wants
    // the ring, so this path must not be claimed.
    renderDropdown();
    act(() => contentProps().onClick(itemClick(0)));
    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("treats a press-inside then release-over-an-item as the pointer gesture it is", () => {
    // Radix has a pointer-up fallback: when the press did not start on the item
    // being released over, it calls .click() itself, and that synthetic click
    // carries detail 0 exactly like a keyboard one. Pressing inside the menu is
    // something a keyboard cannot do, so it separates the two.
    const trigger = renderDropdown();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => {
      contentProps().onPointerDown();
      contentProps().onClick(itemClick(0));
    });
    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("ignores clicks that miss an item, since those do not close the menu", () => {
    // Padding, a label or a separator. Claiming those would strand the flag onto
    // whatever gesture actually closes the menu, and an Escape after a stray
    // click would then lose its ring.
    renderDropdown();
    const padding = document.createElement("div");
    document.body.appendChild(padding);
    act(() =>
      contentProps().onClick({ target: padding, detail: 1 } as unknown as React.MouseEvent)
    );
    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("cancels Radix's restoration when the user clicked away", () => {
    // An outside click is supposed to have its own target to take focus, so
    // there is nothing to strand and no reason to leave a ring on the trigger.
    const trigger = renderDropdown();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => contentProps().onPointerDownOutside());
    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Nothing synchronously — whatever was clicked gets its chance first.
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("leaves focus alone when the click-away target actually took it", () => {
    vi.useFakeTimers();
    try {
      const trigger = renderDropdown();
      const focusSpy = vi.spyOn(trigger, "focus");
      const outside = document.createElement("button");
      document.body.appendChild(outside);

      act(() => contentProps().onPointerDownOutside());
      act(() => contentProps().onCloseAutoFocus(closeEvent()));
      outside.focus();
      act(() => {
        vi.runAllTimers();
      });

      expect(focusSpy).not.toHaveBeenCalled();
      outside.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes focus back ringless when the click-away left it on the body", () => {
    // The common case for a MODAL overlay: Radix disables outside pointer
    // events, so the dismissing press never reaches what was under it and
    // focus lands nowhere. Leaving it there restarts the next Tab from the top
    // of the document.
    vi.useFakeTimers();
    try {
      const trigger = renderDropdown();
      const focusSpy = vi.spyOn(trigger, "focus");

      act(() => contentProps().onPointerDownOutside());
      act(() => contentProps().onCloseAutoFocus(closeEvent()));
      act(() => {
        vi.runAllTimers();
      });

      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still suppresses the tooltip on that deferred restore", async () => {
    // The arm at the top of the close handler disarms on its own zero-delay
    // timer, queued BEFORE the fallback's. Inheriting it would leave the
    // deferred focus unguarded and reopen the tooltip the close just closed.
    const { isTooltipSuppressedForElement } = await import("@/lib/tooltipFocusSuppression");
    vi.useFakeTimers();
    try {
      const trigger = renderDropdown();
      act(() => contentProps().onPointerDownOutside());
      act(() => contentProps().onCloseAutoFocus(closeEvent()));
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        fireEvent.focusIn(trigger);
      });

      expect(isTooltipSuppressedForElement(trigger)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disarms the click-away flag when the dismissal was vetoed", () => {
    // `handleDockInteractOutside` vetoes routinely, which leaves the menu OPEN
    // with no close coming. A flag left armed there turns the Escape that
    // finally closes it into a pointer dismissal and eats the keyboard ring.
    renderDropdown();
    act(() => {
      contentProps().onPointerDownOutside();
      contentProps().onInteractOutside({ defaultPrevented: true });
    });

    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("lets a keystroke supersede a click that did not close the menu", () => {
    // An item holding an inline form calls `onSelect(e.preventDefault())`, so
    // the pointer click never closes anything. The Escape or Enter that does
    // close it belongs to the keyboard and must keep its ring.
    renderDropdown();
    act(() => {
      contentProps().onPointerDown();
      contentProps().onClick(itemClick(1));
      contentProps().onKeyDown();
    });

    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does not let a stranded outside-click flag decide the next close", () => {
    // The flag is per-interaction. Consuming it in onCloseAutoFocus is not
    // enough on its own: a close that skips that callback would strand it onto
    // the next one, which might be an item click that must keep its focus.
    renderDropdown();
    act(() => contentProps().onPointerDownOutside());
    act(() => captured.rootOnOpenChange?.(true));

    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("leaves a consumer that already decided alone", () => {
    // An anchored palette runs its own restoration policy through the same
    // callback. Whoever prevented the default owns the outcome.
    const trigger = renderDropdown();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => contentProps().onClick(itemClick(1)));
    const event = { preventDefault: vi.fn(), defaultPrevented: true };
    act(() => contentProps().onCloseAutoFocus(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("still calls the consumer's own content handlers", () => {
    const onCloseAutoFocus = vi.fn();
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const onPointerDownOutside = vi.fn();
    renderDropdown({ onCloseAutoFocus, onClick, onPointerDown, onPointerDownOutside });

    act(() => {
      contentProps().onPointerDown();
      contentProps().onPointerDownOutside();
      contentProps().onClick(itemClick(1));
      contentProps().onCloseAutoFocus(closeEvent());
    });

    expect(onPointerDown).toHaveBeenCalledTimes(1);
    expect(onPointerDownOutside).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onCloseAutoFocus).toHaveBeenCalledTimes(1);
  });
});

describe("context menu close-time focus policy", () => {
  function renderContextMenu() {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <button type="button" data-testid="target">
            right click me
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>item</ContextMenuContent>
      </ContextMenu>
    );
    return captured.contextContent as {
      onPointerDownOutside: () => void;
      onCloseAutoFocus: (event: { preventDefault: () => void; defaultPrevented: boolean }) => void;
    };
  }

  it("hands focus back ringless after a click-away instead of dropping it", () => {
    // A context menu's restore target is the surface the user was working in,
    // not a control they just dismissed — losing it to document.body would cost
    // them that surface's keyboard handling. So unlike a dropdown, it restores;
    // it just does it without the ring.
    const content = renderContextMenu();
    const target = document.querySelector("[data-testid=target]") as HTMLButtonElement;
    target.focus();
    const focusSpy = vi.spyOn(target, "focus");

    act(() => captured.rootOnOpenChange?.(true));
    act(() => content.onPointerDownOutside());
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("leaves a keyboard close to Radix", () => {
    const content = renderContextMenu();
    act(() => captured.rootOnOpenChange?.(true));
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("popover close-time focus policy", () => {
  // Same policy as the dropdown, reached through a different primitive: the
  // wiring lives in each Content wrapper, so a working dropdown proves nothing
  // about the popover.
  function renderPopover() {
    render(
      <Popover>
        <PopoverTrigger>trigger</PopoverTrigger>
        <PopoverContent>body</PopoverContent>
      </Popover>
    );
    return {
      trigger: document.querySelector("button") as HTMLButtonElement,
      content: captured.popoverContent as {
        onPointerDown: () => void;
        onPointerDownOutside: () => void;
        onClick: (event: React.MouseEvent) => void;
        onCloseAutoFocus: (event: {
          preventDefault: () => void;
          defaultPrevented: boolean;
        }) => void;
      },
    };
  }

  it("returns focus to the trigger ringless after a pointer pick", () => {
    const { trigger, content } = renderPopover();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => content.onClick(optionClick(1)));
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
  });

  it("counts an ordinary button in the body as the thing that was picked", () => {
    // Popovers routinely close from a plain button rather than anything
    // role-flagged — Clear and Done in `PresetColorPicker`. Recognising only
    // menu and option roles would drop those back onto Radix's bare `.focus()`
    // and keep exactly the ring this exists to remove.
    const { trigger, content } = renderPopover();
    const focusSpy = vi.spyOn(trigger, "focus");

    const button = document.createElement("button");
    document.body.appendChild(button);
    act(() => content.onClick({ target: button, detail: 1 } as unknown as React.MouseEvent));
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    button.remove();
  });

  it("cancels Radix's restoration when the user clicked away", () => {
    const { trigger, content } = renderPopover();
    const focusSpy = vi.spyOn(trigger, "focus");

    act(() => content.onPointerDownOutside());
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("stands down for a close the shell already owns", () => {
    // `deferToRadix()` is how `AppPalettePopover` keeps its own restoration
    // policy — notably `restoreFocusOnPointerDismiss`, which one palette sets
    // deliberately. It runs from the consumer's own onCloseAutoFocus, which the
    // wrapper invokes before the shared policy, so clearing the gesture flags
    // has to leave that policy with nothing to cancel.
    let overlay: OverlayFocusRestore | null = null;
    function Probe() {
      overlay = useOverlayFocusRestore();
      return null;
    }
    render(
      <Popover>
        <Probe />
        <PopoverTrigger>trigger</PopoverTrigger>
        <PopoverContent onCloseAutoFocus={() => overlay?.deferToRadix()}>body</PopoverContent>
      </Popover>
    );
    const trigger = document.querySelector("button") as HTMLButtonElement;
    const focusSpy = vi.spyOn(trigger, "focus");
    const content = captured.popoverContent as {
      onPointerDownOutside: () => void;
      onCloseAutoFocus: (event: { preventDefault: () => void; defaultPrevented: boolean }) => void;
    };

    act(() => content.onPointerDownOutside());
    const event = closeEvent();
    act(() => content.onCloseAutoFocus(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(focusSpy).not.toHaveBeenCalled();
  });
});

describe("tooltip suppression on the restored focus", () => {
  it("marks the element focus lands on, whichever close it was", async () => {
    const { isTooltipSuppressedForElement } = await import("@/lib/tooltipFocusSuppression");
    const trigger = renderDropdown();

    const event = closeEvent();
    act(() => contentProps().onCloseAutoFocus(event));
    // The restoration is synchronous with the close handler in every Radix
    // path, so the capture listener resolves inside this act().
    act(() => {
      fireEvent.focusIn(trigger);
    });

    expect(isTooltipSuppressedForElement(trigger)).toBe(true);
  });

  it("arms nothing that outlives a close which restores no focus", async () => {
    const { isTooltipFocusSuppressionArmed } = await import("@/lib/tooltipFocusSuppression");
    renderDropdown();
    vi.useFakeTimers();
    try {
      act(() => contentProps().onCloseAutoFocus(closeEvent()));
      expect(isTooltipFocusSuppressionArmed()).toBe(true);
      act(() => {
        vi.runAllTimers();
      });
      expect(isTooltipFocusSuppressionArmed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
