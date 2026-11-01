import { create } from "zustand";
import {
  mapSpanKeepingEdits,
  mapTextRange,
  minimalDocChange,
  type TextChange,
  type TrackedTextRange,
} from "@/lib/textRangeMapping";
import { makeDraftKey } from "@/lib/draftKey";
import { mapWordCuts } from "@/lib/wordAlignment";
import { carrySpansThroughEdits } from "@shared/utils/voiceUncertainWords";
import {
  carryPausePositionsThroughEdits,
  normalizePausePositions,
} from "@shared/utils/voicePausePositions";
import { useTerminalInputStore } from "./terminalInputStore";

export interface DictationTextSpan {
  from: number;
  to: number;
}

export interface DictationUtterance {
  id: string;
  /** The transcribed words. */
  range: TrackedTextRange;
  /** Everything the utterance put in the draft: its leading separator and its words. */
  insertion: TrackedTextRange;
  /**
   * The space the write put after the words when they landed against text.
   * It stays outside `insertion`, so the next utterance goes in ahead of it;
   * scratching the utterance takes it too while it is untouched and still
   * right after what's removed.
   */
  separatorAfter?: TrackedTextRange;
  /**
   * Main's id for the transcript the words came from, set when spoken file
   * references in it may still arrive. One transcript can span several
   * utterances when a spoken new line splits it.
   */
  transcriptId?: string;
  /** The words as transcribed, when heard-as rules wrote something else in their place. */
  heard?: string;
  /**
   * The words the recogniser was unsure of, relative to `range.from`. They
   * hold only while `range` is unedited, which is the only time correction
   * reads them, and only through writes that say what they changed.
   */
  uncertain?: DictationTextSpan[];
  /** The same words in `heard`, relative to its start. */
  heardUncertain?: DictationTextSpan[];
  /**
   * Where the speaker paused, relative to `range.from`, each straight after a
   * word (#14897). They hold as `uncertain` does.
   */
  pauses?: number[];
  /** The same pauses in `heard`, relative to its start. */
  heardPauses?: number[];
  /**
   * The selection these words replaced. It left the draft with them, so a
   * cancel has to put it back where they stood.
   */
  replaced?: string;
  /**
   * How many of the transcriber's segments these words stand for, when a
   * rewrite ran several into one; one when absent.
   */
  sources?: number;
}

/**
 * Where one dictation session's text sits in a draft. Positions follow every
 * draft edit, and `edited` latches once a change reaches text the range
 * covers, so a caller can refuse to overwrite what it no longer wrote.
 *
 * Positions follow the changes a writer spells out (`expectDraftChange`): the
 * composer's typing, a completion, a correction landing. Any other write is
 * diffed, which tracks text, not keystrokes: an edit inside a run of identical
 * characters is placed at the run's end, which can leave a range on a
 * neighbouring copy of its own text. A range that isn't flagged always still
 * holds the text it held before.
 */
export interface DictationRecord {
  id: string;
  /** The voice session that wrote it (`dictationSessionId` on the voice buffer). */
  sessionId: string;
  panelId: string;
  projectId?: string;
  /**
   * The envelope from the first utterance's separator through the last thing
   * the session inserted, paragraph breaks included. Text the session didn't
   * write that ends up between two of its insertions flags it edited, so an
   * unflagged range is dictated text only.
   */
  range: TrackedTextRange;
  utterances: DictationUtterance[];
  /** Each paragraph break the session inserted. */
  breaks: TrackedTextRange[];
  /**
   * From the session's first dictated word to its last, for learning to diff
   * what is sent against what was heard. Unlike `range`, an edit that reaches
   * its text joins it whole, so a misheard word retyped at either end stays in
   * it; text typed at either edge stays out. Absent until the session writes
   * words.
   */
  learningSpan?: DictationTextSpan;
}

export interface DictationDraftTarget {
  sessionId: string;
  panelId: string;
  projectId?: string;
}

/** A swap of `from`..`to` for `text` that the session makes in its own words. */
export interface DictationWordEdit extends DictationTextSpan {
  text: string;
}

/** New text for one passage of a session's words. */
export interface UtteranceRewrite {
  passage: { utteranceIds: readonly string[]; text: string };
  text: string;
  /**
   * Keep the words as transcribed, for rules that rewrite from them, and the
   * unsure words and pauses in `text`, relative to its start.
   */
  heard?: { uncertain: readonly DictationTextSpan[]; pauses?: readonly number[] };
}

/**
 * Where a session's next words go in one draft. It starts as the caret, or the
 * selection the first words will replace, and becomes a point after the words
 * once any are written. It follows draft edits like a record does, so typing
 * elsewhere never pulls the dictation along with it.
 */
export interface DictationAnchor {
  sessionId: string;
  range: TrackedTextRange;
}

