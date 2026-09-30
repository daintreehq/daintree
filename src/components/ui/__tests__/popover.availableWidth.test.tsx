// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPopoverAvailableWidth } from "../popover";

function boundary(): HTMLElement {
  getPopoverAvailableWidth();
  const element = document.querySelector<HTMLElement>('[data-portal-boundary="true"]');
  if (!element) throw new Error("no portal boundary");
  return element;
}

describe("getPopoverAvailableWidth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
