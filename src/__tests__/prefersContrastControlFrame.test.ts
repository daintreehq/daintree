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

interface Rule {
  selectors: string[];
  declarations: Map<string, string>;
  layer: string | null;
}

function blockBody(css: string, marker: string): string {
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`${marker} block is missing`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`${marker} block never closes`);
}

// The block's own rules plus the ones in its nested `@layer`s, tagged with the
// layer they land in. Other nested at-rules (a reduced-motion query) are skipped:
// they only match under a second condition.
function parseRules(body: string, layer: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf("{", i);
    if (open === -1) break;
    const prelude = body.slice(i, open).trim();
    let depth = 0;
    let close = open;
    for (; close < body.length; close++) {
      if (body[close] === "{") depth++;
      if (body[close] === "}" && --depth === 0) break;
    }
    const inner = body.slice(open + 1, close);
    const layerName = /^@layer\s+([\w-]+)$/.exec(prelude)?.[1];
    if (layerName) {
      rules.push(...parseRules(inner, layerName));
    } else if (!prelude.startsWith("@")) {
      const declarations = new Map<string, string>();
      for (const declaration of inner.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon === -1) continue;
        declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
      }
      rules.push({
        selectors: prelude.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
        declarations,
        layer,
      });
    }
    i = close + 1;
  }
  return rules;
}

const css = readIndexCss().replace(/\/\*[\s\S]*?\*\//g, "");
const rules = parseRules(blockBody(css, "@media (prefers-contrast: more)"));

const widthRule = rules.find(
  (rule) => rule.selectors.includes("button") && rule.declarations.get("border-width") === "2px"
);
const controls = widthRule?.selectors ?? [];

// The rule that colours the widened frame. Without one, the colour is the base
// layer's `* { border-border }` fall-through: `border-default`.
const colourRule = rules.find(
  (rule) =>
    rule.declarations.has("border-color") &&
    controls.every((selector) => rule.selectors.includes(selector))
);

// The field edge every `Input`, `Textarea` and `SelectTrigger` names. Unbound,
// it is whatever the theme resolved `border-input` to.
const fieldEdgeRule = rules.find((rule) => rule.declarations.has("--theme-border-input"));

function tokenOf(value: string | undefined, fallback: AppThemeTokenKey): AppThemeTokenKey {
  if (value === undefined) return fallback;
  const token = /^var\(--(?:color|theme)-([a-z0-9-]+)\)$/.exec(value)?.[1];
  if (!token) throw new Error(`frame ink "${value}" is not a single theme token`);
  return token as AppThemeTokenKey;
}

function worstRatio(scheme: AppColorScheme, ink: AppThemeTokenKey, surfaces: AppThemeTokenKey[]) {
  let worst = { ratio: Infinity, surface: "" };
  for (const surface of surfaces) {
    const background = scheme.tokens[surface];
    const value = scheme.tokens[ink];
    expect(value, `${scheme.id} has no ${ink}`).toBeTypeOf("string");
    const rgba = parseRgba(value);
    const solid = rgba ? blendOverBackground(rgba.hex, background, rgba.opacity) : value;
    const ratio = contrastRatio(solid, background);
    if (ratio < worst.ratio) worst = { ratio, surface };
  }
  return worst;
}

describe("Increase Contrast control frame (#15376)", () => {
  it("widens a known control set", () => {
    expect(controls).toEqual(expect.arrayContaining(["button", '[role="button"]', "input"]));
  });

  it("colours the fall-through from the base layer, so a control's own border utility still wins", () => {
    expect(colourRule, "no rule colours the widened frame").toBeDefined();
    expect(colourRule!.layer).toBe("base");
  });

  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: the frame clears 3:1 on every display surface",
    (_id, scheme) => {
      const ink = tokenOf(colourRule?.declarations.get("border-color"), "border-default");
      const { ratio, surface } = worstRatio(scheme, ink, DISPLAY_SURFACES);
      expect(
        ratio,
        `${ink} is ${ratio.toFixed(2)}:1 on ${surface}`
      ).toBeGreaterThanOrEqual(CONTROL_BOUNDARY_MIN_CONTRAST);
    }
  );

  it.each(BUILT_IN_APP_SCHEMES.map((scheme) => [scheme.id, scheme] as const))(
    "%s: the field edge clears 3:1 on the field fill and every display surface",
    (_id, scheme) => {
      const ink = tokenOf(fieldEdgeRule?.declarations.get("--theme-border-input"), "border-input");
      const { ratio, surface } = worstRatio(scheme, ink, [...DISPLAY_SURFACES, "surface-input"]);
      expect(
        ratio,
        `${ink} is ${ratio.toFixed(2)}:1 on ${surface}`
      ).toBeGreaterThanOrEqual(CONTROL_BOUNDARY_MIN_CONTRAST);
    }
  );

  it("rebinds the field edge below the root, where the inline theme tokens live", () => {
    expect(fieldEdgeRule?.selectors).toEqual(["body"]);
    expect(fieldEdgeRule?.layer).toBeNull();
  });

  it.each([".tip-action", '[data-variant="link"]', ".row-select-target"])(
    "keeps %s unframed",
    (selector) => {
      const exemption = rules.find((rule) => rule.selectors.includes(selector));
      expect(exemption?.declarations.get("border-width")).toBe("0");
      expect(exemption?.layer).toBeNull();
    }
  );
});