interface DictationRangeState {
  /** Records per draft key (`makeDraftKey`), oldest first. Runtime-only. */
  drafts: Record<string, DictationRecord[]>;
  /** Insertion anchors per draft key (`makeDraftKey`), one per session. Runtime-only. */
  anchors: Record<string, DictationAnchor[]>;
  /** Records an utterance the session just wrote into the draft. */
  recordUtterance: (
    target: DictationDraftTarget,
    span: {
      insertion: DictationTextSpan;
      words: DictationTextSpan;
      separatorAfter?: DictationTextSpan;
      transcriptId?: string;
      heard?: string;
      /** Relative to `words.from`. */
      uncertain?: DictationTextSpan[];
      /** Relative to the start of `heard`. */
      heardUncertain?: DictationTextSpan[];
      /** Relative to `words.from`. */
      pauses?: number[];
      /** Relative to the start of `heard`. */
      heardPauses?: number[];
      /** The selection the words replaced. */
      replaced?: string;
    }
  ) => void;
  /**
   * Marks a pause after the session's latest words in this draft, for one the
   * provider reported with no words of its own. Nothing changes once those
   * words were edited. Returns whether it marked a new one.
   */
  markPause: (target: DictationDraftTarget) => boolean;
  /** Records a paragraph break the session just wrote into the draft. */
  recordParagraphBreak: (target: DictationDraftTarget, insertion: DictationTextSpan) => void;
  /**
   * Takes the session's latest utterance out of its record and returns the
   * draft span that held it, trailing paragraph breaks and the space it was
   * given ahead of the text after it included, for the caller to delete. Null when the session has no utterance left in this draft or the
   * latest one was edited since, so typed text is never removed.
   */
  takeLastUtterance: (target: DictationDraftTarget, draft: string) => DictationTextSpan | null;
  /**
   * Carries every record through one transition of the draft map. A draft
   * that is gone or empty — sent, cleared, or its panel removed — releases
   * its records.
   */
  mapDrafts: (previous: Map<string, string>, next: Map<string, string>) => void;
  /**
   * Tells the next mapping of this draft what the write it's about to see
   * actually changed. A diff of the two strings can't say which of two
   * identical runs was written, or that a write touching two places left the
   * text between them alone, so a writer that knows passes it here. Several
   * changes are each placed in `before` and must not overlap. `records` are
   * records the writer rebuilt itself, taken as they are in place of mapping.
   */
  expectDraftChange: (
    panelId: string,
    projectId: string | undefined,
    before: string,
    after: string,
    change: TextChange | readonly TextChange[],
    records?: readonly DictationRecord[]
  ) => void;
  /**
   * Writes `text` over a passage of the session's own words, as the session:
   * the passage's utterances become one holding it, still unedited, so
   * correction treats it as dictated. `uncertain` gives the unsure words in
   * `text` and in `heard`, and `pauses` where the speaker paused in each,
   * which only the rewriter can place. Returns the span
   * the passage covered before the write, or null, writing nothing, once the
   * passage no longer holds `passage.text` or one of its words was edited.
   */
  rewritePassage: (
    id: string,
    passage: { utteranceIds: readonly string[]; text: string },
    text: string,
    heard: string,
    uncertain?: { text: DictationTextSpan[]; heard: DictationTextSpan[] },
    pauses?: { text: number[]; heard: number[] }
  ) => DictationTextSpan | null;
  /**
   * Swaps words inside the session's own utterances, as the session, for a
   * write that changes what they say but not whose they are (a spoken file
   * link becoming its token): the utterance, its insertion and the dictation
   * stay unedited around the new text, and an edit made there afterwards still
   * counts as the user's. `edits` are in draft order and must not overlap;
   * `write` receives the new draft and puts it there. Words the heard-as rules
   * rewrote rerun from the words as heard at stop, so those need `heardSwaps`,
   * the same swaps in them by utterance id: without them the swap stays an
   * edit, as one inside words already edited does.
   */
  rewriteWords: (
    id: string,
    edits: readonly DictationWordEdit[],
    write: (next: string) => void,
    heardSwaps?: ReadonlyMap<string, readonly DictationWordEdit[]>
  ) => void;
  /**
   * Gives up `span`, the space the dictation's first words were written with
   * after text that is going away: each of its ranges that starts inside it
   * starts at its end instead, so the write deleting it leaves them as they
   * were rather than edited.
   */
  yieldLeadingSpace: (id: string, span: DictationTextSpan) => void;
  /**
   * Writes new text over passages of the session's own words, as the session,
   * in one draft write. Each utterance whose edges the rewrite left in place
   * keeps its own words, still unedited, so a scratch or a cancel takes just
   * those; utterances a rewritten word runs across become one. A rewrite with
   * `heard` keeps the words as transcribed, for the heard-as rules to rerun
   * from; one without drops them with the unsure words and pauses (a cleanup,
   * which nothing reruns). `rewrites` are in draft order and must not overlap;
   * `write` receives the new draft and puts it there, and the record moves in
   * the same update as the draft. Returns the span each passage covered
   * before the write, or null, writing nothing, once one of them no longer
   * holds its text or one of its words was edited.
   */
  rewriteUtterances: (
    id: string,
    rewrites: readonly UtteranceRewrite[],
    write: (next: string) => void
  ) => DictationTextSpan[] | null;
  getDictation: (id: string) => DictationRecord | null;
  listDictations: (panelId: string, projectId?: string) => DictationRecord[];
  /** Every live record the voice session wrote, in any draft. */
  listSessionDictations: (sessionId: string) => DictationRecord[];
  releaseDictation: (id: string) => void;
  /** Places the session's insertion anchor in the target's draft. */
  setAnchor: (target: DictationDraftTarget, span: DictationTextSpan) => void;
  getAnchor: (target: DictationDraftTarget) => TrackedTextRange | null;
  /** Drops the session's anchors in every draft; its records stay. */
  releaseAnchors: (sessionId: string) => void;
  clear: () => void;
}

const unedited = (span: DictationTextSpan): TrackedTextRange => ({
  from: span.from,
  to: span.to,
  edited: false,
});

function sameRange(a: TrackedTextRange, b: TrackedTextRange): boolean {
  return a.from === b.from && a.to === b.to && a.edited === b.edited;
}

function startAfter<T extends DictationTextSpan>(range: T, span: DictationTextSpan): T {
  if (range.from < span.from || range.from >= span.to) return range;
  return { ...range, from: span.to, to: Math.max(range.to, span.to) };
}

function sameSpan(a: DictationTextSpan | undefined, b: DictationTextSpan | undefined): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

const placesWords = (u: DictationUtterance) =>
  !!(u.uncertain || u.heardUncertain || u.pauses || u.heardPauses);

/**
 * The record without its unsure words and pauses, for a change its writer
 * didn't describe. The change is then inferred by diffing the drafts, which
 * can't say which copy of repeated text changed, nor see the separate edits one
 * update can hold, so a mark kept through it could end up on another copy of
 * its word.
 */
