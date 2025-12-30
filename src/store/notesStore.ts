import { create } from "zustand";
import { notesClient, type NoteListItem, type NoteContent } from "@/clients/notesClient";

interface NotesState {
  notes: NoteListItem[];
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  lastSelectedNoteId: string | null;
}

interface NotesActions {
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  createNote: (
    title: string,
    scope: "worktree" | "project",
    worktreeId?: string
  ) => Promise<NoteContent>;
  deleteNote: (notePath: string) => Promise<void>;
  setLastSelectedNoteId: (noteId: string | null) => void;
}

type NotesStore = NotesState & NotesActions;

let initPromise: Promise<void> | null = null;

export const useNotesStore = create<NotesStore>()((set, get) => ({
  notes: [],
  isLoading: true,
  error: null,
  isInitialized: false,
  lastSelectedNoteId: null,

  initialize: () => {
    if (get().isInitialized) return Promise.resolve();
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        set({ isLoading: true, error: null });

        const notes = await notesClient.list();
        set({ notes, isLoading: false, isInitialized: true });
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to load notes",
          isLoading: false,
          isInitialized: true,
        });
      }
    })();

    return initPromise;
  },

  refresh: async () => {
    try {
      set({ error: null });
      const notes = await notesClient.list();
      set({ notes });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to refresh notes" });
    }
  },

  createNote: async (title: string, scope: "worktree" | "project", worktreeId?: string) => {
    try {
      const noteContent = await notesClient.create(title, scope, worktreeId);
      await get().refresh();
      return noteContent;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to create note" });
      throw e;
    }
  },

  deleteNote: async (notePath: string) => {
    try {
      await notesClient.delete(notePath);
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : "Failed to delete note" });
      throw e;
    }
  },

  setLastSelectedNoteId: (noteId: string | null) => {
    set({ lastSelectedNoteId: noteId });
  },
}));

export function cleanupNotesStore() {
  initPromise = null;
  useNotesStore.setState({
    notes: [],
    isLoading: true,
    error: null,
    isInitialized: false,
    // Intentionally do NOT reset lastSelectedNoteId so it persists across project switches
  });
}
