import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The power-saving motion gate (#12515) must stop exactly the looping classes
// and nothing else: a wildcard, or a transition override, would reach Radix
// Presence exit transitions and leave closed overlays ghosted in the DOM.
const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

function powerSavingRules(): Array<{ selectors: string[]; body: string }> {
  const rules: Array<{ selectors: string[]; body: string }> = [];
  const pattern = /([^{}]*body\[data-power-saving="true"\][^{}]*)\{([^{}]*)\}/g;
  for (const match of css.matchAll(pattern)) {
    const selectorText = match[1].replace(/\/\*[\s\S]*?\*\//g, "");
    rules.push({
      selectors: selectorText
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean),
      body: match[2],
    });
  }
  return rules;
}

describe("power-saving motion CSS", () => {
  const rules = powerSavingRules();
  const selectors = rules.flatMap((rule) => rule.selectors);

  it("stops every looping indicator the policy covers", () => {
    for (const target of [
      ".animate-spin-slow",
      ".animate-activity-pulse",
      ".animate-breathe",
      ".animate-pulse",
      ".status-working",
      ".animate-skeleton-shimmer::after",
      ".pulse-skeleton-shimmer::after",
    ]) {
      expect(selectors).toContain(`body[data-power-saving="true"] ${target}`);
    }
  });

  it("targets named classes only — never a wildcard", () => {
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector).toMatch(/^body\[data-power-saving="true"\] \.[\w-]+(::after)?$/);
    }
  });

  it("never overrides transitions", () => {
    for (const rule of rules) {
      expect(rule.body).not.toMatch(/transition/);
    }
  });

  it("leaves the gated loading pulses alone so skeletons never vanish", () => {
    expect(selectors.some((s) => s.includes("animate-pulse-delayed"))).toBe(false);
    expect(selectors.some((s) => s.includes("animate-pulse-immediate"))).toBe(false);
  });
});
