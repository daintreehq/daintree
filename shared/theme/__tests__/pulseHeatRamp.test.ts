import { describe, expect, it } from "vitest";
import type { BuiltInThemeSource } from "../builtInThemeSources.js";
import { BUILT_IN_THEME_SOURCES } from "../builtInThemes/index.js";
import { blendOverBackground, deltaEOK } from "../contrast.js";

// Clearly above the ~0.02 JND: a level-1 day that only just clears JND still
// reads as a quiet day at 10px, and a level 3 that only just clears it reads as
// a peak — the two defects this guards against.
const MIN_STEP_DELTA_E = 0.05;

const HEX = /^#[0-9A-Fa-f]{6}$/;
const STOPS = ["pulse-heat-1", "pulse-heat-2", "pulse-heat-3", "pulse-heat-4"] as const;

// Mirrors PulseHeatmap's fallback defaults for a theme that authors only the
// hue: the cell paints `pulse-heat-color` at each opacity over the card.
const LEGACY_OPACITY_DEFAULTS = { low: 0.18, medium: 0.35, high: 0.55 };

/**
 * The ramp a theme actually paints, empty cell first. Opaque stops when the
 * theme authors all four; otherwise the legacy alpha ramp composited over the
 * card. `null` when neither is resolvable to hex.
 */
function paintedRamp(theme: BuiltInThemeSource): string[] | null {
  const ext = theme.extensions ?? {};
  const empty = ext["pulse-empty-bg"];
  if (!empty || !HEX.test(empty)) return null;

  const opaque = STOPS.map((key) => ext[key]);
  if (opaque.every((stop): stop is string => stop !== undefined && HEX.test(stop))) {
    return [empty, ...opaque];
  }

  const color = ext["pulse-heat-color"];
  const card = ext["pulse-card-bg"];
  if (!color || !HEX.test(color) || !card || !HEX.test(card)) return null;
  const opacity = (key: string, fallback: number) => {
    const value = Number(ext[key as keyof typeof ext]);
    return Number.isFinite(value) ? value : fallback;
  };
  return [
    empty,
    blendOverBackground(
      color,
      card,
      opacity("pulse-heat-low-opacity", LEGACY_OPACITY_DEFAULTS.low)
    ),
    blendOverBackground(
      color,
      card,
      opacity("pulse-heat-medium-opacity", LEGACY_OPACITY_DEFAULTS.medium)
    ),
    blendOverBackground(
      color,
      card,
      opacity("pulse-heat-high-opacity", LEGACY_OPACITY_DEFAULTS.high)
    ),
    color,
  ];
}

describe("pulse heat ramp — every painted step is visibly distinct", () => {
  const ramps = BUILT_IN_THEME_SOURCES.map((theme) => [theme.id, paintedRamp(theme)] as const);

  it("resolves a ramp for every built-in theme that styles the pulse", () => {
    const styled = BUILT_IN_THEME_SOURCES.filter((t) => t.extensions?.["pulse-empty-bg"]);
    expect(styled.length).toBeGreaterThan(0);
    for (const theme of styled) {
      expect(paintedRamp(theme), `${theme.id} has no resolvable heat ramp`).not.toBeNull();
    }
  });

  it.each(ramps.filter(([, ramp]) => ramp !== null))(
    "%s: empty → heat-1 → … → heat-4 each step clears the floor",
    (id, ramp) => {
      for (let i = 1; i < ramp!.length; i += 1) {
        expect(
          deltaEOK(ramp![i - 1]!, ramp![i]!),
          `${id}: step ${i - 1}→${i} (${ramp![i - 1]} → ${ramp![i]})`
        ).toBeGreaterThanOrEqual(MIN_STEP_DELTA_E);
      }
    }
  );
});
