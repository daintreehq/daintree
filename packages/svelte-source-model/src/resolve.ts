import { lineColumnToOffset } from "./splice.js";
import { describeElement, findTagNodesAtOffset } from "./resolve/element.js";
import { isGeneratedSourceFile } from "./resolve/generated.js";
import type { DevLocation, ResolveResult, SvelteAstRoot, SvelteParse } from "./types.js";

export { isGeneratedSourceFile } from "./resolve/generated.js";
export { resolveElementByStructure } from "./resolve/structure.js";
export type {
  StructureFailureReason,
  StructureFrame,
  StructureRequest,
  StructureResult,
  StructureStep,
} from "./resolve/structure.js";
export { interpretAncestry } from "./resolve/ancestry.js";
export type {
  AncestryEntry,
  AncestryKind,
  InterpretedAncestry,
  RawAncestryFrame,
} from "./resolve/ancestry.js";

/** Local rather than shared: this package deliberately depends on nothing of Daintree's. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Resolves a rendered node's dev-runtime location to the element in the source
 * that produced it.
 *
 * This is a lookup, not an identity check. A location is only meaningful
 * against the exact bytes it was captured from: insert a line above a selected
 * element and the same line/column resolves cleanly to whatever now sits there.
 * Re-resolving after an edit or an HMR update is therefore only safe when the
 * caller has established that the file is unchanged — the plugin pins a
 * `revision` hash for that — and must otherwise be treated as stale.
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
  source: string,
  location: DevLocation,
  parse: SvelteParse
): ResolveResult {
  if (isGeneratedSourceFile(location.file)) {
    return { status: "failed", reason: "generated-file", detail: location.file };
  }

  const offset = lineColumnToOffset(source, location.line, location.column);
  if (offset === null) {
    return {
      status: "failed",
      reason: "location-out-of-range",
      detail: `${location.file}:${location.line}:${location.column}`,
    };
  }

  let ast: SvelteAstRoot;
  try {
    ast = parse(source, { modern: true, filename: location.file });
  } catch (error) {
    return {
      status: "failed",
      reason: "parse-failed",
      detail: describeError(error),
    };
  }

  const matches = findTagNodesAtOffset(ast, offset);
  if (matches.length === 0) {
    return {
      status: "failed",
      reason: "no-element-at-location",
      detail: `no element starts at offset ${offset}`,
    };
  }
  // Two nodes claiming one offset means the source model disagrees with itself.
  // Failing here rather than picking one keeps a selection stale, which is the
  // recoverable outcome; picking one writes to a node nobody chose.
  if (matches.length > 1) {
    return {
      status: "failed",
      reason: "ambiguous-location",
      detail: `${matches.length} elements start at offset ${offset}`,
    };
  }

  return { status: "resolved", node: describeElement(matches[0]!, source) };
}

/**
 * Counts the elements in `ast` whose start offset matches `offset`.
 *
 * Used to prove the resolve is unambiguous. More than one match means the
 * source model disagrees with itself and no edit may proceed.
 */
export function countElementsAtOffset(ast: SvelteAstRoot, offset: number): number {
  return findTagNodesAtOffset(ast, offset).length;
}
