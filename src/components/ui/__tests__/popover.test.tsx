// @vitest-environment jsdom
import { cleanup, render, act } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { PopoverContent } from "../popover";
import { primeRadix } from "../radix-loader";

// Radix/Floating UI installs its own ResizeObservers on the reference/floating
// elements, so global counters would catch those too. Track per-instance targets
// to attribute observers to the portal boundary specifically.
let instances: MockResizeObserver[] = [];
let resizeCallbacks: ResizeObserverCallback[] = [];

class MockResizeObserver implements ResizeObserver {
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  disconnected = false;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    instances.push(this);
    resizeCallbacks.push(callback);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

function isPortalBoundary(el: Element): boolean {
  return el instanceof HTMLElement && el.dataset.portalBoundary === "true";
}

function portalBoundaryObserver(): MockResizeObserver | undefined {
  return instances.find((o) => o.targets.some(isPortalBoundary));
}

beforeAll(async () => {
  await primeRadix();
});

beforeEach(() => {
  instances = [];
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function getContentEl(): HTMLElement {
  const el = document.querySelector("[data-radix-popper-content-wrapper] > *");
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Expected PopoverContent HTMLElement, got ${el === null ? "null" : typeof el}`);
  }
  return el;
}

function fireResize() {
  act(() => {
    for (const cb of resizeCallbacks) {
      cb([], {} as ResizeObserver);
    }
  });
}

describe("PopoverContent reposition on boundary resize (issue #8969)", () => {
  it("starts at data-reposition-tick='0'", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    expect(getContentEl().getAttribute("data-reposition-tick")).toBe("0");
  });

  it("increments the tick when the boundary resize callback fires", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    fireResize();
    expect(getContentEl().getAttribute("data-reposition-tick")).toBe("1");
  });

  it("increments monotonically across repeated resize callbacks", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    fireResize();
    fireResize();
    fireResize();
    expect(getContentEl().getAttribute("data-reposition-tick")).toBe("3");
  });

  it("internal tick wins over a caller-supplied data-reposition-tick prop", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount data-reposition-tick={99}>
          content
        </PopoverContent>
      </PopoverPrimitive.Root>
    );
    expect(getContentEl().getAttribute("data-reposition-tick")).toBe("0");
    fireResize();
    expect(getContentEl().getAttribute("data-reposition-tick")).toBe("1");
  });

  it("observes the portal boundary element", () => {
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    expect(portalBoundaryObserver()).toBeDefined();
  });

  it("does not observe the portal boundary when a caller-supplied collisionBoundary is provided", () => {
    const callerBoundary = document.createElement("div");
    document.body.appendChild(callerBoundary);
    render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount collisionBoundary={callerBoundary}>
          content
        </PopoverContent>
      </PopoverPrimitive.Root>
    );
    expect(portalBoundaryObserver()).toBeUndefined();
    callerBoundary.remove();
  });

  it("disconnects the boundary observer on unmount", () => {
    const { unmount } = render(
      <PopoverPrimitive.Root open>
        <PopoverPrimitive.Trigger>trigger</PopoverPrimitive.Trigger>
        <PopoverContent forceMount>content</PopoverContent>
      </PopoverPrimitive.Root>
    );
    const observer = portalBoundaryObserver();
    expect(observer).toBeDefined();
    expect(observer!.disconnected).toBe(false);
    unmount();
    expect(observer!.disconnected).toBe(true);
  });
});
