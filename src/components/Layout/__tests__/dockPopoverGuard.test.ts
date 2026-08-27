// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  handleDockFocusOutside,
  shouldSuppressDockClose,
} from "../dockPopoverGuard";
import {
  escapeWasYieldedToDialog,
  ESCAPE_BACKSTOP_DIALOG_ATTR,
  _resetForTests,
} from "@/lib/dialogEscapeBackstop";
import { APP_DIALOG_SURFACE_ATTR } from "@/lib/appDialogSurface";

function makeEvent(target: EventTarget | null): Event & { preventDefault: () => void } {
  const preventDefault = vi.fn();
  return { target, preventDefault } as unknown as Event & { preventDefault: () => void };
}

function makeRadixOutsideEvent(
  originalTarget: EventTarget | null,
  eventTarget: EventTarget | null
): Event & {
  preventDefault: () => void;
  detail: { originalEvent: Event };
} {
  const preventDefault = vi.fn();
  return {
    target: eventTarget,
    detail: { originalEvent: { target: originalTarget } as Event },
    preventDefault,
  } as unknown as Event & {
    preventDefault: () => void;
    detail: { originalEvent: Event };
  };
}

describe("handleDockInteractOutside", () => {
  it("keeps the popover open when the click lands in a dialog it opened", () => {
    // A dialog opened from a dock popover portals to the body, so every click
    // inside it is "outside" the popover. It has to stay open behind the dialog
    // it spawned (#11505) — the Escape path guards the same invariant below.
    const dialog = document.createElement("div");
    dialog.setAttribute(APP_DIALOG_SURFACE_ATTR, "");
    const confirmButton = document.createElement("button");
    dialog.appendChild(confirmButton);
    document.body.appendChild(dialog);

    const event = makeRadixOutsideEvent(confirmButton, confirmButton);
    handleDockInteractOutside(event, document.createElement("div"));

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("still dismisses for a click that is in neither the portal nor a dialog", () => {
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);

    const event = makeRadixOutsideEvent(elsewhere, elsewhere);
    handleDockInteractOutside(event, document.createElement("div"));

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("prevents dismissal when target is inside the portal container", () => {
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    document.body.appendChild(container);

    const event = makeEvent(button);
    handleDockInteractOutside(event, container);

    expect(event.preventDefault).toHaveBeenCalled();
    container.remove();
  });

  it("prevents dismissal when target is inside a dock-popover-child element", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-dock-popover-child", "");
    const menuItem = document.createElement("div");
    wrapper.appendChild(menuItem);
    document.body.appendChild(wrapper);

    const event = makeEvent(menuItem);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).toHaveBeenCalled();
    wrapper.remove();
  });

  it("uses Radix originalEvent target for dock-popover-child portals", () => {
    const layerTarget = document.createElement("div");
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-dock-popover-child", "");
    const menuItem = document.createElement("div");
    wrapper.appendChild(menuItem);
    document.body.appendChild(wrapper);
    document.body.appendChild(layerTarget);

    const event = makeRadixOutsideEvent(menuItem, layerTarget);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).toHaveBeenCalled();
    wrapper.remove();
    layerTarget.remove();
  });

  it("allows dismissal when target is on an unrelated Radix popper wrapper", () => {
    // Regression for #8161: the previous Guard 2 selector matched any
    // [data-radix-popper-content-wrapper] in the document, blocking dismissal
    // even when the click originated in an unrelated Radix overlay. The
    // project-owned data-dock-popover-child attribute must NOT match such
    // wrappers — only Radix content rendered inside a DockPopoverChildProvider.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const menuItem = document.createElement("div");
    wrapper.appendChild(menuItem);
    document.body.appendChild(wrapper);

    const event = makeEvent(menuItem);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).not.toHaveBeenCalled();
    wrapper.remove();
  });

  it("allows dismissal when target is outside both guards", () => {
    const container = document.createElement("div");
    const outsideElement = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(outsideElement);

    const event = makeEvent(outsideElement);
    handleDockInteractOutside(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    container.remove();
    outsideElement.remove();
  });

  it("does nothing for non-Element targets", () => {
    const event = makeEvent(document.createTextNode("text"));
    handleDockInteractOutside(event, null);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("handles null portal container gracefully", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-dock-popover-child", "");
    const child = document.createElement("span");
    wrapper.appendChild(child);
    document.body.appendChild(wrapper);

    const event = makeEvent(child);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).toHaveBeenCalled();
    wrapper.remove();
  });

  it("matches when the data-dock-popover-child attribute is on an ancestor", () => {
    // Radix content nodes stamp the attribute on themselves; clicks frequently
    // land on a descendant (a menu item, an inner span). `closest` should walk
    // up the tree and find the stamped ancestor.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-dock-popover-child", "");
    const middle = document.createElement("div");
    const leaf = document.createElement("span");
    middle.appendChild(leaf);
    wrapper.appendChild(middle);
    document.body.appendChild(wrapper);

    const event = makeEvent(leaf);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).toHaveBeenCalled();
    wrapper.remove();
  });
});

