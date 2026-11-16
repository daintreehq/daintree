import { describe, expect, it } from "vitest";
import { readIndexCss } from "@/__tests__/support/hostCss";

// Compositor work nobody can see (#17074): an infinite animation keeps
// producing frames under `opacity: 0`, and a backdrop-filter behind an opaque
// fill still costs an offscreen pass.

/** Comments out, strings kept: the `@source` globs carry a literal comment opener. */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\") out += source[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const css = stripComments(readIndexCss());

interface Rule {
  /** Resolved against enclosing rules, so a nested `&` or descendant reads as written out. */
  selectors: string[];
  /** The rule's own declarations, nested blocks removed. */
  body: string;
  /** Enclosing at-rule preludes, outermost first (`@layer utilities`, `@media ...`). */
  atRules: string[];
}

/** Splits on `separator` outside brackets, parentheses and quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function withoutNestedBlocks(body: string): string {
  let previous: string;
  let next = body;
  do {
    previous = next;
    next = previous.replace(/[^;{}]*\{[^{}]*\}/g, "");
  } while (next !== previous);
  return next;
}

/** Every style rule in source order, parents as well as nested children. */
function parseRules(source: string): Rule[] {
  interface Frame {
    prelude: string;
    start: number;
    selectors: string[] | null;
    atRules: string[];
    scope: string[] | null;
  }
  const rules: Rule[] = [];
  const stack: Frame[] = [];
  let boundary = 0;
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      const prelude = source.slice(boundary, i).trim();
      const outer = stack[stack.length - 1];
      const scope = outer ? (outer.selectors ?? outer.scope) : null;
      const atRules = outer
        ? outer.selectors
          ? outer.atRules
          : [...outer.atRules, outer.prelude]
        : [];
      const selectors = prelude.startsWith("@")
        ? null
        : splitTopLevel(prelude, ",").flatMap((selector) =>
            scope
              ? scope.map((parent) =>
                  selector.includes("&")
                    ? selector.replaceAll("&", parent)
                    : `${parent} ${selector}`
                )
              : [selector]
          );
      stack.push({ start: i + 1, selectors, atRules, scope, prelude });
      boundary = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame?.selectors) {
        rules.push({
          selectors: frame.selectors,
          body: withoutNestedBlocks(source.slice(frame.start, i)),
          atRules: frame.atRules,
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
  for (const part of splitTopLevel(body, ";")) {
    const colon = part.indexOf(":");
    if (colon !== -1 && part.slice(0, colon).trim() === property) {
      value = part.slice(colon + 1).trim();
    }
  }
  return value;
}

/** A selector's `:where()` arguments, and what is left once they are removed. */
function splitWhere(selector: string): { outside: string; inside: string[] } {
  const inside: string[] = [];
  let outside = "";
  let i = 0;
  while (i < selector.length) {
    if (selector.startsWith(":where(", i)) {
      let depth = 0;
      let j = i + ":where".length;
      for (; j < selector.length; j++) {
        if (selector[j] === "(") depth++;
        else if (selector[j] === ")" && --depth === 0) break;
      }
      inside.push(selector.slice(i + ":where(".length, j));
      i = j + 1;
    } else {
      outside += selector[i];
      i++;
    }
  }
  return { outside: outside.replace(/\s+/g, " ").trim(), inside };
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
      const { outside, inside } = splitWhere(selector);
      // The loading condition adds no specificity: the sweep's single class
      // is all that counts, so the reduce-motion rule later in the sheet, at
      // that same class, still stills it.
      expect(outside).toBe("> .palette-loading-bar__sweep");
      // And every alternative inside it is the loading bar, never a catch-all.
      const alternatives = inside.flatMap((argument) => splitTopLevel(argument, ","));
      expect(alternatives.length).toBeGreaterThan(0);
      for (const alternative of alternatives) {
        expect(alternative).toBe('.palette-loading-bar[data-loading="true"]');
      }
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

    // No preference query puts the blur back either.
    for (const rule of rules) {
      if (!isConditional(rule) || !rule.selectors.includes(".light .surface-overlay")) continue;
      for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
        expect(declaration(rule.body, property) ?? "none").toBe("none");
      }
    }
  });
});
