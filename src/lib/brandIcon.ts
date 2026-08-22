import {
  clampChroma,
  converter,
  formatHex,
  modeOklch,
  modeRgb,
  useMode as registerMode,
} from "culori/fn";
import {
  DISPLAY_SURFACES,
  apcaLc,
  blendOverBackground,
  contrastRatio,
  parseRgba,
  relativeLuminance,
} from "@shared/theme";
import type { AppColorScheme, AppThemeTokenKey, ExtensionKey } from "@shared/theme";

// `culori/fn` ships mode definitions without registering them, which is what
// makes it tree-shakable (the root `culori` entry calls `useMode` for ~30 spaces
// at module scope and cannot be shaken). `modeRgb` is what parses a hex string
// at all — without it `toOklch()` on a hex string returns undefined, not a color.
// Aliased because culori's `useMode` is mode registration, not a React hook, and
// `react-hooks/rules-of-hooks` matches it on the name alone.
registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter("oklch");

/** WCAG 1.4.11 non-text contrast. The accessibility contract, never traded away. */
const CONTRAST_FLOOR = 3;

/**
 * How far the resting mark sits from the active one, as an OKLab distance.
 *
 * One number sets the whole move: mostly lightness, a fixed slice of chroma,
 * and never hue — hue is the half of a brand mark that has to survive.
 *
 * 0.07 is roughly three times the ~0.02 just-noticeable difference: read as
 * "the same colour, slightly back" rather than as a second colour. The bracket
 * published for a state change that should be obvious without being jarring is
 * 0.06–0.10, and a 16px glyph sits at the low end of it because small fields
 * desaturate — the same move reads as less at this size than on a swatch.
 */
const FADE_DELTA_E = 0.07;

/**
 * The slice of the fade taken out of chroma rather than lightness.
 *
 * Small on purpose. A fade spent on chroma is the wash the previous revision
 * shipped — eighteen brands flattened into one grey — so chroma gives up just
 * enough for the hover to read as a bloom of colour on top of the shift in
 * weight, and lightness carries the rest.
 */
const REST_CHROMA_GIVE = 0.2;

/**
 * Perceived weight, in APCA Lc, that an active mark has to carry.
 *
 * WCAG's 3:1 is a compliance floor, not evidence that an intricate 16px glyph
 * is comfortable: a fine outlined mark and a solid square at the same ratio
 * are not the same thing to read. Several dark violets clear 3:1 on a
 * near-black theme while landing around Lc 25, which puts the *active* state —
 * the one you are looking at — below the resting one it came from. Lc 35 is the
 * smallest floor that removes that inversion, and it moves only the marks that
 * were in it.
 */
const ACTIVE_MIN_LC = 35;

/**
 * How far above the theme's own icon ink, in Lc, a resting mark is allowed to
 * get.
 *
 * A resting mark is not the loudest thing in its row — the neutral controls
 * beside it are painted in `text-secondary`, and a brand that arrives near
 * white on a dark theme or near black on a light one lands well above them and
 * reads as a primary control rather than as something at rest. The ceiling pulls
 * those back to the row's own weight; the active state is still the brand.
 *
 * The margin is what keeps this an exception rather than a coin toss. Without
 * it, a brand landing a point or two above `text-secondary` would be clamped
 * while its neighbour a point below faded normally, and the row would lose its
 * common treatment. 11 is where the brightest brand that reaches its resting
 * state *unclamped* already sits, so the ceiling lands the loud ones level with
 * it instead of a visible step above.
 */
const REST_CEILING_LC_MARGIN = 11;

/**
 * Chroma below which a brand has no colour to honour.
 *
 * A few vendors ship a mark that is simply black, or simply white. There is no
 * hue to carry into a theme, so what identifies those is their silhouette, and
 * the honest way to draw a silhouette is in the ink the theme already uses for
 * its own icons. Below this threshold a mark stops trying to be a colour and
 * becomes an icon: it rests at `text-secondary` and its reveal is weight rather
 * than colour.
 */