function makeEscapeEvent(): KeyboardEvent & { preventDefault: () => void } {
  const preventDefault = vi.fn();
  return { preventDefault } as unknown as KeyboardEvent & { preventDefault: () => void };
}

describe("handleDockEscapeKeyDown", () => {
  it("prevents dismissal when activeElement is inside the portal container", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);
    document.body.appendChild(container);
    input.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).toHaveBeenCalled();
    container.remove();
  });

  it("allows dismissal when activeElement is outside the portal container", () => {
    const container = document.createElement("div");
    const outside = document.createElement("input");
    document.body.appendChild(container);
    document.body.appendChild(outside);
    outside.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    container.remove();
    outside.remove();
  });

  it("allows dismissal when portalContainer is null", () => {
    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, null);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("allows dismissal when no element has focus", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    (document.activeElement as HTMLElement)?.blur?.();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    container.remove();
  });
});

/**
 * A dialog opened from inside a dock popover portals to the body, so the
 * containment check above misses it — Radix would dismiss the popover out from
 * under a dialog the user is reading, and `AppDialog`'s own backstop stands
 * down because it sees this popover open (#11505). The popover has to decline
 * the keypress and hand it upward.
 */
describe("handleDockEscapeKeyDown — yielding to a dialog above the popover", () => {
  function mountModalDialog(): { dialog: HTMLElement; focusable: HTMLElement } {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute(ESCAPE_BACKSTOP_DIALOG_ATTR, "");
    const focusable = document.createElement("button");
    dialog.appendChild(focusable);
    document.body.appendChild(dialog);
    return { dialog, focusable };
  }

  afterEach(() => {
    _resetForTests();
    document.body.innerHTML = "";
  });

  it("blocks the dock dismissal when focus is inside a modal dialog", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { focusable } = mountModalDialog();
    focusable.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("marks that keypress as yielded so the dialog's backstop takes it", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { focusable } = mountModalDialog();
    focusable.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(escapeWasYieldedToDialog(event)).toBe(true);
  });

  it("does not yield a keypress it never saw", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { focusable } = mountModalDialog();
    focusable.focus();

    const seen = makeEscapeEvent();
    handleDockEscapeKeyDown(seen, container);

    // The mark is scoped to one event object: a later Escape pressed while a
    // Select is legitimately open inside the dialog must not inherit it and
    // close the dialog underneath.
    const later = makeEscapeEvent();
    expect(escapeWasYieldedToDialog(later)).toBe(false);
  });

  it("still dismisses the dock when focus sits on a non-modal overlay", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    // A Radix popover/menu marks itself `role="dialog"` but never `aria-modal`.
    const layer = document.createElement("div");
    layer.setAttribute("role", "dialog");
    const focusable = document.createElement("button");
    layer.appendChild(focusable);
    document.body.appendChild(layer);
    focusable.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(escapeWasYieldedToDialog(event)).toBe(false);
  });

  it("still dismisses the dock for a modal that the backstop does not handle", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    // WorktreeOverviewModal, ThemeBrowser and WebviewDialog are aria-modal but
    // register no backstop handler. Yielding to one would block the dock's
    // dismissal with nothing left to act on the keypress.
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    const focusable = document.createElement("button");
    modal.appendChild(focusable);
    document.body.appendChild(modal);
    focusable.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(escapeWasYieldedToDialog(event)).toBe(false);
  });

  it("prefers the portal-containment guard when focus is in the terminal", () => {
    const container = document.createElement("div");
    const input = document.createElement("input");
    container.appendChild(input);
    document.body.appendChild(container);
    mountModalDialog();
    input.focus();

    const event = makeEscapeEvent();
    handleDockEscapeKeyDown(event, container);

    // Typing in the docked terminal must keep behaving as before: the popover
    // holds Escape itself rather than handing it to a dialog it isn't in.
    expect(event.preventDefault).toHaveBeenCalled();
    expect(escapeWasYieldedToDialog(event)).toBe(false);
  });
});