function forgetWordMarks(record: DictationRecord): DictationRecord {
  if (!record.utterances.some(placesWords)) return record;
  return {
    ...record,
    utterances: record.utterances.map((utterance) => {
      if (!placesWords(utterance)) return utterance;
      const {
        uncertain: _uncertain,
        heardUncertain: _heardUncertain,
        pauses: _pauses,
        heardPauses: _heardPauses,
        ...rest
      } = utterance;
      return rest;
    }),
  };
}

/**
 * `positions` sorted and each once, or null when none follow a word. Given
 * `text`, each first moves back over the space before it.
 */
function placedPauses(positions: readonly number[] | undefined, text?: string): number[] | null {
  const sorted =
    text === undefined
      ? [...new Set(positions)].sort((a, b) => a - b)
      : normalizePausePositions(text, positions ?? []);
  const placed = sorted.filter((at) => at > 0);
  return placed.length > 0 ? placed : null;
}

/** `pauses` to spread onto an utterance, or nothing when there are none. */
function pausesField(positions: readonly number[] | undefined, text?: string) {
  const pauses = placedPauses(positions, text);
  return pauses ? { pauses } : {};
}

/** `heardPauses` to spread onto an utterance, or nothing when there are none. */
function heardPausesField(positions: readonly number[] | undefined, text?: string) {
  const heardPauses = placedPauses(positions, text);
  return heardPauses ? { heardPauses } : {};
}

function mapRecord(record: DictationRecord, change: TextChange): DictationRecord {
  const range = mapTextRange(record.range, change);
  const learningSpan = record.learningSpan && mapSpanKeepingEdits(record.learningSpan, change);
  let breaksChanged = false;
  const breaks = record.breaks.map((paragraphBreak) => {
    const mapped = mapTextRange(paragraphBreak, change);
    if (sameRange(mapped, paragraphBreak)) return paragraphBreak;
    breaksChanged = true;
    return mapped;
  });
  let utterancesChanged = false;
  const utterances = record.utterances.map((utterance) => {
    const separatorAfter =
      utterance.separatorAfter && mapTextRange(utterance.separatorAfter, change);
    const mapped = {
      ...utterance,
      range: mapTextRange(utterance.range, change),
      insertion: mapTextRange(utterance.insertion, change),
      ...(separatorAfter ? { separatorAfter } : {}),
    };
    if (
      sameRange(mapped.range, utterance.range) &&
      sameRange(mapped.insertion, utterance.insertion) &&
      (!separatorAfter || sameRange(separatorAfter, utterance.separatorAfter!))
    ) {
      return utterance;
    }
    utterancesChanged = true;
    return mapped;
  });
  if (
    !utterancesChanged &&
    !breaksChanged &&
    sameRange(range, record.range) &&
    sameSpan(learningSpan, record.learningSpan)
  ) {
    return record;
  }
  return {
    ...record,
    range,
    utterances: utterancesChanged ? utterances : record.utterances,
    breaks: breaksChanged ? breaks : record.breaks,
    ...(learningSpan ? { learningSpan } : {}),
  };
}

function holds(range: DictationTextSpan, change: TextChange): boolean {
  return range.from < range.to && range.from <= change.from && change.to <= range.to;
}

/** The unedited utterance whose own words a change lies inside and `owns` lets it swap, or -1. */
function ownerOf(
  record: DictationRecord,
  change: TextChange,
  owns: (utterance: DictationUtterance) => boolean
): number {
  return record.utterances.findIndex((u) => !u.range.edited && holds(u.range, change) && owns(u));
}

/**
 * Carries a record through a change its session wrote inside the words of its
 * utterance `owner`. Every range that held those words still holds them,
 * rewritten, and stays as unedited as it was, where `mapRecord` would trim the
 * range to what survives and flag it.
 */
function mapOwnEdit(record: DictationRecord, change: TextChange, owner: number): DictationRecord {
  const delta = change.insert.length - (change.to - change.from);
  const through = (range: TrackedTextRange): TrackedTextRange =>
    holds(range, change) ? { ...range, to: range.to + delta } : mapTextRange(range, change);
  const learningSpan = record.learningSpan && mapSpanKeepingEdits(record.learningSpan, change);
  return {
    ...record,
    range: through(record.range),
    utterances: record.utterances.map((utterance, i) => {
      const separatorAfter = utterance.separatorAfter && through(utterance.separatorAfter);
      const mapped: DictationUtterance = {
        ...utterance,
        range: through(utterance.range),
        insertion: through(utterance.insertion),
        ...(separatorAfter ? { separatorAfter } : {}),
      };
      if (i !== owner || (!utterance.uncertain && !utterance.pauses)) return mapped;
      // An unsure word the change replaced is gone; the rest keep their words.
      // A pause stays after the word it followed, the swap's end for one in it.
      const at = utterance.range.from;
      const edit = { from: change.from - at, to: change.to - at, insert: change.insert };
      const uncertain = carrySpansThroughEdits(utterance.uncertain ?? [], [edit]);
      const { uncertain: _uncertain, pauses: _pauses, ...rest } = mapped;
      return {
        ...rest,
        ...(uncertain.length > 0 ? { uncertain } : {}),
        ...pausesField(carryPausePositionsThroughEdits(utterance.pauses ?? [], [edit])),
      };
    }),
    breaks: record.breaks.map(through),
    ...(learningSpan ? { learningSpan } : {}),
  };
}

/** The utterance with `swaps` made in the words it was heard as, which the heard-as rules rerun at stop. */
function withSwappedHeard(
  utterance: DictationUtterance,
  swaps: readonly DictationWordEdit[]
): DictationUtterance {
  if (utterance.heard === undefined) return utterance;
  const heard = swaps.reduceRight(
    (words, { from, to, text }) => words.slice(0, from) + text + words.slice(to),
    utterance.heard
  );
  const edits = swaps.map(({ from, to, text }) => ({ from, to, insert: text }));
  const unsure = carrySpansThroughEdits(utterance.heardUncertain ?? [], edits);
  const { heardUncertain: _heardUncertain, heardPauses: _heardPauses, ...rest } = utterance;
  return {
    ...rest,
    heard,
    ...(unsure.length > 0 ? { heardUncertain: unsure } : {}),
    ...heardPausesField(carryPausePositionsThroughEdits(utterance.heardPauses ?? [], edits), heard),
  };
}

