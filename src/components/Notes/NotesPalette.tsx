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
import { FileText, Plus, Trash2, ExternalLink, X } from "lucide-react";

interface NotesPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotesPalette({ isOpen, onClose }: NotesPaletteProps) {
  useOverlayState(isOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedNote, setSelectedNote] = useState<NoteListItem | null>(null);
  const [noteContent, setNoteContent] = useState<string>("");
  const [noteMetadata, setNoteMetadata] = useState<NoteMetadata | null>(null);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [contentPreviews, setContentPreviews] = useState<Map<string, string>>(new Map());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const { notes, isLoading, initialize, createNote, deleteNote, refresh } = useNotesStore();
  const { addTerminal } = useTerminalStore();
  const { activeWorktreeId } = useWorktreeSelectionStore();

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

  // Initialize notes and fetch content previews
  useEffect(() => {
    if (isOpen) {
      initialize();
      setQuery("");
      setSelectedIndex(0);
      setSelectedNote(null);
      setNoteContent("");
      setNoteMetadata(null);
    }
  }, [isOpen, initialize]);

  // Fetch content previews for all notes
  useEffect(() => {
    if (!isOpen || notes.length === 0) return;

    const fetchPreviews = async () => {
      const previews = new Map<string, string>();
      await Promise.all(
        notes.map(async (note) => {
          try {
            const content = await notesClient.read(note.path);
            const firstLine = content.content.split("\n").find((line) => line.trim()) || "";
            previews.set(note.id, firstLine.slice(0, 100));
          } catch {
            previews.set(note.id, "");
          }
        })
      );
      setContentPreviews(previews);
    };

    fetchPreviews();
  }, [isOpen, notes]);

  const filteredNotes = useMemo(() => {
    const sorted = [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt);
    if (!query.trim()) {
      return sorted;
    }
    const lowerQuery = query.toLowerCase();
    return sorted.filter(
      (note) =>
        note.title.toLowerCase().includes(lowerQuery) ||
        (contentPreviews.get(note.id) || "").toLowerCase().includes(lowerQuery)
    );
  }, [notes, query, contentPreviews]);

