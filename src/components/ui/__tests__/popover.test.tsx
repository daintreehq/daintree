// @vitest-environment jsdom
import { cleanup, render, act } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Popover, PopoverContent, PopoverTrigger, getPopoverAvailableWidth } from "../popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../tooltip";
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

function boundary(): HTMLElement {
  getPopoverAvailableWidth();
  const element = document.querySelector<HTMLElement>('[data-portal-boundary="true"]');
  if (!element) throw new Error("no portal boundary");
  return element;
}

describe("getPopoverAvailableWidth", () => {
  it("is the collision boundary's width less the padding on both sides", () => {
    const element = boundary();
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 800));
    // The boundary excludes the native panel on the right, so it can be narrower than the window.
    expect(window.innerWidth).toBeGreaterThan(900);
    expect(getPopoverAvailableWidth()).toBe(900 - 16);
    expect(getPopoverAvailableWidth(4)).toBe(900 - 8);
  });

  it("falls back to the window when the boundary has no layout", () => {
    vi.spyOn(boundary(), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 0, 0));
    expect(getPopoverAvailableWidth()).toBe(window.innerWidth - 16);
  });
});

// A popover trigger that also explains itself through the shared Tooltip carries
// two Radix triggers on one element, and the tooltip's `data-state` wins. The
// trigger's `aria-controls` cleanup must key on what the popover owns, or an open
// popover loses the attribute that names it.
function renderTooltippedPopover(open: boolean) {
  return render(
    <TooltipProvider>
      <Popover open={open} onOpenChange={() => {}}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button type="button" aria-label="Sort">
                sort
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Sort</TooltipContent>
        </Tooltip>
        <PopoverContent>options</PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

describe("PopoverTrigger inside a Tooltip trigger", () => {
  it("keeps aria-controls pointing at the open popover", async () => {
    const { getByRole } = renderTooltippedPopover(true);
    await act(async () => {});
    const trigger = getByRole("button", { name: "Sort" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const controls = trigger.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
  });

  it("drops aria-controls while the popover is closed", async () => {
    const { getByRole } = renderTooltippedPopover(false);
    await act(async () => {});
    const trigger = getByRole("button", { name: "Sort" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.hasAttribute("aria-controls")).toBe(false);
  });
});
