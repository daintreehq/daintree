/**
 * Marks a paragraph boundary in a voice buffer's `completedSegments`. Segments
 * are trimmed before they are stored, so no real segment can equal it.
 */
export const VOICE_PARAGRAPH_BREAK = "\n";

/** A session's completed segments as one text: words joined by spaces, paragraphs by newlines. */
export function joinCompletedSegments(segments: readonly string[]): string {
  let text = "";
  for (const segment of segments) {
    if (segment === VOICE_PARAGRAPH_BREAK) {
      if (text) text += "\n";
    } else if (segment) {
      text += text && !text.endsWith("\n") ? ` ${segment}` : segment;
    }
  }
  return text.trimEnd();
}
