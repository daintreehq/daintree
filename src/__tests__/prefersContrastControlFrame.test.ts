import { describe, expect, it } from "vitest";
import {
  DISPLAY_SURFACES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
} from "@shared/theme/contrast";
import { BUILT_IN_APP_SCHEMES } from "@shared/theme/themes";
import type { AppColorScheme, AppThemeTokenKey } from "@shared/theme/types";
import { readIndexCss } from "@/__tests__/support/hostCss";

// WCAG 2.2 SC 1.4.11: the boundary that identifies a control owes 3:1 (#15376).
const CONTROL_BOUNDARY_MIN_CONTRAST = 3;

const MEDIA = "@media (prefers-contrast: more)";

// Text entry is framed by the field edge token, never by inking its own border:
// a bare input is usually the inner half of a compound field with its own shell.
const TEXT_ENTRY = ["input", "textarea"];

// Unlayered author CSS beats every layer; among layers, the later-declared one.
const LAYER_RANK: Record<string, number> = { base: 0, components: 1, utilities: 2 };

interface Rule {
  selectors: string[];
  declarations: Map<string, string>;
  layer: string | null;
}

// The same text twice, offset for offset: `plain` with comments blanked, and
// `masked` with every string's contents blanked too. Structure (braces,
// semicolons) is found in `masked`, so a brace, semicolon or comment opener
// inside a quoted value (an `@source` glob, a data URL) is never read as
// structure; selectors and values are read from `plain`, which keeps the quotes
// an attribute selector needs. Strings are matched first wherever they start first.
interface Source {
  plain: string;
  masked: string;
}

function sourceOf(css: string): Source {
  const lexemes = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const plain = css.replace(lexemes, (match) => (match.startsWith("/*") ? blank(match) : match));
  const masked = css.replace(lexemes, (match) =>
    match.startsWith("/*") ? blank(match) : `${match[0]}${"_".repeat(match.length - 2)}${match[0]}`
  );
  return { plain, masked };
}

function slice(source: Source, start: number, end: number): Source {
  return { plain: source.plain.slice(start, end), masked: source.masked.slice(start, end) };
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`unbalanced block at ${open}`);
}

function declarationsOf(source: Source): Map<string, string> {
  const declarations = new Map<string, string>();
  const { masked, plain } = source;
  let parens = 0;
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    if (masked[i] === "(") parens++;
    if (masked[i] === ")") parens--;
    if (i < masked.length && (masked[i] !== ";" || parens > 0)) continue;
    const colon = masked.indexOf(":", start);
    if (colon !== -1 && colon < i) {
      declarations.set(plain.slice(start, colon).trim(), plain.slice(colon + 1, i).trim());
    }
    start = i + 1;
  }
  return declarations;
}

// A block's own rules plus those in its nested `@layer`s, tagged with the layer
// they land in. Other nested at-rules (a reduced-motion query) are skipped: they
// only match under a second condition.
function parseRules(body: Source, layer: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < body.masked.length) {
    const open = body.masked.indexOf("{", i);
    if (open === -1) break;
    const prelude = body.plain.slice(i, open).trim();
    const close = closingBrace(body.masked, open);
    const inner = slice(body, open + 1, close);
    const layerName = /^@layer\s+([\w-]+)$/.exec(prelude)?.[1];
    if (layerName) {
      rules.push(...parseRules(inner, layerName));
    } else if (!prelude.startsWith("@")) {
      rules.push({
        selectors: prelude.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
        declarations: declarationsOf(inner),
        layer,
      });
    }
    i = close + 1;
  }
  return rules;
}

// Every increased-contrast block in the host stylesheet, in cascade order.
function contrastRules(): Rule[] {
  const source = sourceOf(readIndexCss());
  const { masked } = source;
  const rules: Rule[] = [];
  for (let at = masked.indexOf(MEDIA); at !== -1; at = masked.indexOf(MEDIA, at + MEDIA.length)) {
    const open = masked.indexOf("{", at);
    rules.push(...parseRules(slice(source, open + 1, closingBrace(masked, open))));
  }
  return rules;
}

const rules = contrastRules();

// The rule whose `property` a selector actually ends up with under the media query.
function winner(selector: string, property: string): Rule | undefined {
  const rank = (rule: Rule) => (rule.layer === null ? Infinity : (LAYER_RANK[rule.layer] ?? -1));
  const candidates = rules.filter(
    (rule) => rule.selectors.includes(selector) && rule.declarations.has(property)
  );
  const top = Math.max(...candidates.map(rank));
  return candidates.filter((rule) => rank(rule) === top).at(-1);
}

