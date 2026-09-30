// The colour maths behind the kit's `ColoredLabel`: a label colour the user
// picked (anything from #ffffff to #000000) drawn as a Badge-style tint whose
// text still reads at 4.5:1 in the active theme. Self-contained so the kit
// chunk does not take the theme validator with it.

type Rgb = readonly [number, number, number];

const rgbOf = (channel: (index: number) => number): Rgb => [channel(0), channel(1), channel(2)];

export interface LabelColors {
  /** The tint, translucent so it composites on whatever surface the label sits on. */
  background: string;
  /** The text colour: the label's hue, moved in lightness until it reads. */
  color: string;
  /** A hairline edge in the text colour, so a pale label keeps its shape. */
  border: string;
}

/** WCAG AA for text under 18px. */
const TEXT_CONTRAST = 4.5;
// A hair over the floor, so rounding in the browser's own compositing of the
// translucent tint never lands a label just under it.
const TEXT_CONTRAST_TARGET = TEXT_CONTRAST + 0.05;
const TINT_ALPHA = { light: 0.14, dark: 0.2 } as const;
const BORDER_ALPHA = { light: 0.35, dark: 0.4 } as const;
const FALLBACK_SURFACE: Record<"light" | "dark", Rgb> = {
  light: [255, 255, 255],
  dark: [24, 24, 27],
};

/** `#rgb` or `#rrggbb`, with or without the `#`. */
export function parseLabelHex(value: unknown): Rgb | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return rgbOf((index) => parseInt(full.slice(index * 2, index * 2 + 2), 16));
}

/**
 * A resolved theme token: `#rrggbb` or `rgba(r, g, b, a)`. A translucent one is
 * composited over `backing`, the theme's own polarity, since that is what it
 * paints over.
 */
function parseToken(value: string | undefined, backing: Rgb): Rgb | null {
  if (!value) return null;
  const hex = parseLabelHex(value);
  if (hex) return hex;
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i.exec(
    value.trim()
  );
  if (!match) return null;
  const rgb: Rgb = [Number(match[1]), Number(match[2]), Number(match[3])];
  const alpha = match[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(match[4])));
  return alpha >= 1 ? rgb : blend(rgb, backing, alpha);
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return c * 255;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blend(top: Rgb, under: Rgb, alpha: number): Rgb {
  return rgbOf((index) => top[index]! * alpha + under[index]! * (1 - alpha));
}

// OKLab (Björn Ottosson), so a lightness step keeps the hue a person picked.
function toOklab([r, g, b]: Rgb): [number, number, number] {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB for an OKLab colour; out-of-gamut channels fall outside 0–1. */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (channels: number[]) => channels.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** The colour at lightness `L`, with as much of the hue's chroma as sRGB can show there. */
function atLightness(L: number, a: number, b: number): Rgb {
  let lo = 0;
  let hi = 1;
  if (!inGamut(oklabToLinear(L, a, b))) {
    for (let step = 0; step < 16; step++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, a * mid, b * mid))) lo = mid;
      else hi = mid;
    }
  } else {
    lo = 1;
  }
  const linear = oklabToLinear(L, a * lo, b * lo);
  return rgbOf((index) => Math.min(255, Math.max(0, fromLinear(linear[index]!))));
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

function rgba(rgb: Rgb, alpha: number): string {
  return `rgba(${rgb.map((c) => Math.round(c)).join(", ")}, ${alpha})`;
}

/**
 * The text colour: the label colour itself when it already reads on `under`,
 * otherwise the nearest lightness (darker on a light theme, lighter on a dark
 * one) that does, found by bisection since contrast only grows along the way.
 */
function readableText(color: Rgb, unders: readonly Rgb[], mode: "light" | "dark"): Rgb {
  // The worst of the backgrounds the label can sit on decides.
  const reads = (text: Rgb) =>
    unders.every((under) => contrast(text, under) >= TEXT_CONTRAST_TARGET);
  if (reads(color)) return color;
  const [L, a, b] = toOklab(color);
  const end = mode === "light" ? 0 : 1;
  const farthest = atLightness(end, a, b);
  if (!reads(farthest)) return farthest;
  let near = L;
  let far = end;
  for (let step = 0; step < 24; step++) {
    const mid = (near + far) / 2;
    if (reads(atLightness(mid, a, b))) far = mid;
    else near = mid;
  }
  return atLightness(far, a, b);
}

/**
 * The surfaces a label is measured against: the first token is the pane, and
 * each further one (a raised panel, a hovered row) composites over it when
 * translucent. Unreadable tokens are skipped; with none, the polarity's default.
 */
function resolveSurfaces(
  tokens: string | undefined | readonly (string | undefined)[],
  mode: "light" | "dark"
): Rgb[] {
  const list = typeof tokens === "string" || tokens === undefined ? [tokens] : tokens;
  const base = parseToken(list[0], FALLBACK_SURFACE[mode]) ?? FALLBACK_SURFACE[mode];
  const out = [base];
  for (const token of list.slice(1)) {
    const surface = parseToken(token, base);
    if (surface) out.push(surface);
  }
  return out;
}

/**
 * The tint, text and edge for a label colour in the active theme. `surfaces`
 * are resolved theme tokens, the pane's `surface-panel` first; the text reads
 * on the tint over every one of them. Null for a `color` that is not hex.
 */
export function labelColors(
  color: unknown,
  surfaces: string | undefined | readonly (string | undefined)[],
  mode: "light" | "dark"
): LabelColors | null {
  const rgb = parseLabelHex(color);
  if (!rgb) return null;
  const tints = resolveSurfaces(surfaces, mode).map((surface) =>
    blend(rgb, surface, TINT_ALPHA[mode])
  );
  const text = readableText(rgb, tints, mode);
  return {
    background: rgba(rgb, TINT_ALPHA[mode]),
    color: hex(text),
    border: rgba(text, BORDER_ALPHA[mode]),
  };
}

/**
 * For tests: the lowest contrast the label's text reaches on its tint over
 * any of `surfaces`.
 */
export function labelTextContrast(
  color: string,
  surfaces: string | readonly string[],
  mode: "light" | "dark"
): number {
  const colors = labelColors(color, surfaces, mode);
  const rgb = parseLabelHex(color);
  const text = colors ? parseLabelHex(colors.color) : null;
  if (!rgb || !text) return 0;
  return Math.min(
    ...resolveSurfaces(surfaces, mode).map((surface) =>
      contrast(text, blend(rgb, surface, TINT_ALPHA[mode]))
    )
  );
}
