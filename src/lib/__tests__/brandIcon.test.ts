import { describe, expect, it } from "vitest";
import {
  clampChroma,
  converter,
  formatHex,
  modeOklch,
  modeRgb,
  useMode as registerMode,
} from "culori/fn";
import { blendOverBackground, contrastRatio, parseRgba } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";
import { resolveBrandMarkInk } from "../brandIcon";

registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter("oklch");

const FLOOR = 3;

const SURFACE_KEYS = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
] as const;

function makeScheme(type: "dark" | "light", tokens: Record<string, string>): AppColorScheme {
  return {
    id: "test",
    name: "Test",
    type,
    builtin: true,
    tokens: tokens as AppColorScheme["tokens"],
  };
}

const DARK = makeScheme("dark", {
  "text-secondary": "#a8a8a8",
  "overlay-elevated": "rgba(255, 255, 255, 0.06)",
  "surface-grid": "#141414",
  "surface-sidebar": "#181818",
  "surface-canvas": "#101010",
  "surface-panel": "#1e1e1e",
  "surface-panel-elevated": "#252525",
});

const LIGHT = makeScheme("light", {
  "text-secondary": "#525252",
  "overlay-elevated": "rgba(0, 0, 0, 0.1)",
  "surface-grid": "#f4f4f4",
  "surface-sidebar": "#efefef",
  "surface-canvas": "#ffffff",
  "surface-panel": "#fafafa",
  "surface-panel-elevated": "#ffffff",
});

/** Rebuilds the backdrop set independently of the resolver's own helper. */
function backdrops(scheme: AppColorScheme): string[] {
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  return SURFACE_KEYS.flatMap((key) => {
    const base = scheme.tokens[key]!;
    return overlay ? [base, blendOverBackground(overlay.hex, base, overlay.opacity)] : [base];
  });
}

function worstRatio(ink: string, scheme: AppColorScheme): number {
  return Math.min(...backdrops(scheme).map((bg) => contrastRatio(ink, bg)));
}

