import type { DevLocation, ResolveResult, SvelteAstRoot, SvelteParse } from "./types.js";

/**
 * Resolves a rendered node's dev-runtime location to the element in the source
 * that produced it.
 *
 * The contract, which the implementation must not weaken:
 *
 * - The location must land exactly on an element's opening `<`. Svelte emits
 *   the element's own start position, so an exact offset match is available and
 *   is the only acceptable match. "Nearest element on that line" is how a
 *   visual editor writes to the wrong node after the file shifts.
 * - A location in a generated file (`.svelte-kit/**`, `node_modules/**`) is a
 *   failure, not a resolve — those are real ancestors but never editable.
 * - A parse failure is reported, never treated as "no match".
 *
 * @param source the raw, un-preprocessed `.svelte` bytes
 * @param location `__svelte_meta.loc`, verbatim
 * @param parse the injected Svelte `parse`, so the caller owns compiler loading
 */
export function resolveElementAtLocation(
  _source: string,
  _location: DevLocation,
  _parse: SvelteParse
): ResolveResult {
  throw new Error("resolveElementAtLocation is not implemented yet");
}

/**
 * Counts the elements in `ast` whose start offset matches `offset`.
 *
 * Used to prove the resolve is unambiguous. More than one match means the
 * source model disagrees with itself and no edit may proceed.
 */
export function countElementsAtOffset(_ast: SvelteAstRoot, _offset: number): number {
  throw new Error("countElementsAtOffset is not implemented yet");
}
