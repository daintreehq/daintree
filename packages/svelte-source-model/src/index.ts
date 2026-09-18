/**
 * Svelte source semantics for the SvelteKit Site Builder.
 *
 * Deliberately free of Daintree concepts: give it a `.svelte` file's bytes and
 * a location from Svelte's dev runtime, and it tells you which element of the
 * source that is.
 *
 * The Svelte compiler is a real dependency of this package but is `external` in
 * the bundle and reached only through `loadParse()`, which imports it
 * dynamically — so the consumer decides when several megabytes of parser load.
 * The built-in plugin `await import()`s this package lazily for the same
 * reason.
 */
export * from "./types.js";
export * from "./splice.js";
export * from "./resolve.js";
export { loadParse } from "./parse.js";
