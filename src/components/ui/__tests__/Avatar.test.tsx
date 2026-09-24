// @vitest-environment jsdom
import { useLayoutEffect, useRef } from "react";
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
    expect(skeleton!.className).not.toMatch(/(?:^|\s)bg-muted(?:\s|$)/);
    expect(skeleton!.className).not.toMatch(/muted-foreground/);
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
    const fallback = container.querySelector("[data-avatar-fallback]");
    expect(fallback!.getAttribute("data-avatar-fallback")).toBe("failed");
    expect(fallback!.querySelector("svg")).toBeTruthy();
  });

  it("settles on the failed fallback at once when there is no URL", () => {
    for (const src of ["", "   "]) {
      const { container, unmount } = render(<Avatar src={src} alt="" />);
      // No <img>: an empty src resolves to the page itself.
      expect(container.querySelector("img")).toBeFalsy();
      const fallback = container.querySelector("[data-avatar-fallback]");
      expect(fallback!.getAttribute("data-avatar-fallback")).toBe("failed");
      expect(container.querySelector(".animate-pulse-delayed")).toBeFalsy();
      unmount();
    }
  });

  it("never lets a loading placeholder and a failed one look alike", () => {
    const loading = render(<Avatar src="slow.jpg" alt="" />).container;
    const failed = render(<Avatar src="" alt="" />).container;
    const a = loading.querySelector("[data-avatar-fallback]")!;
    const b = failed.querySelector("[data-avatar-fallback]")!;
    expect(a.className).not.toBe(b.className);
    // Only a request in flight pulses; only a settled failure carries a glyph.
    expect(a.className).toMatch(/animate-pulse/);
    expect(b.className).not.toMatch(/animate-pulse/);
    expect(a.querySelector("svg")).toBeFalsy();
    expect(b.querySelector("svg")).toBeTruthy();
  });

  it("keeps a decorative avatar out of the accessibility tree in every state", () => {
    const { container, rerender } = render(<Avatar src="x.jpg" alt="" />);
    const check = () => {
      const root = container.firstElementChild!;
      expect(root.getAttribute("aria-hidden")).toBe("true");
      expect(container.querySelector('[role="img"]')).toBeFalsy();
    };
    check();
    act(() => {
      fireEvent.error(container.querySelector("img")!);
    });
    check();
    rerender(<Avatar src="" alt="" />);
    check();
  });

  it("names a failed avatar that carries its own alt", () => {
    const { container } = render(<Avatar src="" alt="octocat" />);
    const img = container.querySelector('[role="img"]');
    expect(img!.getAttribute("aria-label")).toBe("octocat");
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBeNull();
  });

  it("swaps from a failed picture to a cached one without showing the stale failure", () => {
    // Reads the DOM in a layout effect — i.e. the commit the user would see
    // painted — rather than after act() has flushed every follow-up effect.
    const seen: (string | null)[] = [];
    function Probe({ src }: { src: string }) {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        const fb = ref.current!.querySelector("[data-avatar-fallback]");
        seen.push(fb ? fb.getAttribute("data-avatar-fallback") : null);
      }, [src]);
      return (
        <div ref={ref}>
          <Avatar src={src} alt="" />
        </div>
      );
    }

    const { rerender } = render(<Probe src="" />);
    expect(seen).toEqual(["failed"]);

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
      rerender(<Probe src="cached.jpg" />);
      expect(seen).toEqual(["failed", null]);
    } finally {
      if (origComplete) {
        Object.defineProperty(HTMLImageElement.prototype, "complete", origComplete);
      }
      if (origNaturalWidth) {
        Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", origNaturalWidth);
      }
    }
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