const COLOURLESS_CHROMA = 0.02;

/**
 * Perceived weight, in APCA Lc, that a mark is placed at once it can no longer
 * be shown as the brand ships it at all. The APCA bracket for a standalone
 * meaningful glyph — where an ordinary icon would sit if the theme had drawn
 * one, which is the honest place for a mark that has lost its colour.
 *
 * Lc rather than a contrast ratio because this is a placement, not a floor, and
 * WCAG ratios compress at the dark end: the same ratio buys much less perceived
 * weight on a dark theme than on a light one, which is the axis this has to be
 * stable across.
 */
const CORRECTED_LC = 60;

/**
 * Lightness move, in OKLab L, past which a correction has stopped preserving
 * the brand colour and starts being a substitute for it.
 *
 * Under it the correction is a nudge — a brand a shade too pale for a cream
 * theme comes down a little and still reads as itself, so the minimum move is
 * exactly right. Over it, fidelity is already gone: a near-black mark on a dark
 * theme is going to be grey whatever we do, and the only question left is
 * whether it is a murky grey sitting on the floor or a legible one. That case
 * gets placed at `CORRECTED_LC` instead of at the bare minimum.
 */
const FIDELITY_LIMIT = 0.15;

/** Halvings of the lightness interval. 2^-16 is far finer than 8-bit output. */
const SEARCH_STEPS = 16;

/**
 * Correlated samples across the 150ms crossfade, endpoints included.
 *
 * Contrast across the crossfade is smooth but not monotonic — foreground and
 * backdrop are both moving, and their channels need not move the same way — so
 * the minimum can sit between two samples. Nine points on each axis put that
 * gap in the third decimal of a ratio; `SAMPLING_GUARD` covers what is left,
 * which is why the floor is enforced with headroom rather than exactly.
 */
const CROSSFADE_SAMPLES = Array.from({ length: 9 }, (_, index) => index / 8);

/** Headroom over the floor, covering the gap between crossfade samples. */
const SAMPLING_GUARD = 0.02;

const CACHE_LIMIT = 512;

export interface BrandMarkInk {
  /** The brand colour one perceptual step back — what the mark wears at rest. */
  rest: string;
  /** The brand colour itself, corrected only as far as legibility demands. */
  active: string;
}

/**
 * Where a mark is actually painted. Supplied by `BrandSurface` (see
 * `src/components/icons/BrandSurface.tsx`), which is how a mark in a panel
 * title bar gets measured against the panel and one in a popover against the
 * popover, rather than every mark answering to whichever surface is hardest.
 */
export interface BrandMarkSurface {
  /** The surface token the container paints. */
  surface: AppThemeTokenKey;
  /**
   * A theme extension that replaces `surface` where the active theme defines
   * one — the `var(--panel-header-bg, ...)` half of the container's own
   * background declaration. Opaque values stand in for the surface outright; a
   * translucent one composites over it, exactly as the paint does.
   */
  extension?: ExtensionKey;
  /** Overlay composited over `surface` when `extension` supplies nothing — the fallback half. */
  lift?: AppThemeTokenKey;
}

/** One backdrop a mark can meet: at rest, and the same backdrop under the hover overlay. */
interface Backdrops {
  rest: string;
  active: string;
}

/**
 * Where a mark is placed, and everywhere it has to hold.
 *
 * The two are not the same when nobody declared a surface. Placement — which
 * way the fade travels, where the ceiling sits — needs one reference backdrop,
 * and the honest choice is the one that leaves the least room. Legibility is
 * not a matter of choice: it has to hold on every surface the mark could land
 * on, so the predicates answer to all of them.
 */
interface Placement {
  primary: Backdrops;
  all: Backdrops[];
}

/**
 * Every surface a brand mark can be painted on.
 *
 * `DISPLAY_SURFACES` is the theme audit's set and does not include the toolbar,
 * which is where the densest row of marks in the product actually lives.
 * Exported so the matrix test iterates the same list rather than a copy that
 * could drift.
 */
