// @vitest-environment jsdom
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { ScrollShadow } from "../ScrollShadow";

let resizeCallbacks: ResizeObserverCallback[] = [];
let observedElements: Element[] = [];

class MockResizeObserver implements ResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeCallbacks.push(callback);
  }
  observe(target: Element) {
    observedElements.push(target);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  resizeCallbacks = [];
  observedElements = [];
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
  Object.defineProperty(el, "scrollTop", { value: metrics.scrollTop, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
}

describe("ScrollShadow", () => {
  it("renders children", () => {
    render(
      <ScrollShadow>
        <p>Hello</p>
      </ScrollShadow>
    );
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("shows no shadows when content does not overflow", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Short content</p>
      </ScrollShadow>
    );
    const gradients = container.querySelectorAll("[aria-hidden='true']");
    expect(gradients).toHaveLength(0);
  });

  it("shows bottom shadow when content overflows and scrolled to top", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Long content</p>
      </ScrollShadow>
    );

    const scrollDiv = container.querySelector(".overflow-y-auto")!;
    setScrollMetrics(scrollDiv as HTMLElement, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 200,
    });

    act(() => {
      fireEvent.scroll(scrollDiv);
    });

    const gradients = container.querySelectorAll("[aria-hidden='true']");
    expect(gradients).toHaveLength(1);
    expect(gradients[0].className).toContain("bottom-0");
  });

  it("shows top shadow when scrolled down", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Long content</p>
      </ScrollShadow>
    );

    const scrollDiv = container.querySelector(".overflow-y-auto")!;
    setScrollMetrics(scrollDiv as HTMLElement, {
      scrollTop: 300,
      scrollHeight: 500,
      clientHeight: 200,
    });

    act(() => {
      fireEvent.scroll(scrollDiv);
    });

    const gradients = container.querySelectorAll("[aria-hidden='true']");
    expect(gradients).toHaveLength(1);
    expect(gradients[0].className).toContain("top-0");
  });

  it("shows both shadows when scrolled to middle", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Long content</p>
      </ScrollShadow>
    );

    const scrollDiv = container.querySelector(".overflow-y-auto")!;
    setScrollMetrics(scrollDiv as HTMLElement, {
      scrollTop: 100,
      scrollHeight: 500,
      clientHeight: 200,
    });

    act(() => {
      fireEvent.scroll(scrollDiv);
    });

    const gradients = container.querySelectorAll("[aria-hidden='true']");
    expect(gradients).toHaveLength(2);
    expect(gradients[0].className).toContain("top-0");
    expect(gradients[1].className).toContain("bottom-0");
  });

  it("forwards ref to inner scrollable div", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <ScrollShadow ref={ref}>
        <p>Content</p>
      </ScrollShadow>
    );
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
    expect(ref.current!.classList.contains("overflow-y-auto")).toBe(true);
  });

  it("applies className to outer wrapper and scrollClassName to inner div", () => {
    const { container } = render(
      <ScrollShadow className="max-h-64" scrollClassName="p-4">
        <p>Content</p>
      </ScrollShadow>
    );
    const outer = container.firstElementChild!;
    expect(outer.className).toContain("max-h-64");
    expect(outer.className).toContain("relative");

    const inner = outer.querySelector(".overflow-y-auto")!;
    expect(inner.className).toContain("p-4");
  });

  it("outer wrapper uses flex layout for height chain", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Content</p>
      </ScrollShadow>
    );
    const outer = container.firstElementChild!;
    expect(outer.className).toContain("flex");
    expect(outer.className).toContain("flex-col");
    expect(outer.className).toContain("min-h-0");
    expect(outer.className).toContain("overflow-hidden");

    const inner = outer.querySelector(".overflow-y-auto")!;
    expect(inner.className).toContain("flex-1");
  });

  it("passes through additional div props to inner scrollable div", () => {
    render(
      <ScrollShadow role="listbox" tabIndex={0} data-testid="scroll-inner">
        <p>Content</p>
      </ScrollShadow>
    );
    const inner = screen.getByTestId("scroll-inner");
    expect(inner.getAttribute("role")).toBe("listbox");
    expect(inner.getAttribute("tabindex")).toBe("0");
  });

  it("gradient overlays are pointer-events-none", () => {
    const { container } = render(
      <ScrollShadow>
        <p>Long content</p>
      </ScrollShadow>
    );

    const scrollDiv = container.querySelector(".overflow-y-auto")!;
    setScrollMetrics(scrollDiv as HTMLElement, {
      scrollTop: 100,
      scrollHeight: 500,
      clientHeight: 200,
    });

    act(() => {
      fireEvent.scroll(scrollDiv);
    });

    const gradients = container.querySelectorAll("[aria-hidden='true']");
    for (const gradient of gradients) {
      expect(gradient.className).toContain("pointer-events-none");
    }
  });
});
