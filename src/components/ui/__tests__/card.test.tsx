// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { cn } from "@/lib/utils";
import { Card, cardVariants } from "../card";
import { SurfaceHeader, SurfaceHeaderTitle } from "../SurfaceHeader";
import {
  expectAtMostOneWinner,
  expectNarrowTransition,
  expectNoUnfocusedAccent,
  expectSingleWinner,
  utilitiesInGroup,
} from "./variantAssertions";

const VARIANTS = ["default", "subtle", "elevated"] as const;
const PADDINGS = ["none", "sm", "md", "lg"] as const;

describe("Card rendering", () => {
  it("renders a div and forwards ref and arbitrary props", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Card ref={ref} id="settings-block" data-testid="card">
        Body
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card.tagName).toBe("DIV");
    expect(ref.current).toBe(card);
    expect(card.id).toBe("settings-block");
  });

  it("becomes the supplied element under asChild with no wrapper left behind", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Card asChild interactive>
        <button type="button" onClick={onClick}>
          Pick this preset
        </button>
      </Card>
    );
    expect(container.querySelectorAll("div")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Pick this preset" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // Header composition belongs to SurfaceHeader; Card only has to get out of
  // its way, which means `padding="none"` must emit no padding at all.
  it("hosts a SurfaceHeader flush against its own edge", () => {
    const { container } = render(
      <Card padding="none" data-testid="card">
        <SurfaceHeader density="compact">
          <SurfaceHeaderTitle as="h3">Presets</SurfaceHeaderTitle>
        </SurfaceHeader>
        <div className="p-4">Body</div>
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(utilitiesInGroup(card.className, "paddingX")).toEqual([]);
    expect(utilitiesInGroup(card.className, "paddingY")).toEqual([]);
    expect(card.firstElementChild).toBe(container.querySelector("h3")?.parentElement);
  });
});

describe("cardVariants", () => {
  it("resolves every combination to a single utility per property", () => {
    for (const variant of VARIANTS) {
      for (const padding of PADDINGS) {
        // `none` legitimately emits no padding; the radius never varies.
        expectAtMostOneWinner(cardVariants({ variant, padding }), ["paddingX", "paddingY"]);
        expectSingleWinner(cardVariants({ variant, padding }), ["radius"]);
      }
    }
  });

  it("keeps padding on an axis of its own, ordered and distinct", () => {
    const sizes = PADDINGS.map(
      (padding) => utilitiesInGroup(cardVariants({ padding }), "paddingX")[0] ?? "none"
    );
    // A table that collapsed every padding onto one value would still satisfy
    // the single-winner check above, so pin that they actually differ.
    expect(new Set(sizes).size).toBe(PADDINGS.length);
  });

  it("varies only paint between variants, never the box it draws", () => {
    const box = (classes: string) =>
      classes
        .split(/\s+/)
        .filter((token) => /^(rounded|p[xy]?)-/.test(token))
        .sort();
    const baseline = box(cardVariants({ variant: "default" }));
    for (const variant of VARIANTS) {
      expect(box(cardVariants({ variant })), variant).toEqual(baseline);
    }
    // Elevated is allowed to add a shadow — that is paint, not geometry.
    expect(cardVariants({ variant: "elevated" })).toContain("shadow-");
    expect(cardVariants({ variant: "default" })).not.toContain("shadow-");
  });

  it("emits no padding utility when padding is none", () => {
    const classes = cardVariants({ padding: "none" });
    expect(classes.split(/\s+/).filter((token) => /^p[xy]?-/.test(token))).toEqual([]);
  });

  it("stays inert until asked to be interactive", () => {
    const inert = cardVariants({ interactive: false });
    expect(inert).not.toContain("hover:");
    expect(utilitiesInGroup(inert, "transition")).toEqual([]);
  });

  it("names the properties it transitions rather than widening to all", () => {
    expectNarrowTransition(cardVariants({ interactive: true }), /^transition-\[[a-z,-]+\]$/);
  });

  it("spends accent only on the focus ring", () => {
    for (const variant of VARIANTS) {
      expectNoUnfocusedAccent(cardVariants({ variant, interactive: true }));
    }
  });

  it("lets a consumer class win its property group outright", () => {
    const merged = cn(cardVariants({ padding: "md" }), "p-8");
    expect(utilitiesInGroup(merged, "paddingX")).toEqual(["p-8"]);
    expect(utilitiesInGroup(merged, "paddingY")).toEqual(["p-8"]);
  });
});