export const BRAND_MARK_SURFACES: AppThemeTokenKey[] = [...DISPLAY_SURFACES, "surface-toolbar"];

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

/** Composites an overlay token over a base, or returns the base unchanged. */
function lift(base: string, token: string | undefined): string {
  // An opaque overlay is not an overlay at all — it replaces what is under it,
  // and reading it as "no overlay" would measure a pixel that is covered.
  const opaque = opaqueHex(token);
  if (opaque) return opaque;
  const overlay = parseRgba(token ?? "");
  // A theme whose overlay is a `color-mix()` rather than an `rgba()` leaves the
  // composite unknowable here; measuring the base alone is the honest floor
  // rather than a guessed one.
  return overlay ? blendOverBackground(overlay.hex, base, overlay.opacity) : base;
}

/**
 * The backdrop a mark actually sits on, and what that becomes under hover.
 *
 * With no `BrandMarkSurface` supplied the placement is unknown, so the mark has
 * to answer to every surface at once — the way it did before provenance was
 * threaded at all. Placement geometry still needs a single reference, and takes
 * the hardest surface: the one whose luminance leaves a legible mark the least
 * room.
 */
function resolveBackdrops(
  scheme: AppColorScheme,
  surface?: BrandMarkSurface | null
): Placement | null {
  const withHover = (base: string): Backdrops => ({
    rest: base,
    active: lift(base, scheme.tokens["overlay-elevated"]),
  });

  // A named surface that cannot be read as an opaque colour (a translucent
  // token, a `color-mix()`) falls back to the same conservative answer as no
  // declaration at all, rather than leaving the mark unresolved.
  const declared = surface ? surfaceBase(scheme, surface) : null;
  if (declared) {
    const primary = withHover(declared);
    return { primary, all: [primary] };
  }

  const surfaces = BRAND_MARK_SURFACES.map((key) => opaqueHex(scheme.tokens[key])).filter(
    (hex): hex is string => hex !== null
  );
  if (surfaces.length === 0) return null;
  return { primary: withHover(hardestSurface(scheme, surfaces)), all: surfaces.map(withHover) };
}

/**
 * Reproduces the container's own background declaration in colour rather than
 * in CSS: the extension when the theme defines one, the token under the
 * fallback overlay when it does not. Several light themes repaint panel title
 * bars outright, so reading the bare surface token there would answer for a
 * pixel that is never painted.
 */
function surfaceBase(scheme: AppColorScheme, surface: BrandMarkSurface): string | null {
  const token = opaqueHex(scheme.tokens[surface.surface]);
  if (!token) return null;

  const extension = surface.extension ? scheme.extensions?.[surface.extension] : undefined;
  if (extension) return opaqueHex(extension) ?? lift(token, extension);
  return surface.lift ? lift(token, scheme.tokens[surface.lift]) : token;
}

/**
 * The surface that leaves a legible mark the least room.
 *
 * Ordered by relative luminance rather than by OKLCH lightness, because
 * luminance is what contrast is a ratio of. The two orderings disagree across
 * hues — a saturated blue can be lighter than a dark green and still carry less
 * luminance — and only the luminance ordering makes "hardest" provable rather
 * than usually true. This is a placement anchor, not a safety claim: safety
 * comes from every surface being checked, not from picking the right one.
 */
function hardestSurface(scheme: AppColorScheme, surfaces: string[]): string {
  const wantBrightest = scheme.type === "dark";
  return surfaces.reduce((worst, candidate) =>
    (
      wantBrightest
        ? relativeLuminance(candidate) > relativeLuminance(worst)
        : relativeLuminance(candidate) < relativeLuminance(worst)
    )
      ? candidate
      : worst
  );
}

