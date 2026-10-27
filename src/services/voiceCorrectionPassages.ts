import type {
  VoiceCorrectionPassages,
  VoiceCorrectionVerdict,
} from "@shared/types/voiceSessionSummary";
import type {
  DictationRecord,
  DictationTextSpan,
  DictationUtterance,
} from "@/store/dictationRangeStore";

// Draft text before a passage sent as correction context, so a dictation that
// continues a typed sentence isn't recased as if it stood alone.
const CONTEXT_CHARS = 500;
// Draft text after a passage dictated into the middle of one, so its casing and
// end punctuation can fit what follows.
const FOLLOWING_CHARS = 200;

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
  /** The draft after the passage, bounded, without its separator; empty at the end of the draft. */
  following: string;
  /** Nothing but whitespace comes before the passage, so it may open with a command. */
  startsPrompt: boolean;
  /** The words in `text` the recogniser was unsure of, when there are any. */
  uncertain?: DictationTextSpan[];
  /** Where the speaker paused in `text`, each straight after a word, when they did. */
  pauses?: number[];
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

function rightContext(draft: string, to: number): string {
  const end = Math.min(draft.length, to + FOLLOWING_CHARS);
  let following = draft.slice(to, end);
  // Drop the word the bound cut through, if it cut one.
  if (end < draft.length && /\S/.test(draft.charAt(end))) following = following.replace(/\S+$/, "");
  // A leading newline says the dictation ends its line, so it stays.
  following = following.trimEnd().replace(/^[^\S\n]+/, "");
  return following.trim() ? following : "";
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
 * nothing the user changed is ever sent back to be rewritten. So is one
 * `include` turns down: a chunk's cleanup has it already.
 */
export function collectCorrectionPassages(
  record: DictationRecord,
  draft: string,
  include: (utterance: DictationUtterance) => boolean = () => true
): CorrectionPassage[] {
  const runs: DictationUtterance[][] = [];
  let run: DictationUtterance[] | null = null;
  for (const utterance of record.utterances) {
    if (
      utterance.range.edited ||
      utterance.range.from >= utterance.range.to ||
      !include(utterance)
    ) {
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
    // Every utterance here is unedited, so each still holds the words its
    // spans were measured against.
    const uncertain = utterances.flatMap(({ range, uncertain: spans = [] }) =>
      spans
        .filter((span) => span.from < span.to && span.to <= range.to - range.from)
        .map((span) => ({ from: range.from - from + span.from, to: range.from - from + span.to }))
    );
    const pauses = utterances.flatMap(({ range, pauses: positions = [] }) =>
      positions
        .filter((at) => at > 0 && at <= range.to - range.from)
        .map((at) => range.from - from + at)
    );
    return {
      utteranceIds: utterances.map((utterance) => utterance.id),
      from,
      to,
      text: draft.slice(from, to),
      context: leftContext(draft, from),
      following: rightContext(draft, to),
      startsPrompt: draft.slice(0, from).trim() === "",
      ...(uncertain.length > 0 ? { uncertain } : {}),
      ...(pauses.length > 0 ? { pauses } : {}),
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

/**
 * A passage as the transcriber produced it, before any heard-as rule: each
 * utterance's heard words in place of what the rules wrote, with the
 * session's own separators between them, the words in it the recogniser was
 * unsure of, and where the speaker paused. Read from the same draft the
 * passage was collected from.
 */
export function transcribedPassage(
  record: DictationRecord,
  passage: CorrectionPassage,
  draft: string
): { text: string; uncertain: DictationTextSpan[]; pauses: number[] } {
  let text = "";
  const uncertain: DictationTextSpan[] = [];
  const pauses: number[] = [];
  let at = passage.from;
  for (const id of passage.utteranceIds) {
    const utterance = record.utterances.find((u) => u.id === id);
    if (!utterance) continue;
    const { from, to } = utterance.range;
    text += draft.slice(at, from);
    const words = utterance.heard ?? draft.slice(from, to);
    const spans =
      (utterance.heard === undefined ? utterance.uncertain : utterance.heardUncertain) ?? [];
    for (const span of spans) {
      if (span.from < span.to && span.to <= words.length) {
        uncertain.push({ from: text.length + span.from, to: text.length + span.to });
      }
    }
    const paused = (utterance.heard === undefined ? utterance.pauses : utterance.heardPauses) ?? [];
    for (const position of paused) {
      if (position > 0 && position <= words.length) pauses.push(text.length + position);
    }
    text += words;
    at = to;
  }
  return { text, uncertain, pauses };
}

/** Where one passage's cleanup ended: main's verdict, or what became of it here. */
export type PassageFate =
  Exclude<VoiceCorrectionVerdict, "replaced"> | "applied" | "unlanded" | "dropped";

const PASSAGE_FATE_FIELDS: Record<PassageFate, Exclude<keyof VoiceCorrectionPassages, "sent">> = {
  applied: "applied",
  unchanged: "unchanged",
  skipped: "skipped",
  rejected_command: "rejectedCommand",
  rejected_low_confidence: "rejectedLowConfidence",
  failed: "failed",
  timed_out: "timedOut",
  dropped: "dropped",
  unlanded: "unlanded",
};

/** Each passage counted once, under its fate. */
export function countPassageFates(fates: readonly PassageFate[]): VoiceCorrectionPassages {
  const counts: VoiceCorrectionPassages = {
    sent: fates.length,
    applied: 0,
    unchanged: 0,
    skipped: 0,
    rejectedCommand: 0,
    rejectedLowConfidence: 0,
    failed: 0,
    timedOut: 0,
    dropped: 0,
    unlanded: 0,
  };
  for (const fate of fates) counts[PASSAGE_FATE_FIELDS[fate]]++;
  return counts;
}

/** One learning baseline for the session, from each passage's settled text. */
export function joinPassageTexts(texts: string[]): string | null {
  const joined = texts.join(" ");
  return joined.trim() ? joined : null;
}

/**
 * Every passage's reply, in passage order, and main's timing from the one
 * that came back last: it is the one the draft waited on.
 */
export async function settlePassageReplies<T extends { timing: unknown }>(
  replies: ReadonlyArray<Promise<T>>
): Promise<{ results: T[]; lastTiming: unknown }> {
  let lastTiming: unknown = null;
  const results = await Promise.all(
    replies.map((reply) =>
      reply.then((result) => {
        lastTiming = result.timing;
        return result;
      })
    )
  );
  return { results, lastTiming };
}
