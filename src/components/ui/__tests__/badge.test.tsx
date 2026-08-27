// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { cn } from "@/lib/utils";
import { Badge, badgeVariants } from "../badge";
import {
  expectNarrowTransition,
  expectNoUnfocusedAccent,
  expectSingleWinner,
  utilitiesInGroup,
} from "./variantAssertions";

const TONES = ["neutral", "outline", "error", "warning", "success", "info"] as const;
const SIZES = ["xs", "sm", "md"] as const;

const GEOMETRY = /^(px|py|p|gap|rounded)-/;
const COLOUR = /^(bg|text|border)-/;
// `text-xs` and `text-[10px]` set a size, not a colour — they belong to the
// geometry axis, so a naive /^text-/ would make the two axes look coupled.
const FONT_SIZE = /^text-(xs|sm|base|lg|xl|\[[^\]]+\])$/;

function tokens(classes: string, pattern: RegExp): string[] {
  return classes
    .split(/\s+/)
    .filter(
      (token) =>
        token.length > 0 &&
        !token.includes(":") &&
        pattern.test(token) &&
        !(pattern === COLOUR && FONT_SIZE.test(token))
    )
    .sort();
}

describe("Badge rendering", () => {
  it("renders a span and forwards ref, ARIA and data attributes", () => {
    const ref = createRef<HTMLSpanElement>();
    render(
      <Badge ref={ref} aria-label="CI failed" data-testid="ci-badge">
        Failed
      </Badge>
    );
    const badge = screen.getByTestId("ci-badge");
    expect(badge.tagName).toBe("SPAN");
    expect(ref.current).toBe(badge);
    expect(badge.getAttribute("aria-label")).toBe("CI failed");
  });

  it("exposes the resolved size and tone for call sites to assert on", () => {
    render(
      <Badge size="xs" tone="warning" data-testid="badge">
        Behind
      </Badge>
    );
    const badge = screen.getByTestId("badge");
    expect(badge.getAttribute("data-size")).toBe("xs");
    expect(badge.getAttribute("data-tone")).toBe("warning");
  });

  // The supported way to make a badge clickable: a real button owns the
  // semantics and the badge stays presentational inside it, so a tooltip
  // trigger still has a genuine interactive element to attach to.
  it("stays presentational inside an interactive wrapper", () => {
    const onClick = vi.fn();
    render(
      <button type="button" onClick={onClick}>
        <Badge tone="info">Open</Badge>
      </button>
    );
    const button = screen.getByRole("button", { name: "Open" });
    // No nested interactive element inside the button.
    expect(button.querySelector("button")).toBeNull();
    expect(button.querySelector('[data-slot="badge"]')!.tagName).toBe("SPAN");

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("badgeVariants", () => {
  it("keeps tone and geometry on independent axes", () => {
    const baselineGeometry = tokens(badgeVariants({ tone: "neutral" }), GEOMETRY);
    for (const tone of TONES) {
      expect(tokens(badgeVariants({ tone }), GEOMETRY)).toEqual(baselineGeometry);
    }

    const baselineColour = tokens(badgeVariants({ size: "sm" }), COLOUR);
    for (const size of SIZES) {
      expect(tokens(badgeVariants({ size }), COLOUR)).toEqual(baselineColour);
    }
  });

  it("resolves every size to a single utility per property", () => {
    for (const size of SIZES) {
      expectSingleWinner(badgeVariants({ size }), ["paddingX", "paddingY", "fontSize", "radius"]);
    }
  });

  // The repo's bare `rounded` is 10px; at pill height that reads as a lozenge.
  it("never falls back to the dialog-scale radius", () => {
    for (const shape of ["default", "pill"] as const) {
      const radius = utilitiesInGroup(badgeVariants({ shape }), "radius");
      expect(radius).toHaveLength(1);
      expect(radius[0]).not.toBe("rounded");
      expect(radius[0]).not.toBe("rounded-lg");
    }
  });

  it("gives every tone both a fill and a foreground so text stays legible", () => {
    for (const tone of TONES) {
      const colours = tokens(badgeVariants({ tone }), COLOUR);
      expect(
        colours.some((token) => token.startsWith("bg-")),
        tone
      ).toBe(true);
      expect(
        colours.some((token) => token.startsWith("text-")),
        tone
      ).toBe(true);
    }
  });

  it("never widens to a blanket transition", () => {
    expectNarrowTransition(badgeVariants(), /^transition-(colors|\[[a-z,-]+\])$/);
  });

  it("keeps every size on its own type scale", () => {
    // `xs` and `sm` deliberately share a box and differ only in type — the size
    // axis is the type scale, and a table that collapsed two sizes onto one
    // would still satisfy the single-winner check above.
    const scales = SIZES.map((size) => utilitiesInGroup(badgeVariants({ size }), "fontSize")[0]);
    expect(scales.every(Boolean)).toBe(true);
    expect(new Set(scales).size).toBe(SIZES.length);
  });

  it("spends no accent at all — a badge is never the load-bearing signal", () => {
    for (const tone of TONES) {
      expectNoUnfocusedAccent(badgeVariants({ tone }));
      expect(badgeVariants({ tone })).not.toContain("accent");
    }
  });

  it("lets a call site override a tone's foreground without losing the fill", () => {
    const merged = cn(badgeVariants({ tone: "outline" }), "text-state-waiting");
    const colours = tokens(merged, COLOUR);
    expect(colours).toContain("text-state-waiting");
    expect(colours.some((token) => token.startsWith("bg-"))).toBe(true);
    expect(colours.filter((token) => /^text-/.test(token))).toEqual(["text-state-waiting"]);
  });
});
