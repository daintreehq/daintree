import type { DictationRecord } from "@/store/dictationRangeStore";
import { formatAtFileToken } from "@/components/Terminal/hybridInputParsing";
import { FILE_LINK_COMMAND_PATTERN } from "@shared/utils/voiceFileLinkCommands";

/**
 * A file description main detected in a transcript, with the path it resolved
 * to relative to the terminal's worktree, or null for a miss.
 */
export interface SpokenFileReference {
  description: string;
  path: string | null;
}

export interface DraftEdit {
  from: number;
  to: number;
  text: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The command, an optional article and the description, as whole words, so
// only the words of an explicit command are ever swapped: the same description
// spoken elsewhere in the sentence stays put, and "bar" never matches inside
// "toolbar". Spacing may differ from what the detector echoed back; the words
// themselves may not.
function commandPattern(description: string): RegExp | null {
  const words = description.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const body = words.map(escapeRegExp).join(String.raw`\s+`);
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}_])${FILE_LINK_COMMAND_PATTERN}\s+(?:(?:the|a|an)\s+)?${body}(?![\p{L}\p{N}_])`,
    "giu"
  );
}

interface TextSpan {
  from: number;
  to: number;
}

// How many words name the file, so a description that is a prefix of
// another ranks below it whatever article the detector kept.
function specificity(description: string): number {
  return description
    .trim()
    .replace(/^(?:the|a|an)\s+/i, "")
    .split(/\s+/)
    .filter(Boolean).length;
}

// The first match inside one of `spans` that no earlier reference claimed.
function findUnclaimed(
  pattern: RegExp,
  draft: string,
  spans: TextSpan[],
  claimed: TextSpan[]
): TextSpan | null {
  for (const span of spans) {
    pattern.lastIndex = span.from;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(draft)) && match.index + match[0].length <= span.to) {
      const from = match.index;
      const to = from + match[0].length;
      if (!claimed.some((c) => from < c.to && c.from < to)) return { from, to };
      pattern.lastIndex = from + 1;
    }
  }
  return null;
}

/**
 * The swaps that turn each spoken file command ("link to the input bar") into
 * its `@file` token, made only inside the words of the transcript main
 * detected it in. Every detected reference claims one command, misses
 * included, so a hit can never take a missed command's words. Descriptions
 * naming more words claim first ("router tests" before "router"), then each takes
 * the earliest command left. Misses, words the user has since edited, and
 * commands that can't be found there are left exactly as spoken.
 */
export function planFileReferenceEdits(
  record: DictationRecord,
  transcriptId: string,
  references: SpokenFileReference[],
  draft: string
): DraftEdit[] {
  const spans = record.utterances
    .filter((u) => u.transcriptId === transcriptId && !u.range.edited && u.range.from < u.range.to)
    .map((u) => u.range);
  const claimed: TextSpan[] = [];
  const edits: DraftEdit[] = [];
  const bySpecificity = references
    .map((reference, index) => ({ reference, words: specificity(reference.description), index }))
    .sort((a, b) => b.words - a.words || a.index - b.index);

  for (const { reference } of bySpecificity) {
    const pattern = commandPattern(reference.description);
    if (!pattern) continue;
    const span = findUnclaimed(pattern, draft, spans, claimed);
    if (!span) continue;
    claimed.push(span);
    if (reference.path) edits.push({ ...span, text: formatAtFileToken(reference.path) });
  }
  return edits.sort((a, b) => a.from - b.from);
}

/** Applies non-overlapping edits given in draft order. */
export function applyDraftEdits(draft: string, edits: DraftEdit[]): string {
  let next = draft;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
  }
  return next;
}
