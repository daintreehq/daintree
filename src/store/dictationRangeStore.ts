import { create } from "zustand";
import {
  mapSpanKeepingEdits,
  mapTextRange,
  minimalDocChange,
  type TextChange,
  type TrackedTextRange,
} from "@/lib/textRangeMapping";
import { makeDraftKey } from "@/lib/draftKey";
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
}

/**
 * Where one dictation session's text sits in a draft. Positions follow every
 * draft edit, and `edited` latches once a change reaches text the range
 * covers, so a caller can refuse to overwrite what it no longer wrote.
 *
 * Positions come from diffing successive draft strings, so they track text,
 * not keystrokes: an edit inside a run of identical characters is placed at
 * the run's end, which can leave a range on a neighbouring copy of its own
 * text. A range that isn't flagged always still holds the text it held before.
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
    }
  ) => void;
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
   * identical runs was written, so a writer that knows passes it here.
   */
  expectDraftChange: (
    panelId: string,
    projectId: string | undefined,
    before: string,
    after: string,
    change: TextChange
  ) => void;
  /**
   * Writes `text` over a passage of the session's own words, as the session:
   * the passage's utterances become one holding it, still unedited, so
   * correction treats it as dictated. `uncertain` gives the unsure words in
   * `text` and in `heard`, which only the rewriter can place. Returns the span
   * the passage covered before the write, or null, writing nothing, once the
   * passage no longer holds `passage.text` or one of its words was edited.
   */
  rewritePassage: (
    id: string,
    passage: { utteranceIds: readonly string[]; text: string },
    text: string,
    heard: string,
    uncertain?: { text: DictationTextSpan[]; heard: DictationTextSpan[] }
  ) => DictationTextSpan | null;
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

function sameSpan(a: DictationTextSpan | undefined, b: DictationTextSpan | undefined): boolean {
  return a === b || (!!a && !!b && a.from === b.from && a.to === b.to);
}

/**
 * The record without its unsure words, for a change its writer didn't
 * describe. The change is then inferred by diffing the drafts, which can't say
 * which copy of repeated text changed, nor see the separate edits one update
 * can hold, so a flag kept through it could end up on another copy of its word.
 */
function forgetUncertain(record: DictationRecord): DictationRecord {
  if (!record.utterances.some((u) => u.uncertain || u.heardUncertain)) return record;
  return {
    ...record,
    utterances: record.utterances.map((utterance) => {
      if (!utterance.uncertain && !utterance.heardUncertain) return utterance;
      const { uncertain: _uncertain, heardUncertain: _heardUncertain, ...rest } = utterance;
      return rest;
    }),
  };
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

/**
 * Every span the dictation put in the draft, last first, for taking it back
 * out: each utterance with its separator, and each paragraph break. Text typed
 * between them stays where it is. Null once any of them has been edited,
 * because removing them would take the user's edits with them.
 *
 * The space an utterance was given ahead of the text after it goes too while
 * it is untouched and still right after something removed, as a scratch takes
 * it, so dictation at the caret leaves the text around it as it was. Edited, or
 * with text typed up against the words, it stays: it is no longer only ours.
 */
export function dictatedSpans(record: DictationRecord, draft: string): DictationTextSpan[] | null {
  // An insertion holds its utterance's words, so an edit to them flags it too.
  const pieces = [...record.utterances.map((u) => u.insertion), ...record.breaks];
  if (pieces.some((piece) => piece.edited)) return null;
  const spans = pieces.map(({ from, to }) => ({ from, to })).sort((a, b) => b.from - a.from);
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

// One-shot and keyed by draft: a write that never lands as expected (another
// write got there first) is simply diffed, as every other write is.
const expectedChanges = new Map<string, { before: string; after: string; change: TextChange }>();

/** The change, and whether its writer said where it was rather than it being inferred. */
function changeFor(
  key: string,
  before: string,
  after: string
): { change: TextChange; known: boolean } {
  const expected = expectedChanges.get(key);
  if (expected?.before === before && expected.after === after) {
    return { change: expected.change, known: true };
  }
  return { change: minimalDocChange(before, after)!, known: false };
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
    const { change } = changeFor(key, before, after);
    nextAnchors[key] = list.map((anchor) => ({
      ...anchor,
      range: mapTextRange(anchor.range, change),
    }));
  }
  return nextAnchors;
}

export const useDictationRangeStore = create<DictationRangeState>()((set, get) => ({
  drafts: {},
  anchors: {},

  recordUtterance: (
    target,
    { insertion, words, separatorAfter, transcriptId, heard, uncertain, heardUncertain }
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
      }),
    })),

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
    if (nextAnchors) set({ anchors: nextAnchors });
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
      const { change, known } = changeFor(key, before, after);
      nextDrafts[key] = records.map((record) =>
        mapRecord(known ? record : forgetUncertain(record), change)
      );
    }
    expectedChanges.clear();
    if (nextDrafts) set({ drafts: nextDrafts });
  },

  expectDraftChange: (panelId, projectId, before, after, change) => {
    expectedChanges.set(makeDraftKey(panelId, projectId), { before, after, change });
  },

  rewritePassage: (id, passage, text, heard, uncertain) => {
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
    set((state) => {
      const key = makeDraftKey(record.panelId, record.projectId);
      const records = state.drafts[key];
      if (!records?.some((r) => r.id === id)) return state;
      return {
        drafts: { ...state.drafts, [key]: records.map((r) => (r.id === id ? rewritten : r)) },
      };
    });
    return { from, to };
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
