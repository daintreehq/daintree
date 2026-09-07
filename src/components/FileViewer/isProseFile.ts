import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";

/**
 * Prose formats beyond Markdown. Plain text, reStructuredText and AsciiDoc are
 * written the same way Markdown is — a paragraph is one physical line, wrapped
 * by the renderer rather than the author — so their diffs are unreadable
 * without soft wrap for exactly the same reason.
 *
 * Deliberately an allowlist, not a "not a known code extension" test: an
 * unrecognised extension is far more likely to be code or config, and wrapping
 * those hides the column structure that makes them readable.
 */
const PROSE_EXTENSIONS = new Set(["txt", "text", "rst", "rest", "adoc", "asciidoc"]);

/**
 * Whether a path names a prose document, which decides the default for diff
 * soft-wrap (#12170). Markdown is answered by the existing check rather than a
 * second extension list, so the two can't drift.
 */
export function isProseFilePath(filePath: string): boolean {
  if (isMarkdownFilePath(filePath)) return true;
  return PROSE_EXTENSIONS.has(filePath.split(".").pop()?.toLowerCase() ?? "");
}
