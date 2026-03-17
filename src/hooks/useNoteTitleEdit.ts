import { useState, useEffect, useRef, useCallback } from "react";
import { notesClient, type NoteListItem, type NoteMetadata } from "@/clients/notesClient";

interface UseNoteTitleEditOptions {
  selectedNote: NoteListItem | null;
  noteMetadata: NoteMetadata | null;
  noteContent: string;
  refresh: () => void;
  setSelectedNote: (note: NoteListItem | null) => void;
  setNoteMetadata: (metadata: NoteMetadata | null) => void;
  setNoteLastModified: (ts: number | null) => void;
}

export interface UseNoteTitleEditReturn {
  editingNoteId: string | null;
  setEditingNoteId: (id: string | null) => void;
  editingTitle: string;
  setEditingTitle: (title: string) => void;
  isEditingHeaderTitle: boolean;
  setIsEditingHeaderTitle: (v: boolean) => void;
  headerTitleEdit: string;
  setHeaderTitleEdit: (title: string) => void;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
  headerTitleInputRef: React.RefObject<HTMLInputElement | null>;
  handleStartRename: (note: NoteListItem, e: React.MouseEvent) => void;
  handleRenameNote: (note: NoteListItem, newTitle: string) => Promise<void>;
  handleTitleKeyDown: (note: NoteListItem, e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleTitleBlur: (note: NoteListItem) => void;
  handleStartHeaderRename: () => void;
  handleHeaderRename: () => Promise<void>;
  handleHeaderTitleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function useNoteTitleEdit({
  selectedNote,
  noteMetadata,
  noteContent,
  refresh,
  setSelectedNote,
  setNoteMetadata,
  setNoteLastModified,
}: UseNoteTitleEditOptions): UseNoteTitleEditReturn {
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [isEditingHeaderTitle, setIsEditingHeaderTitle] = useState(false);
  const [headerTitleEdit, setHeaderTitleEdit] = useState("");

  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const headerTitleInputRef = useRef<HTMLInputElement | null>(null);

  // Focus title input when editing starts
  useEffect(() => {
    if (editingNoteId && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingNoteId]);

  // Focus header title input when editing starts
  useEffect(() => {
    if (isEditingHeaderTitle && headerTitleInputRef.current) {
      headerTitleInputRef.current.focus();
      headerTitleInputRef.current.select();
    }
  }, [isEditingHeaderTitle]);

  const handleStartRename = useCallback((note: NoteListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingNoteId(note.id);
    setEditingTitle(note.title);
  }, []);

  const handleRenameNote = useCallback(
    async (note: NoteListItem, newTitle: string) => {
      const trimmedTitle = newTitle.trim();
      if (!trimmedTitle || trimmedTitle === note.title) {
        setEditingNoteId(null);
        return;
      }

      try {
        const content = await notesClient.read(note.path);
        const updatedMetadata = { ...content.metadata, title: trimmedTitle };
        await notesClient.write(note.path, content.content, updatedMetadata);
        await refresh();

        if (selectedNote?.id === note.id) {
          setSelectedNote({ ...selectedNote, title: trimmedTitle, preview: note.preview });
          setNoteMetadata(updatedMetadata);
        }
      } catch (e) {
        console.error("Failed to rename note:", e);
      } finally {
        setEditingNoteId(null);
      }
    },
    [refresh, selectedNote, setSelectedNote, setNoteMetadata]
  );

  const handleTitleKeyDown = useCallback(
    (note: NoteListItem, e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameNote(note, editingTitle);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditingNoteId(null);
      }
    },
    [editingTitle, handleRenameNote]
  );

  const handleTitleBlur = useCallback(
    (note: NoteListItem) => {
      handleRenameNote(note, editingTitle);
    },
    [editingTitle, handleRenameNote]
  );

  const handleStartHeaderRename = useCallback(() => {
    if (!selectedNote) return;
    setIsEditingHeaderTitle(true);
    setHeaderTitleEdit(selectedNote.title);
  }, [selectedNote]);

  const handleHeaderRename = useCallback(async () => {
    if (!selectedNote || !noteMetadata) {
      setIsEditingHeaderTitle(false);
      return;
    }

    const trimmedTitle = headerTitleEdit.trim();
    if (!trimmedTitle || trimmedTitle === selectedNote.title) {
      setIsEditingHeaderTitle(false);
      return;
    }

    try {
      const updatedMetadata = { ...noteMetadata, title: trimmedTitle };
      const result = await notesClient.write(selectedNote.path, noteContent, updatedMetadata);
      await refresh();

      if (result.lastModified) {
        setNoteLastModified(result.lastModified);
      }
      setSelectedNote({ ...selectedNote, title: trimmedTitle });
      setNoteMetadata(updatedMetadata);
    } catch (e) {
      console.error("Failed to rename note:", e);
    } finally {
      setIsEditingHeaderTitle(false);
    }
  }, [
    selectedNote,
    noteMetadata,
    noteContent,
    headerTitleEdit,
    refresh,
    setSelectedNote,
    setNoteMetadata,
    setNoteLastModified,
  ]);

  const handleHeaderTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleHeaderRename();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setIsEditingHeaderTitle(false);
      }
    },
    [handleHeaderRename]
  );

  return {
    editingNoteId,
    setEditingNoteId,
    editingTitle,
    setEditingTitle,
    isEditingHeaderTitle,
    setIsEditingHeaderTitle,
    headerTitleEdit,
    setHeaderTitleEdit,
    titleInputRef,
    headerTitleInputRef,
    handleStartRename,
    handleRenameNote,
    handleTitleKeyDown,
    handleTitleBlur,
    handleStartHeaderRename,
    handleHeaderRename,
    handleHeaderTitleKeyDown,
  };
}
