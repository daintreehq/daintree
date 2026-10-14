// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ScrollPill } from "../ScrollPill";
import {
  UI_ENTER_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_DURATION,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";

describe("ScrollPill", () => {
  it("forces type=button even if a caller passes type=submit", () => {
    const extra = { type: "submit" } as Record<string, unknown>;
    render(
      <ScrollPill isVisible translateDirection="down" {...extra}>
        hi
      </ScrollPill>
    );
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("uses scoped transition-[opacity,translate] and not bare transition", () => {
    // `translate` (not `transform`) because Tailwind v4 translate-* utilities
    // emit the individual `translate` property, which a `transform` entry in
    // the transition list does not cover.
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("transition-[opacity,translate]");
    expect(button.className.split(/\s+/)).not.toContain("transition");
  });

  it("never lets a hover utility replace the opaque fill", () => {
    // The overlay ladder is alpha-only: as a background-color on hover it
    // turned the pill see-through. A hover tint must be an image layer.
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const classes = screen.getByRole("button").className.split(/\s+/);
    const hoverFills = classes.filter((c) => c.startsWith("hover:bg-"));
    expect(hoverFills.length).toBeGreaterThan(0);
    for (const c of hoverFills) expect(c).toMatch(/^hover:bg-\[linear-gradient\(/);
  });

  it("enters on the entry tier and leaves on the exit tier", () => {
    const { rerender } = render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.style.transitionDuration).toBe(`${UI_ENTER_DURATION}ms`);
    expect(button.style.transitionTimingFunction).toBe(UI_ENTER_EASING);
    expect(button.className.split(/\s+/).some((c) => /^duration-/.test(c))).toBe(false);
    rerender(
      <ScrollPill isVisible={false} translateDirection="down">
        hi
      </ScrollPill>
    );
    expect(button.style.transitionDuration).toBe(`${UI_EXIT_DURATION}ms`);
    expect(button.style.transitionTimingFunction).toBe(UI_EXIT_EASING);
  });

  it("applies the visible resting state when isVisible is true", () => {
    render(
      <ScrollPill isVisible translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-100");
    expect(button.className).toContain("translate-y-0");
  });

  it("slides up when hidden with translateDirection=up", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="up">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("-translate-y-2");
  });

  it("slides down when hidden with translateDirection=down", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="down">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("translate-y-2");
    expect(button.className.split(/\s+/)).not.toContain("-translate-y-2");
  });

  it("does not move vertically when hidden with translateDirection=none", () => {
    render(
      <ScrollPill isVisible={false} translateDirection="none">
        hi
      </ScrollPill>
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("translate-y-0");
  });
});
