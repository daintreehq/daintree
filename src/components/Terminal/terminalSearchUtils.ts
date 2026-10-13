import type { ISearchOptions } from "@xterm/addon-search";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export type SearchStatus = "idle" | "found" | "none" | "invalidRegex";

type SearchDecorationOptions = NonNullable<ISearchOptions["decorations"]>;

const FALLBACK_MATCH_COLOR = "#71717a";
const FALLBACK_ACTIVE_MATCH_COLOR = "#22c55e";
const ACTIVE_MATCH_FILL_ALPHA = 0.45;
const ACTIVE_MATCH_MIN_CONTRAST = 3;

export function validateRegexTerm(
  term: string,
  caseSensitive: boolean
): {
  isValid: boolean;
  error?: string;
} {
  try {
    new RegExp(term, caseSensitive ? "g" : "gi");
    return { isValid: true };
  } catch (e) {
    return {
      isValid: false,
      error: describeRegexError(formatErrorMessage(e, "Invalid regex pattern")),
    };
  }
}

/**
 * The engine's message repeats the whole pattern and its flags before the part
 * that says what is wrong ("Invalid regular expression: /error(TS/gi:
 * Unterminated group"), and the user can already see the pattern in the field.
 * Keep only the reason.
 */
export function describeRegexError(message: string): string {
  const reason = message.replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "").trim();
  if (!reason) return message;
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

type Rgba = { r: number; g: number; b: number; a: number };

function parseColor(value: string): Rgba | null {
  const hex = value.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (hex) {
    return {
      r: parseInt(hex[1]!, 16),
      g: parseInt(hex[2]!, 16),
      b: parseInt(hex[3]!, 16),
      a: 1,
    };
  }
  const rgba = value.match(
    /^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,\s*([\d.]+)(%?)\s*)?\)$/
  );
  if (!rgba) return null;
  const channel = (raw: string) => Math.min(255, Math.max(0, parseInt(raw, 10)));
  const alpha = rgba[4] === undefined ? 1 : parseFloat(rgba[4]) / (rgba[5] ? 100 : 1);
  return {
    r: channel(rgba[1]!),
    g: channel(rgba[2]!),
    b: channel(rgba[3]!),
    a: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1,
  };
}

function toHex({ r, g, b }: Rgba): string {
  const part = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The current match's outline is how the eye finds "2 of 5", so it has to hold
 * WCAG's 3:1 for meaningful non-text marks against the terminal. A theme hue
 * that falls short (a mid blue on a navy terminal) steps toward the
 * terminal's own ink until it clears.
 */
function legibleStroke(stroke: Rgba, backdrop: Rgba, ink: Rgba | null): Rgba {
  if (!ink || contrast(stroke, backdrop) >= ACTIVE_MATCH_MIN_CONTRAST) return stroke;
  for (let step = 1; step <= 10; step++) {
    const t = step / 10;
    const mixed = {
      r: stroke.r + (ink.r - stroke.r) * t,
      g: stroke.g + (ink.g - stroke.g) * t,
      b: stroke.b + (ink.b - stroke.b) * t,
      a: 1,
    };
    if (contrast(mixed, backdrop) >= ACTIVE_MATCH_MIN_CONTRAST) return mixed;
  }
  return ink;
}

/**
 * xterm takes decoration colours as opaque #RRGGBB only, and the theme's
 * match colour is a translucent wash. Dropping the alpha painted every match
 * in the active match's full colour, so "2 of 5" had no visible "2"; the wash
 * is composited over the terminal's own background instead, which is what it
 * would have looked like had xterm accepted it.
 */
function flattenOver(color: Rgba, backdrop: Rgba | null): string {
  if (color.a >= 1 || !backdrop) return toHex(color);
  const mix = (top: number, bottom: number) => top * color.a + bottom * (1 - color.a);
  return toHex({
    r: mix(color.r, backdrop.r),
    g: mix(color.g, backdrop.g),
    b: mix(color.b, backdrop.b),
    a: 1,
  });
}

export function getSearchDecorationColors(): SearchDecorationOptions {
  if (typeof document === "undefined") {
    return {
      matchBackground: FALLBACK_MATCH_COLOR,
      matchOverviewRuler: FALLBACK_MATCH_COLOR,
      activeMatchBackground: FALLBACK_ACTIVE_MATCH_COLOR,
      activeMatchColorOverviewRuler: FALLBACK_ACTIVE_MATCH_COLOR,
    };
  }

  const styles = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
  };

  const wash = parseColor(styles.getPropertyValue("--theme-search-highlight-background").trim());
  const backdrop = parseColor(styles.getPropertyValue("--theme-terminal-background").trim());
  const matchColor = wash ? flattenOver(wash, backdrop) : FALLBACK_MATCH_COLOR;
  // The ruler tick is a few pixels wide, so it keeps the wash's full hue.
  const matchRulerColor = wash ? toHex(wash) : FALLBACK_MATCH_COLOR;
  // search-highlight-text is a solid hex by design. As a full fill it buries the
  // terminal's own ink (xterm keeps each cell's foreground), so the current
  // match takes it as a stroke over a stronger wash than the other matches:
  // two cues that survive any theme, and the text inside stays readable.
  const activeColor = read("--theme-search-highlight-text", FALLBACK_ACTIVE_MATCH_COLOR);
  const active = parseColor(activeColor);
  const activeFill =
    active && backdrop
      ? flattenOver({ ...active, a: ACTIVE_MATCH_FILL_ALPHA }, backdrop)
      : activeColor;
  const ink = parseColor(styles.getPropertyValue("--theme-terminal-foreground").trim());
  const activeStroke =
    active && backdrop ? toHex(legibleStroke(active, backdrop, ink)) : activeColor;

  return {
    matchBackground: matchColor,
    matchOverviewRuler: matchRulerColor,
    activeMatchBackground: activeFill,
    activeMatchBorder: activeStroke,
    activeMatchColorOverviewRuler: activeColor,
  };
}

export function buildSearchOptions(
  caseSensitive: boolean,
  regexEnabled: boolean,
  wholeWord = false
): ISearchOptions {
  const options: ISearchOptions = {
    caseSensitive,
    decorations: getSearchDecorationColors(),
  };
  if (regexEnabled) {
    options.regex = true;
  }
  if (wholeWord) {
    options.wholeWord = true;
  }
  return options;
}
