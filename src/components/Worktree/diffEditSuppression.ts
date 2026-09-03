import type { TokenPath, TokenizeEnhancer } from "react-diff-view";

/**
 * Tokenize enhancer applying git diff-highlight's suppression rule: once the
 * word-level marks from markEdits would cover most of a line, they stop
 * saying *what* changed — the line was rewritten, and the honest display is
 * the plain line fill. Runs directly after markEdits in the enhancer chain
 * and unwraps the `edit` nodes on any line where their spans exceed
 * EDIT_COVERAGE_LIMIT of the line's characters, so largely-rewritten lines
 * fall back to whole-line highlighting while small token edits keep their
 * emphasis.
 *
 * Whitespace-only edits are exempt at any coverage: their mark renders as
 * ·/→ glyphs (renderTokenWithInvisibles), which is the only visible signal
 * an indentation-only change has.
 */
export const EDIT_COVERAGE_LIMIT = 0.6;

/**
 * The judgment itself, separated from the token plumbing so the rendered
 * Markdown diff can apply it to a block's visible text (issue #12171). Both
 * callers must agree: a unit whose edits cover more than EDIT_COVERAGE_LIMIT of
 * its characters was rewritten, and the marks stop saying what changed.
 *
 * `editedText` is every edited character concatenated. Whitespace-only edits
 * are exempt at any coverage — in the line diff their mark is the ·/→ glyph
 * that is the only visible signal of an indentation change, and in the block
 * diff a whitespace-only edit has no other visible signal either.
 */
export function shouldSuppressEdits(
  totalLength: number,
  editedLength: number,
  editedText: string
): boolean {
  if (editedLength === 0 || totalLength === 0) return false;
  if (editedLength / totalLength <= EDIT_COVERAGE_LIMIT) return false;
  return /[^ \t]/.test(editedText);
}

function pathText(path: TokenPath): string {
  const leaf = path[path.length - 1];
  return typeof leaf?.value === "string" ? leaf.value : "";
}

function isEditPath(path: TokenPath): boolean {
  return path.some((node) => node.type === "edit");
}

function suppressLine(line: TokenPath[]): TokenPath[] {
  let total = 0;
  let edited = 0;
  let editText = "";
  for (const path of line) {
    const text = pathText(path);
    total += text.length;
    if (isEditPath(path)) {
      edited += text.length;
      editText += text;
    }
  }
  if (!shouldSuppressEdits(total, edited, editText)) return line;
  return line.map((path) =>
    isEditPath(path) ? path.filter((node) => node.type !== "edit") : path
  );
}

export function suppressFullLineEdits(): TokenizeEnhancer {
  return ([oldLines, newLines]) => [oldLines.map(suppressLine), newLines.map(suppressLine)];
}
