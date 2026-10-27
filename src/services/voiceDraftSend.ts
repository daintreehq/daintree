import type { TextChange } from "@/lib/textRangeMapping";
import type { DictationRecord, DictationTextSpan } from "@/store/dictationRangeStore";

/**
 * A dictated send split from the dictation that began after it: the send takes
 * the draft without a newer session's words, and the draft keeps them for the
 * next prompt (#14804).
 */
export interface VoiceDraftSend {
  /** The voice target's draft: its panel and project. */
  panelId: string;
  projectId: string | undefined;
  /** The dictation sessions whose words and cleanup the send takes. */
  sessions: ReadonlySet<string>;
  /** The draft the split was planned against. */
  draft: string;
  /** What goes out. */
  text: string;
  /** What the draft keeps once the send has gone; empty when nothing is held back. */
  kept: string;
  /** The deletions, placed in `draft`, that leave `kept`. */
  changes: TextChange[];
  /** The space the kept words were written with, which their dictation gives up. */
  leadingSpace: { dictationId: string; span: DictationTextSpan } | null;
}

/**
 * Where a dictation sits in the draft. Its envelope can lose words a cleanup
 * rewrote (`mapTextRange` trims to what survives), while its learning span
 * grows over them, so between them they cover everything it wrote.
 */
function dictationSpan(record: DictationRecord, draft: string): DictationTextSpan {
  const { range, learningSpan } = record;
  const from = Math.min(range.from, learningSpan?.from ?? range.from);
  const to = Math.max(range.to, learningSpan?.to ?? range.to);
  return { from: Math.max(0, from), to: Math.min(draft.length, to) };
}

/**
 * Splits the draft between a send and the sessions it doesn't take. The
 * composer is locked while the send waits, so nothing but dictation writes
 * the draft meanwhile, and a newer session's text is only what its records
 * cover.
 */
export function planVoiceDraftSend(
  target: { panelId: string; projectId: string | undefined },
  draft: string,
  records: readonly DictationRecord[],
  sessions: ReadonlySet<string>
): VoiceDraftSend {
  const held: Array<DictationTextSpan & { id: string }> = [];
  const spans = records
    .filter((record) => !sessions.has(record.sessionId))
    .map((record) => ({ id: record.id, ...dictationSpan(record, draft) }))
    .filter((span) => span.from < span.to)
    .sort((a, b) => a.from - b.from);
  for (const span of spans) {
    const last = held[held.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else held.push({ ...span });
  }

  // The first words kept follow nothing any more, so the space they were
  // written with goes along with the text it separated them from.
  const first = held[0];
  const lead = first ? /^[^\S\n]*/.exec(draft.slice(first.from, first.to))![0].length : 0;
  const leadingSpace =
    first && lead > 0
      ? { dictationId: first.id, span: { from: first.from, to: first.from + lead } }
      : null;

  let text = "";
  let kept = "";
  const changes: TextChange[] = [];
  let at = 0;
  for (const span of held) {
    const keepFrom = span === first ? span.from + lead : span.from;
    text += draft.slice(at, span.from);
    if (keepFrom > at) changes.push({ from: at, to: keepFrom, insert: "" });
    kept += draft.slice(keepFrom, span.to);
    at = span.to;
  }
  text += draft.slice(at);
  if (held.length > 0 && at < draft.length) changes.push({ from: at, to: draft.length, insert: "" });

  return { ...target, sessions, draft, text, kept, changes, leadingSpace };
}
