import type { ISearchOptions } from "@xterm/addon-search";

export type SearchStatus = "idle" | "found" | "none" | "invalidRegex";

type SearchDecorationOptions = NonNullable<ISearchOptions["decorations"]>;

const FALLBACK_MATCH_COLOR = "#6366f1";
const FALLBACK_ACTIVE_MATCH_COLOR = "#0ea5e9";

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
      error: e instanceof Error ? e.message : "Invalid regex pattern",
    };
  }
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

  const matchColor = read("--theme-status-info", FALLBACK_MATCH_COLOR);
  const activeColor = read("--theme-accent-primary", FALLBACK_ACTIVE_MATCH_COLOR);

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