  useEffect(() => {
    if (selectedIndex >= filteredNotes.length) {
      setSelectedIndex(Math.max(0, filteredNotes.length - 1));
    }
  }, [filteredNotes.length, selectedIndex]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && filteredNotes.length > 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, filteredNotes.length]);

  // Load note content when selected
  useEffect(() => {
    if (!selectedNote) {
      setNoteContent("");
      setNoteMetadata(null);
      return;
    }

    let cancelled = false;
    setIsLoadingContent(true);

    notesClient
      .read(selectedNote.path)
      .then((content) => {
        if (cancelled) return;
        setNoteContent(content.content);
        setNoteMetadata(content.metadata);
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

  const handleSelectNote = useCallback((note: NoteListItem, index: number) => {
    setSelectedNote(note);
    setSelectedIndex(index);
  }, []);

  const handleContentChange = useCallback(
    (value: string) => {
      setNoteContent(value);

      if (!selectedNote || !noteMetadata) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(async () => {
        try {
          await notesClient.write(selectedNote.path, value, noteMetadata);
          // Update preview
          const firstLine = value.split("\n").find((line) => line.trim()) || "";
          setContentPreviews((prev) => {
            const next = new Map(prev);
            next.set(selectedNote.id, firstLine.slice(0, 100));
            return next;
          });
        } catch (e) {
          console.error("Failed to save note:", e);
        }
      }, 500);
    },
    [selectedNote, noteMetadata]
  );

  const handleCreateNote = useCallback(async () => {
    try {
      const noteTitle = `Note ${new Date().toLocaleDateString()}`;
      const content = await createNote(noteTitle, "project");
      await refresh();
      // Select the new note
      setSelectedNote({
        id: content.metadata.id,
        title: content.metadata.title,
        path: content.path,
        scope: content.metadata.scope,
        worktreeId: content.metadata.worktreeId,
        createdAt: content.metadata.createdAt,
        modifiedAt: Date.now(),
      });
      setNoteContent(content.content);
      setNoteMetadata(content.metadata);
    } catch (error) {
      console.error("Failed to create note:", error);
    }
  }, [createNote, refresh]);

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

  const handleDeleteNote = useCallback(
    async (note: NoteListItem, e: React.MouseEvent) => {
      e.stopPropagation();

      if (!window.confirm(`Delete "${note.title}"?`)) {
        return;
      }

      try {
        await deleteNote(note.path);
        if (selectedNote?.id === note.id) {
          setSelectedNote(null);
        }
      } catch (error) {
        console.error("Failed to delete note:", error);
      }
    },
    [deleteNote, selectedNote]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          if (filteredNotes.length > 0) {
            const newIndex = Math.max(0, selectedIndex - 1);
            setSelectedNote(filteredNotes[newIndex]);
          }
          break;
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(filteredNotes.length - 1, prev + 1));
          if (filteredNotes.length > 0) {
            const newIndex = Math.min(filteredNotes.length - 1, selectedIndex + 1);
            setSelectedNote(filteredNotes[newIndex]);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) {
            handleCreateNote();
          } else if (e.shiftKey && selectedNote) {
            handleOpenAsPanel();
          } else if (filteredNotes.length > 0 && !selectedNote) {
            setSelectedNote(filteredNotes[selectedIndex]);
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
            setSelectedNote(null);
          }
          break;
      }
    },
    [filteredNotes, selectedIndex, selectedNote, handleCreateNote, handleOpenAsPanel]
  );

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !selectedNote) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose, selectedNote]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping],
    []
  );

  if (!isOpen) return null;

  return createPortal(
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
              onClick={handleCreateNote}
              className="px-2.5 py-1 rounded-[var(--radius-md)] bg-canopy-accent hover:bg-canopy-accent/90 text-canopy-bg font-medium text-xs transition-colors flex items-center gap-1"
              title="Create new note (Cmd+N)"
            >
              <Plus size={14} />
              New
            </button>
            <button
              type="button"
              onClick={onClose}
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
            <div ref={listRef} className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {isLoading ? (
                <div className="px-2 py-6 text-center text-canopy-text/50 text-xs">Loading...</div>
              ) : filteredNotes.length === 0 ? (
                <div className="px-2 py-6 text-center text-canopy-text/50 text-xs">
                  {query.trim() ? `No notes match "${query}"` : "No notes yet"}
                </div>
              ) : (
                filteredNotes.map((note, index) => (
                  <div
                    key={note.id}
                    className={cn(
                      "relative flex items-start gap-2 px-2 py-1.5 rounded-[var(--radius-md)] cursor-pointer transition-colors group",
                      selectedNote?.id === note.id
                        ? "bg-canopy-accent/15 text-canopy-text"
                        : index === selectedIndex
                          ? "bg-white/[0.03] text-canopy-text"
                          : "text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
                    )}
                    onClick={() => handleSelectNote(note, index)}
                  >
                    <FileText size={14} className="shrink-0 mt-0.5 text-canopy-text/40" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{note.title}</div>
                      <div className="text-[10px] text-canopy-text/40 truncate mt-0.5">
                        {contentPreviews.get(note.id) || "Empty note"}
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
                ))
              )}
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedNote ? (
              <>
                {/* Note header */}
                <div className="px-3 py-2 border-b border-canopy-border flex items-center justify-between shrink-0">
                  <span className="text-sm font-medium text-canopy-text truncate">
                    {selectedNote.title}
                  </span>
                  <button
                    type="button"
                    onClick={handleOpenAsPanel}
                    className="px-2 py-1 rounded-[var(--radius-sm)] text-xs text-canopy-text/60 hover:text-canopy-text hover:bg-white/5 transition-colors flex items-center gap-1"
                    title="Open as panel (Shift+Enter)"
                  >
                    <ExternalLink size={12} />
                    Open Panel
                  </button>
                </div>

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
                <FileText size={32} className="mb-2 opacity-50" />
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
  );
}
