// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { revealTabInStrip } from "../document-tab";

/**
 * A strip `stripWidth` wide scrolled to `scrollLeft`, holding a tab whose left edge
 * sits `tabContentLeft` px into the strip's scrollable content. The tab reports
 * `offsetLeft` 0, as it does when a host wraps it in its own positioned box — the
 * measurement must not depend on it.
 */
function setup(stripWidth: number, scrollLeft: number, tabContentLeft: number, tabWidth: number) {
  const strip = document.createElement("div");
  const tab = document.createElement("div");
  strip.appendChild(tab);
  Object.defineProperty(strip, "clientWidth", { value: stripWidth });
  strip.scrollLeft = 0;
  Object.defineProperty(strip, "scrollLeft", { value: scrollLeft, writable: true });
  Object.defineProperty(tab, "offsetWidth", { value: tabWidth });
  Object.defineProperty(tab, "offsetLeft", { value: 0 });
  strip.getBoundingClientRect = () => ({ left: 100 }) as DOMRect;
  tab.getBoundingClientRect = () => ({ left: 100 + tabContentLeft - scrollLeft }) as DOMRect;
  const scrollTo = vi.fn();
  strip.scrollTo = scrollTo as unknown as typeof strip.scrollTo;
  return { strip, tab, scrollTo };
}

describe("revealTabInStrip", () => {
  it("scrolls forward to a tab past the right edge", () => {
    const { strip, tab, scrollTo } = setup(300, 0, 400, 100);
    revealTabInStrip(strip, tab, "auto");
    expect(scrollTo).toHaveBeenCalledWith({ left: 200, behavior: "auto" });
  });

  it("scrolls back to a tab before the left edge", () => {
    const { strip, tab, scrollTo } = setup(300, 250, 50, 100);
    revealTabInStrip(strip, tab, "auto");
    expect(scrollTo).toHaveBeenCalledWith({ left: 50, behavior: "auto" });
  });

  it("leaves a tab that is already fully visible alone", () => {
    const { strip, tab, scrollTo } = setup(300, 100, 150, 100);
    revealTabInStrip(strip, tab, "auto");
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
