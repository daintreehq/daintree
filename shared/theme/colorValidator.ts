import { APP_THEME_TOKEN_KEYS, type AppThemeTokenKey } from "./types.js";

const APP_THEME_TOKEN_KEY_SET: ReadonlySet<string> = new Set<string>(APP_THEME_TOKEN_KEYS);

/**
 * Token keys whose values are NOT CSS colors. These are either numeric/dimension
 * values (opacity, blur, length, scale), multi-value shadow strings, or special
 * formats (the `accent-rgb` triplet, the `chrome-noise-texture` gradient/keyword).
 *
 * Tokens not in this set are validated as CSS colors by `isValidCssColor`.
 * `accent-rgb` uses its own dedicated validator (`isValidAccentRgbTriplet`).
 */
export const NON_COLOR_TOKEN_KEYS: ReadonlySet<AppThemeTokenKey> = new Set<AppThemeTokenKey>([
  "material-blur",
  "material-saturation",
  "material-opacity",
  "radius-scale",
  "scrollbar-width",
  "panel-state-edge-width",
  "panel-state-edge-inset-block",
  "panel-state-edge-radius",
  "focus-ring-offset",
  "chrome-noise-texture",
  "shadow-ambient",
  "shadow-floating",
  "shadow-dialog",
  "accent-rgb",
  "state-chip-bg-opacity",
  "state-chip-border-opacity",
  "label-pill-bg-opacity",
  "label-pill-border-opacity",
]);

/** CSS Color Level 4 named colors (147) plus `transparent` and `currentcolor`. */
const CSS_NAMED_COLORS: ReadonlySet<string> = new Set<string>([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
  "transparent",
  "currentcolor",
]);

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// Matches an rgb()/rgba() call in either legacy (comma) or modern (space +
// optional slash alpha) form. Inner numbers can be integers, decimals, or
// percentages. Mixing comma and space separators is rejected.
const RGB_RE =
  /^rgba?\(\s*(?:-?\d*\.?\d+%?\s*,\s*-?\d*\.?\d+%?\s*,\s*-?\d*\.?\d+%?(?:\s*,\s*-?\d*\.?\d+%?)?|-?\d*\.?\d+%?\s+-?\d*\.?\d+%?\s+-?\d*\.?\d+%?(?:\s*\/\s*-?\d*\.?\d+%?)?)\s*\)$/i;

// Matches an hsl()/hsla() call. Hue may carry a unit (deg/rad/turn/grad).
const HSL_RE =
  /^hsla?\(\s*(?:-?\d*\.?\d+(?:deg|rad|turn|grad)?\s*,\s*-?\d*\.?\d+%\s*,\s*-?\d*\.?\d+%(?:\s*,\s*-?\d*\.?\d+%?)?|-?\d*\.?\d+(?:deg|rad|turn|grad)?\s+-?\d*\.?\d+%\s+-?\d*\.?\d+%(?:\s*\/\s*-?\d*\.?\d+%?)?)\s*\)$/i;

// Matches oklch()/oklab() — modern slash-alpha or legacy comma form.
const OKLCH_OKLAB_RE =
  /^okl(?:ch|ab)\(\s*(?:-?\d*\.?\d+%?\s+-?\d*\.?\d+%?\s+-?\d*\.?\d+(?:deg|rad|turn|grad)?%?(?:\s*\/\s*-?\d*\.?\d+%?)?|-?\d*\.?\d+%?\s*,\s*-?\d*\.?\d+%?\s*,\s*-?\d*\.?\d+(?:deg|rad|turn|grad)?%?(?:\s*,\s*-?\d*\.?\d+%?)?)\s*\)$/i;

const COLOR_MIX_INTERPOLATION_RE =
  /^in\s+[a-z-]+(?:\s+(?:longer|shorter|increasing|decreasing)\s+hue)?$/i;
const VAR_NAME_RE = /^--[a-zA-Z_][\w-]*$/;
const COLOR_COMPONENT_PERCENT_RE = /\s+-?\d*\.?\d+%$/;
const NAMED_COLOR_RE = /^[a-z]+$/i;

