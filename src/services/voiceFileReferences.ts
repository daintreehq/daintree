import type { DictationRecord } from "@/store/dictationRangeStore";
import { formatAtFileToken } from "@/components/Terminal/hybridInputParsing";
import { FILE_LINK_COMMAND_PATTERN } from "@shared/utils/voiceFileLinkCommands";
import type { HeardAsRewriter } from "@shared/utils/voiceHeardAs";
import type { VoiceTextEdit } from "@shared/utils/voiceUncertainWords";
import { pluralNoun } from "@/lib/pluralize";

/**
 * A file description main detected in a transcript, with the path it resolved
 * to relative to the terminal's worktree, or null for a miss.
 */
export interface SpokenFileReference {
  description: string;
  path: string | null;
  /** The lookup threw, timed out or had nowhere to look, rather than finding nothing. */
  failed?: true;
}

const descriptionList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

// One clause per outcome, each description quoted once.
function unresolvedClauses(
  references: ReadonlyArray<Pick<SpokenFileReference, "description" | "failed">>
): string[] {
  const quoted = (failed: boolean) => [
    ...new Set(
      references
        .filter((reference) => (reference.failed === true) === failed)
        .map((reference) => `“${reference.description}”`)
    ),
  ];
  const missing = quoted(false);
  const failed = quoted(true);
  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(
      `No ${pluralNoun(missing.length, "file")} found for ${descriptionList.format(missing)}`
    );
  }
  if (failed.length > 0) clauses.push(`File lookup failed for ${descriptionList.format(failed)}`);
  return clauses;
}

/** What a dictation's unresolved file references say aloud (#14983). */
export function unresolvedFileReferencesStatus(
  references: ReadonlyArray<Pick<SpokenFileReference, "description" | "failed">>
): string {
  return unresolvedClauses(references)
    .map((clause) => `${clause}.`)
    .join(" ");
}

/** The same, on the composer's border. */
export function unresolvedFileReferencesCaption(
  references: ReadonlyArray<Pick<SpokenFileReference, "description" | "failed">>
): string {
  return unresolvedClauses(references).join(" · ");
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

// Where a position in the words as written sits in the words as heard: the
// heard-as rewrites are known exactly, so it is its own offset moved by every
// rewrite before it. Null inside a term a rule wrote, which has no counterpart
// in the words as heard.
function heardOffset(rewrites: readonly VoiceTextEdit[], written: number): number | null {
  let shift = 0;
  for (const { from, to, insert } of rewrites) {
    const start = from + shift;
    if (written <= start) break;
    if (written < start + insert.length) return null;
    shift += insert.length - (to - from);
  }
  return written - shift;
}

/**
 * The same swaps in the words as heard, by utterance id, for each swapped
 * utterance the heard-as rules rewrote: the rules rerun over those words at
 * stop, and would put the spoken command back over its token. Each swap is
 * placed through the rewrites the rules made, so it lands on the command it
 * replaced and not on another that reads alike. An utterance whose words the
 * rules can't be replayed to (they changed since, or a rewrite cuts through
 * the command) has no entry.
 */
export function planHeardSwaps(
  record: DictationRecord,
  edits: readonly DraftEdit[],
  draft: string,
  rewrite: HeardAsRewriter | null
): Map<string, DraftEdit[]> {
  const swaps = new Map<string, DraftEdit[]>();
  if (!rewrite) return swaps;
  for (const { id, range, heard } of record.utterances) {
    if (heard === undefined) continue;
    const mine = edits.filter((edit) => range.from <= edit.from && edit.to <= range.to);
    if (mine.length === 0) continue;
    const rewrites: VoiceTextEdit[] = [];
    if (rewrite(heard, undefined, rewrites) !== draft.slice(range.from, range.to)) continue;
    const spoken = mine.map((edit) => ({
      from: heardOffset(rewrites, edit.from - range.from),
      to: heardOffset(rewrites, edit.to - range.from),
      text: edit.text,
    }));
    if (spoken.every((swap): swap is DraftEdit => swap.from !== null && swap.to !== null)) {
      swaps.set(id, spoken);
    }
  }
  return swaps;
}
