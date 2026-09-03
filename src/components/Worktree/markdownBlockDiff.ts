import { parseDiff } from "react-diff-view";
import type { HunkData } from "react-diff-view";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root, RootContent } from "mdast";
import type { GitStatus } from "@shared/types/git";
import { shouldSuppressEdits } from "./diffEditSuppression";

/**
 * The rendered-Markdown diff engine (issue #12171): everything between a
 * unified patch and the block list `RenderedMarkdownDiff` paints. Pure and
 * synchronous — no React, no DOM — so the whole pipeline is unit-testable and
 * could move to a worker later without touching the component.
 *
 * Three stages, in order:
 *   1. Reconstruct the full old and new documents. Rendering a hunk in
 *      isolation is meaningless (a list item without its list, a table row
 *      without its header), so both sides must be whole documents.
 *   2. Split each side into top-level Markdown blocks and match them by an
 *      exact-source LCS, then pair the leftovers by similarity.
 *   3. Word-diff each paired block's visible text, under the same coverage
 *      judgment the line diff applies (`shouldSuppressEdits`).
 */

/** Why the rendered view can't be built from these inputs. */
export type MarkdownDiffFailure =
  "unsupported-patch" | "source-required" | "source-mismatch" | "too-large";

/**
 * Ceilings. The reconstruction ceiling matches the diff viewer's full-file
 * expansion limit — both commit an unvirtualized document to the DOM, so the
 * point where that stops being responsive is the same. The block and cell
 * ceilings bound the two quadratic matrices; a document that trips one falls
 * back to the source diff rather than degrading silently.
 */
export const MARKDOWN_DIFF_MAX_LINES = 5000;
export const MARKDOWN_DIFF_MAX_BLOCKS = 500;
export const MARKDOWN_DIFF_MAX_INLINE_TOKENS = 2000;

/** Below this the two blocks are too different in length to be the same block. */
const PAIR_LENGTH_RATIO_FLOOR = 0.25;

/**
 * Similarity a removed/added pair must reach to render as one modified block
 * rather than two. Tuned to pair an edited sentence with its rewrite while
 * leaving genuinely unrelated paragraphs apart; exported so a real-world miss
 * is a one-constant adjustment rather than an algorithm rewrite.
 */
export const PAIR_SIMILARITY_THRESHOLD = 0.45;

export interface MarkdownBlock {
  /** mdast node type — `paragraph`, `list`, `table`, `code`, … */
  type: string;
  /**
   * The block's verbatim source slice, which is also its exact-match identity.
   * Deliberately unnormalized: rendered mode always requests a
   * whitespace-sensitive patch, so a whitespace-only edit is a real edit here.
   */
  source: string;
  /** Visible text, flattened for similarity scoring and the word diff. */
  text: string;
}

/** Half-open character range into a block's `text`. */
export interface TextRange {
  start: number;
  end: number;
}

export interface InlineRanges {
  /** Ranges deleted from the old block, or empty when suppressed. */
  old: readonly TextRange[];
  /** Ranges inserted into the new block, or empty when suppressed. */
  new: readonly TextRange[];
}

export type MarkdownBlockChange =
  | { kind: "unchanged"; block: MarkdownBlock }
  | { kind: "removed"; block: MarkdownBlock }
  | { kind: "added"; block: MarkdownBlock }
  | { kind: "modified"; old: MarkdownBlock; new: MarkdownBlock; inline: InlineRanges };

export interface MarkdownDiffModel {
  changes: readonly MarkdownBlockChange[];
  /**
   * Link/image reference definitions from each side, appended to every block
   * before it renders. A definition lives anywhere in the document but is
   * referenced from a block, so a block rendered on its own would otherwise
   * lose the target. They render to nothing, so appending them unconditionally
   * costs a few bytes and removes a whole class of per-block bookkeeping.
   */
  oldDefinitions: string;
  newDefinitions: string;
  /**
   * No block changed. The source did (there was a patch), so the change was
   * invisible to the renderer: raw HTML under `skipHtml`, or trailing
   * whitespace. Callers say so rather than showing an empty pane.
   */
  identical: boolean;
}

