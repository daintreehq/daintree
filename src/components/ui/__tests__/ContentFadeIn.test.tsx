// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { ContentFadeIn } from "../ContentFadeIn";

describe("ContentFadeIn", () => {
  describe("animation classes", () => {
    it("does not use transition-all", () => {
      const { container } = render(<ContentFadeIn>x</ContentFadeIn>);
      expect(container.innerHTML).not.toContain("transition-all");
    });

    it("does not apply will-change in JSX (CSS owns that lifecycle)", () => {
      const { container } = render(<ContentFadeIn>x</ContentFadeIn>);
      expect(container.innerHTML).not.toContain("will-change");
    });
  });

  describe("rendering", () => {
    it("renders children", () => {
      render(
        <ContentFadeIn>
          <span data-testid="child">hello</span>
        </ContentFadeIn>
      );
      expect(screen.getByTestId("child")).toBeTruthy();
    });

    it("merges custom className", () => {
      const { container } = render(<ContentFadeIn className="my-custom flex-1">x</ContentFadeIn>);
      const root = container.firstElementChild;
      expect(root?.className).toContain("my-custom");
      expect(root?.className).toContain("flex-1");
    });

    it("forwards arbitrary HTML attributes (role, data-*, aria-*)", () => {
      const { container } = render(
        <ContentFadeIn role="presentation" data-testid="root" aria-label="content">
          x
        </ContentFadeIn>
      );
      const root = container.firstElementChild;
      expect(root?.getAttribute("role")).toBe("presentation");
      expect(root?.getAttribute("data-testid")).toBe("root");
      expect(root?.getAttribute("aria-label")).toBe("content");
    });
  });
});

describe("ContentFadeIn under reduced motion", () => {
  // A fade is not motion (WCAG 2.3.3), so reduced motion keeps it: nothing may
  // gate the fade behind a motion variant, and no reduce-motion rule may strip it.
  it("does not gate its fade on a motion variant", () => {
    const { container } = render(<ContentFadeIn>x</ContentFadeIn>);
    const classes = container.firstElementChild?.className.split(/\s+/) ?? [];
    expect(classes.some((c) => /fade-in/.test(c))).toBe(true);
    expect(classes.filter((c) => /^motion-(safe|reduce):/.test(c))).toEqual([]);
  });

  it("sets its duration on the animation, not as a bare transition duration", () => {
    const { container } = render(<ContentFadeIn>x</ContentFadeIn>);
    const classes = container.firstElementChild?.className.split(/\s+/) ?? [];
    expect(classes.filter((c) => /^duration-/.test(c))).toEqual([]);
  });

  it("has no reduce-motion rule stripping the keyframe", () => {
    const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");
    const classes = new Set(
      (render(<ContentFadeIn>x</ContentFadeIn>).container.firstElementChild?.className ?? "")
        .split(/\s+/)
        .filter(Boolean)
    );
    for (const block of css.match(/@variant\s+reduce-motion\s*\{[\s\S]*?\n\}/g) ?? []) {
      for (const cls of classes) {
        expect(block.includes(`.${cls} {`) || block.includes(`.${cls},`)).toBe(false);
      }
    }
  });
});
