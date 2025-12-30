import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useOverlayState } from "@/hooks";
import { useNotesStore } from "@/store/notesStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { notesClient, type NoteListItem, type NoteMetadata } from "@/clients/notesClient";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { canopyTheme } from "./editorTheme";
import { Plus, Trash2, ExternalLink, X, AlertTriangle, StickyNote } from "lucide-react";
import { ConfirmDialog } from "@/components/Terminal/ConfirmDialog";

interface NotesPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

// Pattern to match default note titles like "Note 12/27/2024" or "Note 12/27/2024 (2)"
const DEFAULT_TITLE_PATTERN = /^Note \d{1,2}\/\d{1,2}\/\d{4}( \(\d+\))?$/;

function isDefaultTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title);
}

export function NotesPalette({ isOpen, onClose }: NotesPaletteProps) {
  useOverlayState(isOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NoteListItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedNote, setSelectedNote] = useState<NoteListItem | null>(null);
  const [noteContent, setNoteContent] = useState<string>("");
  const [noteMetadata, setNoteMetadata] = useState<NoteMetadata | null>(null);
  const [noteLastModified, setNoteLastModified] = useState<number | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);

  // Inline editing state
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [isEditingHeaderTitle, setIsEditingHeaderTitle] = useState(false);
  const [headerTitleEdit, setHeaderTitleEdit] = useState("");
  const [deleteConfirmNote, setDeleteConfirmNote] = useState<NoteListItem | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const headerTitleInputRef = useRef<HTMLInputElement>(null);

  const {
    notes,
    isLoading,
    initialize,
    createNote,
    deleteNote,
    refresh,
    lastSelectedNoteId,
    setLastSelectedNoteId,
  } = useNotesStore();
  const { addTerminal } = useTerminalStore();
  const { activeWorktreeId } = useWorktreeSelectionStore();

  // Shared styles for note title - both display and input must match exactly
  const noteTitleBaseClass =
    "block w-full h-[22px] m-0 px-1.5 py-0.5 text-xs font-medium leading-4 border border-solid rounded box-border";

  // Focus management
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (previousFocusRef.current) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  // Track whether we've restored the last note on this open cycle
  const hasRestoredRef = useRef(false);

  // Initialize notes
  useEffect(() => {
    if (isOpen) {
      hasRestoredRef.current = false; // Reset on open
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
  }, [isOpen, initialize]);

  // Restore last selected note after notes are loaded and search results are ready
  useEffect(() => {
    if (!isOpen || !lastSelectedNoteId || isLoading || isSearching || hasRestoredRef.current) return;

    // Find the note in search results (not just notes list) for correct index
    const noteToRestore = searchResults.find((n) => n.id === lastSelectedNoteId);
    if (noteToRestore) {
      // Check if it's an auto-deleteable empty note (shouldn't restore these)
      if (isDefaultTitle(noteToRestore.title) && !noteToRestore.preview) {
        // Clear the lastSelectedNoteId since this note would be auto-deleted anyway
        setLastSelectedNoteId(null);
        hasRestoredRef.current = true;
      } else {
        const index = searchResults.indexOf(noteToRestore);
        setSelectedNote(noteToRestore);
        setSelectedIndex(index >= 0 ? index : 0);
        hasRestoredRef.current = true;
      }
    } else if (searchResults.length > 0) {
      // Note not found in search results - clear the stale ID
      setLastSelectedNoteId(null);
      hasRestoredRef.current = true;
    }
    // Don't mark as restored if search results are empty - wait for them to load
  }, [isOpen, lastSelectedNoteId, searchResults, isLoading, isSearching, setLastSelectedNoteId]);

  // Listen for note updates from other components (e.g., NotesPane)
  useEffect(() => {
    if (!isOpen) return;

    const unsubscribe = notesClient.onUpdated((payload) => {
      // Refresh the notes list when any note is updated
      refresh();

      // If the updated note is the currently selected note, reload its content
      if (selectedNote && payload.notePath === selectedNote.path && payload.action === "updated") {
        // The search results will be updated via the refresh, and the useEffect
        // that watches selectedNote will reload the content if needed
      }
    });

    return unsubscribe;
  }, [isOpen, refresh, selectedNote]);

  // Update search results when notes change or query changes
  useEffect(() => {
    if (!isOpen) return;

    // Clear any pending search
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Debounce search
    searchTimeoutRef.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const result = await notesClient.search(query);
        setSearchResults(result.notes);
      } catch (e) {
        console.error("Search failed:", e);
        // Fallback to local filtering
        setSearchResults(notes);
      } finally {
        setIsSearching(false);
      }
    }, 150);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [isOpen, query, notes]);

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

  useEffect(() => {
    if (selectedIndex >= searchResults.length) {
      setSelectedIndex(Math.max(0, searchResults.length - 1));
    }
  }, [searchResults.length, selectedIndex]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && searchResults.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, searchResults.length]);

  // Load note content when selected
  useEffect(() => {
    if (!selectedNote) {
      setNoteContent("");
      setNoteMetadata(null);
      setNoteLastModified(null);
      setHasConflict(false);
      return;
    }

    let cancelled = false;
    setIsLoadingContent(true);
    setHasConflict(false);

    notesClient
      .read(selectedNote.path)
      .then((content) => {
        if (cancelled) return;
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
        setNoteLastModified(content.lastModified);
        setIsLoadingContent(false);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load note:", e);
        setIsLoadingContent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNote]);

  // Check if note should be auto-deleted (empty content AND default title)
  const shouldAutoDelete = useCallback((note: NoteListItem | null, content: string): boolean => {
    if (!note) return false;
    // Only auto-delete if content is empty AND title is still the default
    return !content.trim() && isDefaultTitle(note.title);
  }, []);

  // Delete note if it should be auto-deleted
  const deleteIfAutoDeleteable = useCallback(
    async (note: NoteListItem | null, content: string) => {
      if (!shouldAutoDelete(note, content)) return;
      try {
        await deleteNote(note!.path);
        // Clear lastSelectedNoteId if the auto-deleted note was the last selected
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
      // If switching from another note, check if it should be auto-deleted
      if (selectedNote && selectedNote.id !== note.id) {
        await deleteIfAutoDeleteable(selectedNote, noteContent);
      }
      setSelectedNote(note);
      setSelectedIndex(index);
      // Persist last selected note (only if it's not an auto-deleteable empty note)
      // We check if the note has content by looking at the preview - empty notes won't be persisted
      if (!isDefaultTitle(note.title) || note.preview) {
        setLastSelectedNoteId(note.id);
      }
    },
    [selectedNote, noteContent, deleteIfAutoDeleteable, setLastSelectedNoteId]
  );

  const handleReloadNote = useCallback(async () => {
    if (!selectedNote) return;
    setHasConflict(false);
    setIsLoadingContent(true);
    try {
      const content = await notesClient.read(selectedNote.path);
      setNoteContent(content.content);
      setNoteMetadata(content.metadata);
      setNoteLastModified(content.lastModified);
    } catch (e) {
      console.error("Failed to reload note:", e);
    } finally {
      setIsLoadingContent(false);
    }
  }, [selectedNote]);

  const handleContentChange = useCallback(
    (value: string) => {
      setNoteContent(value);

      if (!selectedNote || !noteMetadata || hasConflict) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(async () => {
        try {
          const result = await notesClient.write(
            selectedNote.path,
            value,
            noteMetadata,
            noteLastModified ?? undefined
          );

          if (result.error === "conflict") {
            setHasConflict(true);
          } else if (result.lastModified) {
            setNoteLastModified(result.lastModified);
            // Once the note has content, persist it as last selected (even if it has a default title)
            // This allows newly created notes to be restored after the user starts writing
            if (value.trim()) {
              setLastSelectedNoteId(selectedNote.id);
            }
          }
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      }, 500);
    },
    [selectedNote, noteMetadata, noteLastModified, hasConflict, setLastSelectedNoteId]
  );

  // Handle renaming a note in the list
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
        // Read the current content
        const content = await notesClient.read(note.path);
        // Update with new title
        const updatedMetadata = { ...content.metadata, title: trimmedTitle };
        await notesClient.write(note.path, content.content, updatedMetadata);
        await refresh();

        // Update selected note if this is the one being renamed
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
    [refresh, selectedNote]
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

  // Handle renaming in the header
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
  }, [selectedNote, noteMetadata, noteContent, headerTitleEdit, refresh]);

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

  const handleCreateNote = useCallback(
    async (customTitle?: string) => {
      try {
        let noteTitle: string;

        if (customTitle) {
          // Use the custom title (from search query)
          noteTitle = customTitle.trim();
        } else {
          // Generate a unique title by checking existing notes
          const baseTitle = `Note ${new Date().toLocaleDateString()}`;
          noteTitle = baseTitle;
          let suffix = 1;

          // Check if title already exists and add suffix if needed
          const existingTitles = new Set(notes.map((n) => n.title));
          while (existingTitles.has(noteTitle)) {
            suffix++;
            noteTitle = `${baseTitle} (${suffix})`;
          }
        }

        const content = await createNote(noteTitle, "project");
        // Clear search so the new note is visible
        setQuery("");
        await refresh();
        // Select the new note
        const newNote = {
          id: content.metadata.id,
          title: content.metadata.title,
          path: content.path,
          scope: content.metadata.scope,
          worktreeId: content.metadata.worktreeId,
          createdAt: content.metadata.createdAt,
          modifiedAt: Date.now(),
          preview: "",
        };
        setSelectedNote(newNote);
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
        setNoteLastModified(content.lastModified);
        // Don't persist newly created notes as "last selected" until they have content or a custom title
        // This prevents auto-created default-titled notes from being restored
        if (customTitle) {
          setLastSelectedNoteId(newNote.id);
        }
        // Auto-start editing the title so user can immediately rename
        setIsEditingHeaderTitle(true);
        setHeaderTitleEdit(content.metadata.title);
        requestAnimationFrame(() => {
          headerTitleInputRef.current?.select();
        });
      } catch (error) {
        console.error("Failed to create note:", error);
      }
    },
    [notes, createNote, refresh, setLastSelectedNoteId]
  );

  const handleOpenAsPanel = useCallback(async () => {
    if (!selectedNote) return;

    try {
      await addTerminal({
        kind: "notes",
        title: selectedNote.title,
        cwd: "",
        worktreeId: activeWorktreeId ?? undefined,
        notePath: selectedNote.path,
        noteId: selectedNote.id,
        scope: selectedNote.scope,
        createdAt: selectedNote.createdAt,
      });
      onClose();
    } catch (error) {
      console.error("Failed to open note as panel:", error);
    }
  }, [selectedNote, addTerminal, activeWorktreeId, onClose]);

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
      // Clear lastSelectedNoteId if the deleted note was the last selected
      if (lastSelectedNoteId === deleteConfirmNote.id) {
        setLastSelectedNoteId(null);
      }
    } catch (error) {
      console.error("Failed to delete note:", error);
    } finally {
      setDeleteConfirmNote(null);
    }
  }, [deleteNote, selectedNote, deleteConfirmNote, lastSelectedNoteId, setLastSelectedNoteId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't handle navigation keys when editing
      if (editingNoteId || isEditingHeaderTitle) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          if (searchResults.length > 0) {
            const newIndex = Math.max(0, selectedIndex - 1);
            setSelectedNote(searchResults[newIndex]);
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(searchResults.length - 1, prev + 1));
          if (searchResults.length > 0) {
            const newIndex = Math.min(searchResults.length - 1, selectedIndex + 1);
            setSelectedNote(searchResults[newIndex]);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) {
            handleCreateNote();
          } else if (e.shiftKey && selectedNote) {
            handleOpenAsPanel();
          } else if (searchResults.length > 0 && !selectedNote) {
            setSelectedNote(searchResults[selectedIndex]);
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
            // Check for auto-delete before deselecting
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
      searchResults,
      selectedIndex,
      selectedNote,
      noteContent,
      handleCreateNote,
      handleOpenAsPanel,
      deleteIfAutoDeleteable,
    ]
  );

  // Escape key to close (when no note is selected)
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

  const handleClose = useCallback(async () => {
    // Check for auto-delete before closing
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

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping],
    []
  );

  if (!isOpen) return null;

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[10vh] bg-black/40 backdrop-blur-sm backdrop-saturate-[1.25]"
          onClick={handleBackdropClick}
          role="dialog"
          aria-modal="true"
          aria-label="Notes"
        >
          <div
            ref={dialogRef}
            className={cn(
              "w-full max-w-3xl mx-4 bg-canopy-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden",
              "animate-in fade-in slide-in-from-top-4 duration-150",
              "flex flex-col"
            )}
            style={{ height: "min(70vh, 600px)" }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-3 py-2 border-b border-canopy-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-xs text-canopy-text/50">Notes</span>
                <span className="text-[10px] text-canopy-text/30 font-mono">⌘⇧O</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleCreateNote()}
                  className="px-2.5 py-1 rounded-[var(--radius-md)] bg-canopy-accent hover:bg-canopy-accent/90 text-canopy-bg font-medium text-xs transition-colors flex items-center gap-1"
                  title="Create new note (Cmd+N)"
                >
                  <Plus size={14} />
                  New
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="p-1 rounded-[var(--radius-sm)] text-canopy-text/50 hover:text-canopy-text hover:bg-white/5 transition-colors"
                  title="Close (Esc)"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Split pane content */}
            <div className="flex flex-1 min-h-0">
              {/* Notes list */}
              <div className="w-64 border-r border-canopy-border flex flex-col shrink-0">
                {/* Search */}
                <div className="p-2 border-b border-canopy-border">
                  <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Search notes..."
                    className="w-full px-2.5 py-1.5 text-sm bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent"
                  />
                </div>

                {/* List */}
                <div
                  ref={listRef}
                  className="flex-1 overflow-y-auto p-1.5 divide-y divide-canopy-border/50"
                >
                  {isLoading || isSearching ? (
                    <div className="px-2 py-6 text-center text-canopy-text/50 text-xs">
                      Loading...
                    </div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-2 py-6 text-center text-canopy-text/50 text-xs">
                      {query.trim() ? (
                        <div className="flex flex-col items-center gap-2">
                          <span>No notes match "{query}"</span>
                          <button
                            type="button"
                            onClick={() => handleCreateNote(query.trim())}
                            className="px-2 py-1 rounded-[var(--radius-md)] bg-canopy-accent/20 hover:bg-canopy-accent/30 text-canopy-accent text-xs transition-colors"
                          >
                            Create "{query.trim().slice(0, 30)}
                            {query.trim().length > 30 ? "..." : ""}"
                          </button>
                        </div>
                      ) : (
                        "No notes yet"
                      )}
                    </div>
                  ) : (
                    searchResults.map((note, index) => {
                      const isEditing = editingNoteId === note.id;

                      return (
                        <div
                          key={note.id}
                          className={cn(
                            "relative flex items-start px-2 py-2 cursor-pointer transition-colors group",
                            selectedNote?.id === note.id
                              ? "bg-canopy-accent/15 text-canopy-text"
                              : index === selectedIndex
                                ? "bg-white/[0.03] text-canopy-text"
                                : "text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
                          )}
                          onClick={() => handleSelectNote(note, index)}
                          onDoubleClick={(e) => handleStartRename(note, e)}
                        >
                          <div className="flex-1 min-w-0">
                            <input
                              ref={isEditing ? titleInputRef : null}
                              type="text"
                              value={isEditing ? editingTitle : note.title}
                              readOnly={!isEditing}
                              onChange={(e) => {
                                if (!isEditing) return;
                                setEditingTitle(e.target.value);
                              }}
                              onKeyDown={(e) => {
                                if (!isEditing) return;
                                handleTitleKeyDown(note, e);
                              }}
                              onBlur={() => {
                                if (!isEditing) return;
                                handleTitleBlur(note);
                              }}
                              onClick={(e) => {
                                if (isEditing) e.stopPropagation();
                              }}
                              className={cn(
                                noteTitleBaseClass,
                                "appearance-none focus:outline-none",
                                isEditing
                                  ? "bg-canopy-sidebar border-canopy-accent text-canopy-text cursor-text"
                                  : "bg-transparent border-transparent text-inherit truncate cursor-default pointer-events-none"
                              )}
                            />
                            <div className="text-[10px] text-canopy-text/40 truncate mt-0.5 px-1">
                              {note.preview || "Empty note"}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteNote(note, e)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded-[var(--radius-sm)] hover:bg-[var(--color-status-error)]/10 text-canopy-text/40 hover:text-[var(--color-status-error)] transition-all"
                            title="Delete note"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Content area */}
              <div className="flex-1 flex flex-col min-w-0">
                {selectedNote ? (
                  <>
                    {/* Note header */}
                    <div className="px-3 py-2 border-b border-canopy-border flex items-center justify-between shrink-0">
                      <input
                        ref={isEditingHeaderTitle ? headerTitleInputRef : null}
                        type="text"
                        value={isEditingHeaderTitle ? headerTitleEdit : selectedNote.title}
                        readOnly={!isEditingHeaderTitle}
                        onChange={(e) => {
                          if (isEditingHeaderTitle) setHeaderTitleEdit(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (isEditingHeaderTitle) handleHeaderTitleKeyDown(e);
                        }}
                        onBlur={() => {
                          if (isEditingHeaderTitle) handleHeaderRename();
                        }}
                        onDoubleClick={() => {
                          if (!isEditingHeaderTitle) handleStartHeaderRename();
                        }}
                        title={isEditingHeaderTitle ? undefined : "Double-click to rename"}
                        className={cn(
                          "flex-1 mr-2 text-sm font-medium px-2 py-1 border rounded appearance-none focus:outline-none box-border",
                          isEditingHeaderTitle
                            ? "bg-canopy-sidebar border-canopy-accent text-canopy-text cursor-text"
                            : "bg-transparent border-transparent text-canopy-text truncate cursor-text"
                        )}
                      />
                      <button
                        type="button"
                        onClick={handleOpenAsPanel}
                        className="px-2 py-1 rounded-[var(--radius-sm)] text-xs text-canopy-text/60 hover:text-canopy-text hover:bg-white/5 transition-colors flex items-center gap-1 shrink-0"
                        title="Open as panel (Shift+Enter)"
                      >
                        <ExternalLink size={12} />
                        Open Panel
                      </button>
                    </div>

                    {/* Conflict warning */}
                    {hasConflict && (
                      <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-amber-500 text-xs">
                          <AlertTriangle size={14} />
                          <span>Note modified externally</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleReloadNote}
                          className="px-2 py-1 rounded text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-500 transition-colors"
                        >
                          Reload
                        </button>
                      </div>
                    )}

                    {/* Editor */}
                    <div className="flex-1 overflow-hidden">
                      {isLoadingContent ? (
                        <div className="flex items-center justify-center h-full text-canopy-text/50 text-sm">
                          Loading...
                        </div>
                      ) : (
                        <div className="h-full bg-canopy-bg text-[13px] font-mono [&_.cm-editor]:h-full [&_.cm-scroller]:p-2 [&_.cm-placeholder]:text-zinc-600 [&_.cm-placeholder]:italic">
                          <CodeMirror
                            value={noteContent}
                            height="100%"
                            theme={canopyTheme}
                            extensions={extensions}
                            onChange={handleContentChange}
                            readOnly={hasConflict}
                            basicSetup={{
                              lineNumbers: false,
                              foldGutter: false,
                              highlightActiveLine: false,
                              highlightActiveLineGutter: false,
                            }}
                            className="h-full"
                            placeholder="Start writing..."
                          />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-canopy-text/40 text-sm">
                    <StickyNote size={32} className="mb-2 opacity-50" />
                    <p>Select a note to view</p>
                    <p className="text-xs mt-1 text-canopy-text/30">
                      or press{" "}
                      <kbd className="px-1 py-0.5 rounded bg-canopy-border text-[10px]">⌘N</kbd> to
                      create one
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-3 py-1.5 border-t border-canopy-border bg-canopy-sidebar/50 text-[10px] text-canopy-text/40 flex items-center gap-4 shrink-0">
              <span>
                <kbd className="px-1 py-0.5 rounded bg-canopy-border">↑↓</kbd> navigate
              </span>
              <span>
                <kbd className="px-1 py-0.5 rounded bg-canopy-border">Enter</kbd> select
              </span>
              <span>
                <kbd className="px-1 py-0.5 rounded bg-canopy-border">⇧Enter</kbd> open panel
              </span>
              <span>
                <kbd className="px-1 py-0.5 rounded bg-canopy-border">⌘N</kbd> new
              </span>
              <span>
                <kbd className="px-1 py-0.5 rounded bg-canopy-border">Esc</kbd>{" "}
                {selectedNote ? "deselect" : "close"}
              </span>
            </div>
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        isOpen={!!deleteConfirmNote}
        title="Delete Note"
        description={`Are you sure you want to delete "${deleteConfirmNote?.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteConfirmNote(null)}
      />
    </>
  );
}