export type MarkdownDiffResult =
  { ok: true; model: MarkdownDiffModel } | { ok: false; reason: MarkdownDiffFailure };

/**
 * Split file content into lines, dropping the phantom trailing element a
 * newline-terminated file splits with and the carriage returns a CRLF checkout
 * carries but git's patch text does not. Same normalization `DiffViewer` does
 * for full-file expansion — kept local so the lazy Markdown chunk doesn't pull
 * the diff viewer component in behind it.
 */
function toSourceLines(source: string): string[] {
  if (source === "") return [];
  const lines = source.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Rebuild the old document by walking the new one and swapping each hunk's
 * new-side lines back for its old-side lines.
 *
 * Every line a hunk names is verified against the supplied source as it goes,
 * so a source that has drifted from the patch is rejected rather than rendered
 * as plausible-looking prose from a different revision. Lines in the gaps
 * between hunks are trusted, which is sound because the caller only offers this
 * mode for disk-backed diff sources and withdraws it the moment the worktree
 * store reports the file changed.
 */
function reverseApplyHunks(
  newLines: readonly string[],
  hunks: readonly HunkData[]
): string[] | null {
  const oldLines: string[] = [];
  // 1-based index of the next new-side line still to be consumed.
  let newCursor = 1;
  for (const hunk of hunks) {
    if (hunk.newStart < newCursor) return null;
    for (let line = newCursor; line < hunk.newStart; line++) {
      const content = newLines[line - 1];
      if (content === undefined) return null;
      oldLines.push(content);
    }
    newCursor = hunk.newStart;
    for (const change of hunk.changes) {
      if (change.type === "delete") {
        oldLines.push(change.content);
        continue;
      }
      if (newLines[newCursor - 1] !== change.content) return null;
      if (change.type === "normal") oldLines.push(change.content);
      newCursor++;
    }
    // The header's declared line counts are deliberately not asserted against
    // the body: react-diff-view normalizes a zero-length side (`@@ -0,0` on an
    // added file) to a count of 1, so the two legitimately disagree. The real
    // guard is above — every new-side line a hunk names is matched against the
    // file on disk, which catches drift the counts never would, and a hunk that
    // consumed the wrong number of lines is caught by the monotonic newStart
    // check on the next one.
  }
  for (let line = newCursor; line <= newLines.length; line++) {
    oldLines.push(newLines[line - 1] as string);
  }
  return oldLines;
}

/** Rebuild a deleted file's content from the patch alone — every line is there. */
function oldSourceFromHunks(hunks: readonly HunkData[]): string[] | null {
  if (!hunks.length || hunks[0]?.oldStart !== 1) return null;
  const oldLines: string[] = [];
  for (const hunk of hunks) {
    if (hunk.oldStart !== oldLines.length + 1) return null;
    for (const change of hunk.changes) {
      if (change.type === "insert") return null;
      oldLines.push(change.content);
    }
  }
  return oldLines;
}

export interface ReconstructInput {
  /** Raw unified patch text, as `useDiffContent` returns it. */
  diff: string;
  /** Whole new-side file from disk; absent for a deleted file. */
  newSource: string | undefined;
  status: GitStatus;
}

export interface MarkdownDocuments {
  old: string;
  new: string;
}

/**
 * Recover both whole documents from the patch plus the new side on disk.
 * A new IPC returning the old blob would be more direct, but the only existing
 * git blob reader is exposed behind an image-MIME gate that returns data URLs,
 * so reaching it would mean designing a new text-blob channel for a view that
 * this reconstruction already serves.
 */
export function reconstructMarkdownDocuments(
  input: ReconstructInput
): { ok: true; documents: MarkdownDocuments } | { ok: false; reason: MarkdownDiffFailure } {
  let files;
  try {
    files = parseDiff(input.diff);
  } catch (error) {
    console.warn("[markdownBlockDiff] failed to parse diff", error);
    return { ok: false, reason: "unsupported-patch" };
  }
  if (files.length !== 1) return { ok: false, reason: "unsupported-patch" };
  const hunks = files[0]?.hunks ?? [];

  if (input.status === "deleted") {
    const oldLines = oldSourceFromHunks(hunks);
    if (!oldLines) return { ok: false, reason: "unsupported-patch" };
    if (oldLines.length > MARKDOWN_DIFF_MAX_LINES) return { ok: false, reason: "too-large" };
    return { ok: true, documents: { old: oldLines.join("\n"), new: "" } };
  }

  if (input.newSource === undefined) return { ok: false, reason: "source-required" };
  const newLines = toSourceLines(input.newSource);
  if (newLines.length > MARKDOWN_DIFF_MAX_LINES) return { ok: false, reason: "too-large" };

  // A pure rename, copy or mode change carries no hunks: the content is
  // identical on both sides, and the rename is the whole story.
  //
  // Guarded on the header because `parseDiff` reports any text it cannot
  // understand as a hunkless "modify" of a file named `a` — indistinguishable
  // from a real rename by shape alone. Without this, arbitrary junk would
  // reconstruct as "both sides equal the file on disk" and render a clean,
  // entirely fictional no-op diff.
  if (!hunks.length) {
    if (!/^diff --git /m.test(input.diff)) return { ok: false, reason: "unsupported-patch" };
    const content = newLines.join("\n");
    return { ok: true, documents: { old: content, new: content } };
  }

  const oldLines = reverseApplyHunks(newLines, hunks);
  if (!oldLines) return { ok: false, reason: "source-mismatch" };
  if (oldLines.length > MARKDOWN_DIFF_MAX_LINES) return { ok: false, reason: "too-large" };
  return { ok: true, documents: { old: oldLines.join("\n"), new: newLines.join("\n") } };
}

// Frozen once: building the processor per parse re-runs plugin attachment for
// every document, and both sides of every file go through it.
const markdownProcessor = unified().use(remarkParse).use(remarkGfm).freeze();

/**
 * Concatenate every visible character a node contributes, in document order.
 *
 * The offsets this produces are matched against the rendered tree before any
 * inline mark is placed, so the traversal deliberately mirrors what
 * `mdast-util-to-hast` emits: a fence body gains the trailing newline the hast
 * `code` handler adds, a hard break is a newline, and raw HTML contributes
 * nothing because `skipHtml` drops it before it renders. Where the two still
 * disagree the renderer notices and falls back to whole-block marking, so this
 * needs to be right for the common shapes rather than exhaustive.
 */
function flattenText(node: RootContent): string {
  const parts: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    const candidate = current as { type?: string; value?: unknown; children?: unknown };
    if (candidate.type === "html") return;
    if (typeof candidate.value === "string") {
      parts.push(
        candidate.type === "code" && candidate.value ? `${candidate.value}\n` : candidate.value
      );
      return;
    }
    // A break is a visible boundary; without a separator the words either side
    // of it fuse into one token and the word diff reports a spurious edit.
    if (candidate.type === "break") {
      parts.push("\n");
      return;
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) walk(child);
    }
  };
  walk(node);
  return parts.join("");
}

