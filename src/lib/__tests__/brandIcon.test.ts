import { describe, expect, it } from "vitest";
import { converter, modeOklab, modeOklch, modeRgb, useMode as registerMode } from "culori/fn";
import { apcaLc, blendOverBackground, contrastRatio, parseRgba } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";
import { resolveBrandMarkInk, type BrandMarkSurface } from "../brandIcon";

registerMode(modeRgb);
registerMode(modeOklch);
registerMode(modeOklab);
const toOklch = converter("oklch");
const toOklab = converter("oklab");

const FLOOR = 3;

const SURFACE_KEYS = [
  "surface-grid",
  "surface-sidebar",
  "surface-canvas",
  "surface-panel",
  "surface-panel-elevated",
] as const;

function makeScheme(
  type: "dark" | "light",
  tokens: Record<string, string>,
  extensions?: Record<string, string>
): AppColorScheme {
  return {
    id: "test",
    name: "Test",
    type,
    builtin: true,
    tokens: tokens as AppColorScheme["tokens"],
    ...(extensions ? { extensions: extensions as AppColorScheme["extensions"] } : null),
  };
}

const DARK = makeScheme("dark", {
  "text-secondary": "#a8a8a8",
  "overlay-elevated": "rgba(255, 255, 255, 0.06)",
  "overlay-subtle": "rgba(255, 255, 255, 0.03)",
  "surface-grid": "#141414",
  "surface-sidebar": "#181818",
  "surface-canvas": "#101010",
  "surface-panel": "#1e1e1e",
  "surface-panel-elevated": "#252525",
});

const LIGHT = makeScheme("light", {
  "text-secondary": "#525252",
  "overlay-elevated": "rgba(0, 0, 0, 0.1)",
  "overlay-subtle": "rgba(0, 0, 0, 0.04)",
  "surface-grid": "#f4f4f4",
  "surface-sidebar": "#efefef",
  "surface-canvas": "#ffffff",
  "surface-panel": "#fafafa",
  "surface-panel-elevated": "#ffffff",
});

const PANEL: BrandMarkSurface = { surface: "surface-panel" };

