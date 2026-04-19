import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Copy,
  Check,
  AlertCircle,
  AlertTriangle,
  RefreshCw,
  PenLine,
  Columns2,
  Eye,
} from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { EditorView } from "@codemirror/view";
import { ContentPanel, type BasePanelProps } from "@/components/Panel";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { notesClient, type NoteMetadata } from "@/clients/notesClient";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { VoiceInputButton } from "@/components/Terminal/VoiceInputButton";
import { daintreeTheme } from "./editorTheme";
import { notesTypographyExtension } from "./codeBlockExtension";
import { MarkdownPreview } from "./MarkdownPreview";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { useNoteVoiceInput } from "./useNoteVoiceInput";
import {
  buildAttachmentExtension,
  buildMarkdownSnippet,
  NOTES_MAX_ATTACHMENT_BYTES,
  type AttachItem,
} from "./attachmentExtension";
import { useNotificationStore } from "@/store/notificationStore";

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
  worktreeId,
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
  const [hasConflict, setHasConflict] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "split" | "preview">("edit");
  const [editorMountKey, setEditorMountKey] = useState(0);

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>("");
  const isMountedRef = useRef(true);
  const saveVersionRef = useRef(0);
  const contentRef = useRef<string>("");
  const editorViewRef = useRef<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const attachHandlerRef = useRef<(items: AttachItem[]) => void>(() => {});
  const attachRejectedRef = useRef<(items: AttachItem[], reason: "oversize" | "empty") => void>(
    () => {}
  );
  const [notesDir, setNotesDir] = useState<string | null>(null);

  const currentProject = useProjectStore((s) => s.currentProject);
  const panelWorktree = useWorktreeStore((s) =>
    worktreeId ? s.worktrees.get(worktreeId) : undefined
  );

  useNoteVoiceInput(id, editorViewRef);

  useEffect(() => {
    if (viewMode === "preview") {
      editorViewRef.current = null;
    }
  }, [viewMode]);

  useEffect(() => {
    let cancelled = false;
    notesClient
      .getDir()
      .then((dir) => {
        if (!cancelled) setNotesDir(dir);
      })
      .catch((e) => {
        console.error("Failed to resolve notes directory:", e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAttach = useCallback(async (items: AttachItem[]) => {
    const view = editorViewRef.current;
    if (!view || items.length === 0) return;

    // Capture the insertion point synchronously, before any async work — the
    // cursor may move during upload and we want the snippet where the paste
    // happened.
    const { from, to } = view.state.selection.main;

    const notify = useNotificationStore.getState().addNotification;

    const snippets = await Promise.all(
      items.map(async (item) => {
        try {
          const buffer = await item.file.arrayBuffer();
          const data = new Uint8Array(buffer);
          const { relativePath } = await notesClient.saveAttachment(
            data,
            item.mimeType,
            item.originalName
          );
          return buildMarkdownSnippet(item, relativePath);
        } catch (err) {
          console.error("Failed to save attachment:", err);
          notify({
            type: "error",
            priority: "high",
            message: `Failed to attach "${item.originalName}": ${err instanceof Error ? err.message : String(err)}`,
          });
          return null;
        }
      })
    );

    const text = snippets.filter((s): s is string => s !== null).join("\n\n");
    if (!text) return;

    const currentView = editorViewRef.current;
    if (!currentView) return;

    const docLen = currentView.state.doc.length;
    const safeFrom = Math.min(from, docLen);
    const safeTo = Math.min(to, docLen);
    currentView.dispatch({
      changes: { from: safeFrom, to: safeTo, insert: text },
      selection: { anchor: safeFrom + text.length },
      scrollIntoView: true,
    });
    currentView.focus();
  }, []);

  const handleAttachRejected = useCallback((items: AttachItem[], reason: "oversize" | "empty") => {
    const notify = useNotificationStore.getState().addNotification;
    const names = items.map((i) => i.originalName || "file").join(", ");
    if (reason === "empty") {
      notify({
        type: "warning",
        priority: "high",
        message: `Skipped empty file${items.length === 1 ? "" : "s"}: ${names}`,
      });
    } else {
      const limitMb = Math.round(NOTES_MAX_ATTACHMENT_BYTES / (1024 * 1024));
      notify({
        type: "error",
        priority: "high",
        message: `Attachment${items.length === 1 ? "" : "s"} exceed ${limitMb} MB limit: ${names}`,
      });
    }
  }, []);

  useEffect(() => {
    attachHandlerRef.current = handleAttach;
  }, [handleAttach]);

  useEffect(() => {
    attachRejectedRef.current = handleAttachRejected;
  }, [handleAttachRejected]);

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

  useEffect(() => {
    if (viewMode !== "split") return;
    const scrollDOM = editorViewRef.current?.scrollDOM;
    const previewEl = previewRef.current;
    if (!scrollDOM || !previewEl) return;

    const onEditorScroll = () => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      const max = scrollDOM.scrollHeight - scrollDOM.clientHeight;
      const ratio = max > 0 ? scrollDOM.scrollTop / max : 0;
      previewEl.scrollTop = ratio * (previewEl.scrollHeight - previewEl.clientHeight);
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    const onPreviewScroll = () => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      const max = previewEl.scrollHeight - previewEl.clientHeight;
      const ratio = max > 0 ? previewEl.scrollTop / max : 0;
      scrollDOM.scrollTop = ratio * (scrollDOM.scrollHeight - scrollDOM.clientHeight);
      requestAnimationFrame(() => {
        isSyncingRef.current = false;
      });
    };

    scrollDOM.addEventListener("scroll", onEditorScroll);
    previewEl.addEventListener("scroll", onPreviewScroll);
    return () => {
      scrollDOM.removeEventListener("scroll", onEditorScroll);
      previewEl.removeEventListener("scroll", onPreviewScroll);
    };
  }, [viewMode, editorMountKey]);

  const handleCopyPath = useCallback(async () => {
    const addressablePath = `@.daintree/notes/${notePath}`;
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
      <div className="flex items-center gap-1">
        <div className="flex items-center rounded-[var(--radius-sm)] border border-daintree-border/50 overflow-hidden mr-1">
          {(
            [
              { mode: "edit" as const, icon: PenLine, label: "Edit" },
              { mode: "split" as const, icon: Columns2, label: "Split" },
              { mode: "preview" as const, icon: Eye, label: "Preview" },
            ] as const
          ).map(({ mode, icon: Icon, label }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-1.5 py-1 text-xs transition-colors ${
                viewMode === mode
                  ? "bg-daintree-text/10 text-daintree-text"
                  : "text-daintree-text/40 hover:text-daintree-text/70 hover:bg-daintree-text/5"
              }`}
              aria-label={label}
              aria-pressed={viewMode === mode}
            >
              <Icon className="w-3 h-3" />
            </button>
          ))}
        </div>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCopyPath}
                className="flex items-center gap-1.5 px-2 py-1 text-xs rounded-[var(--radius-sm)] hover:bg-daintree-text/10 text-daintree-text/60 hover:text-daintree-text transition-colors"
                aria-label="Copy addressable path"
              >
                {copied ? (
                  <Check className="w-3 h-3 text-status-success" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>Copy @path</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Copy addressable path</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    ),
    [handleCopyPath, copied, viewMode]
  );

  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      EditorView.lineWrapping,
      notesTypographyExtension(),
      EditorView.theme({ ".cm-content": { paddingBottom: "52px" } }),
      buildAttachmentExtension({
        onAttach: (items) => attachHandlerRef.current(items),
        onRejected: (items, reason) => attachRejectedRef.current(items, reason),
      }),
    ],
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
            <div className="px-3 py-2 bg-status-warning/[0.03] border-l-2 border-status-warning flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 text-status-warning text-xs">
                <AlertTriangle size={14} />
                <span>Note modified externally</span>
              </div>
              <button
                type="button"
                onClick={handleReload}
                className="px-2 py-1 rounded-[var(--radius-sm)] text-xs bg-status-warning/20 hover:bg-status-warning/30 text-status-warning transition-colors flex items-center gap-1"
              >
                <RefreshCw size={12} />
                Reload
              </button>
            </div>
          )}

          {viewMode === "preview" ? (
            <MarkdownPreview content={content} notesDir={notesDir} className="flex-1" />
          ) : viewMode === "split" ? (
            <div className="flex flex-1 min-h-0 overflow-hidden">
              <div className="flex-1 flex flex-col min-h-0 border-r border-daintree-border">
                {!hasConflict && <MarkdownToolbar editorViewRef={editorViewRef} />}
                <div className="relative flex-1 overflow-hidden bg-daintree-bg text-[13px] [&_.cm-editor]:h-full [&_.cm-scroller]:p-2 [&_.cm-placeholder]:text-daintree-text/30 [&_.cm-placeholder]:italic">
                  <CodeMirror
                    value={content}
                    height="100%"
                    theme={daintreeTheme}
                    extensions={extensions}
                    onChange={handleContentChange}
                    onCreateEditor={(view) => {
                      editorViewRef.current = view;
                      setEditorMountKey((k) => k + 1);
                    }}
                    readOnly={hasConflict}
                    basicSetup={{
                      lineNumbers: false,
                      foldGutter: false,
                      highlightActiveLine: false,
                      highlightActiveLineGutter: false,
                    }}
                    className="h-full"
                    placeholder="Start writing your notes..."
                  />
                  {!hasConflict && (
                    <div className="absolute bottom-3 right-3 z-10">
                      <VoiceInputButton
                        panelId={id}
                        panelTitle={title}
                        projectId={currentProject?.id}
                        projectName={currentProject?.name}
                        worktreeId={worktreeId}
                        worktreeLabel={
                          panelWorktree?.isMainWorktree
                            ? panelWorktree?.name
                            : panelWorktree?.branch || panelWorktree?.name
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
              <MarkdownPreview
                ref={previewRef}
                content={content}
                notesDir={notesDir}
                className="flex-1"
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {!hasConflict && <MarkdownToolbar editorViewRef={editorViewRef} />}
              <div className="relative flex-1 overflow-hidden bg-daintree-bg text-[13px] [&_.cm-editor]:h-full [&_.cm-scroller]:p-2 [&_.cm-placeholder]:text-daintree-text/30 [&_.cm-placeholder]:italic">
                <CodeMirror
                  value={content}
                  height="100%"
                  theme={daintreeTheme}
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
                  placeholder="Start writing your notes..."
                />
                {!hasConflict && (
                  <div className="absolute bottom-3 right-3 z-10">
                    <VoiceInputButton
                      panelId={id}
                      panelTitle={title}
                      projectId={currentProject?.id}
                      projectName={currentProject?.name}
                      worktreeId={worktreeId}
                      worktreeLabel={
                        panelWorktree?.isMainWorktree
                          ? panelWorktree?.name
                          : panelWorktree?.branch || panelWorktree?.name
                      }
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </ContentPanel>
  );
}
