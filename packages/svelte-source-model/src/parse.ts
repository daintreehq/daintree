import type { SvelteParse } from "./types.js";

/**
 * The lazy door to the Svelte compiler.
 *
 * It lives here because this package is the one that declares `svelte` as a
 * dependency. The built-in plugin used to `import("svelte/compiler")` itself,
 * from outside the workspace that owns it, and that only resolved because npm
 * hoists: a change to the install layout, or a second Svelte version anywhere
 * in the tree, could have changed which compiler it got or failed outright. The
 * importer now owns the dependency it imports.
 *
 * Still dynamic, and that matters as much as the ownership: the compiler is
 * several megabytes of parser, plugin activation has a five-second window, and
 * nothing on a startup path may pull it in. `svelte/compiler` appears in this
 * file and nowhere else in the package, so the barrel cannot drag it in either.
 */
let compiler: Promise<SvelteParse> | null = null;

export function loadParse(): Promise<SvelteParse> {
  compiler ??= import("svelte/compiler").then(
    // The package declares its own structural AST subset; the compiler's
    // richer types are assignable in practice but not nominally.
    (module) => {
      const parse = module.parse as unknown as SvelteParse;
      // Callers hand the model text with the file's BOM already removed, and
      // `parse` removes one more. A second U+FEFF is content, so it is shielded
      // with a sacrificial one to keep offsets aligned with the text.
      const aligned: SvelteParse = (source, options) =>
        parse(source.charCodeAt(0) === 0xfeff ? `\uFEFF${source}` : source, options);
      // Resolving one node can parse its file more than once (its location,
      // then its shape), and a selection of many nodes in one file repeats
      // that. The last answer is kept per source text.
      let last: { source: string; options: string; ast: ReturnType<SvelteParse> } | null = null;
      const remembered: SvelteParse = (source, options) => {
        const key = JSON.stringify(options ?? null);
        if (last !== null && last.source === source && last.options === key) return last.ast;
        const ast = aligned(source, options);
        last = { source, options: key, ast };
        return ast;
      };
      return remembered;
    },
    (error: unknown) => {
      // A failed import is not cached: a transient resolution failure must not
      // disable the caller for the rest of the session.
      compiler = null;
      throw error;
    }
  );
  return compiler;
}
