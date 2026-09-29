// @vitest-environment jsdom
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { cn } from "@/lib/utils";
import { CARD_HOVER_PAINT, Card, ChoiceCard, cardVariants, choiceCardVariants } from "../card";
import { basePressTreatment } from "@/components/Terminal/__tests__/launcherMotionContract";
import { SurfaceHeader, SurfaceHeaderTitle } from "../SurfaceHeader";
import {
  baseUtilities,
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

  it("hosts its own interactive content without swallowing the semantics", () => {
    const onClick = vi.fn();
    render(
      <Card interactive data-testid="card">
        <button type="button" onClick={onClick}>
          Pick this preset
        </button>
      </Card>
    );
    const card = screen.getByTestId("card");
    // The frame stays a plain div — it never becomes the control itself.
    expect(card.tagName).toBe("DIV");
    expect(card.getAttribute("role")).toBeNull();

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

  it("keeps padding on an axis of its own, distinct on both sides", () => {
    for (const axis of ["paddingX", "paddingY"] as const) {
      const sizes = PADDINGS.map(
        (padding) => utilitiesInGroup(cardVariants({ padding }), axis)[0] ?? "none"
      );
      // A table that collapsed every padding onto one value would still satisfy
      // the at-most-one check above, so pin that they actually differ.
      expect(new Set(sizes).size, axis).toBe(PADDINGS.length);
    }
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

  // The frame is a plain div that never takes focus, so a focus ring on it could
  // never match. Focus — and the accent that comes with it — belongs to the real
  // control the card wraps.
  it("paints no focus state on a frame that cannot take focus", () => {
    for (const variant of VARIANTS) {
      const classes = cardVariants({ variant, interactive: true });
      const focusUtilities = classes.split(/\s+/).filter((token) => token.includes("focus"));
      expect(focusUtilities, variant).toEqual([]);
      expectNoUnfocusedAccent(classes);
    }
  });

  it("exposes the resolved variant and padding for call sites to assert on", () => {
    render(
      <Card variant="elevated" padding="lg" data-testid="card">
        Body
      </Card>
    );
    const card = screen.getByTestId("card");
    expect(card.getAttribute("data-variant")).toBe("elevated");
    expect(card.getAttribute("data-padding")).toBe("lg");
  });

  it("lets a consumer class win its property group outright", () => {
    const merged = cn(cardVariants({ padding: "md" }), "p-8");
    expect(utilitiesInGroup(merged, "paddingX")).toEqual(["p-8"]);
    expect(utilitiesInGroup(merged, "paddingY")).toEqual(["p-8"]);
  });
});

const TONES = ["default", "elevated"] as const;
const CHOICE_PADDINGS = ["sm", "md"] as const;

function hoverBorders(classes: string): string[] {
  return classes.split(/\s+/).filter((token) => /(^|:)hover:border-/.test(token));
}

function restBorderColors(classes: string): string[] {
  return baseUtilities(classes).filter((token) => /^border-(border|text)-/.test(token));
}

describe("choiceCardVariants", () => {
  it("resolves every combination to one radius, one padding and one resting edge", () => {
    for (const tone of TONES) {
      for (const selected of [false, true]) {
        for (const padding of CHOICE_PADDINGS) {
          const classes = cn(choiceCardVariants({ tone, selected, padding }));
          expectSingleWinner(classes, ["radius", "paddingX", "paddingY"]);
          expect(restBorderColors(classes), `${tone}/${selected}/${padding}`).toHaveLength(1);
        }
      }
    }
  });

  it("shares its radius with the Card frame", () => {
    expect(utilitiesInGroup(choiceCardVariants(), "radius")).toEqual(
      utilitiesInGroup(cardVariants(), "radius")
    );
  });

  // A resting wash is what hover paints, so a filled card reads as already
  // hovered; only the one lifted card may carry a surface at rest.
  it("rests unfilled unless lifted or selected", () => {
    const fills = (classes: string) =>
      baseUtilities(classes).filter((token) => /^bg-/.test(token) && !token.startsWith("bg-["));
    expect(fills(choiceCardVariants({ tone: "default" }))).toEqual([]);
    expect(fills(choiceCardVariants({ tone: "elevated" }))).not.toEqual([]);
    expect(fills(choiceCardVariants({ selected: true }))).not.toEqual([]);
  });

  it("hovers exactly like an interactive Card frame", () => {
    const strip = (classes: string) =>
      classes
        .split(/\s+/)
        .filter((token) => token.includes("hover:"))
        .map((token) => token.replace(/^.*hover:/, ""))
        .sort();
    expect(strip(choiceCardVariants({ tone: "default" }))).toEqual(
      strip(cardVariants({ interactive: true }))
    );
    expect(strip(choiceCardVariants({ tone: "default" }))).toEqual([...CARD_HOVER_PAINT].sort());
  });

  // Hover must never step a selected card's edge down to the hover tier, or a
  // hovered option and the chosen one read alike.
  it("keeps the selected edge distinct from the hover edge", () => {
    const selected = choiceCardVariants({ selected: true });
    expect(hoverBorders(selected)).toEqual([]);
    const hoverEdge = hoverBorders(choiceCardVariants())[0]?.replace(/^.*hover:/, "");
    expect(restBorderColors(selected)[0]).not.toBe(hoverEdge);
  });

  it("never paints hover on a disabled card", () => {
    const classes = choiceCardVariants();
    const hovers = classes.split(/\s+/).filter((token) => token.includes("hover:"));
    expect(hovers.length).toBeGreaterThan(0);
    for (const token of hovers) expect(token.startsWith("not-disabled:"), token).toBe(true);
    expect(classes).toContain("disabled:opacity-50");
  });

  // Exactly the Button snap, and marked so reduced motion can remove it:
  // `active:scale-*` sets the individual `scale` property, which the
  // reduced-motion `transform: none` reset cannot reach.
  it("snaps on press exactly like Button, behind the reduced-motion hook", () => {
    const press = (classes: string) =>
      classes
        .split(/\s+/)
        .filter((token) => token.startsWith("active:"))
        .sort();
    const classes = choiceCardVariants();
    expect(press(classes)).toEqual([...basePressTreatment()].sort());
    expect(press(classes).length).toBeGreaterThan(0);
    expect(classes.split(/\s+/)).toContain("press-scale");
    expectNarrowTransition(classes, /^transition-\[[a-z,-]+\]$/);
    expect(utilitiesInGroup(classes, "transition")[0]).not.toMatch(/scale|transform/);
  });

  it("owns a focus ring and spends accent nowhere else", () => {
    for (const tone of TONES) {
      for (const selected of [false, true]) {
        const classes = choiceCardVariants({ tone, selected });
        expect(classes).toContain("focus-visible:outline-accent-primary");
        expectNoUnfocusedAccent(classes);
      }
    }
  });
});

describe("ChoiceCard", () => {
  it("renders a type=button that forwards ref, props and clicks", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <ChoiceCard ref={ref} tone="elevated" onClick={onClick} aria-label="Open project">
        Open project
      </ChoiceCard>
    );
    const card = screen.getByRole("button", { name: "Open project" });
    expect(ref.current).toBe(card);
    expect(card.getAttribute("type")).toBe("button");
    expect(card.getAttribute("data-tone")).toBe("elevated");
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("lets a consumer class win its property group outright", () => {
    render(<ChoiceCard className="p-4">Body</ChoiceCard>);
    const card = screen.getByRole("button");
    expect(utilitiesInGroup(card.className, "paddingX")).toEqual(["p-4"]);
  });
});