/** Channel-wise sRGB interpolation, matching how a `color` transition crossfades. */
function mix(from: string, to: string, ratio: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * ratio)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/** Shortest angular distance between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

describe("resolveBrandMarkInk", () => {
  it("holds the ink's lightness and takes the brand's hue at rest", () => {
    const ink = resolveBrandMarkInk("#cc785c", DARK)!;
    const rest = toOklch(ink.rest)!;
    const token = toOklch(DARK.tokens["text-secondary"])!;
    const brand = toOklch("#cc785c")!;

    expect(rest.l).toBeCloseTo(token.l, 2);
    expect(hueGap(rest.h!, brand.h!)).toBeLessThan(5);
  });

  it("tints two brands of wildly different chroma by the same amount", () => {
    // The source hexes are all over the place — one of these sits near C=0.11 and
    // the other near C=0.25. Scaling each brand's own chroma would preserve that
    // gap; a constant target closes it, which is what makes marks read as equally
    // tinted rather than one shouting over the other.
    const warm = toOklch(resolveBrandMarkInk("#cc785c", DARK)!.rest)!;
    const violet = toOklch(resolveBrandMarkInk("#8b5cf6", DARK)!.rest)!;
    const sourceGap = Math.abs(toOklch("#cc785c")!.c! - toOklch("#8b5cf6")!.c!);
    const restGap = Math.abs(warm.c! - violet.c!);

    expect(restGap).toBeLessThan(0.01);
    expect(sourceGap).toBeGreaterThan(restGap * 5);
  });

  it("resolves a hueless brand to the plain theme ink", () => {
    // A goose-style near-black has no hue to borrow, so it stays grey rather
    // than having one invented for it.
    expect(resolveBrandMarkInk("#1c1c1c", DARK)!.rest).toBe(DARK.tokens["text-secondary"]);
    expect(resolveBrandMarkInk("#e8e8e8", LIGHT)!.rest).toBe(LIGHT.tokens["text-secondary"]);
  });

  it("keeps the resting tint legible on every surface", () => {
    for (const scheme of [DARK, LIGHT]) {
      for (const brand of ["#cc785c", "#3ee6eb", "#1c1c1c", "#8b5cf6"]) {
        expect(worstRatio(resolveBrandMarkInk(brand, scheme)!.rest, scheme)).toBeGreaterThanOrEqual(
          FLOOR
        );
      }
    }
  });

  it("leaves a brand colour untouched on hover when it is already legible", () => {
    const brand = "#ff8a3d";
    expect(worstRatio(brand, DARK)).toBeGreaterThanOrEqual(FLOOR);
    expect(resolveBrandMarkInk(brand, DARK)!.hover).toBe(brand);
  });

  it("corrects an illegible brand colour while holding its hue", () => {
    const brand = "#102a1e";
    expect(worstRatio(brand, DARK)).toBeLessThan(FLOOR);

    const ink = resolveBrandMarkInk(brand, DARK)!;
    expect(ink.hover).not.toBe(brand);
    expect(worstRatio(ink.hover, DARK)).toBeGreaterThanOrEqual(FLOOR);

    const before = toOklch(brand)!;
    const after = toOklch(ink.hover)!;
    expect(hueGap(after.h!, before.h!)).toBeLessThan(5);
    expect(after.l).toBeGreaterThan(before.l);
  });

  it("moves lightness no further than legibility requires", () => {
    const brand = "#3ee6eb";
    const ink = resolveBrandMarkInk(brand, LIGHT)!;
    const source = toOklch(brand)!;
    const corrected = toOklch(ink.hover)!;
    expect(worstRatio(ink.hover, LIGHT)).toBeGreaterThanOrEqual(FLOOR);

    // Give back a fifth of the correction. If that still cleared the floor, the
    // resolver moved further than it had to — this is what makes the result the
    // *minimum* correction rather than merely one that happens to pass.
    const slacker = corrected.l + (source.l - corrected.l) * 0.2;
    const relaxed = formatHex(
      clampChroma({ mode: "oklch", l: slacker, c: source.c, h: source.h }, "oklch", "rgb")
    );
    expect(worstRatio(relaxed, LIGHT)).toBeLessThan(FLOOR);
  });

  it("stays legible through the whole crossfade, not just at its ends", () => {
    // The control repaints its own background in the same 150ms the glyph
    // recolours, so both ends passing is not the same as the transition passing.
    const overlay = parseRgba(LIGHT.tokens["overlay-elevated"]!)!;
    for (const brand of ["#3ee6eb", "#e8e8e8", "#cc785c"]) {
      const ink = resolveBrandMarkInk(brand, LIGHT)!;
      for (const key of SURFACE_KEYS) {
        const base = LIGHT.tokens[key]!;
        const hovered = blendOverBackground(overlay.hex, base, overlay.opacity);
        for (let step = 0; step <= 10; step++) {
          const t = step / 10;
          expect(
            contrastRatio(mix(ink.rest, ink.hover, t), mix(base, hovered, t))
          ).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    }
  });

  it("treats an arbitrary runtime preset hex exactly like a shipped brand", () => {
    // Nothing in the resolver knows this colour. A new CLI is just a preset we
    // happened to ship, so if this path holds, adding an agent costs one hex.
    const preset = "#3366ff";
    const ink = resolveBrandMarkInk(preset, LIGHT)!;
    expect(worstRatio(ink.rest, LIGHT)).toBeGreaterThanOrEqual(FLOOR);
    expect(worstRatio(ink.hover, LIGHT)).toBeGreaterThanOrEqual(FLOOR);
  });

  it("accepts the shorthand hex form", () => {
    expect(resolveBrandMarkInk("#c75", DARK)).toEqual(resolveBrandMarkInk("#cc7755", DARK));
  });

  it("takes an alpha preset colour at full opacity rather than giving up on it", () => {
    // `sanitizePreset` accepts 4- and 8-digit hex, so alpha colours really do
    // reach here. A translucent mark has no single contrast ratio, so alpha is
    // dropped rather than composited — but dropping the brand treatment
    // entirely would leave the user's chosen colour with no effect at all.
    expect(resolveBrandMarkInk("#cc785c80", DARK)).toEqual(resolveBrandMarkInk("#cc785c", DARK));
    expect(resolveBrandMarkInk("#c75f", DARK)).toEqual(resolveBrandMarkInk("#cc7755", DARK));
  });

  it("declines colours it cannot measure", () => {
    expect(resolveBrandMarkInk("not-a-color", DARK)).toBeNull();
    expect(resolveBrandMarkInk("#12345", DARK)).toBeNull();
    expect(resolveBrandMarkInk(undefined, DARK)).toBeNull();
  });

  it("declines a theme missing the tokens it reads", () => {
    expect(
      resolveBrandMarkInk("#cc785c", makeScheme("dark", { "surface-panel": "#1e1e1e" }))
    ).toBeNull();
    expect(
      resolveBrandMarkInk("#cc785c", makeScheme("dark", { "text-secondary": "#a8a8a8" }))
    ).toBeNull();
  });

  it("re-resolves when a theme is edited in place under a stable id", () => {
    // Custom themes keep their id across an edit, so anything cached against the
    // id alone would hand back the pre-edit colour forever.
    const before = resolveBrandMarkInk("#cc785c", DARK)!;
    const edited = makeScheme("dark", { ...DARK.tokens, "text-secondary": "#6e6e6e" });
    expect(resolveBrandMarkInk("#cc785c", edited)!.rest).not.toBe(before.rest);
  });
});