/**
 * Whether the pair stays legible through the whole 150ms crossfade, on every
 * backdrop the mark can meet.
 *
 * Both ends passing is not the transition passing: the control repaints its
 * background in the same 150ms the glyph recolours, so foreground and backdrop
 * are both in flight, and the channels of the two inks can move in opposite
 * directions — which puts an extremum inside the interval — while a pair
 * straddling the backdrop passes at both ends and collapses to ~1:1 in the
 * middle.
 *
 * The two are sampled as a *grid* rather than in lockstep, because they are not
 * in lockstep: the glyph transitions on `ease-out` and the surfaces it sits on
 * variously on `ease`, so the frames actually painted trace some curve through
 * the square rather than its diagonal. Every monotone pair of easings stays
 * inside the grid, so checking the grid is checking all of them, and no single
 * pairing has to be assumed. `SAMPLING_GUARD` covers what falls between points.
 */
function staysLegible(rest: string, active: string, placement: Placement): boolean {
  for (const backdrops of placement.all) {
    for (const foreground of CROSSFADE_SAMPLES) {
      const ink = mixHex(rest, active, foreground);
      for (const background of CROSSFADE_SAMPLES) {
        const behind = mixHex(backdrops.rest, backdrops.active, background);
        if (contrastRatio(ink, behind) < CONTRAST_FLOOR + SAMPLING_GUARD) return false;
      }
    }
  }
  return true;
}

/** The weakest contrast this ink carries anywhere it can be painted. */
function worstContrast(hex: string, placement: Placement): number {
  return Math.min(
    ...placement.all.flatMap((backdrops) => [
      contrastRatio(hex, backdrops.rest),
      contrastRatio(hex, backdrops.active),
    ])
  );
}

/** The least perceived weight this ink carries anywhere it can be painted. */
function worstWeight(hex: string, placement: Placement): number {
  return Math.min(
    ...placement.all.flatMap((backdrops) => [
      apcaLc(hex, backdrops.rest),
      apcaLc(hex, backdrops.active),
    ])
  );
}

/**
 * The brand's hue and chroma held at a different lightness, re-fitted into sRGB
 * by reducing chroma until it fits rather than by clipping channels — clipping
 * shifts the hue, which is the one thing a correction has to preserve.
 */
function atLightness(hue: number | undefined, chroma: number, lightness: number): string | null {
  const fitted = clampChroma({ mode: "oklch", l: lightness, c: chroma, h: hue }, "oklch", "rgb");
  return opaqueHex(formatHex(fitted));
}

/**
 * The lightness closest to `desired` that still satisfies `ok`, given that
 * `safe` does.
 *
 * Bisection rather than stepping: gamut mapping and 8-bit quantization sit
 * between the lightness we pick and the value we measure, so there is no closed
 * form, and a fixed step either lands visibly coarse or wastes work. Every
 * candidate is measured on the *formatted* hex for that reason — the pre-clamp
 * OKLCH value is not what the screen paints.
 *
 * Those same two steps make `ok` very slightly non-monotonic near a rounding
 * boundary, which costs a hair of optimality and never the guarantee: `passing`
 * only ever holds a lightness whose formatted hex was measured and passed (it
 * starts at `safe`), and `atLightness` is deterministic, so the hex returned is
 * that same measured hex. Keep that invariant if you touch this loop.
 */
function approach(
  hue: number | undefined,
  chroma: number,
  safe: number,
  desired: number,
  ok: (hex: string) => boolean
): { hex: string; lightness: number } | null {
  const target = atLightness(hue, chroma, desired);
  if (target && ok(target)) return { hex: target, lightness: desired };

  const safeHex = atLightness(hue, chroma, safe);
  if (!safeHex || !ok(safeHex)) return null;

  let failing = desired;
  let passing = safe;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const midpoint = (failing + passing) / 2;
    const candidate = atLightness(hue, chroma, midpoint);
    if (candidate && ok(candidate)) {
      passing = midpoint;
    } else {
      failing = midpoint;
    }
  }
  const hex = atLightness(hue, chroma, passing);
  return hex ? { hex, lightness: passing } : null;
}

