import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Copy, Check, AlertCircle } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { notesClient, type NoteMetadata } from "@/clients/notesClient";
import { canopyTheme } from "./editorTheme";

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
  const [copied, setCopied] = useState(false);

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
        await notesClient.write(notePath, newContent, metadata);
        if (!isMountedRef.current) return;
        if (version === saveVersionRef.current) {
          lastSavedContentRef.current = newContent;
        }
      } catch (e) {
        console.error("Failed to save note:", e);
      }
    },
    [notePath, metadata]
  );

  const handleContentChange = useCallback(
    (value: string) => {
      setContent(value);

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

  const headerActions = useMemo(
    () => (
      <button
        onClick={handleCopyPath}
        className="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-canopy-text/10 text-canopy-text/60 hover:text-canopy-text transition-colors"
        title="Copy addressable path"
      >
        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3" />}
        <span>Copy @path</span>
      </button>
    ),
    [handleCopyPath, copied]
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
      onTitleChange={onTitleChange}
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
        <div className="h-full overflow-hidden bg-canopy-bg text-[13px] font-mono [&_.cm-editor]:h-full [&_.cm-scroller]:p-2 [&_.cm-placeholder]:text-zinc-600 [&_.cm-placeholder]:italic">
          <CodeMirror
            value={content}
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
            placeholder="Start writing your notes..."
          />
        </div>
      )}
    </ContentPanel>
  );
}
