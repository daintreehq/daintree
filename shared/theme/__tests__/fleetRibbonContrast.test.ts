import { describe, expect, it } from "vitest";
import { converter, displayable, formatHex, interpolate, parse } from "culori";
import { BUILT_IN_APP_SCHEMES } from "../themes.js";
import { blendOverBackground, contrastRatio, deltaEOK, isHexColor } from "../contrast.js";
import { RED_GREEN_OVERRIDES, BLUE_YELLOW_OVERRIDES } from "../colorVisionOverrides.js";
import { fleetRibbonSheet, type FleetRibbonDerivation } from "./fleetRibbonSheet.js";

// #15334 — the fleet ribbon is a full-width band, so it has to read as its own
// band against the chrome it sits in, on every built-in theme and colour-vision
// palette, without costing its text, its controls or its stripe their contrast.
// The fill and ink are read from fleet-ribbon.css so the two cannot drift.

/**
 * The planes the band runs along: the toolbar above it, the sidebar below it,
 * the window behind. Two JNDs (OKLab ΔE ≈ 0.02 each) is the target; the floor
 * sits just under it because on serengeti the blue-yellow amber is the
 * sidebar's own sand, and for an amber band sRGB, the controls' contrast and
 * red-green's hue leave no lightness or chroma that clears it by more. The
 * pill tint this replaced sat at 0.014 to 0.021.
 */
const BAND_SEPARATION = 0.035;
/**
 * The grid's 4px gutter and the panels beyond it are content, not chrome, and
 * meet the band only past the shell's own bottom border, so they owe one JND.
 */
const CONTENT_SEPARATION = 0.02;

/** The bar's text sits on the band itself and on its controls' resting and hovered tint washes. */
const TEXT_SURFACES = [
  ["band", 0],
  ["resting control", 0.08],
  ["hovered control", 0.14],
] as const;
/** How far a control that was already under AA on the pill tint may move: rounding, not a regression. */
const BELOW_AA_TOLERANCE = 0.05;
const BLINK_ACHROMATIC_CHROMA = 0.02;

const MODES = [
  ["default", {}],
  ["red-green", RED_GREEN_OVERRIDES],
  ["blue-yellow", BLUE_YELLOW_OVERRIDES],
] as const;

const toOklch = converter("oklch");
const toOklab = converter("oklab");

function opaque(color: string, what: string) {
  const parsed = parse(color);
  if (!parsed) throw new Error(`unparseable ${what}: ${color}`);
  // The model below mixes without premultiplying, which only holds for opaque inputs.
  if ((parsed.alpha ?? 1) < 1) throw new Error(`${what} ${color} is translucent`);
  return parsed;
}

/** Resolves a derivation the way Chromium does, and requires it inside sRGB so no gamut mapping is involved. */
function resolveDerivation(
  spec: FleetRibbonDerivation,
  amber: string,
  canvas: string,
  where: string,
  failures: string[]
): string {
  const hue = toOklch(opaque(amber, "amber"))?.h;
  if (hue === undefined) throw new Error(`${where}: amber ${amber} has no hue`);
  let l: number;
  let c: number;
  if (spec.kind === "fixed") {
    ({ l, c } = spec);
  } else {
    // Mixing into the canvas with its chroma removed keeps amber's hue exactly.
    const amberLab = toOklab(opaque(amber, "amber"));
    const canvasLab = toOklab(opaque(canvas, "canvas"));
    if (!amberLab || !canvasLab) throw new Error(`${where}: unconvertible amber or canvas`);
    l = spec.amberShare * amberLab.l + (1 - spec.amberShare) * canvasLab.l;
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

/**
 * The pill tint the band replaced, as it stood then: amber 12% into the canvas
 * on dark and 20% into the elevated plane on light, mixed in oklch. The issue
 * asked that the bar's text and controls keep the contrast they had on it.
 */
function pillTint(amber: string, base: string, share: number): string {
  const baseLch = toOklch(opaque(base, "pill base"));
  if (!baseLch) throw new Error(`unconvertible pill base: ${base}`);
  // Blink treats an oklch chroma under 0.02 as having no hue when it mixes, so
  // the near-neutral canvases borrow amber's hue rather than turning it.
  const hue = baseLch.c < BLINK_ACHROMATIC_CHROMA ? undefined : baseLch.h;
  return formatHex(
    interpolate([opaque(amber, "amber"), { ...baseLch, h: hue }], "oklch")(1 - share)
  );
}

/** Six-digit hex only: the compositing below takes colours as opaque. */
function plainColor(value: string, what: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${what} is not an opaque hex colour this gate can model: ${value}`);
  }
  return value;
}

describe("fleet ribbon band (#15334)", () => {
  it("reads as its own band, and keeps its text, controls and stripe legible, on every theme and palette", () => {
    const failures: string[] = [];

    for (const scheme of BUILT_IN_APP_SCHEMES) {
      const { tokens } = scheme;
      const extensions = (scheme.extensions ?? {}) as Record<string, string | undefined>;
      const canvas = tokens["surface-canvas"];
      const tint = plainColor(tokens.tint, "tint");
      const { fill: fillSpec, ink: inkSpec } = fleetRibbonSheet.derivations[scheme.type];

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
        const pill =
          scheme.type === "dark"
            ? pillTint(amber, canvas, 0.12)
            : pillTint(amber, tokens["surface-panel-elevated"], 0.2);

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

        for (const [surface, wash] of TEXT_SURFACES) {
          for (const text of ["text-primary", "text-secondary"] as const) {
            const ratio = contrastRatio(tokens[text], blendOverBackground(tint, fill, wash));
            const before = contrastRatio(tokens[text], blendOverBackground(tint, pill, wash));
            // The band's own text always owes AA; a control owes it wherever it had it.
            const floor = surface === "band" || before >= 4.5 ? 4.5 : before - BELOW_AA_TOLERANCE;
            if (ratio < floor) {
              failures.push(
                `${where}: ${text} on ${surface} ${ratio.toFixed(2)} < ${floor.toFixed(2)} (pill tint ${before.toFixed(2)})`
              );
            }
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