export interface ParsedMarkdown {
  blocks: readonly MarkdownBlock[];
  definitions: string;
}

/**
 * Split a document into the top-level blocks the rendered diff marks up.
 *
 * Every top-level mdast child is one block, so a list or a table stays atomic:
 * splitting them would emit invalid HTML fragments, and it is also the honest
 * granularity — restructuring a list is a change to the list.
 *
 * Raw `html` nodes are dropped rather than kept as blocks. `MarkdownDocument`
 * renders with `skipHtml` and no `rehype-raw`, which is the boundary that lets
 * arbitrary repo files render inside an Electron renderer at all; a retained
 * html block would be an empty tinted box standing for something invisible.
 */
export function parseMarkdownBlocks(source: string): ParsedMarkdown {
  let tree: Root;
  try {
    tree = markdownProcessor.parse(source);
  } catch (error) {
    console.warn("[markdownBlockDiff] failed to parse markdown", error);
    return { blocks: [], definitions: "" };
  }
  const blocks: MarkdownBlock[] = [];
  const definitions: string[] = [];
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const slice = source.slice(start, end);
    if (node.type === "definition") {
      definitions.push(slice);
      continue;
    }
    if (node.type === "html") continue;
    blocks.push({ type: node.type, source: slice, text: flattenText(node) });
  }
  return { blocks, definitions: definitions.join("\n") };
}

