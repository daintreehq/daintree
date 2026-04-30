import type { ISearchOptions } from "@xterm/addon-search";
import { formatErrorMessage } from "@shared/utils/errorMessage";

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
    const normalizedTerm = caseSensitive ? term : term.toLowerCase();
    new RegExp(normalizedTerm, "g");
    return { isValid: true };
  } catch (e) {
    return {
      isValid: false,
      error: formatErrorMessage(e, "Invalid regex pattern"),
    };
  }
}

function rgbaToHex(value: string): string | null {
  const match = value.match(
    /^rgba?\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*(?:,\s*[\d.]+%?\s*)?\)$/
  );
  if (!match) return null;
  const r = Math.min(255, Math.max(0, parseInt(match[1]!, 10)));
  const g = Math.min(255, Math.max(0, parseInt(match[2]!, 10)));
  const b = Math.min(255, Math.max(0, parseInt(match[3]!, 10)));
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
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

  const bgValue = styles.getPropertyValue("--theme-search-highlight-background").trim();
  const matchColor = rgbaToHex(bgValue) ?? FALLBACK_MATCH_COLOR;
  // search-highlight-text is a solid hex by design — suitable for xterm's active-match background
  const activeColor = read("--theme-search-highlight-text", FALLBACK_ACTIVE_MATCH_COLOR);

  return {
    matchBackground: matchColor,
    matchOverviewRuler: matchColor,
    activeMatchBackground: activeColor,
    activeMatchColorOverviewRuler: activeColor,
  };
}

export function buildSearchOptions(caseSensitive: boolean, regexEnabled: boolean): ISearchOptions {
  const options: ISearchOptions = {
    caseSensitive,
    decorations: getSearchDecorationColors(),
  };
  if (regexEnabled) {
    options.regex = true;
  }
  return options;
}
