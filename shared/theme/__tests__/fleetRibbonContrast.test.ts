import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { converter, displayable, formatHex, parse } from "culori";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { blendOverBackground, contrastRatio, deltaEOK, isHexColor } from "../contrast.js";
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

/** `oklch(from amber L C h)`, or the canvas's lightness stepped toward amber with chroma set from it. */
type Derivation =
  | { kind: "fixed"; l: number; c: number }
  | { kind: "canvas-step"; amberShare: number; chromaPerLightness: number };

function ruleBody(selector: RegExp): string {
  const body = ribbonCss.match(selector)?.[1];
  if (body === undefined) throw new Error(`rule ${selector} not found in fleet-ribbon.css`);
  return body;
}

function derivation(body: string, name: "fill" | "ink"): Derivation {
  const raw = body.match(new RegExp(`--fleet-ribbon-${name}:([^;]+);`))?.[1];
  if (raw === undefined) throw new Error(`--fleet-ribbon-${name} not found in fleet-ribbon.css`);
  const value = raw.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

  const fixed = value.match(/^oklch\(from var\(--color-category-amber\) ([\d.]+) ([\d.]+) h\)$/);
  if (fixed) return { kind: "fixed", l: Number(fixed[1]), c: Number(fixed[2]) };

  const step = value.match(
    /^oklch\(from color-mix\(in oklab, var\(--color-category-amber\) ([\d.]+)%, oklch\(from var\(--color-surface-canvas\) l 0 0\)\) l calc\(l \* ([\d.]+)\) h\)$/
  );
  if (step) {
    return {
      kind: "canvas-step",
      amberShare: Number(step[1]) / 100,
      chromaPerLightness: Number(step[2]),
    };
  }
  throw new Error(`--fleet-ribbon-${name} has a derivation this gate cannot model: ${value}`);
}

const darkBody = ruleBody(/^\.fleet-ribbon-surface\s*\{([^}]*)\}/m);
const lightBody = ruleBody(
  /^:where\(\.light,\s*\[data-color-mode="light"\]\)\s+\.fleet-ribbon-surface\s*\{([^}]*)\}/m
);
const DERIVATIONS = {
  dark: { fill: derivation(darkBody, "fill"), ink: derivation(darkBody, "ink") },
  light: { fill: derivation(lightBody, "fill"), ink: derivation(lightBody, "ink") },
} as const;

/**
 * The planes the band runs along: the toolbar above it, the sidebar below it,
 * the window behind. Two JNDs (OKLab ΔE ≈ 0.02 each) is the target; the floor
 * sits just under it because on serengeti the blue-yellow amber is the
 * sidebar's own sand, and sRGB, the controls' contrast and red-green's hue
 * leave no lightness or chroma that clears it by more. The pill tint this
 * replaced sat at 0.014 to 0.021.
 */
const BAND_SEPARATION = 0.035;
/**
 * The grid's 4px gutter and the panels beyond it are content, not chrome, and
 * meet the band only past the shell's own bottom border, so they owe one JND.
 */
const CONTENT_SEPARATION = 0.02;

const MODES = [
  ["default", {}],
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

const toOklch = converter("oklch");
const toOklab = converter("oklab");

function oklchOf(color: string) {
  const resolved = toOklch(parse(color));
  if (!resolved) throw new Error(`unparseable colour: ${color}`);
  return resolved;
}

/** Resolves a derivation the way Chromium does, and requires it inside sRGB so no gamut mapping is involved. */
function resolveDerivation(
  spec: Derivation,
  amber: string,
  canvas: string,
  where: string,
  failures: string[]
): string {
  const hue = oklchOf(amber).h;
  if (hue === undefined) throw new Error(`${where}: amber ${amber} has no hue`);
  let l: number;
  let c: number;
  if (spec.kind === "fixed") {
    ({ l, c } = spec);
  } else {
    // Mixing into the canvas with its chroma removed keeps amber's hue exactly.
    const amberLab = toOklab(parse(amber));
    if (!amberLab) throw new Error(`unparseable colour: ${amber}`);
    l = spec.amberShare * amberLab.l + (1 - spec.amberShare) * oklchOf(canvas).l;
    c = spec.chromaPerLightness * l;
  }
  const color = { mode: "oklch" as const, l, c, h: hue };
  if (!displayable(color)) {
    failures.push(
      `${where}: oklch(${l.toFixed(3)} ${c.toFixed(3)} ${hue.toFixed(1)}) is outside sRGB`
    );
  }
  return formatHex(color);
}

function plainColor(value: string, what: string): string {
  if (!isHexColor(value))
    throw new Error(`${what} is not a flat hex colour this gate can model: ${value}`);
  return value;
}

describe("fleet ribbon band (#15334)", () => {
  it("reads as its own band, and keeps its text and stripe legible, on every theme and palette", () => {
    const failures: string[] = [];

    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const { tokens } = scheme;
      const extensions = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const canvas = tokens["surface-canvas"];
      const { fill: fillSpec, ink: inkSpec } = DERIVATIONS[scheme.type];

      if (extensions["chrome-bg"] !== undefined) {
        throw new Error(`${scheme.id}: chrome-bg replaces the sidebar plane this gate models`);
      }
      // A grid background that is not a colour (movile's is a gradient) makes
      // `background-color` invalid at computed time, so the gutter shows the canvas.
      const gridValue =
        extensions["panel-grid-bg"] ?? extensions["terminal-grid-bg"] ?? tokens["surface-grid"];
      const bandPlanes = {
        canvas,
        toolbar: plainColor(extensions["toolbar-bg"] ?? tokens["surface-toolbar"], "toolbar"),
        // The sidebar is .surface-chrome: its surface at 95% over the window.
        sidebar: blendOverBackground(tokens["surface-sidebar"], canvas, 0.95),
      };
      const contentPlanes = {
        grid: isHexColor(gridValue) ? gridValue : canvas,
        panel: tokens["surface-panel"],
      };

      for (const [mode, overrides] of MODES) {
        const where = `${scheme.id} ${mode}`;
        const amber =
          (overrides as Record<string, string>)["--theme-category-amber"] ??
          tokens["category-amber"];
        const fill = resolveDerivation(fillSpec, amber, canvas, `${where} fill`, failures);
        const ink = resolveDerivation(inkSpec, amber, canvas, `${where} ink`, failures);

        for (const [planes, floor] of [
          [bandPlanes, BAND_SEPARATION],
          [contentPlanes, CONTENT_SEPARATION],
        ] as const) {
          for (const [plane, color] of Object.entries(planes)) {
            const delta = deltaEOK(fill, color);
            if (delta < floor) {
              failures.push(
                `${where}: band ${fill} vs ${plane} ${color} ΔE ${delta.toFixed(3)} < ${floor}`
              );
            }
          }
        }

        for (const text of ["text-primary", "text-secondary"] as const) {
          const ratio = contrastRatio(tokens[text], fill);
          if (ratio < 4.5) {
            failures.push(
              `${where}: ${text} ${tokens[text]} on ${fill} = ${ratio.toFixed(2)} < 4.5`
            );
          }
        }
        const inkRatio = contrastRatio(ink, fill);
        if (inkRatio < 3) {
          failures.push(`${where}: ink ${ink} on ${fill} = ${inkRatio.toFixed(2)} < 3`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
