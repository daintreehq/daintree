import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// Compositor work nobody can see (#17074): an infinite animation keeps
// producing frames under `opacity: 0`, and a backdrop-filter behind an opaque
// fill still costs an offscreen pass.
const css = readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selectors: string[];
  body: string;
  /** Enclosing at-rule preludes, outermost first (`@layer utilities`, `@media ...`). */
  atRules: string[];
}

/** Innermost rules in source order, each with the at-rules it sits inside. */
function parseRules(source: string): Rule[] {
  const rules: Rule[] = [];
  const stack: Array<{ prelude: string; start: number; nested: boolean }> = [];
  let boundary = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      const parent = stack[stack.length - 1];
      if (parent) parent.nested = true;
      stack.push({ prelude: source.slice(boundary, i).trim(), start: i + 1, nested: false });
      boundary = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame && !frame.nested && !frame.prelude.startsWith("@")) {
        rules.push({
          selectors: frame.prelude
            .split(/,(?![^(]*\))/)
            .map((selector) => selector.trim())
            .filter(Boolean),
          body: source.slice(frame.start, i),
          atRules: stack.map((outer) => outer.prelude).filter((prelude) => prelude.startsWith("@")),
        });
      }
      boundary = i + 1;
    } else if (ch === ";") {
      boundary = i + 1;
    }
  }
  return rules;
}

const rules = parseRules(css);

/** The value CSS would use: the last declaration of the property wins. */
function declaration(body: string, property: string): string | undefined {
  let value: string | undefined;
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon !== -1 && part.slice(0, colon).trim() === property) {
      value = part.slice(colon + 1).trim();
    }
  }
  return value;
}

const isConditional = (rule: Rule) =>
  rule.atRules.some((prelude) => /^@(?:media|supports|variant|container)\b/.test(prelude));

describe("palette loading sweep", () => {
  const sweepRules = rules.filter((rule) =>
    rule.selectors.some((selector) => selector.includes(".palette-loading-bar__sweep"))
  );

  it("draws nothing while the palette is idle", () => {
    const base = sweepRules.filter(
      (rule) => !isConditional(rule) && rule.selectors.includes(".palette-loading-bar__sweep")
    );
    expect(base).toHaveLength(1);
    expect(declaration(base[0]!.body, "display")).toBe("none");
    expect(declaration(base[0]!.body, "animation")).toBeUndefined();
    expect(declaration(base[0]!.body, "will-change")).toBeUndefined();
  });

  it("shows and runs the sweep only under a loading bar", () => {
    const sweeping = sweepRules.filter((rule) =>
      /\bpalette-loading-sweep\b/.test(declaration(rule.body, "animation") ?? "")
    );
    expect(sweeping).toHaveLength(1);
    const [gate] = sweeping;
    expect(isConditional(gate!)).toBe(false);
    expect(declaration(gate!.body, "display")).toBe("block");
    for (const selector of gate!.selectors) {
      expect(selector).toContain('.palette-loading-bar[data-loading="true"]');
      // The loading condition adds no specificity, so the reduce-motion rule
      // later in the sheet, at the sweep's own single class, still stills it.
      expect(selector.replace(/:where\([^)]*\)/g, "")).not.toMatch(/[[#]|\.palette-loading-bar\b/);
    }
  });

  it("keeps every other rule from setting the sweep moving", () => {
    for (const rule of sweepRules) {
      const animation = declaration(rule.body, "animation");
      if (animation === undefined || /\bpalette-loading-sweep\b/.test(animation)) continue;
      expect(animation).toMatch(/^none\b/);
    }
  });
});

describe("light floating surfaces", () => {
  it("drops the overlay's backdrop blur wherever a light menu is drawn", () => {
    // Unconditional rules only: a reset inside a preference query would leave
    // every ordinary light menu blurred.
    const light = rules.filter(
      (rule) => !isConditional(rule) && rule.selectors.includes(".light .surface-overlay")
    );
    const filtered = light.filter(
      (rule) => declaration(rule.body, "backdrop-filter") !== undefined
    );
    expect(filtered.length).toBeGreaterThan(0);
    // The last unconditional word on the filter is the one that holds.
    const last = filtered[filtered.length - 1]!;
    expect(declaration(last.body, "backdrop-filter")).toBe("none");
    expect(declaration(last.body, "-webkit-backdrop-filter")).toBe("none");
    expect(declaration(last.body, "background-color")).toBeDefined();
  });
});
