import { describe, expect, it } from "vitest";
import {
  BUILT_IN_APP_SCHEMES,
  blendOverBackground,
  contrastRatio,
  parseRgba,
  type AppColorScheme,
  type AppThemeTokenKey,
} from "@shared/theme";
import { ROW_TONE_CLASS, type ProjectRowTone } from "../projectRowStatus";

// The switcher's status sentences are small text, so every tone owes AA on the
// row it paints on: the palette surface at rest, and the highlight fill over it
// when the row is the cursor. A tone drifting back to a graphical ink fails here
// on the themes where that ink is only 3:1 grade.

const TONES = Object.keys(ROW_TONE_CLASS) as ProjectRowTone[];

function inkOf(classes: string): AppThemeTokenKey {
  const inks = classes
    .split(/\s+/)
    .map((c) => /^text-([a-z-]+)$/.exec(c)?.[1])
    .filter((name): name is string => name !== undefined);
  expect(inks, classes).toHaveLength(1);
  return inks[0] as AppThemeTokenKey;
}

function opaque(value: string): { hex: string; opacity: number } {
  const rgba = parseRgba(value);
  if (rgba) return rgba;
  if (/^#[0-9a-f]{8}$/i.test(value)) {
    return { hex: value.slice(0, 7), opacity: parseInt(value.slice(7), 16) / 255 };
  }
  return { hex: value, opacity: 1 };
}

function rowBackdrops(scheme: AppColorScheme): Array<{ label: string; hex: string }> {
  const t = scheme.tokens;
  const surfaces =
    scheme.type === "light"
      ? [{ label: "surface-panel-elevated", hex: t["surface-panel-elevated"] }]
      : [
          { label: "surface-sidebar", hex: t["surface-sidebar"] },
          ...(
            ["surface-grid", "surface-canvas", "surface-panel", "surface-panel-elevated"] as const
          ).map((key) => ({
            label: `palette over ${key}`,
            hex: blendOverBackground(t["surface-sidebar"], t[key], 0.94),
          })),
        ];
  const highlight = opaque(t["overlay-highlight"]);
  return surfaces.flatMap((surface) => [
    { label: `${surface.label} (resting)`, hex: surface.hex },
    {
      label: `${surface.label} (highlighted)`,
      hex: blendOverBackground(highlight.hex, surface.hex, highlight.opacity),
    },
  ]);
}

describe("project row status line contrast (#15866)", () => {
  it.each(TONES)("the %s tone reads at AA on every built-in row", (tone) => {
    const ink = inkOf(ROW_TONE_CLASS[tone]);
    for (const scheme of BUILT_IN_APP_SCHEMES) {
      for (const backdrop of rowBackdrops(scheme)) {
        const ratio = contrastRatio(scheme.tokens[ink], backdrop.hex);
        expect(
          ratio,
          `${tone} (${ink}) on ${scheme.id} ${backdrop.label}: ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
