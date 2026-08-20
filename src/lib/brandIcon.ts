import { isHexColor } from "@shared/theme";

/** Painted behind an alpha brand color so the tile is always opaque. */
const ALPHA_BACKPLATE = "#FFFFFF";

/** Alpha of the hairline ring that delimits the tile, as a 0-1 fraction. */
const RING_ALPHA = 0.15;

/**
 * Luminance at which black and white ink contrast equally. Solving
 * `(1.05)/(L+0.05) = (L+0.05)/0.05` gives `sqrt(1.05 * 0.05) - 0.05`; the exact
 * expression rather than a rounded literal because a 4-decimal approximation
 * picks the weaker ink for the ~40 colors sitting on the crossover.
 */
const INK_CROSSOVER = Math.sqrt(1.05 * 0.05) - 0.05;

export interface BrandBadge {
  /** The brand color as painted — never darkened, damped or re-hued. */
  tile: string;
  /** Black or white, whichever reads better on `tile`. Carries the silhouette. */
  glyph: string;
  /** `glyph` at low alpha, so an achromatic tile still has an edge. */
  ring: string;
}

function expand(hex: string): string {
  const body = hex.slice(1);
  return body.length === 3 || body.length === 4
    ? body
        .split("")
        .map((c) => c + c)
        .join("")
    : body;
}

function channels(body: string): [number, number, number] {
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * WCAG 2.x relative luminance. Duplicated from `@shared/theme` rather than
 * imported because this module already normalizes the hex to opaque channels;
 * the shared helper re-parses and reads an alpha hex as opaque.
 */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Flattens `#RGBA`/`#RRGGBBAA` onto the backplate. A translucent tile would let
 * the caller's surface through, which is the surface dependence this whole
 * module exists to remove — so alpha is resolved here, once, against a fixed
 * plate rather than against whatever chrome the mark happens to land on.
 */
function opaqueChannels(body: string): [number, number, number] {
  const [r, g, b] = channels(body);
  if (body.length !== 8) return [r, g, b];
  const alpha = parseInt(body.slice(6, 8), 16) / 255;
  const [pr, pg, pb] = channels(expand(ALPHA_BACKPLATE));
  const over = (c: number, plate: number) => c * alpha + plate * (1 - alpha);
  return [over(r, pr), over(g, pg), over(b, pb)];
}

/**
 * Splits the two jobs the brand color used to do at once (#11895). The glyph is
 * knocked out of a tile painted in the brand color, so its contrast pair is the
 * tile — a fixed, local pair that no theme surface participates in. Legibility
 * therefore holds on the grid, sidebar, toolbar, panel and elevated planes
 * alike, and the color itself is never modified to buy that legibility.
 *
 * Black-or-white ink guarantees at least ~4.58:1 for any opaque color; the
 * binding case across the shipped roster is copilot `#8957e5` at 4.61:1, which
 * `brandBadgeRegistry.test.ts` holds to the 4.5 floor.
 *
 * Returns null when there is no usable color, which leaves the caller rendering
 * a plain `currentColor` glyph — already contrast-safe by inheritance.
 */
export function resolveBrandBadge(brandColor: string | undefined): BrandBadge | null {
  if (!brandColor || !isHexColor(brandColor)) {
    return null;
  }
  const body = expand(brandColor.trim());
  if (body.length !== 6 && body.length !== 8) {
    return null;
  }
  const rgb = opaqueChannels(body);
  const tile = body.length === 8 ? toHex(rgb) : brandColor;
  const glyphIsWhite = luminance(rgb) <= INK_CROSSOVER;
  return {
    tile,
    glyph: glyphIsWhite ? "#FFFFFF" : "#000000",
    ring: glyphIsWhite ? `rgba(255, 255, 255, ${RING_ALPHA})` : `rgba(0, 0, 0, ${RING_ALPHA})`,
  };
}
