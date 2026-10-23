/**
 * Svelte source semantics, for any Svelte 5 app with or without SvelteKit.
 *
 * Deliberately free of Daintree concepts: give it a `.svelte` file's bytes and
 * a location from Svelte's dev runtime, and it tells you which element of the
 * source that is.
 *
 * The Svelte compiler is a real dependency of this package but is `external` in
 * the bundle and reached only through `loadParse()`, which imports its `parse`
 * export dynamically — so the consumer decides when the parser loads, and the
 * rest of the compiler never does.
 * Every consumer reaches this package only behind a dynamic import, for the
 * same reason: the Element Picker host loads its Svelte resolver, and with it
 * this package, only when a Svelte selection arrives.
 */
export * from "./types.js";
export * from "./splice.js";
export * from "./resolve.js";
export { loadParse } from "./parse.js";