/**
 * Indices of a longest common subsequence of two arrays, by exact equality.
 * Uint32Array over a nested array keeps a 500×500 table at 1MB and flat.
 */
function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[]
): Array<[number, number]> {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        left[i] === right[j]
          ? (table[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) {
      // Ties drop the left element first, so duplicate blocks anchor
      // deterministically to their earliest counterpart.
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

const WORD_TOKEN_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;

function tokenize(text: string): string[] {
  return text.match(WORD_TOKEN_RE) ?? [];
}

/** Multiset of lowercased non-whitespace tokens, for the similarity score. */
function tokenBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (!/\S/.test(token)) continue;
    const key = token.toLowerCase();
    bag.set(key, (bag.get(key) ?? 0) + 1);
  }
  return bag;
}

function commonAffixLength(a: string, b: string, fromEnd: boolean): number {
  const limit = Math.min(a.length, b.length);
  let count = 0;
  while (count < limit) {
    const left = fromEnd ? a[a.length - 1 - count] : a[count];
    const right = fromEnd ? b[b.length - 1 - count] : b[count];
    if (left !== right) break;
    count++;
  }
  return count;
}

/**
 * How alike two same-type blocks are, in [0, 1].
 *
 * Token overlap carries the score because prose edits keep most of their words;
 * the shared prefix/suffix term is the tiebreak that favours a block edited at
 * one end over an unrelated one of similar vocabulary — the same shape of
 * judgment `diffTokenizer`'s `edgeSimilarity` makes for line pairing. The
 * length ratio multiplies rather than gates, so a paragraph that grew by half
 * still pairs while one that grew tenfold does not.
 */
export function blockSimilarity(oldText: string, newText: string): number {
  if (oldText === "" || newText === "") return 0;
  const minLength = Math.min(oldText.length, newText.length);
  const maxLength = Math.max(oldText.length, newText.length);
  const lengthRatio = minLength / maxLength;
  if (lengthRatio < PAIR_LENGTH_RATIO_FLOOR) return 0;

  const oldBag = tokenBag(oldText);
  const newBag = tokenBag(newText);
  let oldCount = 0;
  for (const count of oldBag.values()) oldCount += count;
  let newCount = 0;
  for (const count of newBag.values()) newCount += count;
  if (oldCount === 0 || newCount === 0) return 0;
  let overlap = 0;
  for (const [token, count] of oldBag) {
    overlap += Math.min(count, newBag.get(token) ?? 0);
  }
  const dice = (2 * overlap) / (oldCount + newCount);

  const prefix = commonAffixLength(oldText, newText, false);
  const suffix = Math.min(commonAffixLength(oldText, newText, true), minLength - prefix);
  const edge = (prefix + Math.max(suffix, 0)) / minLength;

  return lengthRatio * (0.8 * dice + 0.2 * edge);
}

/**
 * Word-level ranges for one modified pair, or empty ranges where the marks
 * would stop earning their place.
 *
 * Each side is judged on its own coverage: a block that lost a clause but
 * gained a rewrite should keep the precise deletion marks even though the
 * insertion side is a wash. That is the same per-side independence
 * `suppressFullLineEdits` applies.
 */
export function inlineWordRanges(oldText: string, newText: string): InlineRanges {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  // Both matrices are bounded by the same budget the line tokenizer applies to
  // intra-line marks: past it the pair keeps its whole-block treatment and
  // loses only the finer emphasis.
  if (oldTokens.length > MARKDOWN_DIFF_MAX_INLINE_TOKENS) return { old: [], new: [] };
  if (newTokens.length > MARKDOWN_DIFF_MAX_INLINE_TOKENS) return { old: [], new: [] };

  const matches = longestCommonSubsequence(oldTokens, newTokens);
  const oldMatched = new Set<number>();
  const newMatched = new Set<number>();
  for (const [oldIndex, newIndex] of matches) {
    oldMatched.add(oldIndex);
    newMatched.add(newIndex);
  }

  const collect = (tokens: readonly string[], matched: ReadonlySet<number>) => {
    const ranges: TextRange[] = [];
    let offset = 0;
    let runStart: number | null = null;
    tokens.forEach((token, index) => {
      if (matched.has(index)) {
        if (runStart !== null) {
          ranges.push({ start: runStart, end: offset });
          runStart = null;
        }
      } else if (runStart === null) {
        runStart = offset;
      }
      offset += token.length;
    });
    if (runStart !== null) ranges.push({ start: runStart, end: offset });
    return ranges;
  };

  const oldRanges = collect(oldTokens, oldMatched);
  const newRanges = collect(newTokens, newMatched);

  const judge = (text: string, ranges: readonly TextRange[]): readonly TextRange[] => {
    let edited = 0;
    let editedText = "";
    for (const range of ranges) {
      edited += range.end - range.start;
      editedText += text.slice(range.start, range.end);
    }
    return shouldSuppressEdits(text.length, edited, editedText) ? [] : ranges;
  };

  return { old: judge(oldText, oldRanges), new: judge(newText, newRanges) };
}

/**
 * Pair the leftovers between two exact-match anchors.
 *
 * A score-maximizing walk rather than greedy nearest-match: greedy pairing
 * crosses over when a block is inserted mid-gap, which reads as two unrelated
 * blocks being "edited into" each other. Only same-type candidates are
 * considered, so a list item promoted to a blockquote necessarily degrades to a
 * removal followed by an addition — the legible failure the issue asks for
 * rather than a nonsense edit.
 */
function pairGap(
  oldBlocks: readonly MarkdownBlock[],
  newBlocks: readonly MarkdownBlock[]
): MarkdownBlockChange[] {
  if (!oldBlocks.length) return newBlocks.map((block) => ({ kind: "added" as const, block }));
  if (!newBlocks.length) return oldBlocks.map((block) => ({ kind: "removed" as const, block }));

  const rows = oldBlocks.length + 1;
  const cols = newBlocks.length + 1;
  const scores = new Float64Array(rows * cols);
  const candidate = new Float64Array(oldBlocks.length * newBlocks.length);
  for (let i = 0; i < oldBlocks.length; i++) {
    for (let j = 0; j < newBlocks.length; j++) {
      const oldBlock = oldBlocks[i] as MarkdownBlock;
      const newBlock = newBlocks[j] as MarkdownBlock;
      const score =
        oldBlock.type === newBlock.type ? blockSimilarity(oldBlock.text, newBlock.text) : 0;
      candidate[i * newBlocks.length + j] = score >= PAIR_SIMILARITY_THRESHOLD ? score : 0;
    }
  }
  for (let i = oldBlocks.length - 1; i >= 0; i--) {
    for (let j = newBlocks.length - 1; j >= 0; j--) {
      const paired =
        (candidate[i * newBlocks.length + j] as number) > 0
          ? (candidate[i * newBlocks.length + j] as number) +
            (scores[(i + 1) * cols + j + 1] as number)
          : -1;
      scores[i * cols + j] = Math.max(
        paired,
        scores[(i + 1) * cols + j] as number,
        scores[i * cols + j + 1] as number
      );
    }
  }

  const changes: MarkdownBlockChange[] = [];
  let i = 0;
  let j = 0;
  while (i < oldBlocks.length && j < newBlocks.length) {
    const score = candidate[i * newBlocks.length + j] as number;
    const paired = score > 0 ? score + (scores[(i + 1) * cols + j + 1] as number) : -1;
    const current = scores[i * cols + j] as number;
    if (paired === current) {
      const oldBlock = oldBlocks[i] as MarkdownBlock;
      const newBlock = newBlocks[j] as MarkdownBlock;
      changes.push({
        kind: "modified",
        old: oldBlock,
        new: newBlock,
        // A fence's body is highlighted source, not prose; word marks inside it
        // fight the syntax colouring for the same characters. The block keeps
        // its removed/added treatment, which is the readable signal there.
        inline:
          oldBlock.type === "code"
            ? { old: [], new: [] }
            : inlineWordRanges(oldBlock.text, newBlock.text),
      });
      i++;
      j++;
    } else if (current === (scores[(i + 1) * cols + j] as number)) {
      changes.push({ kind: "removed", block: oldBlocks[i] as MarkdownBlock });
      i++;
    } else {
      changes.push({ kind: "added", block: newBlocks[j] as MarkdownBlock });
      j++;
    }
  }
  for (; i < oldBlocks.length; i++) {
    changes.push({ kind: "removed", block: oldBlocks[i] as MarkdownBlock });
  }
  for (; j < newBlocks.length; j++) {
    changes.push({ kind: "added", block: newBlocks[j] as MarkdownBlock });
  }
  return changes;
}

/** Match blocks exactly, then pair what's left in each gap by similarity. */
export function diffMarkdownBlocks(
  oldBlocks: readonly MarkdownBlock[],
  newBlocks: readonly MarkdownBlock[]
): { ok: true; changes: MarkdownBlockChange[] } | { ok: false; reason: MarkdownDiffFailure } {
  if (oldBlocks.length > MARKDOWN_DIFF_MAX_BLOCKS || newBlocks.length > MARKDOWN_DIFF_MAX_BLOCKS) {
    return { ok: false, reason: "too-large" };
  }
  const anchors = longestCommonSubsequence(
    oldBlocks.map((block) => block.source),
    newBlocks.map((block) => block.source)
  );
  const changes: MarkdownBlockChange[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldIndex, newIndex] of anchors) {
    changes.push(
      ...pairGap(oldBlocks.slice(oldCursor, oldIndex), newBlocks.slice(newCursor, newIndex))
    );
    changes.push({ kind: "unchanged", block: newBlocks[newIndex] as MarkdownBlock });
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  changes.push(...pairGap(oldBlocks.slice(oldCursor), newBlocks.slice(newCursor)));
  return { ok: true, changes };
}

/** The whole pipeline: patch plus disk source in, block changes out. */
export function buildMarkdownDiff(input: ReconstructInput): MarkdownDiffResult {
  const reconstructed = reconstructMarkdownDocuments(input);
  if (!reconstructed.ok) return reconstructed;

  const oldParsed = parseMarkdownBlocks(reconstructed.documents.old);
  const newParsed = parseMarkdownBlocks(reconstructed.documents.new);
  const diffed = diffMarkdownBlocks(oldParsed.blocks, newParsed.blocks);
  if (!diffed.ok) return diffed;

  return {
    ok: true,
    model: {
      changes: diffed.changes,
      oldDefinitions: oldParsed.definitions,
      newDefinitions: newParsed.definitions,
      identical: diffed.changes.every((change) => change.kind === "unchanged"),
    },
  };
}
