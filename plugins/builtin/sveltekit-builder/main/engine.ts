import type { SvelteParse } from "@daintreehq/svelte-source-model";

/**
 * Lazy loaders for the two heavy dependencies. Activation has a five-second
 * window and the Svelte compiler alone is several megabytes of parser, so
 * neither module may be imported at the top of any file `activate()` reaches —
 * only from inside a handler, on first use.
 */

export type SourceModel = typeof import("@daintreehq/svelte-source-model");

let sourceModel: Promise<SourceModel> | null = null;

export function loadSourceModel(): Promise<SourceModel> {
  sourceModel ??= import("@daintreehq/svelte-source-model").catch((error: unknown) => {
    // A failed import is not cached: a transient resolution failure must not
    // disable the builder for the rest of the session.
    sourceModel = null;
    throw error;
  });
  return sourceModel;
}

/**
 * The compiler, through the package that declares it. Kept as a function here
 * rather than letting callers reach for the model's own export so the two lazy
 * loads read the same way at every call site.
 */
export function loadParse(): Promise<SvelteParse> {
  return loadSourceModel().then((model) => model.loadParse());
}
