import { create } from "zustand";
import {
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
   * Main's id for the transcript the words came from, set when spoken file
   * references in it may still arrive. One transcript can span several
   * utterances when a spoken new line splits it.
   */
  transcriptId?: string;
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
    span: { insertion: DictationTextSpan; words: DictationTextSpan; transcriptId?: string }
  ) => void;
  /** Records a paragraph break the session just wrote into the draft. */
  recordParagraphBreak: (target: DictationDraftTarget, insertion: DictationTextSpan) => void;
  /**
   * Takes the session's latest utterance out of its record and returns the
   * draft span that held it, trailing paragraph breaks included, for the caller
   * to delete. Null when the session has no utterance left in this draft or the
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

function mapRecord(record: DictationRecord, change: TextChange): DictationRecord {
  const range = mapTextRange(record.range, change);
  let utterancesChanged = false;
  const utterances = record.utterances.map((utterance) => {
    const mapped = {
      ...utterance,
      range: mapTextRange(utterance.range, change),
      insertion: mapTextRange(utterance.insertion, change),
    };
    if (
      sameRange(mapped.range, utterance.range) &&
      sameRange(mapped.insertion, utterance.insertion)
    ) {
      return utterance;
    }
    utterancesChanged = true;
    return mapped;
  });
  if (!utterancesChanged && sameRange(range, record.range)) return record;
  return { ...record, range, utterances: utterancesChanged ? utterances : record.utterances };
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

  if (index < 0) {
    const record: DictationRecord = {
      id: crypto.randomUUID(),
      sessionId: target.sessionId,
      panelId: target.panelId,
      projectId: target.projectId,
      range: unedited(insertion),
      utterances,
    };
    return { ...drafts, [key]: [...records, record] };
  }

  const existing = records[index]!;
  const contiguous = insertion.from === existing.range.to;
  const record: DictationRecord = {
    ...existing,
    range: {
      from: Math.min(existing.range.from, insertion.from),
      to: Math.max(existing.range.to, insertion.to),
      edited: existing.range.edited || !contiguous,
    },
    utterances: [...existing.utterances, ...utterances],
  };
  return { ...drafts, [key]: records.map((r, i) => (i === index ? record : r)) };
}

// One-shot and keyed by draft: a write that never lands as expected (another
// write got there first) is simply diffed, as every other write is.
const expectedChanges = new Map<string, { before: string; after: string; change: TextChange }>();

function changeFor(key: string, before: string, after: string): TextChange {
  const expected = expectedChanges.get(key);
  if (expected?.before === before && expected.after === after) return expected.change;
  return minimalDocChange(before, after)!;
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
    const change = changeFor(key, before, after);
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

  recordUtterance: (target, { insertion, words, transcriptId }) =>
    set((state) => ({
      drafts: withInsertion(state.drafts, target, insertion, {
        id: crypto.randomUUID(),
        range: unedited(words),
        insertion: unedited(insertion),
        ...(transcriptId ? { transcriptId } : {}),
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
    const trimmed: DictationRecord = {
      ...record,
      // Taking the text off the envelope's end keeps a clean envelope clean.
      range:
        to === record.range.to
          ? { ...record.range, to: Math.max(record.range.from, from) }
          : record.range,
      utterances: record.utterances.slice(0, -1),
    };
    set((state) => ({
      drafts: { ...state.drafts, [key]: records.map((r, i) => (i === index ? trimmed : r)) },
    }));
    return { from, to };
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
      const change = changeFor(key, before, after);
      nextDrafts[key] = records.map((record) => mapRecord(record, change));
    }
    expectedChanges.clear();
    if (nextDrafts) set({ drafts: nextDrafts });
  },

  expectDraftChange: (panelId, projectId, before, after, change) => {
    expectedChanges.set(makeDraftKey(panelId, projectId), { before, after, change });
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