const widthRule = winner("button", "border-width");
const controls = widthRule?.selectors ?? [];
const inkedControls = controls.filter((selector) => !TEXT_ENTRY.includes(selector));
const fieldEdgeRules = rules.filter((rule) => rule.declarations.has("--theme-border-input"));

function tokenOf(value: string | undefined, fallback: AppThemeTokenKey): AppThemeTokenKey {
  if (value === undefined) return fallback;
  const token = /^var\(--(?:color|theme)-([a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!token) throw new Error(`frame ink "${value}" is not a single theme token`);
  return token as AppThemeTokenKey;
}

function solidOver(value: string, background: string): string {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  if (hex) {
    return hex[2]
      ? blendOverBackground(`#${hex[1]}`, background, parseInt(hex[2], 16) / 255)
      : value;
  }
  const rgba = parseRgba(value);
  if (rgba) return blendOverBackground(rgba.hex, background, rgba.opacity);
  throw new Error(`cannot measure "${value}": not #rrggbb, #rrggbbaa or rgba()`);
}

function worstRatio(scheme: AppColorScheme, ink: AppThemeTokenKey, surfaces: AppThemeTokenKey[]) {
  const value = scheme.tokens[ink];
  expect(value, `${scheme.id} has no ${ink}`).toBeTypeOf("string");
  let worst = { ratio: Infinity, surface: "" };
  for (const surface of surfaces) {
    const background = scheme.tokens[surface];
    expect(background, `${scheme.id} ${surface}`).toMatch(/^#[0-9a-f]{6}$/i);
    const ratio = contrastRatio(solidOver(value, background), background);
    expect(Number.isFinite(ratio), `${ink} on ${surface} is unmeasurable`).toBe(true);
    if (ratio < worst.ratio) worst = { ratio, surface };
  }
  return worst;
}

const schemes = BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const);

describe("Increase Contrast control frame (#15376)", () => {
  it("widens a known control set", () => {
    expect(widthRule?.declarations.get("border-width")).not.toMatch(/^0/);
    expect(controls).toEqual(expect.arrayContaining(["button", '[role="button"]', "input"]));
  });

  it("inks every non-text control from the base layer, so a control's own border utility still wins", () => {
    expect(inkedControls.length).toBeGreaterThan(0);
    for (const selector of inkedControls) {
      const rule = winner(selector, "border-color");
      expect(rule, `nothing colours the ${selector} frame`).toBeDefined();
      expect(rule!.layer, selector).toBe("base");
    }
  });

  it("never inks a bare text-entry border, which would box the inside of a compound field", () => {
    for (const selector of TEXT_ENTRY) {
      expect(winner(selector, "border-color"), selector).toBeUndefined();
    }
  });

  it.each(schemes)("%s: the frame clears 3:1 on every display surface", (_id, scheme) => {
    for (const selector of inkedControls) {
      const value = winner(selector, "border-color")?.declarations.get("border-color");
      const ink = tokenOf(value, "border-default");
      const { ratio, surface } = worstRatio(scheme, ink, DISPLAY_SURFACES);
      expect(
        ratio,
        `${selector}: ${ink} is ${ratio.toFixed(2)}:1 on ${surface}`
      ).toBeGreaterThanOrEqual(CONTROL_BOUNDARY_MIN_CONTRAST);
    }
  });

  it.each(schemes)(
    "%s: the field edge clears 3:1 on the field fill and every display surface",
    (_id, scheme) => {
      const values = fieldEdgeRules.map((rule) => rule.declarations.get("--theme-border-input"));
      for (const value of values.length > 0 ? values : [undefined]) {
        const ink = tokenOf(value, "border-input");
        const { ratio, surface } = worstRatio(scheme, ink, [...DISPLAY_SURFACES, "surface-input"]);
        expect(ratio, `${ink} is ${ratio.toFixed(2)}:1 on ${surface}`).toBeGreaterThanOrEqual(
          CONTROL_BOUNDARY_MIN_CONTRAST
        );
      }
    }
  );

  it("rebinds the field edge below the root, where the inline theme tokens live", () => {
    const rule = winner("body", "--theme-border-input");
    expect(rule, "nothing rebinds the field edge").toBeDefined();
    expect(rule!.layer).toBeNull();
  });

  it.each([".tip-action", '[data-variant="link"]', ".row-select-target"])(
    "keeps %s unframed",
    (selector) => {
      const rule = winner(selector, "border-width");
      expect(rule?.declarations.get("border-width")).toBe("0");
      expect(rule?.layer).toBeNull();
    }
  );
});
