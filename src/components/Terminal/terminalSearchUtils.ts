export type SearchStatus = "idle" | "found" | "none" | "invalidRegex";

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

export function buildSearchOptions(
  caseSensitive: boolean,
  regexEnabled: boolean
): {
  caseSensitive: boolean;
  regex?: boolean;
} {
  const options: { caseSensitive: boolean; regex?: boolean } = { caseSensitive };
  if (regexEnabled) {
    options.regex = true;
  }
  return options;
}
