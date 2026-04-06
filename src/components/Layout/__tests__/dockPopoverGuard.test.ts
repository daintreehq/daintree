// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { handleDockInteractOutside, handleDockEscapeKeyDown } from "../dockPopoverGuard";

function makeEvent(target: EventTarget | null): Event & { preventDefault: () => void } {
  const preventDefault = vi.fn();
  return { target, preventDefault } as unknown as Event & { preventDefault: () => void };
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

  it("prevents dismissal when target is inside a Radix popper wrapper", () => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const menuItem = document.createElement("div");
    wrapper.appendChild(menuItem);
    document.body.appendChild(wrapper);

    const event = makeEvent(menuItem);
    handleDockInteractOutside(event, null);

    expect(event.preventDefault).toHaveBeenCalled();
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
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const child = document.createElement("span");
    wrapper.appendChild(child);
    document.body.appendChild(wrapper);

    const event = makeEvent(child);
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
