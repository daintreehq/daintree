import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The power-saving motion gate (#12515) must actually stop the looping classes
// and nothing else: a wildcard, or a transition override, would reach Radix
// Presence exit transitions and leave closed overlays ghosted in the DOM.
const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

interface TopLevelRule {
  selectors: string[];
  declarations: Map<string, string>;
}

/**
 * Top-level rules only. Comments are stripped first so braces inside them
 * can't shift the depth count; a rule nested in `@layer` or `@media` never
 * surfaces here, which is the point — only an unlayered rule reliably beats
 * Tailwind's `@layer utilities` animation classes.
 */
function topLevelRules(source: string): TopLevelRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: TopLevelRule[] = [];
  let depth = 0;
  let start = 0;
  let selectorText = "";
  let bodyStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        selectorText = text.slice(start, i);
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const declarations = new Map<string, string>();
        for (const declaration of text.slice(bodyStart, i).split(";")) {
          const colon = declaration.indexOf(":");
          if (colon === -1) continue;
          declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
        }
        rules.push({
          selectors: selectorText
            .split(",")
            .map((selector) => selector.trim())
            .filter(Boolean),
          declarations,
        });
        start = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      start = i + 1;
    }
  }
  return rules;
}

const PREFIX = 'body[data-power-saving="true"] ';
const powerSavingRules = topLevelRules(css).filter((rule) =>
  rule.selectors.some((selector) => selector.includes("data-power-saving"))
);

function ruleFor(target: string): TopLevelRule | undefined {
  return powerSavingRules.find((rule) => rule.selectors.includes(PREFIX + target));
}

describe("power-saving motion CSS", () => {
  it.each([
    ".animate-spin-slow",
    ".animate-activity-pulse",
    ".animate-breathe",
    ".animate-pulse",
    ".motion-safe\\:animate-pulse",
    ".status-working",
    ".forge-status-error",
  ])("stops the %s loop in an unlayered rule", (target) => {
    expect(ruleFor(target)?.declarations.get("animation")).toBe("none");
  });

  it.each([".animate-skeleton-shimmer::after", ".pulse-skeleton-shimmer::after"])(
    "hides the %s sweep rather than parking it mid-bone",
    (target) => {
      expect(ruleFor(target)?.declarations.get("display")).toBe("none");
    }
  );

  it("targets named classes only — never a wildcard", () => {
    const selectors = powerSavingRules.flatMap((rule) => rule.selectors);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector.startsWith(PREFIX)).toBe(true);
      expect(selector.slice(PREFIX.length)).toMatch(/^\.[\w\\:-]+(::after)?$/);
    }
  });

  it("never overrides transitions", () => {
    for (const rule of powerSavingRules) {
      for (const property of rule.declarations.keys()) {
        expect(property.startsWith("transition")).toBe(false);
      }
    }
  });

  it("leaves the gated loading pulses alone so skeletons never vanish", () => {
    const selectors = powerSavingRules.flatMap((rule) => rule.selectors);
    expect(selectors.some((s) => s.includes("animate-pulse-delayed"))).toBe(false);
    expect(selectors.some((s) => s.includes("animate-pulse-immediate"))).toBe(false);
  });
});
