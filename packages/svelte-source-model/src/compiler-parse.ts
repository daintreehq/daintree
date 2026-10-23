/**
 * The one export of `svelte/compiler` this package uses, on its own.
 *
 * A static named re-export is what lets the consumer's bundler drop `compile`,
 * `migrate`, `print` and `preprocess`; a dynamic `import("svelte/compiler")`
 * keeps the whole namespace, destructured or not. This module is reached only
 * through `loadParse()`'s `import()`, so it adds nothing to an eager graph.
 */
export { parse } from "svelte/compiler";
