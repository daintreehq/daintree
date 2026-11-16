import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// Compositor work nobody can see (#17074): an infinite animation keeps
// producing frames under `opacity: 0`, and a backdrop-filter behind an opaque
// fill still costs an offscreen pass.
const css = readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
}

/** Innermost rules at any depth: `@layer` and `@media` wrappers are seen through. */
const rules: Rule[] = [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: match[1]!
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean),
  body: match[2]!,
}));

function declaration(body: string, property: string): string | undefined {
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon !== -1 && part.slice(0, colon).trim() === property) {
      return part.slice(colon + 1).trim();
    }
  }
  return undefined;
}

describe("palette loading sweep", () => {
  const sweepRules = rules.filter((rule) =>
    rule.selectors.some((selector) => selector.includes(".palette-loading-bar__sweep"))
  );

  it("draws nothing while the palette is idle", () => {
    const base = sweepRules.find((rule) => rule.selectors.includes(".palette-loading-bar__sweep"));
    expect(base).toBeDefined();
    expect(declaration(base!.body, "display")).toBe("none");
    expect(declaration(base!.body, "animation")).toBeUndefined();
    expect(declaration(base!.body, "will-change")).toBeUndefined();
  });

  it("runs the sweep only under a loading bar", () => {
    const running = sweepRules.filter((rule) => {
      const animation = declaration(rule.body, "animation");
      return (
        (animation !== undefined && animation !== "none" && !animation.startsWith("none ")) ||
        declaration(rule.body, "will-change") === "transform"
      );
    });
    expect(running.length).toBeGreaterThan(0);
    for (const rule of running) {
      for (const selector of rule.selectors) {
        expect(selector).toContain('.palette-loading-bar[data-loading="true"]');
      }
    }
  });
});

describe("light floating surfaces", () => {
  it("drops the overlay's backdrop blur where its fill is opaque", () => {
    const light = rules.filter((rule) => rule.selectors.includes(".light .surface-overlay"));
    expect(
      light.some(
        (rule) =>
          declaration(rule.body, "background-color") !== undefined &&
          declaration(rule.body, "backdrop-filter") === "none" &&
          declaration(rule.body, "-webkit-backdrop-filter") === "none"
      )
    ).toBe(true);
    // And no light rule puts a blur back.
    for (const rule of light) {
      for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
        expect(declaration(rule.body, property) ?? "none").toBe("none");
      }
    }
  });
});
