/**
 * Svelte source semantics for the SvelteKit Site Builder.
 *
 * Deliberately free of Daintree concepts: give it a `.svelte` file's bytes and
 * a location from Svelte's dev runtime, and it tells you which element that is
 * and how to change it without disturbing anything else.
 *
 * The Svelte compiler is a real dependency of this package but is `external` in
 * the bundle, so the consumer decides when it loads. The built-in plugin
 * `await import()`s this package lazily for that reason.
 */
export * from "./types.js";
export * from "./splice.js";
export * from "./resolve.js";
export * from "./mutate.js";