/** A stretch of the draft the dictation wrote, as it comes back out. */
export interface DictatedSpan extends DictationTextSpan {
  /** The selection the span's words replaced, for the cancel to put in their place. */
  restore?: string;
}

/**
 * Every span the dictation put in the draft, last first, for taking it back
 * out: each utterance with its separator, and each paragraph break. Text typed
 * between them stays where it is. Null once any of them has been edited,
 * because removing them would take the user's edits with them.
 *
 * Words that replaced a selection carry it as `restore`: taking them out means
 * putting that back, or the selection would be lost along with them.
 *
 * The space an utterance was given ahead of the text after it goes too while
 * it is untouched and still right after something removed, as a scratch takes
 * it, so dictation at the caret leaves the text around it as it was. Edited, or
 * with text typed up against the words, it stays: it is no longer only ours.
 */
export function dictatedSpans(record: DictationRecord, draft: string): DictatedSpan[] | null {
  // An insertion holds its utterance's words, so an edit to them flags it too.
  const pieces = [
    ...record.utterances.map(({ insertion, replaced }) => ({ insertion, replaced })),
    ...record.breaks.map((insertion) => ({ insertion, replaced: undefined })),
  ];
  if (pieces.some(({ insertion }) => insertion.edited)) return null;
  const spans: DictatedSpan[] = pieces
    .map(({ insertion: { from, to }, replaced }) => ({
      from,
      to,
      ...(replaced ? { restore: replaced } : {}),
    }))
    .sort((a, b) => b.from - a.from);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const later = spans[i - 1];
    if (span.from < 0 || span.to > draft.length || (later && span.to > later.from)) return null;
  }
  const separators = record.utterances.flatMap(({ separatorAfter: separator }) =>
    separator &&
    !separator.edited &&
    separator.from < separator.to &&
    separator.to <= draft.length &&
    draft.slice(separator.from, separator.to).trim() === "" &&
    spans.some((span) => span.to === separator.from) &&
    !spans.some((span) => span.from < separator.to && span.to > separator.from)
      ? [{ from: separator.from, to: separator.to }]
      : []
  );
  if (separators.length === 0) return spans;
  return [...spans, ...separators].sort((a, b) => b.from - a.from);
}

/**
 * Extends the session's record in this draft over `insertion`, or starts one.
 * A record the draft already released stays released: the session's next
 * insertion starts a fresh record under a new id, so work still holding the
 * old id can't find text it never saw.
 */
function withInsertion(
  drafts: Record<string, DictationRecord[]>,
  target: DictationDraftTarget,
  insertion: DictationTextSpan,
  utterance: DictationUtterance | null
): Record<string, DictationRecord[]> {
  const key = makeDraftKey(target.panelId, target.projectId);
  const records = drafts[key] ?? [];
  const index = records.findIndex((record) => record.sessionId === target.sessionId);
  const utterances = utterance ? [utterance] : [];
  const words = utterance ? { from: utterance.range.from, to: utterance.range.to } : undefined;
  // A paragraph break is kept on its own, so a cancel can take it back out.
  const breaks = utterance ? [] : [unedited(insertion)];

  if (index < 0) {
    const record: DictationRecord = {
      id: crypto.randomUUID(),
      sessionId: target.sessionId,
      panelId: target.panelId,
      projectId: target.projectId,
      range: unedited(insertion),
      utterances,
      breaks,
      ...(words ? { learningSpan: words } : {}),
    };
    return { ...drafts, [key]: [...records, record] };
  }

  const existing = records[index]!;
  const contiguous = insertion.from === existing.range.to;
  const learningSpan =
    words && existing.learningSpan
      ? {
          from: Math.min(existing.learningSpan.from, words.from),
          to: Math.max(existing.learningSpan.to, words.to),
        }
      : (words ?? existing.learningSpan);
  const record: DictationRecord = {
    ...existing,
    range: {
      from: Math.min(existing.range.from, insertion.from),
      to: Math.max(existing.range.to, insertion.to),
      edited: existing.range.edited || !contiguous,
    },
    utterances: [...existing.utterances, ...utterances],
    breaks: [...existing.breaks, ...breaks],
    ...(learningSpan ? { learningSpan } : {}),
  };
  return { ...drafts, [key]: records.map((r, i) => (i === index ? record : r)) };
}

/** A passage of a record, located for `rewriteUtterances`. */
interface LocatedRewrite {
  first: number;
  run: DictationUtterance[];
  from: number;
  to: number;
  rewrite: UtteranceRewrite;
}

/**
 * The utterances `located` becomes once its new text is written at `at`. Each
 * cut between two of them that the rewrite kept stays, so each keeps its own
 * words; any other joins them. `mapped` is the record carried through the
 * write, for the space kept after the words.
 */
