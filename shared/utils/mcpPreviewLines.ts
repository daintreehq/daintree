/**
 * The caution-line convention shared by every MCP confirm preview formatter.
 *
 * `buildMcpConfirmPreview` flattens each preview kind to `string[]`, so a line
 * that means "we could not verify this" or "this operation will be refused" has
 * no way to carry severity except in its own text. Four formatter sites already
 * prefixed those lines with a bare "⚠ " (#11343, #11538, #11746). Naming the
 * marker here lets the dialog render them as real warnings — a Lucide icon and
 * a status tone — instead of leaving a bespoke glyph to do the work inside a
 * monospace block, where the most safety-critical line the preview can emit
 * renders at exactly the same weight as "No uncommitted changes."
 *
 * The line array is consumed only by `McpConfirmDialog`; the human-initiated
 * dialogs render structured data instead, so this stays a private contract
 * between the formatters and that one surface.
 */
export const MCP_PREVIEW_CAUTION_PREFIX = "⚠ ";

/** True when a preview line is a caution rather than ordinary content. */
export function isCautionPreviewLine(line: string): boolean {
  return line.startsWith(MCP_PREVIEW_CAUTION_PREFIX);
}

/** The line's text with the caution marker removed, for rendering beside an icon. */
export function stripCautionPrefix(line: string): string {
  return isCautionPreviewLine(line) ? line.slice(MCP_PREVIEW_CAUTION_PREFIX.length) : line;
}

/** True when any line in a preview is a caution. Drives the card's tone. */
export function hasCautionLine(lines: readonly string[]): boolean {
  return lines.some(isCautionPreviewLine);
}
