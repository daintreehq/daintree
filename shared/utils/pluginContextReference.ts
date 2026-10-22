import type { ContextReference } from "../types/pluginContextProvider.js";

/**
 * The `@{prefix}:{id}` grammar of a plugin context reference (#13795), and the
 * bounds every value crossing the plugin boundary is held to. Pure and
 * dependency-free, so the manifest schema, main's registry, the composer and
 * the SDK's drag contract all read one definition.
 */

/** One to sixteen lowercase letters: short enough to type, one word to read. */
export const CONTEXT_PROVIDER_PREFIX_PATTERN = /^[a-z]{1,16}$/;

/** The composer's own `@` words. A plugin can never claim one. */
export const CONTEXT_PROVIDER_RESERVED_PREFIXES: ReadonlySet<string> = new Set([
  "diff",
  "terminal",
  "selection",
]);

export const CONTEXT_ITEM_ID_MAX_LENGTH = 128;
export const CONTEXT_QUERY_MAX_LENGTH = 256;
export const CONTEXT_SEARCH_MAX_RESULTS = 50;
export const CONTEXT_ITEM_LABEL_MAX_LENGTH = 120;
export const CONTEXT_ITEM_DESCRIPTION_MAX_LENGTH = 200;
/** Distinct references one send resolves; the rest become placeholders. */
export const CONTEXT_RESOLVE_MAX_REFERENCES = 20;

/**
 * An item id is one draft token: letters, digits and `_ - . : / # ~ + =`, and
 * never ending in `.` or `:`, which a sentence puts after a word.
 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9_\-.:/#~+=]*[A-Za-z0-9_\-/#~+=]$/;

/**
 * A reference opens on `@` at the start or after whitespace, like the
 * composer's own tokens. The id run is cut at the first character an id can't
 * hold; sentence punctuation after it ends the token, anything else means the
 * text was never a reference.
 */
const REFERENCE_PATTERN = /(?<=^|\s)@([a-z]{1,16}):([A-Za-z0-9_\-.:/#~+=]+)/g;
const AFTER_REFERENCE = /[\s,;!?)\]}'"]/;

export function isContextProviderPrefix(prefix: unknown): prefix is string {
  return (
    typeof prefix === "string" &&
    CONTEXT_PROVIDER_PREFIX_PATTERN.test(prefix) &&
    !CONTEXT_PROVIDER_RESERVED_PREFIXES.has(prefix)
  );
}

export function isContextItemId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length <= CONTEXT_ITEM_ID_MAX_LENGTH && ITEM_ID_PATTERN.test(id)
  );
}

export function formatContextReference(reference: ContextReference): string {
  return `@${reference.prefix}:${reference.id}`;
}

export interface ContextReferenceToken extends ContextReference {
  start: number;
  end: number;
}

/**
 * Every well-formed `@{prefix}:{id}` in `text`, whatever its prefix — which of
 * them a provider holds is the caller's question, answered per project.
 */
export function findContextReferences(text: string): ContextReferenceToken[] {
  const tokens: ContextReferenceToken[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const start = match.index;
    const prefix = match[1]!;
    const run = match[2]!;
    const after = text[start + match[0].length];
    if (after !== undefined && !AFTER_REFERENCE.test(after)) continue;
    if (CONTEXT_PROVIDER_RESERVED_PREFIXES.has(prefix)) continue;
    const id = run.replace(/[.:]+$/, "");
    if (!isContextItemId(id)) continue;
    tokens.push({ start, end: start + 2 + prefix.length + id.length, prefix, id });
  }
  return tokens;
}

/**
 * The provider prefix and search text of an `@` completion query, when it
 * names one: `rec:login` → `{ prefix: "rec", query: "login" }`. Only the text
 * after the prefix is ever a provider's to see.
 */
export function splitContextProviderQuery(query: string): { prefix: string; query: string } | null {
  const colon = query.indexOf(":");
  if (colon <= 0) return null;
  const prefix = query.slice(0, colon);
  if (!isContextProviderPrefix(prefix)) return null;
  return { prefix, query: query.slice(colon + 1) };
}