const cache = new Map<string, BrandMarkInk | null>();

/**
 * Resolves the two colours a brand mark wears: at rest the brand colour drawn
 * back toward the theme's own icon ink, and when the mark is active — hovered,
 * keyboard-focused, in a selected tab or in the focused panel — the brand
 * colour itself.
 *
 * The direction matters and it is not "fade into the background". A resting
 * mark moves *toward the ink*, so on a light theme it sits darker than the
 * brand and lightens into it, and on a dark theme it sits lighter and deepens
 * into it. Fading toward the backdrop instead is what makes a row of marks read
 * as washed out: it spends contrast to signal a state that the control's own
 * hover background is already signalling.
 *
 * Both states are placed by measuring against the backdrop the mark is actually
 * painted on, with WCAG 1.4.11's 3:1 as a hard floor underneath — checked on
 * every frame of the crossfade rather than only at its endpoints — and APCA Lc
 * deciding where a mark goes when its brand colour cannot be shown at all.
 *
 * Derives entirely from the brand hex, the theme's tokens and the constants
 * above: no per-agent table, no per-theme number. An arbitrary preset hex
 * arriving at runtime takes the same path a shipped agent does, which is what
 * makes adding a CLI cost one hex.
 */
export function resolveBrandMarkInk(
  brandColor: string | undefined,
  scheme: AppColorScheme,
  surface?: BrandMarkSurface | null
): BrandMarkInk | null {
  const brand = brandHex(brandColor);
  if (!brand) return null;

  const placement = resolveBackdrops(scheme, surface);
  if (!placement) return null;
  // The theme's own icon ink, as a ceiling on how loud a resting mark may get.
  const ink = opaqueHex(scheme.tokens["text-secondary"]);

  // Keyed on the resolved backdrops rather than the scheme id: a custom theme
  // can be edited in place and keep its id, and the same theme resolves
  // differently per surface.
  const key = [
    brand,
    ink ?? "",
    ...placement.all.flatMap((backdrops) => [backdrops.rest, backdrops.active]),
    placement.primary.rest,
  ].join("|");
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const resolved = computeInk(brand, placement, ink);
  if (cache.size >= CACHE_LIMIT) {
    // Oldest-first eviction. Preset colours are arbitrary hexes arriving at
    // runtime, so the key space is unbounded and the map needs a ceiling.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, resolved);
  return resolved;
}

function computeInk(
  brandHex: string,
  placement: Placement,
  inkHex: string | null
): BrandMarkInk | null {
  const brand = toOklch(brandHex);
  if (!brand) return null;

  // A brand with no chroma has nothing for a theme to carry. Drawn as a
  // silhouette in the theme's own icon ink it sits exactly level with the
  // neutral controls beside it, and its reveal becomes weight — the one axis it
  // still has — instead of a colour that never arrives.
  if ((brand.c ?? 0) < COLOURLESS_CHROMA && inkHex) {
    const silhouette = resolveColourless(inkHex, placement);
    if (silhouette) return silhouette;
  }

  const active = resolveActive(brandHex, brand.h, brand.c ?? 0, brand.l, placement);
  if (!active) return null;

  return { rest: resolveRest(active.hex, brand.h, placement, inkHex), active: active.hex };
}

/**
 * The theme's icon ink at rest, and the same ink one step further from the
 * backdrop when active.
 *
 * The direction is the reverse of a coloured mark's, and deliberately so. A
 * coloured mark rests brighter and *gains colour* on hover, which is a reveal
 * even though it loses a little weight. A colourless one has no colour to gain,
 * so weight is the only reveal available and it has to move the other way.
 * Moving away from the backdrop only adds contrast, so the ink's own contrast
 * guarantee carries both states.
 */
function resolveColourless(inkHex: string, placement: Placement): BrandMarkInk | null {
  const ink = toOklch(inkHex);
  const backdrop = toOklch(placement.primary.rest);
  if (!ink || !backdrop) return null;

  const away = (ink.l ?? 0) >= (backdrop.l ?? 0) ? 1 : -1;
  const active = atLightness(
    ink.h,
    ink.c ?? 0,
    Math.min(1, Math.max(0, ink.l + away * FADE_DELTA_E))
  );
  if (!active || !staysLegible(inkHex, active, placement)) return null;
  return { rest: inkHex, active };
}

/**
 * The brand colour, untouched wherever it is legible, and otherwise moved along
 * its own hue line — hue held, chroma reduced until it fits sRGB rather than
 * clipped channel-wise, since clipping shifts the hue.
 *
 * Both directions are tried and the shorter move wins: a near-black brand on a
 * dark theme has to come up, a near-white one on a light theme has to come
 * down, and which of those a given brand needs is a property of the pair, not
 * of the brand.
 */
function resolveActive(
  brandHex: string,
  hue: number | undefined,
  chroma: number,
  lightness: number,
  placement: Placement
): { hex: string; lightness: number } | null {
  // An active mark is painted on the resting backdrop too — a selected tab is
  // not a hovered one — so every backdrop has to hold, and the weakest of them
  // is the one that decides.
  const legible = (hex: string) =>
    worstContrast(hex, placement) >= CONTRAST_FLOOR + SAMPLING_GUARD &&
    worstWeight(hex, placement) >= ACTIVE_MIN_LC;

  if (legible(brandHex)) return { hex: brandHex, lightness };

  const minimal = [
    approach(hue, chroma, 0, lightness, legible),
    approach(hue, chroma, 1, lightness, legible),
  ]
    .filter((result): result is { hex: string; lightness: number } => result !== null)
    .sort((a, b) => Math.abs(a.lightness - lightness) - Math.abs(b.lightness - lightness))[0];
  if (!minimal) return null;

  if (Math.abs(minimal.lightness - lightness) <= FIDELITY_LIMIT) return minimal;

  // The minimum move was already large enough that this is not the brand colour
  // any more. Sitting on the floor buys nothing at that point — it just makes it
  // a murkier grey — so place it at a weight that reads. Direction is the one
  // the minimum move chose; it is the near side.
  const toward = minimal.lightness > lightness ? 1 : 0;
  const comfortable = approach(
    hue,
    chroma,
    toward,
    lightness,
    (hex) => legible(hex) && worstWeight(hex, placement) >= CORRECTED_LC
  );
  return comfortable ?? minimal;
}

/**
 * The active ink drawn `FADE_DELTA_E` back from the brand colour, away from the
 * backdrop, and never louder than the row it sits in.
 *
 * Away, not toward. Both directions read as "less brand colour", but only one
 * keeps the mark legible while it does: a mark pulled toward its backdrop gives
 * up contrast to signal a state the control's own hover background is already
 * signalling, and a row of them reads as washed out. Pulled the other way, a
 * resting mark on a light theme sits *darker* than the brand and lightens into
 * it, and on a dark theme sits *lighter* and deepens into it.
 *
 * Most of the step is lightness and a fixed slice is chroma, so the reveal is a
 * small bloom of colour as well as a shift in weight. The chroma slice is
 * deliberately small: taking the fade out of chroma is what flattens eighteen
 * marks into one grey wash, which is the failure this treatment exists to undo.
 *
 * The ceiling is what stops the step running away with an already-loud brand.
 * A near-white cyan on a dark theme starts above the theme's own icon ink;
 * another step away from the backdrop would leave a *resting* mark shouting
 * over every control beside it. Those come back down to the row's
 * weight instead, which inverts their direction — and that is the right trade,
 * because the state you look at all day is rest.
 */
function resolveRest(
  activeHex: string,
  hue: number | undefined,
  placement: Placement,
  inkHex: string | null
): string {
  const active = toOklch(activeHex);
  const backdrop = toOklch(placement.primary.rest);
  if (!active || !backdrop) return activeHex;

  const away = (active.l ?? 0) >= (backdrop.l ?? 0) ? 1 : -1;
  const brandChroma = active.c ?? 0;
  // Pythagoras on the OKLab plane: at a fixed hue the distance from the active
  // ink is `hypot(ΔL, ΔC)`, so the chroma slice decides what is left for
  // lightness rather than the two being set independently.
  const slice = brandChroma * REST_CHROMA_GIVE;
  let lightness = Math.min(
    1,
    Math.max(0, (active.l ?? 0) + away * Math.sqrt(Math.max(0, FADE_DELTA_E ** 2 - slice ** 2)))
  );

  // Whatever the ceiling takes off the lightness move comes back as chroma, so
  // the fade is the same size wherever it lands. A mark held down to the row's
  // weight fades by losing colour instead of by gaining brightness — which is
  // the only axis it has left, and still reads as the same mark one step back.
  //
  // Chroma and the ceiling depend on each other: a lower chroma changes the
  // weight a lightness carries, which changes where the ceiling bites, which
  // changes how much chroma is owed. Two passes settle it — the second measures
  // the chroma the first arrived at — and the loop below re-checks the result
  // either way, so this converges rather than merely approximating.
  const ceiling = inkHex
    ? apcaLc(inkHex, placement.primary.rest) + REST_CEILING_LC_MARGIN
    : Infinity;
  const spend = (from: number) =>
    Math.min(
      brandChroma,
      Math.max(slice, Math.sqrt(Math.max(0, FADE_DELTA_E ** 2 - ((active.l ?? 0) - from) ** 2)))
    );

  let chroma = brandChroma - spend(lightness);
  for (let pass = 0; pass < 2 && Number.isFinite(ceiling); pass++) {
    const candidate = atLightness(hue, chroma, lightness);
    if (!candidate || apcaLc(candidate, placement.primary.rest) <= ceiling) break;
    lightness = atWeight(hue, chroma, ceiling, backdrop.l ?? 0, lightness, placement.primary.rest);
    chroma = brandChroma - spend(lightness);
  }

  const at = (ratio: number): string | null =>
    atLightness(
      hue,
      (active.c ?? 0) + (chroma - (active.c ?? 0)) * ratio,
      (active.l ?? 0) + (lightness - (active.l ?? 0)) * ratio
    );

  const ok = (hex: string) => staysLegible(hex, activeHex, placement);
  const target = at(1);
  if (target && ok(target)) return target;

  // Bisect back toward the active ink, which is legible by construction. Every
  // candidate is measured on the formatted hex, since gamut mapping and 8-bit
  // rounding both sit between the ratio picked and the contrast measured, and
  // only a hex that was measured and passed is ever returned — falling all the
  // way back to the active ink rather than to a ratio nothing verified.
  let failing = 1;
  let passing: string | null = null;
  let floor = 0;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const midpoint = (failing + floor) / 2;
    const candidate = at(midpoint);
    if (candidate && ok(candidate)) {
      passing = candidate;
      floor = midpoint;
    } else {
      failing = midpoint;
    }
  }
  return passing ?? activeHex;
}

/**
 * The lightness at which this hue carries `targetLc` against `backdrop`,
 * searched between the backdrop's own lightness (where weight is nil) and a
 * lightness known to exceed the target.
 *
 * Bisection for the same reason every other search here uses it: gamut mapping
 * and 8-bit rounding sit between the lightness picked and the weight measured,
 * so the relationship has no closed form.
 */
function atWeight(
  hue: number | undefined,
  chroma: number,
  targetLc: number,
  backdropLightness: number,
  overLightness: number,
  backdrop: string
): number {
  let under = backdropLightness;
  let over = overLightness;
  for (let step = 0; step < SEARCH_STEPS; step++) {
    const midpoint = (under + over) / 2;
    const candidate = atLightness(hue, chroma, midpoint);
    if (candidate && apcaLc(candidate, backdrop) > targetLc) {
      over = midpoint;
    } else {
      under = midpoint;
    }
  }
  return over;
}
