import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { createTooltipWithShortcut } from "@/lib/platform";
import { keybindingService } from "@/services/KeybindingService";
import { useOverlayState } from "@/hooks";
import { usePaletteStore } from "@/store/paletteStore";
import { useNotesStore } from "@/store/notesStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { notesClient, type NoteListItem, type NoteMetadata } from "@/clients/notesClient";
import { normalizeTag } from "../../../shared/utils/noteTags";
import { formatTimeAgo } from "@/utils/timeAgo";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { canopyTheme } from "./editorTheme";
import { MarkdownToolbar } from "./MarkdownToolbar";
import {
  Plus,
  Trash2,
  ExternalLink,
  X,
  AlertTriangle,
  StickyNote,
  ChevronDown,
  PenLine,
  Eye,
  ArrowUpDown,
  Tag,
} from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NotesPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

type SortOrder = "modified-desc" | "created-desc" | "created-asc" | "title-asc";

const SORT_LABELS: Record<SortOrder, string> = {
  "modified-desc": "Modified (newest)",
  "created-desc": "Created (newest)",
  "created-asc": "Created (oldest)",
  "title-asc": "Title (A–Z)",
};

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
  const [isOpeningPanel, setIsOpeningPanel] = useState(false);
  const [paletteViewMode, setPaletteViewMode] = useState<"edit" | "preview">("edit");

  // Sort and filter state
  const [sortOrder, setSortOrder] = useState<SortOrder>(
    () => (sessionStorage.getItem("notes-sort-order") as SortOrder) || "modified-desc"
  );
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const headerTitleInputRef = useRef<HTMLInputElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);

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

  const noteTitleBaseClass =
    "flex-1 min-w-0 m-0 px-1 py-0.5 text-sm font-medium leading-tight border rounded box-border";

  // Derived tag list and filtered/sorted notes
  const availableTags = useMemo(
    () => [...new Set(searchResults.flatMap((n) => n.tags ?? []))].sort(),
    [searchResults]
  );

  const visibleNotes = useMemo(() => {
    const list = selectedTag
      ? searchResults.filter((n) => n.tags?.includes(selectedTag))
      : searchResults;
    return [...list].sort((a, b) => {
      switch (sortOrder) {
        case "modified-desc":
          return b.modifiedAt - a.modifiedAt;
        case "created-desc":
          return b.createdAt - a.createdAt;
        case "created-asc":
          return a.createdAt - b.createdAt;
        case "title-asc":
          return a.title.localeCompare(b.title);
      }
    });
  }, [searchResults, selectedTag, sortOrder]);

  // Clear selected tag when it disappears from available tags
  useEffect(() => {
    if (selectedTag && !availableTags.includes(selectedTag)) {
      setSelectedTag(null);
    }
  }, [availableTags, selectedTag]);

  // Persist sort order to sessionStorage
  useEffect(() => {
    sessionStorage.setItem("notes-sort-order", sortOrder);
  }, [sortOrder]);

  // Focus management
  useLayoutEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (previousFocusRef.current) {
      if (!usePaletteStore.getState().activePaletteId) {
        previousFocusRef.current.focus();
      }
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
    if (!isOpen || isLoading || isSearching || hasRestoredRef.current) return;
    if (visibleNotes.length === 0) return;

    if (lastSelectedNoteId) {
      // Find the note in visible notes (not just notes list) for correct index
      const noteToRestore = visibleNotes.find((n) => n.id === lastSelectedNoteId);
      if (noteToRestore) {
        // Check if it's an auto-deleteable empty note (shouldn't restore these)
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
        // Note not found in visible notes - clear the stale ID
        setLastSelectedNoteId(null);
      }
    }

    // No prior selection or cleared stale/empty note — select the first non-empty visible note
    const fallback = visibleNotes.find((n) => !(isDefaultTitle(n.title) && !n.preview));
    if (fallback) {
      const idx = visibleNotes.indexOf(fallback);
      setSelectedNote(fallback);
      setSelectedIndex(idx >= 0 ? idx : 0);
    }
    hasRestoredRef.current = true;
  }, [isOpen, lastSelectedNoteId, visibleNotes, isLoading, isSearching, setLastSelectedNoteId]);

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
    if (selectedIndex >= visibleNotes.length) {
      setSelectedIndex(Math.max(0, visibleNotes.length - 1));
    }
  }, [visibleNotes.length, selectedIndex]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && visibleNotes.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, visibleNotes.length]);

  // Load note content when selected
  useEffect(() => {
    setPaletteViewMode("edit");
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

  // Handle tag operations
  const handleAddTag = useCallback(
    async (tag: string) => {
      if (!selectedNote || !noteMetadata) return;
      const normalized = normalizeTag(tag);
      if (!normalized) return;
      const currentTags = noteMetadata.tags ?? [];
      if (currentTags.includes(normalized)) return;

      // Cancel any pending content save to prevent race condition
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      const updatedTags = [...currentTags, normalized];
      const updatedMetadata = { ...noteMetadata, tags: updatedTags };
      setNoteMetadata(updatedMetadata);

      try {
        const result = await notesClient.write(
          selectedNote.path,
          noteContent,
          updatedMetadata,
          noteLastModified ?? undefined
        );
        if (result.error === "conflict") {
          setHasConflict(true);
        } else if (result.lastModified) {
          setNoteLastModified(result.lastModified);
        }
        await refresh();
      } catch (e) {
        console.error("Failed to save tags:", e);
      }
    },
    [selectedNote, noteMetadata, noteContent, noteLastModified, refresh]
  );

  const handleRemoveTag = useCallback(
    async (tag: string) => {
      if (!selectedNote || !noteMetadata) return;
      const currentTags = noteMetadata.tags ?? [];
      const updatedTags = currentTags.filter((t) => t !== tag);
      const updatedMetadata = {
        ...noteMetadata,
        tags: updatedTags.length > 0 ? updatedTags : undefined,
      };

      // Cancel any pending content save to prevent race condition
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      setNoteMetadata(updatedMetadata);

      try {
        const result = await notesClient.write(
          selectedNote.path,
          noteContent,
          updatedMetadata,
          noteLastModified ?? undefined
        );
        if (result.error === "conflict") {
          setHasConflict(true);
        } else if (result.lastModified) {
          setNoteLastModified(result.lastModified);
        }
        await refresh();
      } catch (e) {
        console.error("Failed to save tags:", e);
      }
    },
    [selectedNote, noteMetadata, noteContent, noteLastModified, refresh]
  );

  const handleTagInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        handleAddTag(tagInput);
        setTagInput("");
      } else if (e.key === "Backspace" && !tagInput && noteMetadata?.tags?.length) {
        handleRemoveTag(noteMetadata.tags[noteMetadata.tags.length - 1]);
      }
    },
    [tagInput, handleAddTag, handleRemoveTag, noteMetadata]
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
          tags: [] as string[],
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

  const handleOpenAsPanel = useCallback(
    async (location: "grid" | "dock" = "grid") => {
      if (!selectedNote || isOpeningPanel) return;

      setIsOpeningPanel(true);
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
          location,
        });
        onClose();
      } catch (error) {
        console.error("Failed to open note as panel:", error);
        setIsOpeningPanel(false);
      }
    },
    [selectedNote, isOpeningPanel, addTerminal, activeWorktreeId, onClose]
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
          if (visibleNotes.length > 0) {
            const newIndex = Math.max(0, selectedIndex - 1);
            setSelectedNote(visibleNotes[newIndex]);
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(visibleNotes.length - 1, prev + 1));
          if (visibleNotes.length > 0) {
            const newIndex = Math.min(visibleNotes.length - 1, selectedIndex + 1);
            setSelectedNote(visibleNotes[newIndex]);
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
      visibleNotes,
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
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 backdrop-blur-xs backdrop-saturate-[1.25] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
          onClick={handleBackdropClick}
          role="dialog"
          aria-modal="true"
          aria-label="Notes"
          data-testid="notes-palette"
        >
          <div
            ref={dialogRef}
            className={cn(
              "w-full max-w-2xl mx-4 bg-canopy-bg border border-[var(--border-overlay)] rounded-[var(--radius-xl)] shadow-modal overflow-hidden",
              "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200",
              "flex flex-col h-[80vh] max-h-[900px]"
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-3 py-1.5 border-b border-canopy-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-canopy-text/50">Notes</span>
                <span className="text-[11px] text-canopy-text/50 font-mono">
                  {keybindingService.getDisplayCombo("notes.openPalette") || "⌘⇧N"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        onClick={() => handleCreateNote()}
                        size="sm"
                        aria-label="Create new note"
                        className="h-7 px-2.5 text-xs"
                      >
                        <Plus size={14} className="mr-1" />
                        New
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {createTooltipWithShortcut("Create new note", "Cmd+N")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={handleClose}
                        className="p-1 rounded-[var(--radius-sm)] text-canopy-text/50 hover:text-canopy-text hover:bg-white/5 transition-colors"
                        aria-label="Close"
                      >
                        <X size={16} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Close (Esc)</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>

            {/* Split pane content */}
            <div className="flex flex-1 min-h-0">
              {/* Notes list sidebar */}
              <div className="w-64 border-r border-canopy-border flex flex-col shrink-0">
                {/* Search and sort */}
                <div className="p-2 border-b border-canopy-border space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={inputRef}
                      type="text"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Search notes..."
                      className="flex-1 min-w-0 px-3 py-2 text-sm bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)] text-canopy-text placeholder:text-canopy-text/40 focus:outline-none focus:border-canopy-accent/40 focus:ring-1 focus:ring-canopy-accent/20"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="shrink-0 p-2 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-sidebar text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-sidebar/80 transition-colors"
                          aria-label="Sort notes"
                        >
                          <ArrowUpDown size={14} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-[160px]">
                        <DropdownMenuRadioGroup
                          value={sortOrder}
                          onValueChange={(v) => setSortOrder(v as SortOrder)}
                        >
                          {(Object.entries(SORT_LABELS) as [SortOrder, string][]).map(
                            ([value, label]) => (
                              <DropdownMenuRadioItem key={value} value={value}>
                                {label}
                              </DropdownMenuRadioItem>
                            )
                          )}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Tag filter bar */}
                  {availableTags.length > 0 && (
                    <div className="flex items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                      <button
                        type="button"
                        onClick={() => setSelectedTag(null)}
                        className={cn(
                          "shrink-0 px-2 py-0.5 rounded-full text-[11px] transition-colors",
                          selectedTag === null
                            ? "bg-canopy-accent/20 text-canopy-accent"
                            : "bg-canopy-border/50 text-canopy-text/50 hover:text-canopy-text hover:bg-canopy-border"
                        )}
                      >
                        All
                      </button>
                      {availableTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSelectedTag(selectedTag === tag ? null : tag)}
                          className={cn(
                            "shrink-0 px-2 py-0.5 rounded-full text-[11px] transition-colors",
                            selectedTag === tag
                              ? "bg-canopy-accent/20 text-canopy-accent"
                              : "bg-canopy-border/50 text-canopy-text/50 hover:text-canopy-text hover:bg-canopy-border"
                          )}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* List */}
                <div ref={listRef} role="listbox" className="flex-1 overflow-y-auto">
                  {isLoading || isSearching ? (
                    <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
                      Loading...
                    </div>
                  ) : visibleNotes.length === 0 ? (
                    <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
                      {query.trim() ? (
                        <div className="flex flex-col items-center gap-3">
                          <span>No notes match "{query}"</span>
                          <Button
                            onClick={() => handleCreateNote(query.trim())}
                            variant="secondary"
                            size="sm"
                            className="bg-canopy-accent/10 hover:bg-canopy-accent/20 text-canopy-accent"
                          >
                            Create "{query.trim().slice(0, 30)}
                            {query.trim().length > 30 ? "..." : ""}"
                          </Button>
                        </div>
                      ) : selectedTag ? (
                        "No notes with this tag"
                      ) : (
                        "No notes yet"
                      )}
                    </div>
                  ) : (
                    visibleNotes.map((note, index) => {
                      const isEditing = editingNoteId === note.id;

                      return (
                        <div
                          key={note.id}
                          role="option"
                          aria-selected={selectedNote?.id === note.id}
                          className={cn(
                            "relative flex items-start px-3 py-1.5 cursor-pointer transition-colors group",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1",
                            selectedNote?.id === note.id
                              ? "bg-overlay-soft text-canopy-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                              : index === selectedIndex
                                ? "bg-overlay-soft text-canopy-text"
                                : "text-canopy-text/70 hover:bg-overlay-subtle hover:text-canopy-text"
                          )}
                          onClick={() => handleSelectNote(note, index)}
                          onDoubleClick={(e) => handleStartRename(note, e)}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline gap-1 min-w-0">
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
                                tabIndex={isEditing ? 0 : -1}
                                className={cn(
                                  noteTitleBaseClass,
                                  "appearance-none focus:outline-none",
                                  isEditing
                                    ? "bg-canopy-sidebar border-canopy-accent text-canopy-text cursor-text"
                                    : "bg-transparent border-transparent text-inherit truncate cursor-default pointer-events-none"
                                )}
                              />
                              {!isEditing && (
                                <span className="shrink-0 text-[11px] text-canopy-text/40 tabular-nums">
                                  {formatTimeAgo(note.modifiedAt)}
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-canopy-text/40 truncate mt-0.5 px-1">
                              {note.preview || "Empty note"}
                            </div>
                          </div>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={(e) => handleDeleteNote(note, e)}
                                  className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded-[var(--radius-sm)] hover:bg-status-error/10 text-canopy-text/40 hover:text-status-error transition-all"
                                  aria-label="Delete note"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">Delete note</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
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
                    <div className="px-3 h-9 border-b border-canopy-border flex items-center justify-between shrink-0 bg-overlay-subtle">
                      <TooltipProvider>
                        <Tooltip open={isEditingHeaderTitle ? false : undefined}>
                          <TooltipTrigger asChild>
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
                              className={cn(
                                "flex-1 mr-3 text-sm font-medium px-1.5 py-1 border rounded appearance-none focus:outline-none box-border",
                                isEditingHeaderTitle
                                  ? "bg-canopy-bg/60 border-canopy-accent/50 text-canopy-text cursor-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1"
                                  : "bg-transparent border-transparent text-canopy-text truncate cursor-text hover:text-canopy-text"
                              )}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="bottom">Double-click to rename</TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <div className="flex items-center rounded-[var(--radius-sm)] border border-canopy-border/50 overflow-hidden mr-1 shrink-0">
                        {(
                          [
                            { mode: "edit" as const, icon: PenLine, label: "Edit" },
                            { mode: "preview" as const, icon: Eye, label: "Preview" },
                          ] as const
                        ).map(({ mode, icon: Icon, label }) => (
                          <button
                            key={mode}
                            onClick={() => setPaletteViewMode(mode)}
                            className={`px-1.5 py-1 text-xs transition-colors ${
                              paletteViewMode === mode
                                ? "bg-canopy-text/10 text-canopy-text"
                                : "text-canopy-text/40 hover:text-canopy-text/70 hover:bg-canopy-text/5"
                            }`}
                            aria-label={label}
                            aria-pressed={paletteViewMode === mode}
                          >
                            <Icon className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                      <DropdownMenu>
                        <div className="flex items-center shrink-0">
                          <button
                            type="button"
                            onClick={() => handleOpenAsPanel("grid")}
                            disabled={isOpeningPanel}
                            className="p-1.5 rounded-l-[var(--radius-sm)] text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-text/10 transition-colors flex items-center gap-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
                            aria-label="Open in grid (Shift+Enter)"
                          >
                            <ExternalLink size={14} />
                          </button>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              disabled={isOpeningPanel}
                              className="p-1.5 pl-1 pr-1.5 rounded-r-[var(--radius-sm)] text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-text/10 transition-colors border-l border-canopy-border/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
                              aria-label="More options"
                            >
                              <ChevronDown size={12} />
                            </button>
                          </DropdownMenuTrigger>
                        </div>
                        <DropdownMenuContent align="end" className="min-w-[140px]">
                          <DropdownMenuItem onSelect={() => handleOpenAsPanel("grid")}>
                            Open in Grid
                            <span className="ml-auto text-[10px] font-mono text-canopy-text/40">
                              ⇧⏎
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => handleOpenAsPanel("dock")}>
                            Open in Dock
                            <span className="ml-auto text-[10px] font-mono text-canopy-text/40">
                              ⇧⌘⏎
                            </span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {/* Tag editor */}
                    {noteMetadata && (
                      <div className="px-3 py-1.5 border-b border-canopy-border flex items-center gap-1.5 flex-wrap bg-overlay-subtle/50">
                        <Tag size={12} className="text-canopy-text/40 shrink-0" />
                        {(noteMetadata.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-canopy-accent/10 text-canopy-accent text-[11px]"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => handleRemoveTag(tag)}
                              className="hover:text-canopy-text transition-colors"
                              aria-label={`Remove tag ${tag}`}
                            >
                              <X size={10} />
                            </button>
                          </span>
                        ))}
                        <input
                          type="text"
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={handleTagInputKeyDown}
                          onBlur={() => {
                            if (tagInput.trim()) {
                              handleAddTag(tagInput);
                              setTagInput("");
                            }
                          }}
                          placeholder={noteMetadata.tags?.length ? "" : "Add tags..."}
                          className="flex-1 min-w-[60px] bg-transparent text-[11px] text-canopy-text placeholder:text-canopy-text/30 focus:outline-none py-0.5"
                        />
                      </div>
                    )}

                    {/* Conflict warning */}
                    {hasConflict && (
                      <div className="px-4 py-2 bg-status-warning/[0.03] border-l-2 border-status-warning flex items-center justify-between shrink-0">
                        <div className="flex items-center gap-2 text-status-warning text-xs">
                          <AlertTriangle size={14} />
                          <span>Note modified externally</span>
                        </div>
                        <Button
                          onClick={handleReloadNote}
                          variant="ghost"
                          size="xs"
                          className="bg-status-warning/20 hover:bg-status-warning/30 text-status-warning"
                        >
                          Reload
                        </Button>
                      </div>
                    )}

                    {/* Editor / Preview */}
                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      {isLoadingContent ? (
                        <div className="flex items-center justify-center h-full text-canopy-text/50 text-sm">
                          Loading...
                        </div>
                      ) : paletteViewMode === "preview" ? (
                        <MarkdownPreview content={noteContent} />
                      ) : (
                        <>
                          {!hasConflict && <MarkdownToolbar editorViewRef={editorViewRef} />}
                          <div className="flex-1 overflow-hidden text-[13px] font-mono [&_.cm-editor]:h-full [&_.cm-scroller]:p-4 [&_.cm-placeholder]:text-canopy-text/30 [&_.cm-placeholder]:italic">
                            <CodeMirror
                              value={noteContent}
                              height="100%"
                              theme={canopyTheme}
                              extensions={extensions}
                              onChange={handleContentChange}
                              onCreateEditor={(view) => {
                                editorViewRef.current = view;
                              }}
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
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-canopy-text/30">
                    <StickyNote size={32} className="mb-3" />
                    <p className="text-sm">Select a note to view</p>
                    <p className="text-xs mt-2">
                      or press{" "}
                      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/40 text-[11px]">
                        ⌘N
                      </kbd>{" "}
                      to create one
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-3 py-2 border-t border-canopy-border bg-canopy-sidebar/50 text-xs text-canopy-text/50 flex items-center gap-4 shrink-0">
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  ↑
                </kbd>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60 ml-1">
                  ↓
                </kbd>
                <span className="ml-1.5">to navigate</span>
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  Enter
                </kbd>
                <span className="ml-1.5">to select</span>
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  ⇧Enter
                </kbd>
                <span className="ml-1.5">grid</span>
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  ⇧⌘Enter
                </kbd>
                <span className="ml-1.5">dock</span>
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  ⌘N
                </kbd>
                <span className="ml-1.5">new</span>
              </span>
              <span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
                  Esc
                </kbd>
                <span className="ml-1.5">{selectedNote ? "deselect" : "close"}</span>
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
        variant="destructive"
        onConfirm={handleConfirmDelete}
        onClose={() => setDeleteConfirmNote(null)}
      />
    </>
  );
}
