import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { converter, displayable, formatHex, parse } from "culori";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { blendOverBackground, contrastRatio, deltaEOK, parseRgba } from "../contrast.js";
import { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES } from "../colorVisionOverrides.js";

// #15334 — the fleet ribbon is a full-width band, so it has to read as its own
// band against the chrome it sits in, on every built-in theme and colour-vision
// palette, without costing its text or its stripe their contrast. The fill and
// ink are derived in fleet-ribbon.css; this reads them from there so the two
// cannot drift.

const ribbonCss = readFileSync(
  resolve(__dirname, "../../../src/styles/components/fleet-ribbon.css"),
  "utf-8"
);

type Derivation = { l: number; c: number };
type Polarity = "dark" | "light";

function ruleBody(selector: RegExp): string {
  const match = ribbonCss.match(selector);
  if (!match) throw new Error(`rule ${selector} not found in fleet-ribbon.css`);
  return match[1];
}

function derivation(body: string, name: "fill" | "ink"): Derivation {
  const match = body.match(
    new RegExp(
      `--fleet-ribbon-${name}:\\s*oklch\\(\\s*from var\\(--color-category-amber\\)\\s+([\\d.]+)\\s+([\\d.]+)\\s+h\\s*\\)`
    )
  );
  if (!match) throw new Error(`--fleet-ribbon-${name} derivation not found in fleet-ribbon.css`);
  return { l: Number(match[1]), c: Number(match[2]) };
}

const darkBody = ruleBody(/^\.fleet-ribbon-surface\s*\{([^}]*)\}/m);
const lightBody = ruleBody(
  /^:where\(\.light, \[data-color-mode="light"\]\) \.fleet-ribbon-surface\s*\{([^}]*)\}/m
);
const DERIVATIONS: Record<Polarity, { fill: Derivation; ink: Derivation }> = {
  dark: { fill: derivation(darkBody, "fill"), ink: derivation(darkBody, "ink") },
  light: { fill: derivation(lightBody, "fill"), ink: derivation(lightBody, "ink") },
};

/** The planes whose edges the band runs along: the toolbar above it, the sidebar below, the window. */
const BAND_PLANES = ["canvas", "toolbar", "sidebar"] as const;
/** Two JNDs (OKLab ΔE ≈ 0.02 each): visibly a different colour, not a rounding of the same one. */
const BAND_SEPARATION = 0.04;
/**
 * The grid's 4px gutter and the panels below it meet the band only behind the
 * shell's own bottom border, and some palettes paint that gutter in the sand
 * family amber belongs to, so it is held to one JND rather than two.
 */
const CONTENT_SEPARATION = 0.02;

const MODES = [
  ["default", {}],
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

const toOklch = converter("oklch");

function amberHue(amber: string): number {
  const hue = toOklch(parse(amber))?.h;
  if (hue === undefined) throw new Error(`amber ${amber} has no hue`);
  return hue;
}

/** `oklch(from amber L C h)`, required to sit inside sRGB so no gamut mapping is involved. */
function resolveDerivation(
  { l, c }: Derivation,
  hue: number,
  where: string,
  failures: string[]
): string {
  const color = { mode: "oklch" as const, l, c, h: hue };
  if (!displayable(color))
    failures.push(`${where}: oklch(${l} ${c} ${hue.toFixed(1)}) is outside sRGB`);
  return formatHex(color);
}

/** Every colour layer the grid gutter can show: the final flat layer and each gradient stop over it. */
function gridLayers(value: string): string[] {
  const base = value.match(/#[0-9a-f]{6}\s*$/i)?.[0].trim();
  if (!base) throw new Error(`grid background has no flat colour layer: ${value}`);
  const stops = (value.match(/rgba?\([^)]*\)/g) ?? []).map((stop) => {
    const rgba = parseRgba(stop);
    if (!rgba) throw new Error(`unparseable grid stop: ${stop}`);
    return blendOverBackground(rgba.hex, base, rgba.opacity);
  });
  return [base, ...stops];
}

describe("fleet ribbon band (#15334)", () => {
  it("reads as its own band, and keeps its text and stripe legible, on every theme and palette", () => {
    const failures: string[] = [];

    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const tokens = scheme.tokens as Record<string, string>;
      const extensions = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const { fill: fillDerivation, ink: inkDerivation } = DERIVATIONS[scheme.type];

      const bandPlanes: Record<string, string> = {
        canvas: tokens["surface-canvas"],
        toolbar: extensions["toolbar-bg"] ?? tokens["surface-toolbar"],
        sidebar: tokens["surface-sidebar"],
      };
      const contentPlanes: Record<string, string> = { panel: tokens["surface-panel"] };
      gridLayers(
        extensions["panel-grid-bg"] ?? extensions["terminal-grid-bg"] ?? tokens["surface-grid"]
      ).forEach((layer, index) => {
        contentPlanes[index === 0 ? "grid" : `grid stop ${index}`] = layer;
      });

      for (const [mode, overrides] of MODES) {
        const where = `${scheme.id} ${mode}`;
        const amber =
          (overrides as Record<string, string>)["--theme-category-amber"] ??
          tokens["category-amber"];
        const hue = amberHue(amber);
        const fill = resolveDerivation(fillDerivation, hue, `${where} fill`, failures);
        const ink = resolveDerivation(inkDerivation, hue, `${where} ink`, failures);

        for (const plane of BAND_PLANES) {
          const delta = deltaEOK(fill, bandPlanes[plane]);
          if (delta < BAND_SEPARATION) {
            failures.push(
              `${where}: band ${fill} vs ${plane} ${bandPlanes[plane]} ΔE ${delta.toFixed(3)} < ${BAND_SEPARATION}`
            );
          }
        }
        for (const [plane, color] of Object.entries(contentPlanes)) {
          const delta = deltaEOK(fill, color);
          if (delta < CONTENT_SEPARATION) {
            failures.push(
              `${where}: band ${fill} vs ${plane} ${color} ΔE ${delta.toFixed(3)} < ${CONTENT_SEPARATION}`
            );
          }
        }

        for (const text of ["text-primary", "text-secondary"]) {
          const ratio = contrastRatio(tokens[text], fill);
          if (ratio < 4.5) {
            failures.push(`${where}: ${text} ${tokens[text]} on ${fill} = ${ratio.toFixed(2)}`);
          }
        }
        const inkRatio = contrastRatio(ink, fill);
        if (inkRatio < 3) {
          failures.push(`${where}: ink ${ink} on ${fill} = ${inkRatio.toFixed(2)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
