import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Copy, Check, AlertCircle, Pencil, Eye, AlertTriangle, RefreshCw } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { notesClient, type NoteMetadata } from "@/clients/notesClient";
import { canopyTheme } from "./editorTheme";
import { cn } from "@/lib/utils";

export interface NotesPaneProps extends BasePanelProps {
  notePath: string;
  noteId: string;
  scope: "worktree" | "project";
  createdAt: number;
}

export function NotesPane({
  id,
  title,
  notePath,
  noteId: _noteId,
  scope: _scope,
  createdAt: _createdAt,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  isTrashing = false,
  gridPanelCount,
}: NotesPaneProps) {
  const [content, setContent] = useState<string>("");
  const [metadata, setMetadata] = useState<NoteMetadata | null>(null);
  const [lastModified, setLastModified] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>("");
  const isMountedRef = useRef(true);
  const saveVersionRef = useRef(0);
  const contentRef = useRef<string>("");

  useEffect(() => {
    let cancelled = false;

    async function loadNote() {
      if (!notePath) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);
        setHasConflict(false);
        const noteContent = await notesClient.read(notePath);
        if (cancelled) return;

        setContent(noteContent.content);
        setMetadata(noteContent.metadata);
        setLastModified(noteContent.lastModified);
        lastSavedContentRef.current = noteContent.content;
        contentRef.current = noteContent.content;
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load note");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadNote();

    return () => {
      cancelled = true;
    };
  }, [notePath]);

  const handleReload = useCallback(async () => {
    if (!notePath) return;
    setIsLoading(true);
    setHasConflict(false);
    try {
      const noteContent = await notesClient.read(notePath);
      setContent(noteContent.content);
      setMetadata(noteContent.metadata);
      setLastModified(noteContent.lastModified);
      lastSavedContentRef.current = noteContent.content;
      contentRef.current = noteContent.content;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to reload note");
    } finally {
      setIsLoading(false);
    }
  }, [notePath]);

  const saveNote = useCallback(
    async (newContent: string, version: number) => {
      if (!notePath || !metadata || hasConflict) return;

      try {
        const result = await notesClient.write(
          notePath,
          newContent,
          metadata,
          lastModified ?? undefined
        );
        if (!isMountedRef.current) return;

        if (result.error === "conflict") {
          setHasConflict(true);
        } else if (result.lastModified) {
          setLastModified(result.lastModified);
          if (version === saveVersionRef.current) {
            lastSavedContentRef.current = newContent;
          }
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      }
    },
    [notePath, metadata, lastModified, hasConflict]
  );

  const handleContentChange = useCallback(
    (value: string) => {
      setContent(value);
      contentRef.current = value;

      if (hasConflict) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveVersionRef.current += 1;
      const version = saveVersionRef.current;

      saveTimeoutRef.current = setTimeout(() => {
        saveNote(value, version);
      }, 1000);
    },
    [saveNote, hasConflict]
  );

  // Handle title changes - update both the panel title and the note's front matter
  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      const trimmedTitle = newTitle.trim();
      if (!trimmedTitle || !metadata || !notePath) return;

      // Update the panel title
      onTitleChange?.(trimmedTitle);

      // Update the front matter
      try {
        const updatedMetadata = { ...metadata, title: trimmedTitle };
        const result = await notesClient.write(notePath, contentRef.current, updatedMetadata);
        setMetadata(updatedMetadata);
        if (result.lastModified) {
          setLastModified(result.lastModified);
        }
      } catch (e) {
        console.error("Failed to update note title:", e);
      }
    },
    [metadata, notePath, onTitleChange]
  );

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const handleCopyPath = useCallback(async () => {
    const addressablePath = `@.canopy/notes/${notePath}`;
    try {
      await navigator.clipboard.writeText(addressablePath);
      setCopied(true);
      setTimeout(() => {
        if (isMountedRef.current) setCopied(false);
      }, 2000);
    } catch (e) {
      console.error("Failed to copy path:", e);
    }
  }, [notePath]);

  const toggleEditMode = useCallback(() => {
    setIsEditing((prev) => !prev);
  }, []);

  const headerActions = useMemo(
    () => (
      <div className="flex items-center">
        <button
          onClick={toggleEditMode}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-xs transition-colors",
            isEditing
              ? "text-canopy-accent"
              : "text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-text/10"
          )}
          title={isEditing ? "Switch to view mode" : "Switch to edit mode"}
        >
          {isEditing ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          <span>{isEditing ? "Editing" : "Viewing"}</span>
        </button>
        <button
          onClick={handleCopyPath}
          className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-canopy-text/10 text-canopy-text/60 hover:text-canopy-text transition-colors"
          title="Copy addressable path"
        >
          {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
          <span>Copy @path</span>
        </button>
      </div>
    ),
    [handleCopyPath, copied, isEditing, toggleEditMode]
  );

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage, codeLanguages: languages }), EditorView.lineWrapping],
    []
  );

  return (
    <ContentPanel
      id={id}
      title={title}
      kind="notes"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isTrashing={isTrashing}
      gridPanelCount={gridPanelCount}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={handleTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      headerActions={headerActions}
    >
      {isLoading ? (
        <div className="flex items-center justify-center h-full text-muted-foreground">
          Loading note...
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-destructive">
          <AlertCircle className="w-8 h-8" />
          <span>{error}</span>
        </div>
      ) : (
        <div className="h-full flex flex-col">
          {/* Conflict warning */}
          {hasConflict && (
            <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-amber-500 text-xs">
                <AlertTriangle size={14} />
                <span>Note modified externally</span>
              </div>
              <button
                type="button"
                onClick={handleReload}
                className="px-2 py-1 rounded text-xs bg-amber-500/20 hover:bg-amber-500/30 text-amber-500 transition-colors flex items-center gap-1"
              >
                <RefreshCw size={12} />
                Reload
              </button>
            </div>
          )}

          <div className="flex-1 overflow-hidden bg-canopy-bg text-[13px] font-mono [&_.cm-editor]:h-full [&_.cm-scroller]:p-2 [&_.cm-placeholder]:text-zinc-600 [&_.cm-placeholder]:italic">
            <CodeMirror
              value={content}
              height="100%"
              theme={canopyTheme}
              extensions={extensions}
              onChange={handleContentChange}
              readOnly={!isEditing || hasConflict}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: isEditing,
                highlightActiveLineGutter: false,
              }}
              className={cn("h-full", !isEditing && "[&_.cm-cursor]:hidden")}
              placeholder="Start writing your notes..."
            />
          </div>
        </div>
      )}
    </ContentPanel>
  );
}
