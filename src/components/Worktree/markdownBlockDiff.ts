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
/**
 * Total word-LCS cells one document may spend. The per-pair token cap alone
 * bounds one matrix at ~16MB but says nothing about how many get built: a
 * document at the block ceiling can hold 250 modified pairs, which would run
 * ~1e9 cell updates synchronously inside a single render. Pairs past the budget
 * keep their whole-block treatment and lose only the finer emphasis.
 */
export const MARKDOWN_DIFF_MAX_INLINE_CELLS = 4_000_000;

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
  /**
   * Normalized identifiers this block resolves through document-level
   * definitions. A change to one of those definitions changes what the block
   * renders even when its own source is byte-identical, so they are tracked
   * per-block: comparing the document's definitions wholesale would mark every
   * referencing block as edited whenever any unrelated definition moved.
   */
  referenceIds: readonly string[];
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
 * Split file content for comparison against a patch body.
 *
 * Unlike `DiffViewer`'s equivalent this KEEPS the empty trailing element a
 * newline-terminated file splits with, because the patch it is compared against
 * keeps it too: the added/untracked path in `WorkspaceService` builds its patch
 * by hand as `content.split("\n").map(l => "+" + l)`, so a file ending in a
 * newline contributes a final `+` line with nothing after it. Dropping the
 * element made every newline-terminated added Markdown file fail to
 * reconstruct.
 *
 * Carriage returns are stripped on both sides rather than one, so a CRLF file
 * matches whether or not the producer normalized them.
 */
