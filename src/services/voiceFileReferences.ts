import type { DictationRecord } from "@/store/dictationRangeStore";
import { formatAtFileToken } from "@/components/Terminal/hybridInputParsing";
import { FILE_LINK_COMMAND_PATTERN } from "@shared/utils/voiceFileLinkCommands";

/** A spoken file description main resolved to a path relative to the terminal's worktree. */
export interface SpokenFileReference {
  description: string;
  path: string;
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

/**
 * The swaps that turn each spoken file command ("link to the input bar") into
 * its `@file` token, made only inside the words of the transcript main
 * detected it in. References are matched in the order they were spoken, each
 * after the last one placed. Words the user has since edited, and commands
 * that can't be found there, are left exactly as spoken.
 */
export function planFileReferenceEdits(
  record: DictationRecord,
  transcriptId: string,
  references: SpokenFileReference[],
  draft: string
): DraftEdit[] {
  const spans = record.utterances
    .filter(
      (u) => u.transcriptId === transcriptId && !u.range.edited && u.range.from < u.range.to
    )
    .map((u) => u.range);
  const edits: DraftEdit[] = [];
  let spanIndex = 0;
  let cursor = spans[0]?.from ?? 0;

  for (const reference of references) {
    const pattern = commandPattern(reference.description);
    if (!pattern || !reference.path) continue;
    for (let i = spanIndex; i < spans.length; i++) {
      const span = spans[i]!;
      const start = i === spanIndex ? Math.max(cursor, span.from) : span.from;
      pattern.lastIndex = start;
      const match = pattern.exec(draft);
      if (!match || match.index + match[0].length > span.to) continue;
      const from = match.index;
      const to = from + match[0].length;
      edits.push({ from, to, text: formatAtFileToken(reference.path) });
      spanIndex = i;
      cursor = to;
      break;
    }
  }
  return edits;
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
