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
import type { NoteListItem } from "@/clients/notesClient";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { canopyTheme } from "./editorTheme";
import { notesTypographyExtension } from "./codeBlockExtension";
import { MarkdownToolbar } from "./MarkdownToolbar";
import {
  Plus,
  ExternalLink,
  X,
  AlertTriangle,
  Leaf,
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
import { useNoteSearch, SORT_LABELS, type SortOrder } from "@/hooks/useNoteSearch";
import { useNoteEditor } from "@/hooks/useNoteEditor";
import { useNoteTitleEdit } from "@/hooks/useNoteTitleEdit";
import { useNoteActions } from "@/hooks/useNoteActions";
import { NoteListItemRow } from "./NoteListItem";
import { NotesPaletteFooter } from "./NotesPaletteFooter";

interface NotesPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NotesPalette({ isOpen, onClose }: NotesPaletteProps) {
  useOverlayState(isOpen);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteListItem | null>(null);
  const [isOpeningPanel, setIsOpeningPanel] = useState(false);
  const [paletteViewMode, setPaletteViewMode] = useState<"edit" | "preview">("edit");

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

  const search = useNoteSearch({ isOpen, notes, refresh });

  const editor = useNoteEditor({
    selectedNote,
    refresh,
    setLastSelectedNoteId,
  });

  const titleEdit = useNoteTitleEdit({
    selectedNote,
    noteMetadata: editor.noteMetadata,
    noteContent: editor.noteContent,
    refresh,
    setSelectedNote,
    setNoteMetadata: editor.setNoteMetadata,
    setNoteLastModified: editor.setNoteLastModified,
  });

  const trimmedQuery = search.query.trim();
  const showCreateItem =
    search.visibleNotes.length === 0 &&
    trimmedQuery.length > 0 &&
    !isLoading &&
    !search.isSearching;
  const createDisplayTitle =
    trimmedQuery.length > 40 ? `${trimmedQuery.slice(0, 40)}…` : trimmedQuery;

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

  const actions = useNoteActions({
    isOpen,
    notes,
    visibleNotes: search.visibleNotes,
    isLoading,
    isSearching: search.isSearching,
    lastSelectedNoteId,
    setLastSelectedNoteId,
    initialize,
    createNote,
    deleteNote,
    refresh,
    setQuery: search.setQuery,
    setNoteContent: editor.setNoteContent,
    setNoteMetadata: editor.setNoteMetadata,
    setNoteLastModified: editor.setNoteLastModified,
    setHasConflict: editor.setHasConflict,
    setEditingNoteId: titleEdit.setEditingNoteId,
    setIsEditingHeaderTitle: titleEdit.setIsEditingHeaderTitle,
    setHeaderTitleEdit: titleEdit.setHeaderTitleEdit,
    headerTitleInputRef: titleEdit.headerTitleInputRef,
    flushSave: editor.flushSave,
    getLatestContent: editor.getLatestContent,
    editingNoteId: titleEdit.editingNoteId,
    isEditingHeaderTitle: titleEdit.isEditingHeaderTitle,
    showCreateItem,
    trimmedQuery,
    onClose,
    handleOpenAsPanel,
    selectedNote,
    setSelectedNote,
  });

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

  // Reset view mode on selection change
  useEffect(() => {
    setPaletteViewMode("edit");
  }, [selectedNote]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && actions.selectedIndex >= 0 && search.visibleNotes.length > 0) {
      const selectedItem = listRef.current.children[actions.selectedIndex] as HTMLElement;
      selectedItem?.scrollIntoView({ block: "nearest" });
    }
  }, [actions.selectedIndex, search.visibleNotes.length]);

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      notesTypographyExtension(),
    ],
    []
  );

  if (!isOpen) return null;

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-scrim-medium backdrop-blur-xs backdrop-saturate-[1.25] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
          onClick={actions.handleBackdropClick}
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
                        onClick={() => actions.handleCreateNote()}
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Create new note"
                      >
                        <Plus />
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
                        onClick={actions.handleClose}
                        className="p-1 rounded-[var(--radius-sm)] text-canopy-text/50 hover:text-canopy-text hover:bg-tint/5 transition-colors"
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
                <div className="p-2 border-b border-canopy-border space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={inputRef}
                      type="text"
                      value={search.query}
                      onChange={(e) => search.setQuery(e.target.value)}
                      onKeyDown={actions.handleKeyDown}
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
                          value={search.sortOrder}
                          onValueChange={(v) => search.setSortOrder(v as SortOrder)}
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
                  {search.availableTags.length > 0 && (
                    <div className="flex items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                      <button
                        type="button"
                        onClick={() => search.setSelectedTag(null)}
                        className={cn(
                          "shrink-0 px-2 py-0.5 rounded-full text-[11px] transition-colors",
                          search.selectedTag === null
                            ? "bg-canopy-accent/20 text-canopy-accent"
                            : "bg-canopy-border/50 text-canopy-text/50 hover:text-canopy-text hover:bg-canopy-border"
                        )}
                      >
                        All
                      </button>
                      {search.availableTags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() =>
                            search.setSelectedTag(search.selectedTag === tag ? null : tag)
                          }
                          className={cn(
                            "shrink-0 px-2 py-0.5 rounded-full text-[11px] transition-colors",
                            search.selectedTag === tag
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

                <div ref={listRef} role="listbox" className="flex-1 overflow-y-auto">
                  {isLoading || search.isSearching ? (
                    <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
                      Loading...
                    </div>
                  ) : showCreateItem ? (
                    <div
                      role="option"
                      aria-selected={actions.selectedIndex === 0}
                      className={cn(
                        "relative flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors",
                        "bg-overlay-soft text-canopy-text before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                      )}
                      onClick={() => actions.handleCreateNote(trimmedQuery)}
                    >
                      <Plus className="shrink-0 w-3.5 h-3.5 text-canopy-accent" />
                      <span className="text-sm font-medium truncate">
                        Create &ldquo;{createDisplayTitle}&rdquo;
                      </span>
                    </div>
                  ) : search.visibleNotes.length === 0 ? (
                    <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
                      {search.selectedTag ? "No notes with this tag" : "No notes yet"}
                    </div>
                  ) : (
                    search.visibleNotes.map((note, index) => (
                      <NoteListItemRow
                        key={note.id}
                        note={note}
                        index={index}
                        isSelected={selectedNote?.id === note.id}
                        isHighlighted={index === actions.selectedIndex}
                        titleEdit={titleEdit}
                        onSelect={actions.handleSelectNote}
                        onDelete={actions.handleDeleteNote}
                      />
                    ))
                  )}
                </div>
              </div>

              {/* Content area */}
              <div className="flex-1 flex flex-col min-w-0">
                {selectedNote ? (
                  <>
                    <div className="px-3 h-9 border-b border-canopy-border flex items-center justify-between shrink-0 bg-overlay-subtle">
                      <TooltipProvider>
                        <Tooltip open={titleEdit.isEditingHeaderTitle ? false : undefined}>
                          <TooltipTrigger asChild>
                            <input
                              ref={
                                titleEdit.isEditingHeaderTitle
                                  ? titleEdit.headerTitleInputRef
                                  : null
                              }
                              type="text"
                              value={
                                titleEdit.isEditingHeaderTitle
                                  ? titleEdit.headerTitleEdit
                                  : selectedNote.title
                              }
                              readOnly={!titleEdit.isEditingHeaderTitle}
                              onChange={(e) => {
                                if (titleEdit.isEditingHeaderTitle)
                                  titleEdit.setHeaderTitleEdit(e.target.value);
                              }}
                              onKeyDown={(e) => {
                                if (titleEdit.isEditingHeaderTitle)
                                  titleEdit.handleHeaderTitleKeyDown(e);
                              }}
                              onBlur={() => {
                                if (titleEdit.isEditingHeaderTitle) titleEdit.handleHeaderRename();
                              }}
                              onDoubleClick={() => {
                                if (!titleEdit.isEditingHeaderTitle)
                                  titleEdit.handleStartHeaderRename();
                              }}
                              className={cn(
                                "flex-1 mr-3 text-sm font-medium px-1.5 py-1 border rounded appearance-none focus:outline-none box-border",
                                titleEdit.isEditingHeaderTitle
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
                            className={`px-1.5 py-1 text-xs transition-colors ${paletteViewMode === mode ? "bg-canopy-text/10 text-canopy-text" : "text-canopy-text/40 hover:text-canopy-text/70 hover:bg-canopy-text/5"}`}
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

                    {editor.noteMetadata && (
                      <div className="px-3 py-1.5 border-b border-canopy-border flex items-center gap-1.5 flex-wrap bg-overlay-subtle/50">
                        <Tag size={12} className="text-canopy-text/40 shrink-0" />
                        {(editor.noteMetadata.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-canopy-accent/10 text-canopy-accent text-[11px]"
                          >
                            {tag}
                            <button
                              type="button"
                              onClick={() => editor.handleRemoveTag(tag)}
                              className="hover:text-canopy-text transition-colors"
                              aria-label={`Remove tag ${tag}`}
                            >
                              <X size={10} />
                            </button>
                          </span>
                        ))}
                        <input
                          type="text"
                          value={editor.tagInput}
                          onChange={(e) => editor.setTagInput(e.target.value)}
                          onKeyDown={editor.handleTagInputKeyDown}
                          onBlur={() => {
                            if (editor.tagInput.trim()) {
                              editor.handleAddTag(editor.tagInput);
                              editor.setTagInput("");
                            }
                          }}
                          placeholder={editor.noteMetadata.tags?.length ? "" : "Add tags..."}
                          className="flex-1 min-w-[60px] bg-transparent text-[11px] text-canopy-text placeholder:text-canopy-text/30 focus:outline-none py-0.5"
                        />
                      </div>
                    )}

                    {editor.hasConflict && (
                      <div className="px-4 py-2 bg-status-warning/[0.03] border-l-2 border-status-warning flex items-center justify-between shrink-0">
                        <div className="flex items-center gap-2 text-status-warning text-xs">
                          <AlertTriangle size={14} />
                          <span>Note modified externally</span>
                        </div>
                        <Button
                          onClick={editor.handleReloadNote}
                          variant="ghost"
                          size="xs"
                          className="bg-status-warning/20 hover:bg-status-warning/30 text-status-warning"
                        >
                          Reload
                        </Button>
                      </div>
                    )}

                    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                      {editor.isLoadingContent ? (
                        <div className="flex items-center justify-center h-full text-canopy-text/50 text-sm">
                          Loading...
                        </div>
                      ) : paletteViewMode === "preview" ? (
                        <MarkdownPreview content={editor.noteContent} />
                      ) : (
                        <>
                          {!editor.hasConflict && <MarkdownToolbar editorViewRef={editorViewRef} />}
                          <div className="flex-1 overflow-hidden text-[13px] [&_.cm-editor]:h-full [&_.cm-scroller]:p-4 [&_.cm-placeholder]:text-canopy-text/30 [&_.cm-placeholder]:italic">
                            <CodeMirror
                              value={editor.noteContent}
                              height="100%"
                              theme={canopyTheme}
                              extensions={extensions}
                              onChange={editor.handleContentChange}
                              onCreateEditor={(view) => {
                                editorViewRef.current = view;
                              }}
                              readOnly={editor.hasConflict}
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
                    <Leaf size={32} className="mb-3" />
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
            <NotesPaletteFooter hasSelection={!!selectedNote} />
          </div>
        </div>,
        document.body
      )}

      <ConfirmDialog
        isOpen={!!actions.deleteConfirmNote}
        title="Delete Note"
        description={`Are you sure you want to delete "${actions.deleteConfirmNote?.title}"? This action cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="destructive"
        onConfirm={actions.handleConfirmDelete}
        onClose={() => actions.setDeleteConfirmNote(null)}
      />
    </>
  );
}
