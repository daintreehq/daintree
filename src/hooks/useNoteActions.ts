import { useState, useEffect, useRef, useCallback } from "react";
import type { NoteListItem, NoteMetadata } from "@/clients/notesClient";

const DEFAULT_TITLE_PATTERN = /^Note \d{1,2}\/\d{1,2}\/\d{4}( \(\d+\))?$/;

export function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title);
}

interface UseNoteActionsOptions {
  isOpen: boolean;
  notes: NoteListItem[];
  visibleNotes: NoteListItem[];
  isLoading: boolean;
  isSearching: boolean;
  lastSelectedNoteId: string | null;
  setLastSelectedNoteId: (id: string | null) => void;
  initialize: () => void;
  createNote: (
    title: string,
    scope: "worktree" | "project"
  ) => Promise<{
    metadata: NoteMetadata;
    content: string;
    path: string;
    lastModified: number;
  }>;
  deleteNote: (path: string) => Promise<void>;
  refresh: () => void;
  // Hook setters
  setQuery: (q: string) => void;
  setNoteContent: (content: string) => void;
  setNoteMetadata: (metadata: NoteMetadata | null) => void;
  setNoteLastModified: (ts: number | null) => void;
  setHasConflict: (v: boolean) => void;
  setEditingNoteId: (id: string | null) => void;
  setIsEditingHeaderTitle: (v: boolean) => void;
  setHeaderTitleEdit: (title: string) => void;
  headerTitleInputRef: React.RefObject<HTMLInputElement | null>;
  // Current state from hooks
  noteContent: string;
  editingNoteId: string | null;
  isEditingHeaderTitle: boolean;
  showCreateItem: boolean;
  trimmedQuery: string;
  // Component-owned state
  selectedNote: NoteListItem | null;
  setSelectedNote: (note: NoteListItem | null) => void;
  // Callbacks
  onClose: () => void;
  handleOpenAsPanel: (location: "grid" | "dock") => Promise<void>;
}

export interface UseNoteActionsReturn {
  selectedIndex: number;
  deleteConfirmNote: NoteListItem | null;
  setDeleteConfirmNote: (note: NoteListItem | null) => void;
  handleSelectNote: (note: NoteListItem, index: number) => Promise<void>;
  handleCreateNote: (customTitle?: string) => Promise<void>;
  handleDeleteNote: (note: NoteListItem, e: React.MouseEvent) => void;
  handleConfirmDelete: () => Promise<void>;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleClose: () => Promise<void>;
  handleBackdropClick: (e: React.MouseEvent) => void;
}