function rewrittenUtterances(
  located: LocatedRewrite,
  at: number,
  mapped: DictationRecord,
  draft: string
): DictationUtterance[] {
  const { first, run, from, rewrite } = located;
  const { text } = rewrite;
  const cuts = mapWordCuts(
    rewrite.passage.text,
    text,
    run.slice(1).map((next, i) => ({ end: run[i]!.range.to - from, start: next.range.from - from }))
  );
  const groups: Array<{ members: DictationUtterance[]; start: number; end: number }> = [];
  let members = [run[0]!];
  let start = 0;
  cuts.forEach((cut, i) => {
    // A cut that would leave either side without words of its own joins them.
    if (!cut || cut.end <= start || cut.start < cut.end || cut.start >= text.length) {
      members.push(run[i + 1]!);
      return;
    }
    groups.push({ members, start, end: cut.end });
    members = [run[i + 1]!];
    start = cut.start;
  });
  groups.push({ members, start, end: text.length });

  const end = at + text.length;
  const separators = mapped.utterances
    .slice(first, first + run.length)
    .flatMap((u) => (u.separatorAfter ? [u.separatorAfter] : []));
  const separatorAfter =
    separators.find((s) => s.from === end) ?? separators[separators.length - 1];
  return groups.map((group, g) => {
    const lead = group.members[0]!;
    const words = { from: at + group.start, to: at + group.end };
    const insertion =
      g === 0
        ? { ...lead.insertion, from: lead.insertion.from - from + at, to: words.to }
        : unedited({ from: at + groups[g - 1]!.end, to: words.to });
    const transcriptId = group.members.find((u) => u.transcriptId)?.transcriptId;
    const replaced = group.members.find((u) => u.replaced)?.replaced;
    const sources = group.members.reduce((sum, u) => sum + (u.sources ?? 1), 0);
    const utterance: DictationUtterance = {
      id: lead.id,
      range: unedited(words),
      insertion,
      ...(g === groups.length - 1 && separatorAfter ? { separatorAfter } : {}),
      ...(transcriptId ? { transcriptId } : {}),
      ...(replaced ? { replaced } : {}),
      ...(sources > 1 ? { sources } : {}),
    };
    if (!rewrite.heard) return utterance;
    // The words as transcribed, each member's own with the space the session
    // put between them, so the heard-as rules can rerun from them.
    let heard = "";
    const heardUncertain: DictationTextSpan[] = [];
    const heardPauses: number[] = [];
    group.members.forEach((member, i) => {
      if (i > 0) heard += draft.slice(group.members[i - 1]!.range.to, member.range.from);
      const said = member.heard ?? draft.slice(member.range.from, member.range.to);
      const spans = (member.heard === undefined ? member.uncertain : member.heardUncertain) ?? [];
      for (const span of spans) {
        heardUncertain.push({ from: heard.length + span.from, to: heard.length + span.to });
      }
      const paused = (member.heard === undefined ? member.pauses : member.heardPauses) ?? [];
      for (const at of paused) heardPauses.push(heard.length + at);
      heard += said;
    });
    const uncertain = rewrite.heard.uncertain
      .filter((span) => span.from >= group.start && span.to <= group.end && span.from < span.to)
      .map((span) => ({ from: span.from - group.start, to: span.to - group.start }));
    // A pause on the cut ends the words before it, so this group keeps it.
    const pauses = (rewrite.heard.pauses ?? [])
      .filter((at) => at > group.start && at <= group.end)
      .map((at) => at - group.start);
    const written = text.slice(group.start, group.end);
    return {
      ...utterance,
      ...(uncertain.length > 0 ? { uncertain } : {}),
      ...pausesField(pauses, written),
      ...(heard !== written
        ? {
            heard,
            ...(heardUncertain.length > 0 ? { heardUncertain } : {}),
            ...heardPausesField(heardPauses, heard),
          }
        : {}),
    };
  });
}

/** `record` in place of the one with its id, unless its draft released it meanwhile. */
function replaceRecord(
  state: DictationRangeState,
  record: DictationRecord
): Partial<DictationRangeState> {
  const key = makeDraftKey(record.panelId, record.projectId);
  const records = state.drafts[key];
  if (!records?.some((r) => r.id === record.id)) return state;
  return {
    drafts: { ...state.drafts, [key]: records.map((r) => (r.id === record.id ? record : r)) },
  };
}

// One-shot and keyed by draft: a write that never lands as expected (another
// write got there first) is simply diffed, as every other write is.
const expectedChanges = new Map<
  string,
  {
    before: string;
    after: string;
    changes: readonly TextChange[];
    records: ReadonlyMap<string, DictationRecord> | null;
  }
>();

/**
 * The write's changes, last in the draft first, so each still lands where it
 * was placed, whether its writer said where they were rather than them being
 * inferred, and the records it rebuilt itself.
 */
function changesFor(
  key: string,
  before: string,
  after: string
): {
  changes: readonly TextChange[];
  known: boolean;
  records: ReadonlyMap<string, DictationRecord> | null;
} {
  const expected = expectedChanges.get(key);
  if (expected?.before === before && expected.after === after) {
    return { changes: expected.changes, known: true, records: expected.records };
  }
  return { changes: [minimalDocChange(before, after)!], known: false, records: null };
}

function mapAnchors(
  anchors: Record<string, DictationAnchor[]>,
  previous: Map<string, string>,
  next: Map<string, string>
): Record<string, DictationAnchor[]> | null {
  let nextAnchors: Record<string, DictationAnchor[]> | null = null;
  for (const [key, list] of Object.entries(anchors)) {
    const after = next.get(key) ?? "";
    const before = previous.get(key) ?? "";
    if (after === before) continue;
    nextAnchors ??= { ...anchors };
    if (after === "") {
      delete nextAnchors[key];
      continue;
    }
    const { changes } = changesFor(key, before, after);
    nextAnchors[key] = list.map((anchor) => ({
      ...anchor,
      range: changes.reduce(mapTextRange, anchor.range),
    }));
  }
  return nextAnchors;
}

