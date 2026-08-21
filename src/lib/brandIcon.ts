import {
  clampChroma,
  converter,
  formatHex,
  modeOklch,
  modeRgb,
  useMode as registerMode,
} from "culori/fn";
import { DISPLAY_SURFACES, blendOverBackground, contrastRatio, parseRgba } from "@shared/theme";
import type { AppColorScheme } from "@shared/theme";

// `culori/fn` ships mode definitions without registering them, which is what
// makes it tree-shakable (the root `culori` entry calls `useMode` for ~30 spaces
// at module scope and cannot be shaken). `modeRgb` is what parses a hex string
// at all — without it `toOklch()` on a hex string returns undefined, not a color.
// Aliased because culori's `useMode` is mode registration, not a React hook, and
// `react-hooks/rules-of-hooks` matches it on the name alone.
registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter("oklch");

/** WCAG 1.4.11 non-text contrast. A mark is a non-text UI component. */
const CONTRAST_FLOOR = 3;

// One chroma for every mark on every theme. Deliberately NOT a fraction of the
// brand's own chroma: the source hexes are all over the place, spanning roughly
// C = 0.11 to C = 0.25, so scaling them by a common factor preserves that
// disparity and the saturated end shouts while the muted end reads grey. A
// constant target is what makes a row of marks read as *equally* tinted. 0.05
// sits mid-band for a 16px glyph — below ~0.02 it is indistinguishable from
// grey, above ~0.08 it stops being a tint and becomes a full colour mark, which
// is the failure mode #11903 backed out of.
const TINT_CHROMA = 0.05;

// Below this the OKLCH hue is meaningless (and culori reports it as `undefined`
// rather than 0). The near-black and near-white monochrome marks land here: no
// hue to borrow, so they resolve to the plain ink. That is correct, not a bug.
const ACHROMATIC_CHROMA = 1e-4;

/** Halvings of the lightness interval. 2^-16 is far finer than 8-bit output. */
const SEARCH_STEPS = 16;

const CACHE_LIMIT = 512;

export interface BrandMarkInk {
  /** Theme ink lightness carrying the brand hue at `TINT_CHROMA`. */
  rest: string;
  /** The brand colour, lightness-corrected only as far as legibility demands. */
  hover: string;
}

/** Resting surface and the backdrop it becomes while the control is hovered. */
interface Backdrop {
  base: string;
  hovered: string;
}

/**
 * Normalizes an opaque 3- or 6-digit hex, rejecting everything else.
 *
 * Used for the theme's own tokens, where strictness is the point: a translucent
 * surface composites over whatever sits behind it, so reading one as opaque
 * would measure a pixel the screen never paints. Declining is the honest answer
 * — the mark keeps its inherited colour rather than a mis-measured one.
 */
function opaqueHex(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const body = match[1]!;
  const expanded =
    body.length === 3
      ? body
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : body;
  return `#${expanded.toLowerCase()}`;
}

/**
 * Normalizes the brand colour, additionally accepting the 4- and 8-digit forms
 * by dropping their alpha.
 *
 * Deliberately laxer than `opaqueHex` because the two inputs fail differently.
 * `sanitizePreset` (`src/config/agents.ts`) accepts alpha, so alpha brand hexes
 * really do arrive here, and refusing them would leave a colour the user
 * explicitly chose with no effect at all. A foreground also has somewhere to
 * fall back to — its opaque RGB — whereas a translucent *backdrop* has no single
 * value to measure against. So alpha is dropped on the way in and never on the
 * surfaces, which is why this is not one shared helper.
 */
function brandHex(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(trimmed);
  if (!match) return opaqueHex(trimmed);
  const body = match[1]!;
  return opaqueHex(body.length === 4 ? `#${body.slice(0, 3)}` : `#${body.slice(0, 6)}`);
}

