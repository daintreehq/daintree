import { tokenize, markEdits, pickRanges } from "react-diff-view";
import type { HunkData, HunkTokens, TokenizeOptions } from "react-diff-view";
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
  | ({ id: number; ok: true } & DiffTokenizeResult)
  | { id: number; ok: false; error: string };

/** Changed-line budget above which word-level edit marking is skipped. */
export const MAX_INTRALINE_CHANGES = 3000;

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
    const options: TokenizeOptions = {
      highlight,
      refractor: refractorAdapter,
      language,
      enhancers: [
        ...(shouldMarkIntraLineEdits(hunks)
          ? [markEdits(hunks, { type: "block" }), suppressFullLineEdits()]
          : []),
        ...(extraRanges ? [pickRanges(extraRanges.old, extraRanges.new)] : []),
      ],
    };
    return { tokens: tokenize(hunks, options) ?? null, langLoadFailed };
  } catch (err) {
    // A null token pass silently degrades highlighting, edit pills, and
    // search marks to plain text — keep the failure observable.
    console.warn("Diff tokenization failed", err);
    return { tokens: null, langLoadFailed };
  }
}
