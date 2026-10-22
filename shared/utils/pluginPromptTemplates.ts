/** Argument names a prompt template may declare and reference as `{{name}}`. */
export const PROMPT_TEMPLATE_ARG_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** Longest template body, in characters. Mirrors a recipe terminal's `initialPrompt`. */
export const PROMPT_TEMPLATE_MAX_BODY_LENGTH = 8192;

export const PROMPT_TEMPLATE_MAX_ARGS = 20;

// Anything between double braces, so a malformed reference (`{{ Foo }}`,
// `{{a-b}}`) is found by the manifest check instead of passing through as text.
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

/** The raw text inside every `{{…}}` in `body`, trimmed, in order of appearance. */
export function findPromptTemplatePlaceholders(body: string): string[] {
  return Array.from(body.matchAll(PLACEHOLDER_PATTERN), (match) => match[1]!.trim());
}

/**
 * Expands `{{name}}` references in one pass. A value is inserted literally and
 * never scanned again, so an argument containing `{{other}}` or `$&` comes out
 * as typed. A reference with no value becomes empty text.
 */
export function renderPromptTemplate(
  body: string,
  values: Readonly<Record<string, string>>
): string {
  return body.replace(PLACEHOLDER_PATTERN, (_whole, raw: string) => {
    const name = raw.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : "";
  });
}