/** Channel-wise sRGB interpolation — the space a `color` transition crossfades in. */
function mixHex(from: string, to: string, ratio: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const a = parseInt(from.slice(offset, offset + 2), 16);
    const b = parseInt(to.slice(offset, offset + 2), 16);
    return Math.round(a + (b - a) * ratio)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

/**
 * The five display surfaces, each paired with itself under the hover overlay.
 * A mark carries no surface provenance — the same component renders on the grid,
 * the sidebar and the panels — so the correction answers to the worst of all of
 * them at once. Stricter than any single placement needs, and the price of not
 * threading a surface prop through every call site.
 */
function collectBackdrops(scheme: AppColorScheme): Backdrop[] {
  const overlay = parseRgba(scheme.tokens["overlay-elevated"] ?? "");
  const backdrops: Backdrop[] = [];
  for (const key of DISPLAY_SURFACES) {
    const base = opaqueHex(scheme.tokens[key]);
    if (!base) continue;
    // A theme whose overlay is a `color-mix()` rather than an `rgba()` leaves the
    // hovered backdrop unknowable here; measuring against the resting surface
    // alone is the honest floor rather than a guessed composite.
    const hovered = overlay ? blendOverBackground(overlay.hex, base, overlay.opacity) : base;
    backdrops.push({ base, hovered });
  }
  return backdrops;
}

/**
 * Whether `ink` stays legible across the whole 150ms crossfade, not just at its
 * endpoints. `.toolbar-agent-button:hover` repaints its background in the same
 * 150ms the glyph recolours, so foreground and backdrop are both moving.
 *
 * Backdrop luminance is monotonic along the composite line, so the resting and
 * hovered surfaces bound every intermediate backdrop. The foreground is not so
 * well behaved: its channels can move in opposite directions, which puts an
 * interior extremum inside the interval. Sampling the correlated midpoint — the
 * halfway foreground against the halfway backdrop — is what catches that, and it
 * is also what catches a rest/hover pair straddling the backdrop, where the
 * crossfade passes through it and contrast collapses to ~1:1 mid-transition.
 */
function staysLegible(ink: string, backdrops: Backdrop[], rest?: string): boolean {
  for (const { base, hovered } of backdrops) {
    if (contrastRatio(ink, base) < CONTRAST_FLOOR) return false;
    if (contrastRatio(ink, hovered) < CONTRAST_FLOOR) return false;
    if (
      rest &&
      contrastRatio(mixHex(rest, ink, 0.5), mixHex(base, hovered, 0.5)) < CONTRAST_FLOOR
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The brand's hue and chroma held at a different lightness, re-fitted into sRGB
 * by CSS Color 4 chroma reduction rather than by clipping channels — clipping
 * shifts the hue, which is the one thing the correction has to preserve.
 */
function atLightness(hue: number | undefined, chroma: number, lightness: number): string | null {
  const fitted = clampChroma({ mode: "oklch", l: lightness, c: chroma, h: hue }, "oklch", "rgb");
  return opaqueHex(formatHex(fitted));
}

/**
 * Smallest lightness move toward `target` (0 or 1) that clears the floor.
 *
 * Bisection rather than stepping: gamut mapping and 8-bit quantization sit
 * between the lightness we pick and the contrast we measure, so there is no
 * closed form to solve, and a fixed step either lands visibly coarse or wastes
 * work. Every candidate is measured on the *formatted* hex for that reason —
 * the pre-clamp OKLCH value is not what the screen paints.
 *
 * Those same two steps also make the predicate very slightly non-monotonic in
 * lightness: near a rounding boundary a candidate can clear the floor while one
 * a fraction closer to the extreme misses it by a hundredth of a ratio point.
 * That costs a hair of optimality, never the floor itself — `passing` only ever
 * holds a lightness whose formatted hex was measured and passed (it starts at
 * the verified extreme), and `atLightness` is deterministic, so the value
 * returned below is that same verified hex. Keep that invariant if you touch
 * this loop: the contrast guarantee rests on it, not on monotonicity.
 */
function searchLightness(
  hue: number | undefined,
  chroma: number,
  from: number,
  target: 0 | 1,
  backdrops: Backdrop[],
  rest: string
): { hex: string; delta: number } | null {
  const extreme = atLightness(hue, chroma, target);
  if (!extreme || !staysLegible(extreme, backdrops, rest)) return null;

  let failing = from;
  let passing: number = target;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const midpoint = (failing + passing) / 2;
    const candidate = atLightness(hue, chroma, midpoint);
    if (candidate && staysLegible(candidate, backdrops, rest)) {
      passing = midpoint;
    } else {
      failing = midpoint;
    }
  }
  const hex = atLightness(hue, chroma, passing);
  return hex ? { hex, delta: Math.abs(passing - from) } : null;
}

const cache = new Map<string, BrandMarkInk | null>();

/**
 * Resolves the two colours a brand mark wears: a lightly tinted resting state and
 * the full brand colour on hover.
 *
 * At rest the mark sits at the theme's own icon-ink lightness carrying the
 * brand's hue at one global chroma, so a row of marks reads as a row of icons
 * that happen to be tinted rather than as a row of logos. On hover it goes to
 * the brand colour, corrected by the minimum lightness move that keeps it
 * readable — legibility wins, brand fidelity yields, decided per brand and per
 * theme rather than once for the roster.
 *
 * Derives entirely from the brand hex, the active theme's tokens and the one
 * chroma constant: no per-agent table, no per-theme number, no knowledge of the
 * agent registry. An arbitrary preset hex arriving at runtime takes the same
 * path a shipped agent does, which is what makes adding a CLI cost one hex.
 */
export function resolveBrandMarkInk(
  brandColor: string | undefined,
  scheme: AppColorScheme
): BrandMarkInk | null {
  const brand = brandHex(brandColor);
  const inkHex = opaqueHex(scheme.tokens["text-secondary"]);
  if (!brand || !inkHex) return null;

  // Keyed on the token values themselves, not the scheme id: a custom theme can
  // be edited in place and keep its id, so an id-keyed entry would go stale.
  const key = [
    brand,
    inkHex,
    scheme.tokens["overlay-elevated"] ?? "",
    ...DISPLAY_SURFACES.map((surface) => scheme.tokens[surface] ?? ""),
  ].join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const resolved = computeInk(brand, inkHex, scheme);
  if (cache.size >= CACHE_LIMIT) {
    // Oldest-first eviction. Preset colours are arbitrary hexes arriving at
    // runtime, so the key space is unbounded and the map needs a ceiling.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, resolved);
  return resolved;
}

function computeInk(brandHex: string, inkHex: string, scheme: AppColorScheme): BrandMarkInk | null {
  const backdrops = collectBackdrops(scheme);
  if (backdrops.length === 0) return null;

  const brand = toOklch(brandHex);
  const ink = toOklch(inkHex);
  if (!brand || !ink) return null;

  const brandChroma = brand.c ?? 0;
  const hasHue = brand.h !== undefined && brandChroma > ACHROMATIC_CHROMA;

  // The tint only earns its place if it is no less legible than the ink it
  // replaces; a hue that cannot hold the floor at this lightness stays grey.
  let rest = inkHex;
  if (hasHue) {
    const tinted = atLightness(brand.h, TINT_CHROMA, ink.l);
    if (tinted && staysLegible(tinted, backdrops)) rest = tinted;
  }

  if (staysLegible(brandHex, backdrops, rest)) {
    return { rest, hover: brandHex };
  }

  // Both directions, then the smaller move — the correction is a last resort and
  // should be as close to the untouched brand colour as legibility allows.
  const darker = searchLightness(brand.h, brandChroma, brand.l, 0, backdrops, rest);
  const lighter = searchLightness(brand.h, brandChroma, brand.l, 1, backdrops, rest);
  const best = [darker, lighter]
    .filter((result): result is { hex: string; delta: number } => result !== null)
    .sort((a, b) => a.delta - b.delta)[0];

  // Nothing on the lightness axis clears the floor against every surface at
  // once, so the mark holds its resting ink through the hover rather than
  // animating into something unreadable.
  return { rest, hover: best?.hex ?? rest };
}
