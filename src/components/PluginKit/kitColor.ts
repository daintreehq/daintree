// The colour text a kit ColorPicker reads and writes. Values are lowercase
// `#rrggbb`; the hex field also takes `#rgb`, `rgb()` and `hsl()`, since a
// colour is as often copied from a stylesheet as from a design tool.

/** `#rgb` or `#rrggbb`, with or without the `#`, as lowercase `#rrggbb`; null for anything else. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return `#${[...hex].map((digit) => digit + digit).join("")}`.toLowerCase();
  }
  return null;
}

function channelHex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;
}

/** Hue in degrees, saturation and lightness in percent. */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  if (sat === 0) return rgbToHex(light * 255, light * 255, light * 255);
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return rgbToHex(channel(hue + 1 / 3) * 255, channel(hue) * 255, channel(hue - 1 / 3) * 255);
}

/** A hex colour as whole-number HSL: `{ h: 0–359, s: 0–100, l: 0–100 }`. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const normal = normalizeHex(hex);
  if (normal === null) return null;
  const r = parseInt(normal.slice(1, 3), 16) / 255;
  const g = parseInt(normal.slice(3, 5), 16) / 255;
  const b = parseInt(normal.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: Math.round(h * 60) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

const NUMBER = String.raw`([+-]?\d*\.?\d+)`;
const RGB_TEXT = new RegExp(
  String.raw`^rgba?\(\s*${NUMBER}\s*[,\s]\s*${NUMBER}\s*[,\s]\s*${NUMBER}\s*(?:[,/]\s*[\d.]+%?\s*)?\)$`,
  "i"
);
const HSL_TEXT = new RegExp(
  String.raw`^hsla?\(\s*${NUMBER}(?:deg)?\s*[,\s]\s*${NUMBER}%?\s*[,\s]\s*${NUMBER}%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)$`,
  "i"
);

/**
 * Typed colour text as lowercase `#rrggbb`: hex with or without the `#`,
 * `rgb(r, g, b)` or `hsl(h, s%, l%)`, commas or spaces, any alpha dropped.
 * Null for anything else.
 */
export function parseColorText(text: string): string | null {
  const trimmed = text.trim();
  const hex = normalizeHex(trimmed);
  if (hex !== null) return hex;
  const rgb = RGB_TEXT.exec(trimmed);
  if (rgb) {
    const channels = [rgb[1], rgb[2], rgb[3]].map(Number);
    if (channels.some((c) => !Number.isFinite(c) || c < 0 || c > 255)) return null;
    return rgbToHex(channels[0]!, channels[1]!, channels[2]!);
  }
  const hsl = HSL_TEXT.exec(trimmed);
  if (hsl) {
    const [h, s, l] = [hsl[1], hsl[2], hsl[3]].map(Number);
    if (![h, s, l].every(Number.isFinite) || s! > 100 || l! > 100 || s! < 0 || l! < 0) return null;
    return hslToHex(h!, s!, l!);
  }
  return null;
}

/** The theme's categorical ramp, in the order the default palette lists it. */
export const CATEGORY_SWATCH_KEYS = [
  "category-blue",
  "category-purple",
  "category-cyan",
  "category-green",
  "category-amber",
  "category-orange",
  "category-teal",
  "category-indigo",
  "category-rose",
  "category-pink",
  "category-violet",
  "category-slate",
] as const;

export type CategorySwatchKey = (typeof CATEGORY_SWATCH_KEYS)[number];

/** "category-amber" → "Amber", the swatch's spoken name. */
export function categorySwatchName(key: CategorySwatchKey): string {
  const word = key.slice("category-".length);
  return word.charAt(0).toUpperCase() + word.slice(1);
}