describe("shouldSuppressDockClose", () => {
  it("returns true when focus is inside the portal container (typing into terminal)", () => {
    const container = document.createElement("div");
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    document.body.appendChild(container);
    textarea.focus();

    expect(shouldSuppressDockClose(container)).toBe(true);
    container.remove();
  });

  it("returns false when focus is outside the portal container", () => {
    const container = document.createElement("div");
    const outside = document.createElement("input");
    document.body.appendChild(container);
    document.body.appendChild(outside);
    outside.focus();

    expect(shouldSuppressDockClose(container)).toBe(false);
    container.remove();
    outside.remove();
  });

  it("returns false when the portal container is null (transition window)", () => {
    expect(shouldSuppressDockClose(null)).toBe(false);
  });

  it("returns false when no element has focus", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    (document.activeElement as HTMLElement)?.blur?.();

    expect(shouldSuppressDockClose(container)).toBe(false);
    container.remove();
  });
});

function makeTypedRadixEvent(
  originalType: string,
  originalTarget: EventTarget | null
): Event & { preventDefault: () => void; detail: { originalEvent: Event } } {
  const preventDefault = vi.fn();
  return {
    target: originalTarget,
    detail: { originalEvent: { type: originalType, target: originalTarget } as Event },
    preventDefault,
  } as unknown as Event & {
    preventDefault: () => void;
    detail: { originalEvent: Event };
  };
}

describe("handleDockInteractOutside — focus-driven guard (#8368)", () => {
  it("prevents a focusin dismissal when focus is inside the portal (mid-keystroke)", () => {
    const container = document.createElement("div");
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    document.body.appendChild(container);
    textarea.focus();

    // Simulate the portal-migration race: the focusin event's target resolves
    // to a stale offscreen node (Guard 1 misses it), but activeElement is the
    // in-portal textarea.
    const staleNode = document.createElement("div");
    document.body.appendChild(staleNode);
    const event = makeTypedRadixEvent("focusin", staleNode);
    handleDockInteractOutside(event, container);

    expect(event.preventDefault).toHaveBeenCalled();
    container.remove();
    staleNode.remove();
  });

  it("allows a focusin dismissal when focus left the portal", () => {
    const container = document.createElement("div");
    const outside = document.createElement("input");
    document.body.appendChild(container);
    document.body.appendChild(outside);
    outside.focus();

    const event = makeTypedRadixEvent("focusin", outside);
    handleDockInteractOutside(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    container.remove();
    outside.remove();
  });

  it("still allows a real pointer-down-outside while the terminal holds focus", () => {
    // Regression for the review finding: a legitimate outside click must
    // dismiss even though document.activeElement is the in-portal terminal.
    const container = document.createElement("div");
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);
    const canvas = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(canvas);
    textarea.focus();

    const event = makeTypedRadixEvent("pointerdown", canvas);
    handleDockInteractOutside(event, container);

    expect(event.preventDefault).not.toHaveBeenCalled();
    container.remove();
    canvas.remove();
  });
});

describe("handleDockFocusOutside", () => {
  it("always prevents focus-driven dismissal", () => {
    const event = makeEvent(null);
    handleDockFocusOutside(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("prevents dismissal regardless of where focus currently lives", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const event = makeEvent(outside);
    handleDockFocusOutside(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    outside.remove();
  });
});

describe("Dock popover guard integration", () => {
  it("DockedTerminalItem uses onInteractOutside with handleDockInteractOutside", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const filePath = path.resolve(__dirname, "../DockedTerminalItem.tsx");
    const content = await fs.readFile(filePath, "utf-8");

    expect(content).toContain("handleDockInteractOutside");
    expect(content).toContain("onInteractOutside");
  });

  it("DockedTabGroup uses onInteractOutside with handleDockInteractOutside", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const filePath = path.resolve(__dirname, "../DockedTabGroup.tsx");
    const content = await fs.readFile(filePath, "utf-8");

    expect(content).toContain("handleDockInteractOutside");
    expect(content).toContain("onInteractOutside");
  });
});
