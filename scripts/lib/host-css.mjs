import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/** The host stylesheet entry: what the renderer imports and Tailwind compiles. */
export const HOST_CSS_ENTRY = path.join(REPO_ROOT, "src/index.css");

/**
 * The directory the entry's own rules were split into (#13321). Imports of these
 * files are pieces of `index.css`, not separate stylesheets, so readers expand
 * them; the design contract and the component sheets stay as they are.
 */
export const HOST_PARTIAL_DIR = "styles/host";

const PLAIN_IMPORT = /^@import "(\.\/styles\/host\/[^"/]+\.css)";[ \t]*$/gm;

const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

const blank = (text) => text.replace(/[^\n]/g, " ");

/**
 * Blank out comments, preserving length, so a commented-out import never
 * matches. Strings are skipped rather than scanned: the entry's `@source` globs
 * end in a slash-star, which would otherwise open a comment that swallows real
 * imports.
 * With `strings`, quoted text is blanked too, so only real at-rules remain.
 */
function blankComments(source, { strings = false } = {}) {
  return source.replace(COMMENT_OR_STRING, (match) =>
    match.startsWith("/*") || strings ? blank(match) : match
  );
}

/** Offsets of every real `@import` at-rule, outside comments and strings. */
function importOffsets(source) {
  return [...blankComments(source, { strings: true }).matchAll(/@import\b/g)].map((m) => m.index);
}

/**
 * `src/index.css` with every host-partial import replaced in place by that
 * partial's text, in source order: the same rules, in the same order, that the
 * file held before the split.
 *
 * Contract suites and scripts that scan "the host stylesheet" read this rather
 * than the entry file. Reading the entry alone finds almost nothing since the
 * split, and a guard scanning it would pass over an empty set rather than fail.
 *
 * Throws when a referenced partial is missing, when a partial imports another,
 * or when a host-partial import is written in a form this reader does not expand.
 *
 * @param {string} [entry]
 * @param {{ onFile?: (file: string) => void }} [options]
 * @returns {{ css: string, files: { path: string, source: string }[] }}
 */
export function readHostStylesheet(entry = HOST_CSS_ENTRY, { onFile } = {}) {
  const source = readFileSync(entry, "utf-8");
  onFile?.(entry);
  const files = [{ path: entry, source }];
  const scanned = blankComments(source);

  const expanded = new Set();
  let css = "";
  let cursor = 0;
  for (const match of scanned.matchAll(PLAIN_IMPORT)) {
    expanded.add(match.index);
    const partial = path.resolve(path.dirname(entry), match[1]);
    let text;
    try {
      text = readFileSync(partial, "utf-8");
    } catch {
      throw new Error(
        `[host-css] ${path.relative(REPO_ROOT, entry)} imports ${match[1]}, which does not exist`
      );
    }
    if (importOffsets(text).length > 0) {
      throw new Error(
        `[host-css] ${path.relative(REPO_ROOT, partial)} has an @import; host partials must not nest`
      );
    }
    onFile?.(partial);
    files.push({ path: partial, source: text });
    css += source.slice(cursor, match.index) + text.replace(/\n+$/, "");
    cursor = match.index + match[0].length;
  }
  css += source.slice(cursor);

  for (const offset of importOffsets(source)) {
    const statement = scanned.slice(offset, scanned.indexOf(";", offset) + 1 || undefined);
    if (!expanded.has(offset) && statement.includes(`${HOST_PARTIAL_DIR}/`)) {
      throw new Error(
        `[host-css] ${path.relative(REPO_ROOT, entry)} imports a host partial in a form other than ` +
          `@import "./${HOST_PARTIAL_DIR}/<name>.css"; on its own line`
      );
    }
  }
  return { css, files };
}