export const useDictationRangeStore = create<DictationRangeState>()((set, get) => ({
  drafts: {},
  anchors: {},

  recordUtterance: (
    target,
    {
      insertion,
      words,
      separatorAfter,
      transcriptId,
      heard,
      uncertain,
      heardUncertain,
      pauses,
      heardPauses,
      replaced,
    }
  ) =>
    set((state) => ({
      drafts: withInsertion(state.drafts, target, insertion, {
        id: crypto.randomUUID(),
        range: unedited(words),
        insertion: unedited(insertion),
        ...(separatorAfter ? { separatorAfter: unedited(separatorAfter) } : {}),
        ...(transcriptId ? { transcriptId } : {}),
        ...(heard !== undefined ? { heard } : {}),
        ...(uncertain && uncertain.length > 0 ? { uncertain } : {}),
        ...(heard !== undefined && heardUncertain && heardUncertain.length > 0
          ? { heardUncertain }
          : {}),
        ...pausesField(pauses?.filter((at) => at <= words.to - words.from)),
        ...(heard !== undefined
          ? heardPausesField(heardPauses?.filter((at) => at <= heard.length))
          : {}),
        ...(replaced ? { replaced } : {}),
      }),
    })),

  markPause: (target) => {
    const key = makeDraftKey(target.panelId, target.projectId);
    const record = get().drafts[key]?.find((r) => r.sessionId === target.sessionId);
    const last = record?.utterances[record.utterances.length - 1];
    if (!record || !last || last.range.edited) return false;
    const end = last.range.to - last.range.from;
    const heardEnd = last.heard?.length;
    // Each is checked on its own: a rule can have written the end over a
    // pause the words as heard put somewhere else.
    const written = !last.pauses?.includes(end);
    const heard = heardEnd !== undefined && !last.heardPauses?.includes(heardEnd);
    if (end <= 0 || (!written && !heard)) return false;
    const marked: DictationUtterance = {
      ...last,
      ...pausesField([...(last.pauses ?? []), end]),
      ...(heardEnd !== undefined ? heardPausesField([...(last.heardPauses ?? []), heardEnd]) : {}),
    };
    set((state) =>
      replaceRecord(state, { ...record, utterances: [...record.utterances.slice(0, -1), marked] })
    );
    return true;
  },

  recordParagraphBreak: (target, insertion) =>
    set((state) => ({ drafts: withInsertion(state.drafts, target, insertion, null) })),

  takeLastUtterance: (target, draft) => {
    const key = makeDraftKey(target.panelId, target.projectId);
    const records = get().drafts[key] ?? [];
    const index = records.findIndex((r) => r.sessionId === target.sessionId);
    const record = records[index];
    const last = record?.utterances[record.utterances.length - 1];
    if (!record || !last || last.insertion.edited || last.insertion.from >= last.insertion.to) {
      return null;
    }
    // Only an unedited envelope holds nothing but the session's own text, so
    // only there is a newline past the utterance one of its paragraph breaks
    // rather than one the user typed.
    const tail = draft.slice(last.insertion.to, record.range.to);
    const to =
      !record.range.edited && /^\n*$/.test(tail)
        ? Math.max(last.insertion.to, record.range.to)
        : last.insertion.to;
    const from = last.insertion.from;
    if (to > draft.length) return null;
    // The space the words were given ahead of the text after them goes with
    // them, so that text is left as it was before they landed.
    const separator = last.separatorAfter;
    const end =
      separator &&
      !separator.edited &&
      separator.from === to &&
      separator.to <= draft.length &&
      draft.slice(separator.from, separator.to).trim() === ""
        ? separator.to
        : to;
    const trimmed: DictationRecord = {
      ...record,
      // Taking the text off the envelope's end keeps a clean envelope clean.
      range:
        to === record.range.to
          ? { ...record.range, to: Math.max(record.range.from, from) }
          : record.range,
      utterances: record.utterances.slice(0, -1),
      // Breaks it took with the utterance are gone from the draft too. Kept,
      // they would map to empty edited ranges and stop a cancel taking the rest.
      breaks: record.breaks.filter(
        (paragraphBreak) => paragraphBreak.to <= from || paragraphBreak.from >= to
      ),
    };
    set((state) => ({
      drafts: { ...state.drafts, [key]: records.map((r, i) => (i === index ? trimmed : r)) },
    }));
    return { from, to: end };
  },

  mapDrafts: (previous, next) => {
    const { drafts, anchors } = get();
    const nextAnchors = mapAnchors(anchors, previous, next);
    let nextDrafts: Record<string, DictationRecord[]> | null = null;
    for (const [key, records] of Object.entries(drafts)) {
      const after = next.get(key) ?? "";
      const before = previous.get(key) ?? "";
      if (after === before) continue;
      nextDrafts ??= { ...drafts };
      if (after === "") {
        delete nextDrafts[key];
        continue;
      }
      const { changes, known, records: rebuilt } = changesFor(key, before, after);
      nextDrafts[key] = records.map(
        (record) =>
          rebuilt?.get(record.id) ??
          changes.reduce(mapRecord, known ? record : forgetWordMarks(record))
      );
    }
    expectedChanges.clear();
    // One update: a subscriber woken between two would read ranges that
    // haven't moved yet against the draft that has.
    if (nextAnchors || nextDrafts) {
      set({
        ...(nextAnchors ? { anchors: nextAnchors } : {}),
        ...(nextDrafts ? { drafts: nextDrafts } : {}),
      });
    }
  },

  expectDraftChange: (panelId, projectId, before, after, change, records) => {
    // A replacement goes ahead of an insertion at its start: the insertion is
    // the earlier of the two in the draft.
    const changes =
      "insert" in change ? [change] : [...change].sort((a, b) => b.from - a.from || b.to - a.to);
    expectedChanges.set(makeDraftKey(panelId, projectId), {
      before,
      after,
      changes,
      records: records?.length ? new Map(records.map((record) => [record.id, record])) : null,
    });
  },

  rewritePassage: (id, passage, text, heard, uncertain, pauses) => {
    const record = get().getDictation(id);
    if (!record || !text) return null;
    const first = record.utterances.findIndex((u) => u.id === passage.utteranceIds[0]);
    const run = record.utterances.slice(first, first + passage.utteranceIds.length);
    if (
      first < 0 ||
      run.length !== passage.utteranceIds.length ||
      run.some((u, i) => u.id !== passage.utteranceIds[i] || u.range.edited)
    ) {
      return null;
    }
    // A stop has waited for its transcripts' file references, so this is only
    // for one still on its way, which can then land in the merged words.
    const transcriptId = run.find((u) => u.transcriptId)?.transcriptId;
    const replaced = run.find((u) => u.replaced)?.replaced;
    const from = run[0]!.range.from;
    const to = run[run.length - 1]!.range.to;
    const inputStore = useTerminalInputStore.getState();
    const draft = inputStore.getDraftInput(record.panelId, record.projectId);
    if (draft.slice(from, to) !== passage.text) return null;

    const change: TextChange = { from, to, insert: text };
    const next = draft.slice(0, from) + text + draft.slice(to);
    // Spelled out, so the session's anchor and other records follow the words
    // actually rewritten rather than a repeat of them the diff might pick.
    get().expectDraftChange(record.panelId, record.projectId, draft, next, change);
    inputStore.setDraftInput(record.panelId, next, record.projectId);
    // The write was mapped like anyone's, which flagged the passage edited.
    // The session wrote it, so the record is rebuilt from what it knows: the
    // passage becomes one utterance, and what follows it (later words, the
    // space kept before typed text, the learning span) moves with the write.
    const mapped = mapRecord(record, change);
    const end = from + text.length;
    const separators = mapped.utterances
      .slice(first, first + run.length)
      .flatMap((u) => (u.separatorAfter ? [u.separatorAfter] : []));
    const separatorAfter =
      separators.find((s) => s.from === end) ?? separators[separators.length - 1];
    const merged: DictationUtterance = {
      id: run[0]!.id,
      range: unedited({ from, to: end }),
      insertion: { ...run[0]!.insertion, to: end },
      ...(separatorAfter ? { separatorAfter } : {}),
      ...(transcriptId ? { transcriptId } : {}),
      ...(heard !== text ? { heard } : {}),
      ...(uncertain && uncertain.text.length > 0 ? { uncertain: uncertain.text } : {}),
      ...(heard !== text && uncertain && uncertain.heard.length > 0
        ? { heardUncertain: uncertain.heard }
        : {}),
      ...pausesField(pauses?.text, text),
      ...(heard !== text ? heardPausesField(pauses?.heard, heard) : {}),
      ...(replaced ? { replaced } : {}),
    };
    const delta = end - to;
    const rewritten: DictationRecord = {
      ...mapped,
      range: {
        ...record.range,
        to: record.range.to >= to ? record.range.to + delta : record.range.to,
      },
      utterances: [
        ...mapped.utterances.slice(0, first),
        merged,
        ...mapped.utterances.slice(first + run.length),
      ],
      // A paragraph break inside the passage is now part of the merged words.
      // Kept, it would map to an empty edited range and stop a cancel.
      breaks: mapped.breaks.filter((_, i) => {
        const paragraphBreak = record.breaks[i]!;
        return paragraphBreak.to <= from || paragraphBreak.from >= to;
      }),
    };
    set((state) => replaceRecord(state, rewritten));
    return { from, to };
  },

  rewriteWords: (id, edits, write, heardSwaps) => {
    const record = get().getDictation(id);
    if (!record || edits.length === 0) return;
    let next = useTerminalInputStore.getState().getDraftInput(record.panelId, record.projectId);
    let rewritten = record;
    const owners = new Set<string>();
    // Words the heard-as rules wrote are replayed from the words as heard at
    // stop, which would put the spoken command back over a swap they don't
    // carry; that swap stays an edit.
    const owns = (utterance: DictationUtterance) =>
      utterance.heard === undefined || heardSwaps?.has(utterance.id) === true;
    // Last first, so each edit is still placed where it was planned.
    for (let i = edits.length - 1; i >= 0; i--) {
      const { from, to, text } = edits[i]!;
      const change = { from, to, insert: text };
      next = next.slice(0, from) + text + next.slice(to);
      const owner = ownerOf(rewritten, change, owns);
      if (owner < 0) {
        rewritten = mapRecord(rewritten, change);
        continue;
      }
      owners.add(rewritten.utterances[owner]!.id);
      rewritten = mapOwnEdit(rewritten, change, owner);
    }
    rewritten = {
      ...rewritten,
      utterances: rewritten.utterances.map((utterance) => {
        const swaps = heardSwaps?.get(utterance.id);
        return swaps && owners.has(utterance.id) ? withSwappedHeard(utterance, swaps) : utterance;
      }),
    };
    write(next);
    // The write was mapped like anyone's, which flagged the words it swapped
    // edited. The session wrote them, so the record is the one mapped above.
    set((state) => replaceRecord(state, rewritten));
  },

  yieldLeadingSpace: (id, span) => {
    const record = get().getDictation(id);
    if (!record) return;
    // An utterance's words never open with a space, and its unsure words are
    // placed from their start, so they stay where they are.
    const moved: DictationRecord = {
      ...record,
      range: startAfter(record.range, span),
      utterances: record.utterances.map((utterance) => ({
        ...utterance,
        insertion: startAfter(utterance.insertion, span),
      })),
      breaks: record.breaks.map((paragraphBreak) => startAfter(paragraphBreak, span)),
      ...(record.learningSpan ? { learningSpan: startAfter(record.learningSpan, span) } : {}),
    };
    set((state) => replaceRecord(state, moved));
  },

  rewriteUtterances: (id, rewrites, write) => {
    const record = get().getDictation(id);
    if (!record || rewrites.length === 0) return null;
    const draft = useTerminalInputStore.getState().getDraftInput(record.panelId, record.projectId);
    const located: LocatedRewrite[] = [];
    for (const rewrite of rewrites) {
      const { utteranceIds, text } = rewrite.passage;
      const first = record.utterances.findIndex((u) => u.id === utteranceIds[0]);
      const run = record.utterances.slice(first, first + utteranceIds.length);
      if (
        first < 0 ||
        !rewrite.text ||
        run.length !== utteranceIds.length ||
        run.some((u, i) => u.id !== utteranceIds[i] || u.range.edited)
      ) {
        return null;
      }
      const from = run[0]!.range.from;
      const to = run[run.length - 1]!.range.to;
      const prev = located[located.length - 1];
      if ((prev && from < prev.to) || draft.slice(from, to) !== text) return null;
      located.push({ first, run, from, to, rewrite });
    }
    const spans = located.map(({ from, to }) => ({ from, to }));

    // Each change trimmed to what it alters, so the anchor and every other
    // range follow exactly what was rewritten.
    const changes = located.flatMap(({ from, rewrite }) => {
      const change = minimalDocChange(rewrite.passage.text, rewrite.text);
      return change
        ? [{ from: from + change.from, to: from + change.to, insert: change.insert }]
        : [];
    });
    if (changes.length === 0) return spans;
    let next = draft;
    for (let i = located.length - 1; i >= 0; i--) {
      const { from, to, rewrite } = located[i]!;
      next = next.slice(0, from) + rewrite.text + next.slice(to);
    }

    // Carried through the write like anyone's, which flags what it rewrote;
    // the session wrote it, so each passage's utterances are then rebuilt
    // from what it knows.
    const mapped = [...changes].sort((a, b) => b.from - a.from).reduce(mapRecord, record);
    const utterances = [...mapped.utterances];
    let rangeShift = 0;
    for (let i = located.length - 1; i >= 0; i--) {
      const piece = located[i]!;
      const at =
        piece.from +
        located
          .slice(0, i)
          .reduce((sum, { from, to, rewrite }) => sum + rewrite.text.length - (to - from), 0);
      utterances.splice(
        piece.first,
        piece.run.length,
        ...rewrittenUtterances(piece, at, mapped, draft)
      );
      const delta = piece.rewrite.text.length - (piece.to - piece.from);
      if (record.range.to >= piece.to) rangeShift += delta;
    }
    // Over each whole passage, not the trimmed changes: words the rewrite
    // added at the very end of the dictation are still its words to learn from.
    const learningSpan =
      record.learningSpan &&
      located.reduceRight(
        (span, { from, to, rewrite }) =>
          mapSpanKeepingEdits(span, { from, to, insert: rewrite.text }),
        record.learningSpan
      );
    const rebuilt: DictationRecord = {
      ...mapped,
      range: { ...record.range, to: record.range.to + rangeShift },
      ...(learningSpan ? { learningSpan } : {}),
      utterances,
      // A paragraph break inside a passage is now part of its words. Kept, it
      // would map to an empty edited range and stop a cancel.
      breaks: mapped.breaks.filter((_, i) => {
        const paragraphBreak = record.breaks[i]!;
        return located.every(
          ({ from, to }) => paragraphBreak.to <= from || paragraphBreak.from >= to
        );
      }),
    };
    get().expectDraftChange(record.panelId, record.projectId, draft, next, changes, [rebuilt]);
    write(next);
    // A write that didn't land as the one expected was mapped like any other.
    if (get().getDictation(id) !== rebuilt) set((state) => replaceRecord(state, rebuilt));
    return spans;
  },

  getDictation: (id) => {
    for (const records of Object.values(get().drafts)) {
      const record = records.find((r) => r.id === id);
      if (record) return record;
    }
    return null;
  },

  listDictations: (panelId, projectId) => get().drafts[makeDraftKey(panelId, projectId)] ?? [],

  listSessionDictations: (sessionId) =>
    Object.values(get().drafts).flatMap((records) =>
      records.filter((record) => record.sessionId === sessionId)
    ),

  releaseDictation: (id) =>
    set((state) => {
      for (const [key, records] of Object.entries(state.drafts)) {
        if (!records.some((r) => r.id === id)) continue;
        const drafts = { ...state.drafts };
        const remaining = records.filter((r) => r.id !== id);
        if (remaining.length > 0) drafts[key] = remaining;
        else delete drafts[key];
        return { drafts };
      }
      return state;
    }),

  setAnchor: (target, span) =>
    set((state) => {
      const key = makeDraftKey(target.panelId, target.projectId);
      const others = (state.anchors[key] ?? []).filter((a) => a.sessionId !== target.sessionId);
      return {
        anchors: {
          ...state.anchors,
          [key]: [...others, { sessionId: target.sessionId, range: unedited(span) }],
        },
      };
    }),

  getAnchor: (target) =>
    get().anchors[makeDraftKey(target.panelId, target.projectId)]?.find(
      (anchor) => anchor.sessionId === target.sessionId
    )?.range ?? null,

  releaseAnchors: (sessionId) =>
    set((state) => {
      let anchors: Record<string, DictationAnchor[]> | null = null;
      for (const [key, list] of Object.entries(state.anchors)) {
        if (!list.some((a) => a.sessionId === sessionId)) continue;
        anchors ??= { ...state.anchors };
        const remaining = list.filter((a) => a.sessionId !== sessionId);
        if (remaining.length > 0) anchors[key] = remaining;
        else delete anchors[key];
      }
      return anchors ? { anchors } : state;
    }),

  clear: () => {
    expectedChanges.clear();
    set((state) =>
      Object.keys(state.drafts).length === 0 && Object.keys(state.anchors).length === 0
        ? state
        : { drafts: {}, anchors: {} }
    );
  },
}));

/**
 * Keeps dictation ranges on their text while anything rewrites a draft —
 * typing, paste, a send, panel cleanup. Synchronous, so a writer that records
 * a range straight after its own draft write sees positions that already
 * account for that write. Registered by `initStoreOrchestrator()`; tearing it
 * down drops every record, since ranges left unmapped go stale.
 */
export function subscribeDictationRangeTracking(): () => void {
  const unsubscribe = useTerminalInputStore.subscribe((state, prev) => {
    if (state.draftInputs === prev.draftInputs) return;
    useDictationRangeStore.getState().mapDrafts(prev.draftInputs, state.draftInputs);
  });
  return () => {
    unsubscribe();
    useDictationRangeStore.getState().clear();
  };
}
