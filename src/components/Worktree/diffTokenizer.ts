import { markEdits, pickRanges } from "react-diff-view";
import type { ChangeData, HunkData, HunkTokens, TokenizeEnhancer } from "react-diff-view";
import { tokenizeFast, type FastTokenizeOptions } from "./diffTokenizePipeline";
import {
  ensureLanguage,
  isLanguageFailed,
  isLanguageRegistered,
  refractorAdapter,
} from "./diffRefractor";
import { suppressFullLineEdits } from "./diffEditSuppression";
import type { SideRanges } from "./diffTokenRanges";

export interface DiffTokenizeRequest {
  hunks: HunkData[];
  language: string;
  highlight: boolean;
  extraRanges: SideRanges | null;
}

export interface DiffTokenizeResult {
  tokens: HunkTokens | null;
  langLoadFailed: boolean;
}

export type DiffTokenizeWorkerRequest = DiffTokenizeRequest & { id: number };

export type DiffTokenizeWorkerResponse =
  ({ id: number; ok: true } & DiffTokenizeResult) | { id: number; ok: false; error: string };

/** Changed-line budget above which word-level edit marking is skipped. */
export const MAX_INTRALINE_CHANGES = 3000;
const MIN_LINE_ALIGNED_BLOCK_LINES = 8;
const MIN_LINE_PAIR_EDGE_SIMILARITY = 0.35;

function edgeSimilarity(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  if (limit === 0) return 0;
  let prefix = 0;
  while (prefix < limit && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return (prefix + suffix) / limit;
}

function shouldLineAlignBlock(deletes: ChangeData[], inserts: ChangeData[]): boolean {
  if (deletes.length !== inserts.length || deletes.length < MIN_LINE_ALIGNED_BLOCK_LINES) {
    return false;
  }
  for (let i = 0; i < deletes.length; i += 1) {
    if (edgeSimilarity(deletes[i]!.content, inserts[i]!.content) < MIN_LINE_PAIR_EDGE_SIMILARITY) {
      return false;
    }
  }
  return true;
}

function intralineEditEnhancers(hunks: HunkData[]): TokenizeEnhancer[] {
  let hasLineAligned = false;
  let hasBlock = false;
  const lineAlignedHunks: HunkData[] = [];
  const blockHunks: HunkData[] = [];

  for (const hunk of hunks) {
    const lineAlignedChanges: ChangeData[] = [];
    const blockChanges: ChangeData[] = [];
    const changes = hunk.changes;
    for (let start = 0; start < changes.length;) {
      if (changes[start]!.type === "normal") {
        lineAlignedChanges.push(changes[start]!);
        blockChanges.push(changes[start]!);
        start += 1;
        continue;
      }

      let end = start + 1;
      while (end < changes.length && changes[end]!.type !== "normal") end += 1;
      const block = changes.slice(start, end);
      const deletes = block.filter((change) => change.type === "delete");
      const inserts = block.filter((change) => change.type === "insert");
      if (shouldLineAlignBlock(deletes, inserts)) {
        for (let i = 0; i < deletes.length; i += 1) {
          lineAlignedChanges.push(deletes[i]!, inserts[i]!);
        }
        hasLineAligned = true;
      } else {
        blockChanges.push(...block);
        hasBlock = true;
      }
      start = end;
    }
    lineAlignedHunks.push({ ...hunk, changes: lineAlignedChanges });
    blockHunks.push({ ...hunk, changes: blockChanges });
  }

  const enhancers: TokenizeEnhancer[] = [];
  if (hasLineAligned) enhancers.push(markEdits(lineAlignedHunks, { type: "line" }));
  if (hasBlock) enhancers.push(markEdits(blockHunks, { type: "block" }));
  return enhancers;
}

// Past the budget, intra-line diffing (diff-match-patch per change block) is
// churn-on-churn: the marks stop being review signal and the per-block diffs
// get slow. Whole-line fills only — the same large-hunk fallback git
// diff-highlight and VS Code apply.
function shouldMarkIntraLineEdits(hunks: HunkData[]): boolean {
  let changedLines = 0;
  for (const hunk of hunks) {
    for (const change of hunk.changes) {
      if (change.type !== "normal") changedLines++;
    }
  }
  return changedLines <= MAX_INTRALINE_CHANGES;
}

/**
 * The one tokenize implementation — the Web Worker and the in-thread fallback
 * both call this, so their behavior can't drift. Grammar loading is lazy per
 * language; failures downgrade to an unhighlighted pass and are reported via
 * langLoadFailed.
 */
export async function runDiffTokenize(request: DiffTokenizeRequest): Promise<DiffTokenizeResult> {
  const { hunks, language, highlight, extraRanges } = request;
  if (highlight) await ensureLanguage(language);
  const langLoadFailed = isLanguageFailed(language);
  if (highlight && !isLanguageRegistered(language)) {
    return { tokens: null, langLoadFailed };
  }
  try {
    const options: FastTokenizeOptions = {
      highlight,
      refractor: refractorAdapter,
      language,
      enhancers: [
        ...(shouldMarkIntraLineEdits(hunks)
          ? [...intralineEditEnhancers(hunks), suppressFullLineEdits()]
          : []),
        ...(extraRanges ? [pickRanges(extraRanges.old, extraRanges.new)] : []),
      ],
    };
    return { tokens: tokenizeFast(hunks, options), langLoadFailed };
  } catch (err) {
    // A null token pass silently degrades highlighting, edit pills, and
    // search marks to plain text — keep the failure observable.
    console.warn("Diff tokenization failed", err);
    return { tokens: null, langLoadFailed };
  }
}
