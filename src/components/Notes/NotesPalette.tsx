import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { useNotesStore } from "@/store/notesStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import type { NoteListItem } from "@/clients/notesClient";
import { FileText, Plus, Trash2 } from "lucide-react";

interface NotesPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotesPalette({ isOpen, onClose }: NotesPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { notes, isLoading, initialize, createNote, deleteNote } = useNotesStore();
  const { addTerminal } = useTerminalStore();
  const { getWorktree } = useWorktreeDataStore();
  const { activeWorktreeId } = useWorktreeSelectionStore();

  useEffect(() => {
    if (isOpen) {
      initialize();
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen, initialize]);

  const filteredNotes = useMemo(() => {
    const sorted = [...notes].sort((a, b) => b.modifiedAt - a.modifiedAt);
    if (!query.trim()) {
      return sorted;
    }
    const lowerQuery = query.toLowerCase();
    return sorted.filter((note) => note.title.toLowerCase().includes(lowerQuery));
  }, [notes, query]);

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

  const handleSelectPrevious = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleSelectNext = useCallback(() => {
    setSelectedIndex((prev) => Math.min(filteredNotes.length - 1, prev + 1));
  }, [filteredNotes.length]);

  const handleCreateNote = useCallback(async () => {
    try {
      const noteTitle = `Note ${new Date().toLocaleDateString()}`;
      const noteContent = await createNote(noteTitle, "project");

      await addTerminal({
        kind: "notes",
        title: noteContent.metadata.title,
        cwd: "",
        worktreeId: activeWorktreeId ?? undefined,
        notePath: noteContent.path,
        noteId: noteContent.metadata.id,
        scope: noteContent.metadata.scope,
        createdAt: noteContent.metadata.createdAt,
      });

      onClose();
    } catch (error) {
      console.error("Failed to create note:", error);
    }
  }, [createNote, addTerminal, activeWorktreeId, onClose]);

  const handleOpenNote = useCallback(
    async (note: NoteListItem) => {
      try {
        await addTerminal({
          kind: "notes",
          title: note.title,
          cwd: "",
          worktreeId: note.worktreeId,
          notePath: note.path,
          noteId: note.id,
          scope: note.scope,
          createdAt: note.createdAt,
        });

        onClose();
      } catch (error) {
        console.error("Failed to open note:", error);
      }
    },
    [addTerminal, onClose]
  );

  const handleDeleteNote = useCallback(
    async (note: NoteListItem, e: React.MouseEvent) => {
      e.stopPropagation();

      if (!window.confirm(`Delete "${note.title}"?`)) {
        return;
      }

      try {
        await deleteNote(note.path);
      } catch (error) {
        console.error("Failed to delete note:", error);
      }
    },
    [deleteNote]
  );

  const handleConfirm = useCallback(() => {
    if (filteredNotes.length > 0 && selectedIndex >= 0) {
      handleOpenNote(filteredNotes[selectedIndex]);
    }
  }, [filteredNotes, selectedIndex, handleOpenNote]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          handleSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          handleSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) {
            handleCreateNote();
          } else {
            handleConfirm();
          }
          break;
        case "Delete":
        case "Backspace":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            if (filteredNotes.length > 0 && selectedIndex >= 0) {
              handleDeleteNote(filteredNotes[selectedIndex], e as unknown as React.MouseEvent);
            }
          }
          break;
        case "n":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            handleCreateNote();
          }
          break;
      }
    },
    [
      handleSelectPrevious,
      handleSelectNext,
      handleConfirm,
      handleCreateNote,
      handleDeleteNote,
      filteredNotes,
      selectedIndex,
    ]
  );

  const getWorktreeName = useCallback(
    (worktreeId?: string) => {
      if (!worktreeId) return null;
      const worktree = getWorktree(worktreeId);
      return worktree?.name || worktreeId;
    },
    [getWorktree]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Notes palette">
      <AppPaletteDialog.Header label="Notes" keyHint="⌘⇧O">
        <div className="flex items-center gap-2 mb-2">
          <div
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-controls="notes-list"
            className="flex-1"
          >
            <AppPaletteDialog.Input
              inputRef={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search notes..."
              aria-label="Search notes"
              aria-activedescendant={
                filteredNotes.length > 0 &&
                selectedIndex >= 0 &&
                selectedIndex < filteredNotes.length
                  ? `note-option-${filteredNotes[selectedIndex].id}`
                  : undefined
              }
            />
          </div>
          <button
            type="button"
            onClick={handleCreateNote}
            className="shrink-0 px-3 py-2 rounded-[var(--radius-md)] bg-canopy-accent hover:bg-canopy-accent/90 text-canopy-bg font-medium text-sm transition-colors flex items-center gap-1.5"
            title="Create new note (Cmd+N)"
          >
            <Plus size={16} />
            New
          </button>
        </div>
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        {isLoading ? (
          <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">Loading notes...</div>
        ) : filteredNotes.length === 0 ? (
          <AppPaletteDialog.Empty
            query={query}
            emptyMessage="No notes yet. Create one to get started!"
            noMatchMessage={`No notes match "${query}"`}
          />
        ) : (
          <div ref={listRef} id="notes-list" role="listbox" aria-label="Notes">
            {filteredNotes.map((note, index) => (
              <div
                key={note.id}
                id={`note-option-${note.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                className={cn(
                  "relative w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--radius-md)] cursor-pointer transition-colors border group",
                  index === selectedIndex
                    ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                    : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text"
                )}
                onClick={() => handleOpenNote(note)}
              >
                <div className="shrink-0 text-canopy-text/50">
                  <FileText size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <div className="text-sm font-medium text-canopy-text truncate">
                      {note.title}
                    </div>
                    {note.scope === "worktree" && note.worktreeId && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border/50 text-canopy-text/60 text-[10px] font-medium">
                        {getWorktreeName(note.worktreeId)}
                      </span>
                    )}
                    {note.scope === "project" && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-accent/15 text-canopy-accent text-[10px] font-medium">
                        Project
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-canopy-text/40 flex items-center gap-1">
                    Modified <LiveTimeAgo timestamp={note.modifiedAt} />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleDeleteNote(note, e)}
                  className="shrink-0 opacity-0 group-hover:opacity-100 p-1.5 rounded-[var(--radius-sm)] hover:bg-[var(--color-status-error)]/10 text-canopy-text/50 hover:text-[var(--color-status-error)] transition-all"
                  title="Delete note"
                  aria-label={`Delete ${note.title}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
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
          <span className="ml-1.5">to open</span>
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
          <span className="ml-1.5">to close</span>
        </span>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
  );
}
