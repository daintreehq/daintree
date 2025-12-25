import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { FileText, Copy, Check, AlertCircle } from "lucide-react";
import MDEditor from "@uiw/react-md-editor";
import rehypeSanitize from "rehype-sanitize";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { notesClient, type NoteMetadata } from "@/clients/notesClient";

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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>("");
  const isMountedRef = useRef(true);
  const saveVersionRef = useRef(0);

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
        const noteContent = await notesClient.read(notePath);
        if (cancelled) return;

        setContent(noteContent.content);
        setMetadata(noteContent.metadata);
        lastSavedContentRef.current = noteContent.content;
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

  const saveNote = useCallback(
    async (newContent: string, version: number) => {
      if (!notePath || !metadata) return;

      try {
        if (isMountedRef.current) setIsSaving(true);
        await notesClient.write(notePath, newContent, metadata);
        if (!isMountedRef.current) return;
        if (version === saveVersionRef.current) {
          lastSavedContentRef.current = newContent;
          setHasUnsavedChanges(false);
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      } finally {
        if (isMountedRef.current) setIsSaving(false);
      }
    },
    [notePath, metadata]
  );

  const handleContentChange = useCallback(
    (newContent: string | undefined) => {
      const value = newContent ?? "";
      setContent(value);
      setHasUnsavedChanges(value !== lastSavedContentRef.current);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveVersionRef.current += 1;
      const version = saveVersionRef.current;

      saveTimeoutRef.current = setTimeout(() => {
        saveNote(value, version);
      }, 1000);
    },
    [saveNote]
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

  const headerContent = useMemo(
    () => (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <FileText className="w-3.5 h-3.5" />
        <span className="truncate max-w-[200px]">{notePath}</span>
        {hasUnsavedChanges && <span className="text-amber-500">Unsaved</span>}
        {isSaving && <span className="text-blue-500">Saving...</span>}
      </div>
    ),
    [notePath, hasUnsavedChanges, isSaving]
  );

  const toolbar = useMemo(
    () => (
      <div className="flex items-center gap-1 px-2 py-1 border-b border-overlay bg-[var(--color-surface-alt)]">
        <button
          onClick={handleCopyPath}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded hover:bg-white/5 text-muted-foreground hover:text-foreground transition-colors"
          title="Copy addressable path"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-green-500" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
          <span>Copy @path</span>
        </button>
      </div>
    ),
    [handleCopyPath, copied]
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
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      headerContent={headerContent}
      toolbar={toolbar}
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
        <div className="h-full overflow-hidden" data-color-mode="dark">
          <MDEditor
            value={content}
            onChange={handleContentChange}
            height="100%"
            preview="live"
            previewOptions={{
              rehypePlugins: [[rehypeSanitize]],
            }}
            textareaProps={{
              placeholder: "Start writing your notes...",
            }}
          />
        </div>
      )}
    </ContentPanel>
  );
}
