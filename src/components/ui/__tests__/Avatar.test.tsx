// @vitest-environment jsdom
import { render, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Avatar } from "../Avatar";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("Avatar", () => {
  it("shows skeleton on initial render", () => {
    const { container } = render(<Avatar src="test.jpg" alt="Test" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.style.opacity).toBe("0");
    const skeleton = container.querySelector(".animate-pulse-delayed");
    expect(skeleton).toBeTruthy();
    // Regression guard for #7572: bg-muted resolves to the panel surface
    // color, making the placeholder invisible against the dropdown row.
    expect(skeleton!.className).toContain("bg-muted-foreground/20");
    expect(skeleton!.className).not.toMatch(/(?:^|\s)bg-muted(?:\s|$)/);
  });

  it("shows skeleton when complete is true but naturalWidth is 0", () => {
    const origComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const origNaturalWidth = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth"
    );

    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      value: 0,
      configurable: true,
    });

    try {
      const { container } = render(<Avatar src="broken-cached.jpg" alt="Broken" />);
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      // naturalWidth=0 means a broken cached image — skeleton should remain
      expect(img!.style.opacity).toBe("0");
      expect(container.querySelector(".animate-pulse-delayed")).toBeTruthy();
    } finally {
      if (origComplete) {
        Object.defineProperty(HTMLImageElement.prototype, "complete", origComplete);
      }
      if (origNaturalWidth) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", origNaturalWidth);
      }
    }
  });

  it("sets loaded=true when cached image is detected at mount", () => {
    // Simulate a cached image by overriding complete/naturalWidth before
    // render. The lazy useState initializer calls probeCache(), which creates
    // a fresh Image() — patching the prototype makes that probe report cached.
    const origComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const origNaturalWidth = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth"
    );

    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      value: 48,
      configurable: true,
    });

    try {
      const { container } = render(<Avatar src="cached.jpg" alt="Cached" />);
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img!.style.opacity).toBe("1");
      expect(container.querySelector(".animate-pulse-delayed")).toBeFalsy();
      expect(container.querySelector(".animate-pulse")).toBeFalsy();
    } finally {
      if (origComplete) {
        Object.defineProperty(HTMLImageElement.prototype, "complete", origComplete);
      }
      if (origNaturalWidth) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", origNaturalWidth);
      }
    }
  });

  it("shows error state when onError fires", () => {
    const { container } = render(<Avatar src="broken.jpg" alt="Broken" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();

    act(() => {
      fireEvent.error(img!);
    });

    expect(container.querySelector("img")).toBeFalsy();
    expect(container.querySelector(".ring-2")).toBeTruthy();
    const userIcon = container.querySelector("svg");
    expect(userIcon).toBeTruthy();
  });

  it("resets state when src changes", () => {
    const { container, rerender } = render(<Avatar src="first.jpg" alt="First" />);

    const img = container.querySelector("img")!;
    act(() => {
      fireEvent.load(img);
    });
    expect(img.style.opacity).toBe("1");

    rerender(<Avatar src="second.jpg" alt="Second" />);
    const newImg = container.querySelector("img")!;
    expect(newImg.style.opacity).toBe("0");
    expect(container.querySelector(".animate-pulse-delayed")).toBeTruthy();
  });

  it("renders tooltip wrapper when title is provided", () => {
    const { container } = render(<Avatar src="test.jpg" alt="Test" title="Test User" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    // Content should still render through the mocked tooltip
  });

  it("renders circle shape by default", () => {
    const { container } = render(<Avatar src="test.jpg" alt="Test" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).not.toContain("rounded-md");
  });

  it("renders square shape when shape='square'", () => {
    const { container } = render(<Avatar src="test.jpg" alt="Test" shape="square" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.className).toContain("rounded-md");
    expect(img!.className).not.toContain("rounded-full");
  });

  it("renders circle shape when shape='circle' is explicit", () => {
    const { container } = render(<Avatar src="test.jpg" alt="Test" shape="circle" />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.className).toContain("rounded-full");
    expect(img!.className).not.toContain("rounded-md");
  });

  it("loads immediately when src changes between two cached images", () => {
    const origComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "complete");
    const origNaturalWidth = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      "naturalWidth"
    );

    Object.defineProperty(HTMLImageElement.prototype, "complete", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
      value: 48,
      configurable: true,
    });

    try {
      const { container, rerender } = render(<Avatar src="a.jpg" alt="A" />);
      expect(container.querySelector("img")!.style.opacity).toBe("1");

      rerender(<Avatar src="b.jpg" alt="B" />);
      // Src change re-probes the cache via probeCache() in the effect, so a
      // cached second image stays loaded with no placeholder flash.
      expect(container.querySelector("img")!.style.opacity).toBe("1");
      expect(container.querySelector(".animate-pulse-delayed")).toBeFalsy();
      expect(container.querySelector(".animate-pulse")).toBeFalsy();
    } finally {
      if (origComplete) {
        Object.defineProperty(HTMLImageElement.prototype, "complete", origComplete);
      }
      if (origNaturalWidth) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", origNaturalWidth);
      }
    }
  });
});
