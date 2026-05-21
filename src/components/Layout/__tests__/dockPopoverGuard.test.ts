// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  handleDockInteractOutside,
  handleDockEscapeKeyDown,
  shouldSuppressDockClose,
} from "../dockPopoverGuard";

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
