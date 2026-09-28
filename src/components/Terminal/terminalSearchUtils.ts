import type { ISearchOptions } from "@xterm/addon-search";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { contrastRatio } from "@shared/theme";

export type SearchStatus = "idle" | "found" | "none" | "invalidRegex";

type SearchDecorationOptions = NonNullable<ISearchOptions["decorations"]>;

const FALLBACK_MATCH_COLOR = "#71717a";
const FALLBACK_ACTIVE_MATCH_COLOR = "#22c55e";

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
      error: formatErrorMessage(e, "Invalid regex pattern"),
    };
  }
}

function parseRgb(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const hex = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.replace(/./g, "$&$&") : hex[1]!;
    const n = parseInt(digits, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const match = value.match(
    /^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,\s*([\d.]+)(%?)\s*)?\)$/
  );
  if (!match) return null;
  const channel = (raw: string) => Math.min(255, Math.max(0, parseInt(raw, 10)));
  let alpha = match[4] === undefined ? 1 : parseFloat(match[4]);
  if (match[5] === "%") alpha /= 100;
  return {
    rgb: [channel(match[1]!), channel(match[2]!), channel(match[3]!)],
    alpha: Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1,
  };
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

// Every inactive match has to stay findable against the terminal, not just the
// surface the wash was tuned on: light themes tune a faint dark ink for a light
// canvas but run a dark terminal, where that ink composites to nothing.
const MIN_MATCH_CONTRAST = 1.5;

// xterm decorations only take opaque #RRGGBB, so a translucent match wash has to
// be flattened. Dropping the alpha instead painted every match in the wash's
// full-strength colour, identical to the active match and louder than the text.
// The wash keeps its own alpha when that is visible over the terminal, and is
// strengthened just far enough to clear MIN_MATCH_CONTRAST when it is not.
function flattenOver(value: string, backdrop: string): string | null {
  const fg = parseRgb(value);
  if (!fg) return null;
  const bg = parseRgb(backdrop);
  if (fg.alpha >= 1 || !bg) return toHex(fg.rgb);
  const backdropHex = toHex(bg.rgb);
  const at = (alpha: number) => {
    const blend = (i: 0 | 1 | 2) => fg.rgb[i] * alpha + bg.rgb[i] * (1 - alpha);
    return toHex([blend(0), blend(1), blend(2)]);
  };
  for (let alpha = fg.alpha; alpha < 1; alpha += 0.05) {
    const flattened = at(alpha);
    if (contrastRatio(flattened, backdropHex) >= MIN_MATCH_CONTRAST) return flattened;
  }
  return toHex(fg.rgb);
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
    const parsed = parseRgb(styles.getPropertyValue(name).trim());
    return parsed && parsed.alpha >= 1 ? toHex(parsed.rgb) : fallback;
  };

  const bgValue = styles.getPropertyValue("--theme-search-highlight-background").trim();
  const backdrop =
    styles.getPropertyValue("--theme-terminal-background").trim() ||
    styles.getPropertyValue("--theme-surface-canvas").trim();
  const matchColor = flattenOver(bgValue, backdrop) ?? FALLBACK_MATCH_COLOR;
  // search-highlight-text is a solid hex by design — suitable for xterm's active-match background
  const activeColor = read("--theme-search-highlight-text", FALLBACK_ACTIVE_MATCH_COLOR);

  return {
    matchBackground: matchColor,
    matchOverviewRuler: matchColor,
    activeMatchBackground: activeColor,
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
