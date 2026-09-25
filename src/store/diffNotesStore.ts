import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StorageValue } from "zustand/middleware";
import { createSafeJSONStorage } from "./persistence/safeStorage";
import {
  mergeRecordByWriterDelta,
  type PersistWriteMergeContext,
} from "./persistence/persistWriteMerge";
import { registerPersistedStore } from "./persistence/persistedStoreRegistry";
import type { DiffNote, DiffNoteAnchor } from "@/components/Worktree/diffNotes";

/**
 * Pending review notes on local diffs, waiting to be handed to an agent. This
 * is an outbox, not a notes store (docs/feature-curation.md): a note leaves
 * once it is sent. Persisted because a pending note has to outlive the panel
 * and project-view eviction, and kept flat by note id so the cross-view write
 * merge settles each note on its own rather than a whole worktree's worth.
 */

interface DiffNotesState {
  notes: Record<string, DiffNote>;
  /**
   * Open editors per note in this view. Never persisted: it only exists so a
   * send can leave a note alone while its reviewer is still rewriting it. A
   * count, because two panes can have the same note open and closing one must
   * not release the other.
   */
  editingIds: Record<string, number>;
  setEditing: (id: string, editing: boolean) => void;
  addNote: (input: {
    worktreePath: string;
    filePath: string;
    anchor: DiffNoteAnchor;
    body: string;
  }) => DiffNote | null;
  /**
   * Saves an edit. A note that is gone by then was sent while its editor was
   * open, so the edit is kept as a new pending note rather than dropped.
   */
  saveNote: (note: DiffNote, body: string) => void;
  deleteNote: (id: string) => void;
  /**
   * Removes notes that were delivered, but only where the stored note still
   * matches what was sent — one edited after the prompt was built stays.
   */
  clearSent: (sent: readonly DiffNote[]) => number;
}

type DiffNotesPersistedState = Pick<DiffNotesState, "notes">;

function notesOf(value: StorageValue<DiffNotesPersistedState> | null): Record<string, DiffNote> {
  const notes = value?.state?.notes;
  return notes !== null && typeof notes === "object" ? notes : {};
}

export function mergeDiffNotesPersistedWrite({
  baseline,
  onDisk,
  incoming,
}: PersistWriteMergeContext<DiffNotesPersistedState>): StorageValue<DiffNotesPersistedState> {
  if (!onDisk) return incoming;
  const baselineNotes = notesOf(baseline);
  const incomingNotes = notesOf(incoming);
  const onDiskNotes = notesOf(onDisk);
  const merged = mergeRecordByWriterDelta(baselineNotes, incomingNotes, onDiskNotes);
  // The generic merge lets a writer's deletion win outright. For a note that
  // was sent, that would erase a rewrite a sibling view saved after this
  // writer's baseline, so a deletion only lands on the revision it saw.
  for (const [id, before] of Object.entries(baselineNotes)) {
    if (id in incomingNotes) continue;
    const current = onDiskNotes[id];
    if (current && current.updatedAt !== before.updatedAt) merged[id] = current;
  }
  return { version: incoming.version, state: { notes: merged } };
}

function newNoteId(): string {
  return `diffnote-${crypto.randomUUID()}`;
}

export const useDiffNotesStore = create<DiffNotesState>()(
  persist(
    (set, get) => ({
      notes: {},
      editingIds: {},

      setEditing: (id, editing) =>
        set((state) => {
          const count = (state.editingIds[id] ?? 0) + (editing ? 1 : -1);
          const next = { ...state.editingIds };
          if (count > 0) next[id] = count;
          else delete next[id];
          return { editingIds: next };
        }),

      addNote: ({ worktreePath, filePath, anchor, body }) => {
        const trimmed = body.trim();
        if (!trimmed || !worktreePath || !filePath) return null;
        const now = Date.now();
        const note: DiffNote = {
          id: newNoteId(),
          worktreePath,
          filePath,
          anchor,
          body: trimmed,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ notes: { ...state.notes, [note.id]: note } }));
        return note;
      },

      saveNote: (note, body) => {
        const trimmed = body.trim();
        if (!trimmed) {
          get().deleteNote(note.id);
          return;
        }
        set((state) => {
          const existing = state.notes[note.id];
          if (existing && existing.body === trimmed) return state;
          const now = Date.now();
          const next: DiffNote = existing
            ? { ...existing, body: trimmed, updatedAt: now }
            : { ...note, id: newNoteId(), body: trimmed, createdAt: now, updatedAt: now };
          return { notes: { ...state.notes, [next.id]: next } };
        });
      },

      deleteNote: (id) =>
        set((state) => {
          if (!(id in state.notes)) return state;
          const { [id]: _removed, ...rest } = state.notes;
          return { notes: rest };
        }),

      clearSent: (sent) => {
        let cleared = 0;
        set((state) => {
          const next = { ...state.notes };
          for (const note of sent) {
            const current = next[note.id];
            if (!current) continue;
            if (current.updatedAt !== note.updatedAt || current.body !== note.body) continue;
            delete next[note.id];
            cleared++;
          }
          return cleared === 0 ? state : { notes: next };
        });
        return cleared;
      },
    }),
    {
      name: "daintree-diff-notes",
      storage: createSafeJSONStorage<DiffNotesPersistedState>({
        mergeOnWrite: mergeDiffNotesPersistedWrite,
      }),
      version: 0,
      partialize: (state): DiffNotesPersistedState => ({ notes: state.notes }),
    }
  )
);

registerPersistedStore({
  storeId: "diffNotesStore",
  store: useDiffNotesStore,
  persistedStateType: "{ notes: Record<string, DiffNote> }",
});

const EMPTY_NOTES: readonly DiffNote[] = [];

/** Notes for one worktree, optionally one file. Callers memoize with useShallow. */
export function selectDiffNotes(
  state: Pick<DiffNotesState, "notes">,
  worktreePath: string,
  filePath?: string
): readonly DiffNote[] {
  if (!worktreePath) return EMPTY_NOTES;
  const result: DiffNote[] = [];
  for (const note of Object.values(state.notes)) {
    if (note.worktreePath !== worktreePath) continue;
    if (filePath !== undefined && note.filePath !== filePath) continue;
    result.push(note);
  }
  return result.length ? result : EMPTY_NOTES;
}
