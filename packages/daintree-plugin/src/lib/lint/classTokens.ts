/**
 * Tailwind token helpers, ported from the host's
 * `scripts/eslint-rules/component-contract/classStrings.js` so the CLI splits a
 * class exactly where Tailwind (and the host's own lint) splits it.
 */

function topLevelIndexes(token: string, delimiter: string): number[] {
  const indexes: number[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === delimiter && depth === 0) indexes.push(i);
  }
  return indexes;
}

export interface SplitToken {
  variants: string[];
  /** The utility with variants and `!important` stripped. */
  base: string;
}

export function splitToken(token: string): SplitToken {
  const colons = topLevelIndexes(token, ":");
  const segments: string[] = [];
  let start = 0;
  for (const index of colons) {
    segments.push(token.slice(start, index));
    start = index + 1;
  }
  const base = token.slice(start).replace(/^!/, "").replace(/!$/, "");
  return { variants: segments.filter(Boolean), base };
}

/** Split a trailing top-level `/modifier` off a utility value. */
export function splitModifier(value: string): { value: string; modifier: string | null } {
  const slashes = topLevelIndexes(value, "/");
  if (slashes.length === 0) return { value, modifier: null };
  const last = slashes[slashes.length - 1]!;
  return { value: value.slice(0, last), modifier: value.slice(last + 1) };
}

const STOCK_HUES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|taupe|mauve|mist|olive";

const COLOUR_UTILITIES =
  "bg|text|border(?:-[xytrblse])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow|inset-shadow|inset-ring|drop-shadow|text-shadow";

/**
 * A utility naming Tailwind's stock palette. The design contract sets
 * `--color-*: initial`, which deletes every stock colour — `white` and `black`
 * included — so these generate no CSS at all for a plugin.
 */
export const STOCK_COLOUR = new RegExp(
  `^-?(?:${COLOUR_UTILITIES})-(?:(?:${STOCK_HUES})-(?:50|[1-9]00|950)|white|black)$`
);

const UNIT =
  "px|rem|em|pt|pc|in|cm|mm|Q|ex|ch|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb|cqmin|cqmax|%";
const LENGTH = new RegExp(`^-?(?:\\d*\\.)?\\d+(?:${UNIT})$`);
const MATH = /^(?:calc|min|max|clamp)\(/;
const NAMED_STEP = /^(?:[2-9]?xs|sm|base|lg|[2-9]?xl)$/;

function arbitraryBody(value: string): string | null {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  if (value.startsWith("(") && value.endsWith(")")) return value.slice(1, -1);
  return null;
}

/** Whether a `text-*` value is a font size rather than a colour. Mirrors `fontSize.js`. */
export function isFontSizeValue(value: string): boolean {
  const body = arbitraryBody(value);
  if (body === null) return NAMED_STEP.test(value);
  if (body.startsWith("length:")) return true;
  if (body.startsWith("color:")) return false;
  const normalized = body.replaceAll("_", " ").trim();
  return LENGTH.test(normalized) || MATH.test(normalized);
}

export function isArbitraryTextSize(base: string): boolean {
  if (!base.startsWith("text-")) return false;
  const { value } = splitModifier(base.slice(5));
  return arbitraryBody(value) !== null && isFontSizeValue(value);
}

export function isTextColourSlashAlpha(base: string): boolean {
  if (!base.startsWith("text-") || base.startsWith("text-shadow")) return false;
  const { value, modifier } = splitModifier(base.slice(5));
  return modifier !== null && !isFontSizeValue(value);
}

export const LEGACY_DAINTREE = new Map([
  ["daintree-text", "text-primary"],
  ["daintree-bg", "surface-canvas"],
  ["daintree-sidebar", "surface-sidebar"],
  ["daintree-border", "border-default"],
  ["daintree-accent", "accent-primary"],
  ["daintree-accent-rgb", "accent-rgb"],
  ["daintree-focus", "focus-ring"],
]);

/** `text-daintree-text` → `{ prefix: "text", alias: "daintree-text" }`. */
export function legacyAlias(base: string): { prefix: string; alias: string } | null {
  const { value } = splitModifier(base);
  const match = /^([a-z]+(?:-[a-z]+)*?)-(daintree-[a-z0-9-]+)$/.exec(value);
  return match ? { prefix: match[1]!, alias: match[2]! } : null;
}

export const STOCK_SHADOW = /^(?:inset-)?shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner))?$/;

/** An arbitrary box shadow that reads no custom property hardcodes its colour. */
export function isRawArbitraryShadow(base: string): boolean {
  if (!base.startsWith("shadow-[") && !base.startsWith("shadow-(")) return false;
  return !/var\(|^shadow-\(--/.test(base);
}

const RADIUS_SIDES = new Set([
  "t",
  "r",
  "b",
  "l",
  "s",
  "e",
  "tl",
  "tr",
  "br",
  "bl",
  "ss",
  "se",
  "es",
  "ee",
]);

/** Bare `rounded` (which renders the theme's `lg`) or a hardcoded arbitrary radius. */
export function isRawRadius(base: string): boolean {
  if (base !== "rounded" && !base.startsWith("rounded-")) return false;
  let rest = base === "rounded" ? "" : base.slice(8);
  const dash = rest.indexOf("-");
  const side = dash < 0 ? rest : rest.slice(0, dash);
  if (RADIUS_SIDES.has(side)) rest = dash < 0 ? "" : rest.slice(dash + 1);
  if (rest === "") return true;
  const body = arbitraryBody(rest);
  if (body === null) return false;
  return !/var\(|^--|^length:--/.test(body);
}

export const OUTLINE_SUPPRESSORS = new Set(["outline-none", "outline-hidden", "outline-0"]);

/** A variant owned by the element's own focus, carrying a visible treatment. */
export function isFocusTreatment(variants: string[], base: string): boolean {
  const ownFocus = variants.some(
    (segment) => /^focus(?:-visible|-within)?$/.test(segment) || /^data-\[macro-focus/.test(segment)
  );
  if (!ownFocus) return false;
  if (OUTLINE_SUPPRESSORS.has(base)) return false;
  return /^(?:outline|ring|inset-ring|border|bg|shadow|text|decoration|underline|fill|stroke|opacity)\b/.test(
    base
  );
}