/** The two backdrops a mark on `surface` actually meets: at rest, and under hover. */
function backdrops(scheme: AppColorScheme, surface: BrandMarkSurface, base?: string) {
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  const rest = base ?? scheme.tokens[surface.surface]!;
  return { rest, active: blendOverBackground(overlay!.hex, rest, overlay!.opacity) };
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

/** Worst contrast across the whole correlated crossfade, both ends included. */
function worstAcrossFade(
  rest: string,
  active: string,
  pair: { rest: string; active: string }
): number {
  let worst = Infinity;
  for (let step = 0; step <= 40; step++) {
    const t = step / 40;
    worst = Math.min(worst, contrastRatio(mix(rest, active, t), mix(pair.rest, pair.active, t)));
  }
  return worst;
}

/** OKLab distance — the space the fade is sized in. */
function deltaE(a: string, b: string): number {
  const one = toOklab(a)!;
  const two = toOklab(b)!;
  return Math.hypot(one.l - two.l, one.a - two.a, one.b - two.b);
}

/** Formats an OKLCH-shaped object as the hex the screen would paint. */
function hexOf(color: { l: number; c?: number; h?: number }): string {
  const rgb = converter("rgb")({ mode: "oklch", l: color.l, c: color.c ?? 0, h: color.h });
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

/** Shortest angular distance between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

describe("resolveBrandMarkInk", () => {
  it("shows a legible brand colour exactly as the brand ships it", () => {
    const brand = "#cc785c";
    const pair = backdrops(DARK, PANEL);
    expect(contrastRatio(brand, pair.rest)).toBeGreaterThanOrEqual(FLOOR);
    expect(resolveBrandMarkInk(brand, DARK, PANEL)!.active).toBe(brand);
  });

  it("rests away from the backdrop, not toward it", () => {
    // The direction is the whole point. A resting mark drawn toward the backdrop
    // spends contrast to signal a state the hover background already signals,
    // and a row of them reads as washed out. Drawn the other way it keeps every
    // bit of that contrast and the reveal is the brand colour arriving.
    const backdrop = toOklch(DARK.tokens["surface-panel"])!;
    const ink = resolveBrandMarkInk("#cc785c", DARK, PANEL)!;
    const rest = toOklch(ink.rest)!;
    const active = toOklch(ink.active)!;

    expect(ink.rest).not.toBe(ink.active);
    expect(hueGap(rest.h!, active.h!)).toBeLessThan(3);
    expect(Math.abs(rest.l - backdrop.l)).toBeGreaterThan(Math.abs(active.l - backdrop.l));
    // Which on a dark theme means lighter, and deepening into the brand on hover.
    expect(rest.l).toBeGreaterThan(active.l);
    expect(contrastRatio(ink.rest, DARK.tokens["surface-panel"]!)).toBeGreaterThan(
      contrastRatio(ink.active, DARK.tokens["surface-panel"]!)
    );
  });

  it("reverses that direction on a light theme without a second rule", () => {
    const ink = resolveBrandMarkInk("#cc785c", LIGHT, PANEL)!;
    expect(toOklch(ink.rest)!.l).toBeLessThan(toOklch(ink.active)!.l);
    expect(contrastRatio(ink.rest, LIGHT.tokens["surface-panel"]!)).toBeGreaterThan(
      contrastRatio(ink.active, LIGHT.tokens["surface-panel"]!)
    );
  });

  it("takes only a slice of the fade out of chroma", () => {
    // Spending the fade on chroma is the wash this treatment exists to undo: at
    // rest the mark has to still be the brand's colour, not a grey hint of it.
    for (const [brand, scheme] of [
      ["#cc785c", DARK],
      ["#7c3aed", LIGHT],
      ["#615ced", DARK],
    ] as const) {
      const ink = resolveBrandMarkInk(brand, scheme, PANEL)!;
      expect(toOklch(ink.rest)!.c!).toBeGreaterThan(toOklch(ink.active)!.c! * 0.7);
    }
  });

  it("holds a resting mark to the weight of the row it sits in", () => {
    // A near-white cyan on a dark theme already starts above the theme's own
    // icon ink. Another step away from the backdrop would leave the *resting*
    // mark shouting over every neutral control beside it, so it comes back down
    // to the row's weight and pays for the fade in chroma instead.
    const brand = "#3ee6eb";
    const surface = DARK.tokens["surface-panel"]!;
    const ceiling = apcaLc(DARK.tokens["text-secondary"]!, surface) + 11;
    const ink = resolveBrandMarkInk(brand, DARK, PANEL)!;

    expect(apcaLc(ink.active, surface)).toBeGreaterThan(ceiling);
    expect(apcaLc(ink.rest, surface)).toBeLessThanOrEqual(ceiling + 1);
    // And it is still cyan: the ceiling took weight, not the brand.
    expect(toOklch(ink.rest)!.c!).toBeGreaterThan(toOklch(ink.active)!.c! * 0.7);
    expect(toOklch(ink.rest)!.c!).toBeLessThan(toOklch(ink.active)!.c!);
  });

  it("draws a brand with no colour as the theme's own icon, and reveals by weight", () => {
    // Black and white are not colours a theme can carry, so those marks stop
    // pretending: they sit level with the neutral controls and their reveal is
    // the one axis they still have.
    for (const [brand, scheme] of [
      ["#1c1c1c", DARK],
      ["#e8e8e8", LIGHT],
    ] as const) {
      const ink = resolveBrandMarkInk(brand, scheme, PANEL)!;
      const surface = scheme.tokens["surface-panel"]!;
      expect(ink.rest).toBe(scheme.tokens["text-secondary"]);
      expect(apcaLc(ink.active, surface)).toBeGreaterThan(apcaLc(ink.rest, surface));
      expect(contrastRatio(ink.active, surface)).toBeGreaterThan(contrastRatio(ink.rest, surface));
    }
  });

  it("gives a colourless brand the same size of reveal a hued one gets", () => {
    // The axis differs — weight rather than colour — but the step does not, so a
    // row of marks reacts by the same amount whatever each one is made of.
    const ink = resolveBrandMarkInk("#1c1c1c", DARK, PANEL)!;
    expect(ink.rest).not.toBe(ink.active);
    expect(deltaE(ink.rest, ink.active)).toBeGreaterThan(0.04);
  });

  it("keeps both states legible across the whole crossfade, not just at its ends", () => {
    // The control repaints its own background in the same 150ms the glyph
    // recolours, so both ends passing is not the same as the transition passing.
    for (const scheme of [DARK, LIGHT]) {
      for (const surface of SURFACE_KEYS) {
        for (const brand of ["#3ee6eb", "#e8e8e8", "#cc785c", "#1c1c1c", "#615ced"]) {
          const ink = resolveBrandMarkInk(brand, scheme, { surface })!;
          expect(
            worstAcrossFade(ink.rest, ink.active, backdrops(scheme, { surface }))
          ).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    }
  });

  it("nudges a brand that only just misses, and holds its hue doing it", () => {
    const brand = "#102a1e";
    const pair = backdrops(DARK, PANEL);
    expect(contrastRatio(brand, pair.rest)).toBeLessThan(FLOOR);

    const ink = resolveBrandMarkInk(brand, DARK, PANEL)!;
    expect(ink.active).not.toBe(brand);
    expect(contrastRatio(ink.active, pair.rest)).toBeGreaterThanOrEqual(FLOOR);

    const before = toOklch(brand)!;
    const after = toOklch(ink.active)!;
    expect(hueGap(after.h!, before.h!)).toBeLessThan(5);
    expect(after.l).toBeGreaterThan(before.l);
  });

  it("stops a correction as soon as the mark clears what was holding it back", () => {
    // Minimality, tested against the conjunction rather than against one of its
    // halves: on a dark theme it is usually APCA weight that binds and on a
    // light one the WCAG ratio, so a test that named either would be checking
    // the wrong constraint half the time. Give a fifth of the correction back
    // and at least one of the two has to break — otherwise the resolver moved
    // further than it had to.
    for (const [brand, scheme] of [
      ["#3ee6eb", LIGHT],
      ["#cc785c", LIGHT],
      ["#615ced", DARK],
    ] as const) {
      const ink = resolveBrandMarkInk(brand, scheme, PANEL)!;
      if (ink.active.toLowerCase() === brand.toLowerCase()) continue;

      const source = toOklch(brand)!;
      const corrected = toOklch(ink.active)!;
      // Past the fidelity limit the mark is placed rather than nudged, and
      // "minimal" stops being the claim — that branch has its own test.
      if (Math.abs(corrected.l - source.l) > 0.15) continue;
      const relaxed = hexOf({
        ...source,
        l: corrected.l + (source.l - corrected.l) * 0.2,
      });

      const pair = backdrops(scheme, PANEL);
      const ratio = Math.min(
        contrastRatio(relaxed, pair.rest),
        contrastRatio(relaxed, pair.active)
      );
      const weight = Math.min(apcaLc(relaxed, pair.rest), apcaLc(relaxed, pair.active));
      // 3.05 rather than 3, because the resolver holds a small guard over the
      // floor to cover the gaps between its crossfade samples.
      expect(`${brand}/${scheme.type}: ${ratio < 3.05 || weight < 35}`).toBe(
        `${brand}/${scheme.type}: true`
      );
    }
  });

  it("places a brand it cannot show at a weight that reads, not on the floor", () => {
    // A near-black mark on a dark theme is going to be grey whatever we do, so
    // the minimum legal move buys nothing — it just makes it a murkier grey with
    // nowhere left to fade to.
    const ink = resolveBrandMarkInk("#1c1c1c", DARK, PANEL)!;
    const pair = backdrops(DARK, PANEL);
    expect(apcaLc(ink.active, pair.rest)).toBeGreaterThanOrEqual(58);
    expect(contrastRatio(ink.rest, pair.rest)).toBeGreaterThan(FLOOR);
  });

  it("darkens a near-white brand on a light theme instead of letting it vanish", () => {
    const ink = resolveBrandMarkInk("#e8e8e8", LIGHT, PANEL)!;
    const pair = backdrops(LIGHT, PANEL);
    expect(toOklch(ink.active)!.l).toBeLessThan(toOklch("#e8e8e8")!.l);
    expect(
      Math.min(contrastRatio(ink.active, pair.rest), contrastRatio(ink.active, pair.active))
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it("answers to the surface it is told it is painted on", () => {
    // The whole point of threading provenance: the same brand on the theme's
    // darkest and lightest surfaces is not the same colour problem.
    const onCanvas = resolveBrandMarkInk("#615ced", DARK, { surface: "surface-canvas" })!;
    const onElevated = resolveBrandMarkInk("#615ced", DARK, {
      surface: "surface-panel-elevated",
    })!;
    expect(onCanvas.rest).not.toBe(onElevated.rest);
    expect(contrastRatio(onCanvas.rest, DARK.tokens["surface-canvas"]!)).toBeGreaterThanOrEqual(
      FLOOR
    );
    expect(
      contrastRatio(onElevated.rest, DARK.tokens["surface-panel-elevated"]!)
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it("measures against the container's own lift, not the bare surface token", () => {
    const lifted = resolveBrandMarkInk("#615ced", DARK, {
      surface: "surface-panel",
      lift: "overlay-subtle",
    })!;
    const bare = resolveBrandMarkInk("#615ced", DARK, PANEL)!;
    expect(lifted.rest).not.toBe(bare.rest);
    expect(
      contrastRatio(
        lifted.rest,
        blendOverBackground("#ffffff", DARK.tokens["surface-panel"]!, 0.03)
      )
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  it("uses a theme extension that repaints the surface outright", () => {
    // Several light themes repaint panel title bars through `panel-header-bg`,
    // so the bare surface token there answers for a pixel never painted.
    const repainted = makeScheme("light", LIGHT.tokens, { "panel-header-bg": "#c8c8c8" });
    const ink = resolveBrandMarkInk("#cc785c", repainted, {
      surface: "surface-panel",
      extension: "panel-header-bg",
    })!;
    expect(contrastRatio(ink.rest, "#c8c8c8")).toBeGreaterThanOrEqual(FLOOR);
    expect(ink.rest).not.toBe(resolveBrandMarkInk("#cc785c", repainted, PANEL)!.rest);
  });

  it("composites a translucent extension over the surface below it", () => {
    const tinted = makeScheme("dark", DARK.tokens, {
      "panel-header-focus-bg": "rgba(255,255,255,0.06)",
    });
    const ink = resolveBrandMarkInk("#615ced", tinted, {
      surface: "surface-panel",
      extension: "panel-header-focus-bg",
    })!;
    const composited = blendOverBackground("#ffffff", DARK.tokens["surface-panel"]!, 0.06);
    expect(contrastRatio(ink.rest, composited)).toBeGreaterThanOrEqual(FLOOR);
  });

  it("stays safe on every surface when it is not told which one it is on", () => {
    // No provider is a real state — an unwrapped call site, a plugin panel — so
    // the fallback has to clear the floor everywhere rather than merely somewhere.
    for (const scheme of [DARK, LIGHT]) {
      for (const brand of ["#cc785c", "#3ee6eb", "#1c1c1c", "#e8e8e8", "#615ced"]) {
        const ink = resolveBrandMarkInk(brand, scheme)!;
        for (const surface of SURFACE_KEYS) {
          expect(
            worstAcrossFade(ink.rest, ink.active, backdrops(scheme, { surface }))
          ).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    }
  });

  it("falls back rather than declining when the named surface cannot be measured", () => {
    const translucent = makeScheme("dark", { ...DARK.tokens, "surface-panel": "#1e1e1e80" });
    const ink = resolveBrandMarkInk("#cc785c", translucent, PANEL);
    expect(ink).not.toBeNull();
    // A translucent backdrop composites over whatever is behind it, so it is
    // never read as opaque — the conservative surface answers instead.
    expect(ink).toEqual(resolveBrandMarkInk("#cc785c", translucent));
  });

  it("accepts the shorthand hex form", () => {
    expect(resolveBrandMarkInk("#c75", DARK, PANEL)).toEqual(
      resolveBrandMarkInk("#cc7755", DARK, PANEL)
    );
  });

  it("takes an alpha preset colour at full opacity rather than giving up on it", () => {
    // `sanitizePreset` accepts 4- and 8-digit hex, so alpha colours really do
    // reach here. A translucent mark has no single contrast ratio, so alpha is
    // dropped rather than composited — but dropping the brand treatment
    // entirely would leave the user's chosen colour with no effect at all.
    expect(resolveBrandMarkInk("#cc785c80", DARK, PANEL)).toEqual(
      resolveBrandMarkInk("#cc785c", DARK, PANEL)
    );
    expect(resolveBrandMarkInk("#c75f", DARK, PANEL)).toEqual(
      resolveBrandMarkInk("#cc7755", DARK, PANEL)
    );
  });

  it("declines colours it cannot measure", () => {
    expect(resolveBrandMarkInk("not-a-color", DARK, PANEL)).toBeNull();
    expect(resolveBrandMarkInk("#12345", DARK, PANEL)).toBeNull();
    expect(resolveBrandMarkInk(undefined, DARK, PANEL)).toBeNull();
  });

  it("declines a theme with no surface it can read", () => {
    expect(
      resolveBrandMarkInk("#cc785c", makeScheme("dark", { "text-secondary": "#a8a8a8" }))
    ).toBeNull();
  });

  it("re-resolves when a theme is edited in place under a stable id", () => {
    // Custom themes keep their id across an edit, so anything cached against the
    // id alone would hand back the pre-edit colour forever.
    const before = resolveBrandMarkInk("#cc785c", DARK, PANEL)!;
    const edited = makeScheme("dark", { ...DARK.tokens, "surface-panel": "#3a3a3a" });
    expect(resolveBrandMarkInk("#cc785c", edited, PANEL)!.rest).not.toBe(before.rest);
  });
});