export function useNoteActions({
  isOpen,
  notes,
  visibleNotes,
  isLoading,
  isSearching,
  lastSelectedNoteId,
  setLastSelectedNoteId,
  initialize,
  createNote,
  deleteNote,
  refresh,
  setQuery,
  setNoteContent,
  setNoteMetadata,
  setNoteLastModified,
  setHasConflict,
  setEditingNoteId,
  setIsEditingHeaderTitle,
  setHeaderTitleEdit,
  headerTitleInputRef,
  noteContent,
  editingNoteId,
  isEditingHeaderTitle,
  selectedNote,
  setSelectedNote,
  showCreateItem,
  trimmedQuery,
  onClose,
  handleOpenAsPanel,
}: UseNoteActionsOptions): UseNoteActionsReturn {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [deleteConfirmNote, setDeleteConfirmNote] = useState<NoteListItem | null>(null);

  const hasRestoredRef = useRef(false);

  // Initialize notes on open
  useEffect(() => {
    if (isOpen) {
      hasRestoredRef.current = false;
      initialize();
      setQuery("");
      setSelectedIndex(0);
      setSelectedNote(null);
      setNoteContent("");
      setNoteMetadata(null);
      setNoteLastModified(null);
      setEditingNoteId(null);
      setIsEditingHeaderTitle(false);
      setHasConflict(false);
    }
  }, [
    isOpen,
    initialize,
    setQuery,
    setSelectedNote,
    setNoteContent,
    setNoteMetadata,
    setNoteLastModified,
    setEditingNoteId,
    setIsEditingHeaderTitle,
    setHasConflict,
  ]);

  // Restore last selected note
  useEffect(() => {
    if (!isOpen || isLoading || isSearching || hasRestoredRef.current) return;
    if (visibleNotes.length === 0) return;

    if (lastSelectedNoteId) {
      const noteToRestore = visibleNotes.find((n) => n.id === lastSelectedNoteId);
      if (noteToRestore) {
        if (isDefaultTitle(noteToRestore.title) && !noteToRestore.preview) {
          setLastSelectedNoteId(null);
        } else {
          const index = visibleNotes.indexOf(noteToRestore);
          setSelectedNote(noteToRestore);
          setSelectedIndex(index >= 0 ? index : 0);
          hasRestoredRef.current = true;
          return;
        }
      } else {
        setLastSelectedNoteId(null);
      }
    }

    const fallback = visibleNotes.find((n) => !(isDefaultTitle(n.title) && !n.preview));
    if (fallback) {
      const idx = visibleNotes.indexOf(fallback);
      setSelectedNote(fallback);
      setSelectedIndex(idx >= 0 ? idx : 0);
    }
    hasRestoredRef.current = true;
  }, [
    isOpen,
    lastSelectedNoteId,
    visibleNotes,
    isLoading,
    isSearching,
    setLastSelectedNoteId,
    setSelectedNote,
  ]);

  // Clamp selectedIndex
  useEffect(() => {
    if (selectedIndex >= visibleNotes.length) {
      setSelectedIndex(Math.max(0, visibleNotes.length - 1));
    }
  }, [visibleNotes.length, selectedIndex]);

  // Escape key to close (when no note selected)
  useEffect(() => {
    if (!isOpen) return;
    const handleEscapeClose = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !selectedNote && !editingNoteId && !isEditingHeaderTitle) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscapeClose);
    return () => window.removeEventListener("keydown", handleEscapeClose);
  }, [isOpen, onClose, selectedNote, editingNoteId, isEditingHeaderTitle]);

  const shouldAutoDelete = useCallback((note: NoteListItem | null, content: string): boolean => {
    if (!note) return false;
    return !content.trim() && isDefaultTitle(note.title);
  }, []);

  const deleteIfAutoDeleteable = useCallback(
    async (note: NoteListItem | null, content: string) => {
      if (!shouldAutoDelete(note, content)) return;
      try {
        await deleteNote(note!.path);
        if (lastSelectedNoteId === note!.id) {
          setLastSelectedNoteId(null);
        }
      } catch (e) {
        console.error("Failed to delete empty note:", e);
      }
    },
    [deleteNote, shouldAutoDelete, lastSelectedNoteId, setLastSelectedNoteId]
  );

  const handleSelectNote = useCallback(
    async (note: NoteListItem, index: number) => {
      if (selectedNote && selectedNote.id !== note.id) {
        await deleteIfAutoDeleteable(selectedNote, noteContent);
      }
      setSelectedNote(note);
      setSelectedIndex(index);
      if (!isDefaultTitle(note.title) || note.preview) {
        setLastSelectedNoteId(note.id);
      }
    },
    [selectedNote, noteContent, deleteIfAutoDeleteable, setLastSelectedNoteId, setSelectedNote]
  );

  const handleCreateNote = useCallback(
    async (customTitle?: string) => {
      try {
        let noteTitle: string;

        if (customTitle) {
          noteTitle = customTitle.trim();
        } else {
          const baseTitle = `Note ${new Date().toLocaleDateString()}`;
          noteTitle = baseTitle;
          let suffix = 1;
          const existingTitles = new Set(notes.map((n) => n.title));
          while (existingTitles.has(noteTitle)) {
            suffix++;
            noteTitle = `${baseTitle} (${suffix})`;
          }
        }

        const content = await createNote(noteTitle, "project");
        setQuery("");
        await refresh();
        const newNote = {
          id: content.metadata.id,
          title: content.metadata.title,
          path: content.path,
          scope: content.metadata.scope,
          worktreeId: content.metadata.worktreeId,
          createdAt: content.metadata.createdAt,
          modifiedAt: Date.now(),
          preview: "",
          tags: [] as string[],
        };
        setSelectedNote(newNote);
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
        setNoteLastModified(content.lastModified);
        if (customTitle) {
          setLastSelectedNoteId(newNote.id);
        }
        setIsEditingHeaderTitle(true);
        setHeaderTitleEdit(content.metadata.title);
        requestAnimationFrame(() => {
          headerTitleInputRef.current?.select();
        });
      } catch (error) {
        console.error("Failed to create note:", error);
      }
    },
    [
      notes,
      createNote,
      refresh,
      setLastSelectedNoteId,
      setQuery,
      setNoteContent,
      setNoteMetadata,
      setNoteLastModified,
      setIsEditingHeaderTitle,
      setHeaderTitleEdit,
      headerTitleInputRef,
      setSelectedNote,
    ]
  );

  const handleDeleteNote = useCallback((note: NoteListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteConfirmNote(note);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteConfirmNote) return;
    try {
      await deleteNote(deleteConfirmNote.path);
      if (selectedNote?.id === deleteConfirmNote.id) {
        setSelectedNote(null);
      }
      if (lastSelectedNoteId === deleteConfirmNote.id) {
        setLastSelectedNoteId(null);
      }
    } catch (error) {
      console.error("Failed to delete note:", error);
    } finally {
      setDeleteConfirmNote(null);
    }
  }, [
    deleteNote,
    selectedNote,
    deleteConfirmNote,
    lastSelectedNoteId,
    setLastSelectedNoteId,
    setSelectedNote,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editingNoteId || isEditingHeaderTitle) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          if (!showCreateItem) {
            setSelectedIndex((prev) => Math.max(0, prev - 1));
            if (visibleNotes.length > 0) {
              const newIndex = Math.max(0, selectedIndex - 1);
              setSelectedNote(visibleNotes[newIndex]);
            }
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          if (!showCreateItem) {
            setSelectedIndex((prev) => Math.min(visibleNotes.length - 1, prev + 1));
            if (visibleNotes.length > 0) {
              const newIndex = Math.min(visibleNotes.length - 1, selectedIndex + 1);
              setSelectedNote(visibleNotes[newIndex]);
            }
          }
          break;
        case "Enter":
          e.preventDefault();
          if (e.shiftKey && (e.metaKey || e.ctrlKey) && selectedNote) {
            handleOpenAsPanel("dock");
          } else if (e.metaKey || e.ctrlKey) {
            handleCreateNote();
          } else if (e.shiftKey && selectedNote) {
            handleOpenAsPanel("grid");
          } else if (showCreateItem) {
            handleCreateNote(trimmedQuery);
          } else if (visibleNotes.length > 0 && !selectedNote) {
            setSelectedNote(visibleNotes[selectedIndex]);
          }
          break;
        case "n":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            handleCreateNote();
          }
          break;
        case "Escape":
          if (selectedNote) {
            e.preventDefault();
            e.stopPropagation();
            deleteIfAutoDeleteable(selectedNote, noteContent).then(() => {
              setSelectedNote(null);
            });
          }
          break;
      }
    },
    [
      editingNoteId,
      isEditingHeaderTitle,
      visibleNotes,
      selectedIndex,
      selectedNote,
      noteContent,
      showCreateItem,
      trimmedQuery,
      handleCreateNote,
      handleOpenAsPanel,
      deleteIfAutoDeleteable,
      setSelectedNote,
    ]
  );

  const handleClose = useCallback(async () => {
    if (selectedNote) {
      await deleteIfAutoDeleteable(selectedNote, noteContent);
    }
    onClose();
  }, [selectedNote, noteContent, deleteIfAutoDeleteable, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        handleClose();
      }
    },
    [handleClose]
  );

  return {
    selectedIndex,
    deleteConfirmNote,
    setDeleteConfirmNote,
    handleSelectNote,
    handleCreateNote,
    handleDeleteNote,
    handleConfirmDelete,
    handleKeyDown,
    handleClose,
    handleBackdropClick,
  };
}