function hasBalancedParens(value: string): boolean {
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Split `inner` on top-level commas (ignoring commas inside nested parens). */
function splitTopLevelArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

function isValidColorMix(value: string): boolean {
  if (!value.endsWith(")")) return false;
  if (!hasBalancedParens(value)) return false;
  const inner = value.slice("color-mix(".length, -1).trim();
  const parts = splitTopLevelArgs(inner).map((part) => part.trim());
  if (parts.length !== 3) return false;
  if (!COLOR_MIX_INTERPOLATION_RE.test(parts[0]!)) return false;
  for (const part of parts.slice(1)) {
    if (!part) return false;
    const withoutPercent = part.replace(COLOR_COMPONENT_PERCENT_RE, "").trim();
    if (!withoutPercent) return false;
    if (!isValidCssColor(withoutPercent)) return false;
  }
  return true;
}

function isValidVarExpression(value: string): boolean {
  if (!value.endsWith(")")) return false;
  if (!hasBalancedParens(value)) return false;
  const inner = value.slice("var(".length, -1).trim();
  const parts = splitTopLevelArgs(inner).map((part) => part.trim());
  if (parts.length === 0 || parts.length > 2) return false;
  if (!VAR_NAME_RE.test(parts[0]!)) return false;
  if (parts.length === 2) {
    const fallback = parts[1];
    if (!fallback) return false;
    if (!isValidCssColor(fallback)) return false;
  }
  return true;
}

/**
 * Returns true if `value` is structurally a valid CSS color string. Accepts
 * hex (3/4/6/8 digits), `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`/`oklab()`,
 * `color-mix(in <space>, ...)`, `var(--...)` (with optional color fallback),
 * and the CSS named colors (including `transparent` and `currentcolor`).
 *
 * Structural validation, not full CSS parsing: `color-mix()` and `var()`
 * arguments are recursively validated one level deep; deeper nesting is not
 * expected in theme files. The goal is to block obvious garbage like
 * `"not-a-color"` at the import boundary without rejecting legal CSS.
 */
export function isValidCssColor(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (HEX_RE.test(trimmed)) return true;

  if (trimmed.startsWith("#")) return false;

  if (/^rgba?\(/i.test(trimmed)) return RGB_RE.test(trimmed);
  if (/^hsla?\(/i.test(trimmed)) return HSL_RE.test(trimmed);
  if (/^okl(?:ch|ab)\(/i.test(trimmed)) return OKLCH_OKLAB_RE.test(trimmed);

  if (/^color-mix\(/i.test(trimmed)) return isValidColorMix(trimmed);
  if (/^var\(/i.test(trimmed)) return isValidVarExpression(trimmed);

  // Bare identifier → named color table lookup.
  if (NAMED_COLOR_RE.test(trimmed)) {
    return CSS_NAMED_COLORS.has(trimmed.toLowerCase());
  }

  return false;
}

/**
 * Validates the `accent-rgb` token, which carries a comma-space RGB triplet
 * like `"62, 144, 102"` (the format produced by `hexToRgbTriplet`). Each
 * component must be an integer in 0–255.
 */
export function isValidAccentRgbTriplet(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = /^\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*$/.exec(value);
  if (!match) return false;
  for (let i = 1; i <= 3; i++) {
    const component = Number(match[i]);
    if (!Number.isFinite(component) || component < 0 || component > 255) return false;
  }
  return true;
}

const DATA_IMAGE_URL_RE = /^data:image\/[a-z0-9.+-]+[;,]/i;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Validates `heroImage` values on theme import. Allowlist semantics: only a
 * `data:image/...` URL or a path (relative, root-relative, or dot-relative)
 * is accepted. Everything with a URL scheme is rejected, including `http:`,
 * `https:`, `file:`, `javascript:`, `ftp:`, and non-image `data:` payloads.
 * Protocol-relative URLs (`//cdn…`), Windows absolute (`C:\...`), and UNC
 * (`\\server\share`) are rejected.
 */
export function isValidThemeHeroImage(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (DATA_IMAGE_URL_RE.test(trimmed)) return true;
  if (URL_SCHEME_RE.test(trimmed)) return false;
  if (trimmed.startsWith("//")) return false;
  if (trimmed.startsWith("\\\\")) return false;
  return true;
}

/**
 * Leaf color keys inside `ThemePalette`. When a theme is imported in palette
 * format, each of these paths must carry a valid CSS color string.
 * `accentSecondary`, `overlayTint`, `terminal`, and `strategy` are optional
 * top-level keys; we only validate them when present.
 */
const PALETTE_COLOR_FIELDS = {
  surfaces: ["grid", "sidebar", "canvas", "panel", "elevated"] as const,
  text: ["primary", "secondary", "muted", "inverse"] as const,
  status: ["success", "warning", "danger", "info"] as const,
  activity: ["active", "idle", "working", "waiting"] as const,
  terminal: [
    "background",
    "foreground",
    "muted",
    "cursor",
    "selection",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ] as const,
  syntax: [
    "comment",
    "punctuation",
    "number",
    "string",
    "operator",
    "keyword",
    "function",
    "link",
    "quote",
    "chip",
  ] as const,
} as const;

const PALETTE_TOP_LEVEL_COLORS = ["border", "accent", "accentSecondary", "overlayTint"] as const;

function collectPaletteColorErrors(palette: unknown): string[] {
  const errors: string[] = [];
  if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
    return ["Invalid palette: expected an object."];
  }
  const record = palette as Record<string, unknown>;
  const invalid: string[] = [];

  for (const key of PALETTE_TOP_LEVEL_COLORS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !isValidCssColor(value)) {
      invalid.push(`palette.${key}`);
    }
  }

  for (const [groupKey, leafKeys] of Object.entries(PALETTE_COLOR_FIELDS) as [
    keyof typeof PALETTE_COLOR_FIELDS,
    readonly string[],
  ][]) {
    const group = record[groupKey];
    if (group === undefined) continue;
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      invalid.push(`palette.${groupKey}`);
      continue;
    }
    const groupRecord = group as Record<string, unknown>;
    for (const leafKey of leafKeys) {
      const value = groupRecord[leafKey];
      if (value === undefined) continue;
      if (typeof value !== "string" || !isValidCssColor(value)) {
        invalid.push(`palette.${groupKey}.${leafKey}`);
      }
    }
  }

  if (invalid.length > 0) {
    invalid.sort();
    errors.push(
      `Invalid color values for palette field(s): ${invalid.join(", ")}. ` +
        `Values must be valid CSS colors (hex, rgb/rgba, hsl/hsla, oklch/oklab, color-mix, var, or named color).`
    );
  }

  return errors;
}

export interface ImportedThemeDataForValidation {
  tokens?: Record<string, unknown> | null;
  palette?: unknown;
  heroImage?: unknown;
}

export type ValidateImportedThemeDataResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validates user-supplied theme data at the import boundary. Iterates the
 * `tokens` map and checks each recognized key against the appropriate
 * validator (color / `accent-rgb` triplet / non-color pass-through), walks
 * the nested `palette` color leaves when provided, then validates `heroImage`
 * if present. Unknown token keys are ignored here — the importer emits a
 * separate "Ignored unknown tokens" warning for those.
 *
 * Returns all failures together so users see every problem in one pass.
 */
export function validateImportedThemeData(
  data: ImportedThemeDataForValidation
): ValidateImportedThemeDataResult {
  const errors: string[] = [];
  const invalidColorTokens: string[] = [];

  if (data.tokens !== undefined && data.tokens !== null) {
    if (typeof data.tokens !== "object" || Array.isArray(data.tokens)) {
      errors.push("Invalid tokens: expected an object of token name → value pairs.");
    } else {
      for (const [key, value] of Object.entries(data.tokens)) {
        if (!APP_THEME_TOKEN_KEY_SET.has(key)) continue;
        if (typeof value !== "string") {
          invalidColorTokens.push(key);
          continue;
        }

        const tokenKey = key as AppThemeTokenKey;
        if (tokenKey === "accent-rgb") {
          if (!isValidAccentRgbTriplet(value)) invalidColorTokens.push(key);
          continue;
        }
        if (NON_COLOR_TOKEN_KEYS.has(tokenKey)) {
          if (!value.trim()) invalidColorTokens.push(key);
          continue;
        }
        if (!isValidCssColor(value)) invalidColorTokens.push(key);
      }
    }
  }

  if (invalidColorTokens.length > 0) {
    invalidColorTokens.sort();
    errors.push(
      `Invalid color values for token(s): ${invalidColorTokens.join(", ")}. ` +
        `Values must be valid CSS colors (hex, rgb/rgba, hsl/hsla, oklch/oklab, color-mix, var, or named color).`
    );
  }

  if (data.palette !== undefined && data.palette !== null) {
    errors.push(...collectPaletteColorErrors(data.palette));
  }

  if (data.heroImage !== undefined && data.heroImage !== null) {
    if (typeof data.heroImage !== "string" || !isValidThemeHeroImage(data.heroImage)) {
      errors.push(
        `Invalid heroImage value. heroImage must be a relative path or a data:image/ URL — remote URLs, non-image data URLs, and absolute OS paths are not allowed.`
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
