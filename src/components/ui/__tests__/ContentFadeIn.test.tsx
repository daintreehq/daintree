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
    it("applies motion-safe entry animation classes on the wrapper", () => {
      const { container } = render(
        <ContentFadeIn>
          <span>child</span>
        </ContentFadeIn>
      );
      const root = container.firstElementChild;
      expect(root).toBeTruthy();
      expect(root?.className).toContain("motion-safe:animate-in");
      expect(root?.className).toContain("motion-safe:fade-in");
      expect(root?.className).toContain("motion-safe:duration-150");
    });

    it("includes the content-fade-in marker class for CSS overrides", () => {
      const { container } = render(<ContentFadeIn>x</ContentFadeIn>);
      expect(container.firstElementChild?.className).toContain("content-fade-in");
    });

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

describe("content-fade-in CSS contract", () => {
  // Read the source CSS once. Build pipeline transforms (Tailwind, autoprefixer)
  // shouldn't matter — we're asserting authored intent in src/index.css.
  const css = readFileSync(resolve(__dirname, "../../../index.css"), "utf8");

  it("declares the data-reduce-animations override for .content-fade-in", () => {
    const block = css.match(
      /body\[data-reduce-animations="true"\]\s+\.content-fade-in\s*\{[^}]*\}/
    )?.[0];
    expect(block).toBeTruthy();
    expect(block).toMatch(/animation:\s*none/);
    expect(block).toMatch(/opacity:\s*1/);
  });
});
