import type { SvelteParse } from "@daintreehq/svelte-source-model";

/**
 * Lazy loaders for the two heavy dependencies. Activation has a five-second
 * window and the Svelte compiler alone is several megabytes of parser, so
 * neither module may be imported at the top of any file `activate()` reaches —
 * only from inside a handler, on first use.
 */

export type SourceModel = typeof import("@daintreehq/svelte-source-model");

let sourceModel: Promise<SourceModel> | null = null;
let compiler: Promise<SvelteParse> | null = null;

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
 * The source model's own class-token and entity semantics: a second tokenizer
 * here is exactly how the view once removed a different token than the one the
 * user clicked.
 */
export type TokenModel = Pick<SourceModel, "splitClassValue" | "decodeEntities" | "validateToken">;

export async function loadTokenModel(): Promise<TokenModel> {
  return loadSourceModel();
}

export function loadParse(): Promise<SvelteParse> {
  compiler ??= import("svelte/compiler").then(
    // The package declares its own structural AST subset; the compiler's
    // richer types are assignable in practice but not nominally.
    (module) => {
      const parse = module.parse as unknown as SvelteParse;
      // Main hands the model text with the file's BOM already removed, and
      // `parse` removes one more. A second U+FEFF is content, so it is shielded
      // with a sacrificial one to keep offsets aligned with the text.
      const aligned: SvelteParse = (source, options) =>
        parse(source.charCodeAt(0) === 0xfeff ? `\uFEFF${source}` : source, options);
      return aligned;
    },
    (error: unknown) => {
      compiler = null;
      throw error;
    }
  );
  return compiler;
}
