/**
 * Budgets and grammar for plugin search providers in the quick switcher
 * (#13792). Shared so the manifest gate, main's query coordinator and the
 * switcher agree on one set of numbers.
 */

/**
 * A provider keyword: lowercase ASCII letters, digits and `-`, starting with a
 * letter. The grammar alone keeps a keyword clear of every prefix character
 * the palettes route on (`>`, `@`, `#`, `:`, `/`).
 */
export const SEARCH_PROVIDER_KEYWORD_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;

/** The icon a provider and its results get when the manifest names none. */
export const SEARCH_PROVIDER_DEFAULT_ICON_ID = "search";

/** Most characters of a provider's title. */
export const SEARCH_PROVIDER_TITLE_MAX_LENGTH = 80;

/** How long the switcher waits after the last keystroke before asking providers. */
export const SEARCH_PROVIDER_DEBOUNCE_MS = 150;

/**
 * How long one provider has to answer, from main accepting the query. It
 * covers a declarative query's child process starting and a scoped runtime
 * provider's plugin activating; an answer after it is dropped and recorded.
 */
export const SEARCH_PROVIDER_DEADLINE_MS = 1000;

/** Most results one provider shows while the switcher is scoped to it. */
export const SEARCH_PROVIDER_SCOPED_LIMIT = 20;

/** Most results one provider adds to the unscoped search. */
export const SEARCH_PROVIDER_BLENDED_LIMIT = 3;

/** Most provider results the unscoped search shows in all, below the built-in ones. */
export const SEARCH_PROVIDER_BLENDED_TOTAL = 6;

/** Longest query a provider is sent, in characters; longer input is cut. */
export const SEARCH_PROVIDER_QUERY_MAX_LENGTH = 512;

/** Longest result id, label and description, in characters. Longer labels are cut; ids are refused. */
export const SEARCH_RESULT_ID_MAX_LENGTH = 128;
export const SEARCH_RESULT_LABEL_MAX_LENGTH = 160;
export const SEARCH_RESULT_DESCRIPTION_MAX_LENGTH = 256;

/** Most bytes of JSON one runtime provider's answer may be; a larger answer fails in the worker. */
export const SEARCH_PROVIDER_MAX_RESPONSE_BYTES = 128 * 1024;

/** Most bytes of JSON a result's `args` may carry; a larger bag drops the row. */
export const SEARCH_RESULT_ARGS_MAX_BYTES = 4096;
