import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const TOOLBAR_CSS_PATH = path.join(REPO_ROOT, "src/styles/components/toolbar.css");
export const DIFF_VIEWER_CSS_PATH = path.join(REPO_ROOT, "src/components/Worktree/DiffViewer.css");

const IMPORT_LINE = /^@import\s+"(\.{1,2}\/[^"]+)";[^\S\n]*$/gm;

/**
 * A stylesheet with its relative `@import`s inlined in place, the way the
 * bundler flattens it.
 *
 * `toolbar.css` and `DiffViewer.css` are manifests over feature partials
 * (#13322). A source guard that read the manifest alone would see only import
 * lines, and every "this rule is absent" assertion would pass over an empty
 * file. Inlining keeps each guard reading the same rules, in the same cascade
 * order, as it did before the split.
 */
export function readCssWithImports(cssPath: string): string {
  const source = fs.readFileSync(cssPath, "utf8");
  let inlined = 0;
  const result = source.replace(IMPORT_LINE, (_, rel: string) => {
    inlined++;
    return readCssWithImports(path.resolve(path.dirname(cssPath), rel));
  });
  // Package imports (`tailwindcss`) stay as they are; a relative one this
  // reader cannot expand would hide its partial's rules from every guard.
  const relativeImports =
    source.replace(/\/\*[\s\S]*?\*\//g, "").match(/@import\s+(?:url\(\s*)?["']?\.{1,2}\//g) ?? [];
  if (relativeImports.length !== inlined) {
    throw new Error(
      `${cssPath}: ${relativeImports.length - inlined} relative @import(s) not in the plain \`@import "./x.css";\` form`
    );
  }
  return inlined === 0 ? source : result;
}

export function readToolbarCss(): string {
  return readCssWithImports(TOOLBAR_CSS_PATH);
}

export function readDiffViewerCss(): string {
  return readCssWithImports(DIFF_VIEWER_CSS_PATH);
}