function toComparableLines(source: string): string[] {
  // No empty-string special case: `"".split("\n")` is `[""]`, which is exactly
  // what the added-file producer emits for an empty file (one `+` line with
  // nothing after it). Returning no lines made every empty addition mismatch.
  return source.split("\n").map(stripCarriageReturn);
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Logical line count, ignoring the phantom element a trailing newline adds. */
function logicalLineCount(lines: readonly string[]): number {
  return lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/**
 * The hunk header's REAL line counts.
 *
 * `parseDiff` normalizes an omitted or zero count to 1, which erases the
 * difference between "one line" and "no lines on this side" — the shape every
 * addition, whole-file deletion and zero-context edit takes. The raw header
 * survives on the hunk, so read the counts from there and take only positions
 * from the parsed fields.
 */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function rawHunkCounts(hunk: HunkData): { old: number; new: number } | null {
  const match = HUNK_HEADER_RE.exec(hunk.content ?? "");
  if (!match) return null;
  return {
    old: match[2] === undefined ? 1 : Number(match[2]),
    new: match[4] === undefined ? 1 : Number(match[4]),
  };
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
    const counts = rawHunkCounts(hunk);
    if (!counts || !hunk.changes.length) return null;

    // Structural validation against the REAL counts, which the parsed fields
    // could not support. Without it a header may claim a span its body doesn't
    // fill, and the next hunk lands at an offset nothing checked — assembling a
    // document that never existed and presenting it as history.
    let bodyOld = 0;
    let bodyNew = 0;
    for (const change of hunk.changes) {
      if (change.type !== "insert") bodyOld++;
      if (change.type !== "delete") bodyNew++;
    }
    if (bodyOld !== counts.old || bodyNew !== counts.new) return null;

    // A zero-length side names the line BEFORE the range rather than its first
    // line, so a pure deletion under `diff.context=0` starts one line later
    // than its header reads, and a hunk emptying the file starts at 0.
    const start = counts.new === 0 ? hunk.newStart + 1 : hunk.newStart;
    if (start < newCursor) return null;
    for (let line = newCursor; line < start; line++) {
      const content = newLines[line - 1];
      if (content === undefined) return null;
      oldLines.push(content);
    }
    newCursor = start;
    for (const change of hunk.changes) {
      const content = stripCarriageReturn(change.content);
      if (change.type === "delete") {
        oldLines.push(content);
        continue;
      }
      if (newLines[newCursor - 1] !== content) return null;
      if (change.type === "normal") oldLines.push(content);
      newCursor++;
    }
  }
  for (let line = newCursor; line <= newLines.length; line++) {
    oldLines.push(newLines[line - 1] as string);
  }
  return oldLines;
}

/**
 * Rebuild a deleted file's content from the patch alone — every line is there.
 *
 * Held to the shape a real deletion has rather than merely to contiguity: every
 * change must be a delete and the new side must be genuinely empty. A patch
 * that only removes some lines from a still-present file satisfies contiguity,
 * and accepting it would present its surviving context lines as deleted prose.
 */
function oldSourceFromHunks(hunks: readonly HunkData[]): string[] | null {
  if (!hunks.length) return null;
  const oldLines: string[] = [];
  for (const hunk of hunks) {
    const counts = rawHunkCounts(hunk);
    if (!counts || counts.new !== 0 || !hunk.changes.length) return null;
    if (hunk.oldStart !== oldLines.length + 1) return null;
    if (hunk.changes.length !== counts.old) return null;
    for (const change of hunk.changes) {
      if (change.type !== "delete") return null;
      oldLines.push(stripCarriageReturn(change.content));
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
  const file = files[0];
  const hunks = file?.hunks ?? [];

  if (input.status === "deleted") {
    // The patch must agree that this is a deletion, not just the caller. A
    // panel holds the status it was opened with, and a zero-context patch that
    // merely strips a file's opening lines has the same hunk shape as a whole
    // file removed — accepting it would present surviving prose as deleted.
    if (file?.type !== "delete") return { ok: false, reason: "unsupported-patch" };
    // An empty file's deletion is metadata only; there is no hunk to rebuild.
    if (!hunks.length) return { ok: true, documents: { old: "", new: "" } };
    const oldLines = oldSourceFromHunks(hunks);
    if (!oldLines) return { ok: false, reason: "unsupported-patch" };
    if (oldLines.length > MARKDOWN_DIFF_MAX_LINES) return { ok: false, reason: "too-large" };
    return { ok: true, documents: { old: oldLines.join("\n"), new: "" } };
  }

  if (input.newSource === undefined) return { ok: false, reason: "source-required" };
  const newLines = toComparableLines(input.newSource);
  if (logicalLineCount(newLines) > MARKDOWN_DIFF_MAX_LINES) {
    return { ok: false, reason: "too-large" };
  }

  // A pure rename, copy or mode change carries no hunks: the content is
  // identical on both sides, and the rename is the whole story.
  //
  // Guarded on the header because `parseDiff` reports any text it cannot
  // understand as a hunkless "modify" of a file named `a` — indistinguishable
  // from a real rename by shape alone. Without this, arbitrary junk would
  // reconstruct as "both sides equal the file on disk" and render a clean,
  // entirely fictional no-op diff.
  if (!hunks.length) {
    if (!input.diff.trimStart().startsWith("diff --git ")) {
      return { ok: false, reason: "unsupported-patch" };
    }
    const content = newLines.join("\n");
    return { ok: true, documents: { old: content, new: content } };
  }

  const oldLines = reverseApplyHunks(newLines, hunks);
  if (!oldLines) return { ok: false, reason: "source-mismatch" };
  if (logicalLineCount(oldLines) > MARKDOWN_DIFF_MAX_LINES) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true, documents: { old: oldLines.join("\n"), new: newLines.join("\n") } };
}

// Frozen once: building the processor per parse re-runs plugin attachment for
// every document, and both sides of every file go through it.
const markdownProcessor = unified().use(remarkParse).use(remarkGfm).freeze();

const REFERENCE_TYPES: ReadonlySet<string> = new Set([
  "linkReference",
  "imageReference",
  "footnoteReference",
]);

/** Every definition identifier this block resolves through. */
function referenceIdsOf(node: RootContent): string[] {
  const ids = new Set<string>();
  const walk = (current: unknown): void => {
    if (typeof current !== "object" || current === null) return;
    const candidate = current as { type?: string; identifier?: unknown; children?: unknown };
    if (
      candidate.type !== undefined &&
      REFERENCE_TYPES.has(candidate.type) &&
      typeof candidate.identifier === "string"
    ) {
      ids.add(candidate.identifier);
    }
    if (Array.isArray(candidate.children)) {
      for (const child of candidate.children) walk(child);
    }
  };
  walk(node);
  return [...ids];
}

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
  /** Every definition's source, for appending to the blocks that cite them. */
  definitions: string;
  /** Definition source by normalized identifier, for detecting what moved. */
  definitionsById: ReadonlyMap<string, string>;
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
    return { blocks: [], definitions: "", definitionsById: new Map() };
  }
  const blocks: MarkdownBlock[] = [];
  const definitions: string[] = [];
  const definitionsById = new Map<string, string>();
  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const slice = source.slice(start, end);
    // Footnote definitions ride with link definitions rather than standing as
    // blocks of their own. A footnote definition rendered alone produces no
    // visible output, and the paragraph citing it would render a literal
    // `[^1]` — between them the note's text would vanish from the diff.
    if (node.type === "definition" || node.type === "footnoteDefinition") {
      definitions.push(slice);
      definitionsById.set(node.identifier, slice);
      continue;
    }
    if (node.type === "html") continue;
    blocks.push({
      type: node.type,
      source: slice,
      text: flattenText(node),
      referenceIds: referenceIdsOf(node),
    });
  }
  return { blocks, definitions: definitions.join("\n\n"), definitionsById };
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

