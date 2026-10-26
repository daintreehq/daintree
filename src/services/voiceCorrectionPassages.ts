import type { DictationRecord, DictationUtterance } from "@/store/dictationRangeStore";

// Draft text before a passage sent as correction context, so a dictation that
// continues a typed sentence isn't recased as if it stood alone.
const CONTEXT_CHARS = 500;

/**
 * A run of one dictation's words that correction may rewrite: everything
 * between its first and last word was written by the session itself, so text
 * typed or pasted into the draft never sits inside one.
 */
export interface CorrectionPassage {
  utteranceIds: string[];
  from: number;
  to: number;
  text: string;
  /** The draft before the passage, bounded, without the passage's separator. */
  context: string;
}

function leftContext(draft: string, from: number): string {
  const start = Math.max(0, from - CONTEXT_CHARS);
  let context = draft.slice(start, from);
  // Drop the word the bound cut through, if it cut one.
  if (start > 0 && /\S/.test(draft.charAt(start - 1))) context = context.replace(/^\S+/, "");
  // A trailing newline says the dictation starts a new line, so it stays.
  context = context.trimStart().replace(/[^\S\n]+$/, "");
  return context.trim() ? context : "";
}

/**
 * Whether `next` continues the passage `prev` ends. An unedited envelope holds
 * only session-written text, so every gap in it is a paragraph break; once it's
 * edited, only an utterance written straight after the previous one is proven
 * to be the session's.
 */
function continuesPassage(
  record: DictationRecord,
  prev: DictationUtterance,
  next: DictationUtterance
): boolean {
  if (next.insertion.edited || next.insertion.from < prev.range.to) return false;
  return !record.range.edited || next.insertion.from === prev.range.to;
}

/**
 * Splits a dictation into the passages correction may rewrite. An utterance
 * whose own words were edited is left out and ends the passage before it, so
 * nothing the user changed is ever sent back to be rewritten.
 */
export function collectCorrectionPassages(
  record: DictationRecord,
  draft: string
): CorrectionPassage[] {
  const runs: DictationUtterance[][] = [];
  let run: DictationUtterance[] | null = null;
  for (const utterance of record.utterances) {
    if (utterance.range.edited || utterance.range.from >= utterance.range.to) {
      run = null;
      continue;
    }
    const prev = run?.[run.length - 1];
    if (run && prev && continuesPassage(record, prev, utterance)) {
      run.push(utterance);
    } else {
      run = [utterance];
      runs.push(run);
    }
  }

  return runs.map((utterances) => {
    const from = utterances[0]!.range.from;
    const to = utterances[utterances.length - 1]!.range.to;
    return {
      utteranceIds: utterances.map((utterance) => utterance.id),
      from,
      to,
      text: draft.slice(from, to),
      context: leftContext(draft, from),
    };
  });
}

/**
 * Where `passage` sits in `draft` now, or null once anything in it changed:
 * the dictation was released, one of its utterances was edited, or text landed
 * between them. A gap the passage was sent with must still be provably the
 * session's, so an edit that was undone still counts.
 */
export function locatePassage(
  record: DictationRecord | null,
  passage: CorrectionPassage,
  draft: string
): { from: number; to: number } | null {
  if (!record) return null;
  const utterances: DictationUtterance[] = [];
  for (const id of passage.utteranceIds) {
    const utterance = record.utterances.find((u) => u.id === id);
    if (!utterance || utterance.range.edited) return null;
    const prev = utterances[utterances.length - 1];
    if (prev && !continuesPassage(record, prev, utterance)) return null;
    utterances.push(utterance);
  }
  const from = utterances[0]!.range.from;
  const to = utterances[utterances.length - 1]!.range.to;
  return draft.slice(from, to) === passage.text ? { from, to } : null;
}

/** One learning baseline for the session, from each passage's settled text. */
export function joinPassageTexts(texts: string[]): string | null {
  const joined = texts.join(" ");
  return joined.trim() ? joined : null;
}
