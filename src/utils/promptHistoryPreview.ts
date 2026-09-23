/**
 * One-line previews of sent prompts for the prompt history palette.
 *
 * Prompts are rarely one line. They are pasted briefs, markdown checklists and
 * code blocks, and the old preview kept only the first line — so a prompt that
 * opened with a blank line rendered as an empty row, and one that opened with a
 * fence read as nothing but "```ts". The preview is the whole prompt with its
 * whitespace collapsed, so every row starts with the first thing the user wrote
 * and the layout's ellipsis decides where it stops.
 */

/** Opening and closing code fences carry no words worth recognising a prompt by. */
const FENCE_LINE = /^\s*(```|~~~)[\w+-]*\s*$/;

export interface PromptPreview {
  /** The prompt on one line: fence markers dropped, every whitespace run collapsed. */
  text: string;
  /** Non-blank lines in the original prompt, so a pasted brief can say it is one. */
  lineCount: number;
}

export function toPromptPreview(prompt: string): PromptPreview {
  const lines = prompt.split(/\r?\n/).filter((line) => line.trim() !== "");
  const text = lines
    .filter((line) => !FENCE_LINE.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // A prompt that is nothing but fences still has to show something.
  return { text: text || prompt.replace(/\s+/g, " ").trim(), lineCount: lines.length };
}

export type MatchRange = readonly [number, number];

export interface PreviewExcerpt {
  text: string;
  indices: MatchRange[] | undefined;
}

/**
 * The characters that fit before a 608px palette's row ellipses the preview.
 * Deliberately conservative — an excerpt that starts a little early costs
 * nothing, one that starts too late hides the match it was cut for.
 */
const VISIBLE_CHARS = 48;
/** How much leading context an excerpt keeps before the first match. */
const LEAD_CHARS = 20;
/**
 * The row renders at most this much text. The layout truncates long before it,
 * but the row's text is also its accessible name, and a multi-kilobyte name
 * would be read out in full on every arrow press.
 */
export const PREVIEW_MAX_CHARS = 240;

/**
 * Cut the preview so the first match is on screen, and move the match ranges
 * with it. Browsing shows the prompt from its start; a search whose first match
 * would fall past the ellipsis starts a few words before the match instead,
 * behind a leading "…", so the row shows why it matched.
 */
export function excerptPreview(
  text: string,
  indices: readonly MatchRange[] | undefined
): PreviewExcerpt {
  const first = indices?.length ? Math.min(...indices.map(([start]) => start)) : 0;
  let start = 0;
  if (first > VISIBLE_CHARS) {
    const wordBreak = text.lastIndexOf(" ", first - LEAD_CHARS);
    start = wordBreak > 0 ? wordBreak + 1 : first - LEAD_CHARS;
  }
  const prefix = start > 0 ? "…" : "";
  const body = text.slice(start, start + PREVIEW_MAX_CHARS);
  const end = start + body.length;
  const shifted = indices
    ?.filter(([s]) => s >= start && s < end)
    .map(([s, e]): MatchRange => [
      s - start + prefix.length,
      Math.min(e, end - 1) - start + prefix.length,
    ]);
  return { text: prefix + body, indices: shifted?.length ? shifted : undefined };
}

/**
 * Where the query appears in the preview, for highlighting.
 *
 * Literal occurrences of each query word first: search ignores where in a
 * prompt a word sits, so the fuzzy scorer's own ranges over a long prompt are
 * scattered fragments of the query's letters, and painting those reads as
 * noise rather than as the reason the row matched. Only when no word occurs
 * literally (a typo) do the scorer's ranges stand in, and then only runs long
 * enough to mean something.
 */
export function findPreviewMatches(
  text: string,
  query: string,
  fuzzyRanges: readonly MatchRange[] | undefined
): MatchRange[] | undefined {
  const haystack = text.toLowerCase();
  const ranges: MatchRange[] = [];
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (word.length < 2) continue;
    for (
      let at = haystack.indexOf(word);
      at !== -1;
      at = haystack.indexOf(word, at + word.length)
    ) {
      ranges.push([at, at + word.length - 1]);
    }
  }
  if (ranges.length > 0) return ranges;
  const fuzzy = fuzzyRanges?.filter(([s, e]) => e - s >= 2);
  return fuzzy?.length ? [...fuzzy] : undefined;
}