interface TokenStats {
  bag: Map<string, number>;
  count: number;
}

/** Multiset of lowercased non-whitespace tokens, for the similarity score. */
function tokenStats(text: string): TokenStats {
  const bag = new Map<string, number>();
  let count = 0;
  for (const token of tokenize(text)) {
    if (!/\S/.test(token)) continue;
    const key = token.toLowerCase();
    bag.set(key, (bag.get(key) ?? 0) + 1);
    count++;
  }
  return { bag, count };
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
  return similarityFrom(oldText, newText, tokenStats(oldText), tokenStats(newText));
}

/**
 * The scoring itself, taking token stats the caller already holds. `pairGap`
 * compares every candidate against every other, so recomputing both bags per
 * comparison would re-tokenize each block once per counterpart.
 */
function similarityFrom(
  oldText: string,
  newText: string,
  oldStats: TokenStats,
  newStats: TokenStats
): number {
  if (oldText === "" || newText === "") return 0;
  const minLength = Math.min(oldText.length, newText.length);
  const maxLength = Math.max(oldText.length, newText.length);
  const lengthRatio = minLength / maxLength;
  if (lengthRatio < PAIR_LENGTH_RATIO_FLOOR) return 0;

  if (oldStats.count === 0 || newStats.count === 0) return 0;
  let overlap = 0;
  for (const [token, count] of oldStats.bag) {
    overlap += Math.min(count, newStats.bag.get(token) ?? 0);
  }
  const dice = (2 * overlap) / (oldStats.count + newStats.count);

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
export interface InlineCellBudget {
  remaining: number;
}

const NO_RANGES: InlineRanges = { old: [], new: [] };

export function inlineWordRanges(
  oldText: string,
  newText: string,
  budget?: InlineCellBudget
): InlineRanges {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  // Per-pair cap, then the document-wide one: past either the pair keeps its
  // whole-block treatment and loses only the finer emphasis.
  if (oldTokens.length > MARKDOWN_DIFF_MAX_INLINE_TOKENS) return NO_RANGES;
  if (newTokens.length > MARKDOWN_DIFF_MAX_INLINE_TOKENS) return NO_RANGES;
  const cells = (oldTokens.length + 1) * (newTokens.length + 1);
  if (budget) {
    if (cells > budget.remaining) return NO_RANGES;
    budget.remaining -= cells;
  }

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
  newBlocks: readonly MarkdownBlock[],
  budget: InlineCellBudget
): MarkdownBlockChange[] {
  if (!oldBlocks.length) return newBlocks.map((block) => ({ kind: "added" as const, block }));
  if (!newBlocks.length) return oldBlocks.map((block) => ({ kind: "removed" as const, block }));

  const rows = oldBlocks.length + 1;
  const cols = newBlocks.length + 1;
  const scores = new Float64Array(rows * cols);
  const candidate = new Float64Array(oldBlocks.length * newBlocks.length);
  // Tokenized once per block rather than once per comparison — the matrix is
  // quadratic, so the difference is a block's tokens counted once against being
  // counted for every counterpart it is measured against.
  const oldStats = oldBlocks.map((block) => tokenStats(block.text));
  const newStats = newBlocks.map((block) => tokenStats(block.text));
  for (let i = 0; i < oldBlocks.length; i++) {
    for (let j = 0; j < newBlocks.length; j++) {
      const oldBlock = oldBlocks[i] as MarkdownBlock;
      const newBlock = newBlocks[j] as MarkdownBlock;
      const score =
        oldBlock.type === newBlock.type
          ? similarityFrom(
              oldBlock.text,
              newBlock.text,
              oldStats[i] as TokenStats,
              newStats[j] as TokenStats
            )
          : 0;
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
            ? NO_RANGES
            : inlineWordRanges(oldBlock.text, newBlock.text, budget),
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
  newBlocks: readonly MarkdownBlock[],
  /**
   * Identifiers whose definition differs between the two sides. A block whose
   * own source is byte-identical still renders differently when a definition it
   * resolves through has moved, so those blocks cannot anchor as unchanged.
   */
  changedDefinitionIds: ReadonlySet<string> = new Set()
): { ok: true; changes: MarkdownBlockChange[] } | { ok: false; reason: MarkdownDiffFailure } {
  if (oldBlocks.length > MARKDOWN_DIFF_MAX_BLOCKS || newBlocks.length > MARKDOWN_DIFF_MAX_BLOCKS) {
    return { ok: false, reason: "too-large" };
  }
  const anchors = longestCommonSubsequence(
    oldBlocks.map((block) => block.source),
    newBlocks.map((block) => block.source)
  );
  const budget: InlineCellBudget = { remaining: MARKDOWN_DIFF_MAX_INLINE_CELLS };
  const changes: MarkdownBlockChange[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  for (const [oldIndex, newIndex] of anchors) {
    changes.push(
      ...pairGap(oldBlocks.slice(oldCursor, oldIndex), newBlocks.slice(newCursor, newIndex), budget)
    );
    const oldBlock = oldBlocks[oldIndex] as MarkdownBlock;
    const newBlock = newBlocks[newIndex] as MarkdownBlock;
    // Identical source, but it renders through a definition that moved — so the
    // block really did change and must not be reported as untouched. The word
    // marks stay empty: the text is the same, the target behind it is not.
    //
    // Both sides' identifiers count. Removing a definition outright makes the
    // new side parse `[docs][d]` as literal text with no reference at all, so
    // testing the new block alone would miss exactly the case where the
    // rendered output changed most.
    const touchesMovedDefinition =
      oldBlock.referenceIds.some((id) => changedDefinitionIds.has(id)) ||
      newBlock.referenceIds.some((id) => changedDefinitionIds.has(id));
    changes.push(
      touchesMovedDefinition
        ? { kind: "modified", old: oldBlock, new: newBlock, inline: NO_RANGES }
        : { kind: "unchanged", block: newBlock }
    );
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  changes.push(...pairGap(oldBlocks.slice(oldCursor), newBlocks.slice(newCursor), budget));
  return { ok: true, changes };
}

/** The whole pipeline: patch plus disk source in, block changes out. */
export function buildMarkdownDiff(input: ReconstructInput): MarkdownDiffResult {
  const reconstructed = reconstructMarkdownDocuments(input);
  if (!reconstructed.ok) return reconstructed;

  const oldParsed = parseMarkdownBlocks(reconstructed.documents.old);
  const newParsed = parseMarkdownBlocks(reconstructed.documents.new);
  const changedDefinitionIds = new Set<string>();
  for (const id of new Set([
    ...oldParsed.definitionsById.keys(),
    ...newParsed.definitionsById.keys(),
  ])) {
    if (oldParsed.definitionsById.get(id) !== newParsed.definitionsById.get(id)) {
      changedDefinitionIds.add(id);
    }
  }
  const diffed = diffMarkdownBlocks(oldParsed.blocks, newParsed.blocks, changedDefinitionIds);
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
