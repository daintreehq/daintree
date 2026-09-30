// Apart from the render policy so a code surface outside rendered Markdown
// (the plugin kit's CodeBlock) resolves fence names the same way without
// pulling react-markdown in with it.

/**
 * Fence-info aliases → the grammar keys diffRefractor's loaders know.
 * refractor registers Prism's own aliases (ts, py, …) once the grammar is
 * loaded; this map only bridges the *loader* lookup for grammars that are
 * still cold.
 */
const FENCE_LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  dockerfile: "docker",
  html: "markup",
  xml: "markup",
};

export function canonicalLang(lang: string): string {
  const lower = lang.toLowerCase();
  // Own keys only: a fence named "constructor" or "__proto__" is an unknown
  // grammar, not a lookup into Object.prototype.
  return Object.hasOwn(FENCE_LANG_ALIASES, lower) ? FENCE_LANG_ALIASES[lower]! : lower;
}
