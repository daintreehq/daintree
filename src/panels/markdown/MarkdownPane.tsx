import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, FileText, RefreshCw, Search } from "lucide-react";
import type { MarkdownViewMode } from "@shared/types/panel";
import { isMarkdownPanel } from "@shared/types/panel";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { MarkdownViewer } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton, SkeletonBone, SkeletonText } from "@/components/ui/Skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  FILE_READ_ERROR_MESSAGES,
  toFileReadErrorCode,
} from "@/components/FileViewer/fileReadErrors";
import { filesClient } from "@/clients/filesClient";
import { actionService } from "@/services/ActionService";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isClientAppError } from "@/utils/clientAppError";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";

export interface MarkdownPaneProps extends BasePanelProps {
  tabs?: TabInfo[];
  onTabClick?: (tabId: string) => void;
  onTabClose?: (tabId: string) => void;
  onTabRename?: (tabId: string, newTitle: string) => void;
  onAddTab?: () => void;
}

const toForwardSlashes = (p: string) => p.replace(/\\/g, "/");

function parentDirectory(filePath: string): string {
  const fwd = toForwardSlashes(filePath);
  const idx = fwd.lastIndexOf("/");
  return idx > 0 ? fwd.slice(0, idx) : "/";
}

function isUnderRoot(filePath: string, rootPath: string): boolean {
  if (!rootPath) return false;
  const root = toForwardSlashes(rootPath).replace(/\/$/, "") + "/";
  return toForwardSlashes(filePath).startsWith(root);
}

type LoadState = "idle" | "loading" | "loaded" | "error";

const SEARCH_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 2000;

interface PickerResult {
  relativePath: string;
  absolutePath: string;
}

/** Debounced .md file search over the panel's root — the empty-state picker. */
function useMarkdownFileSearch(rootPath: string, query: string): PickerResult[] {
  const [results, setResults] = useState<PickerResult[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      filesClient
        // The files:search IPC schema caps limit at 100.
        .search({ cwd: rootPath, query: query || ".md", limit: 100 })
        .then(({ files }) => {
          if (cancelled) return;
          const root = toForwardSlashes(rootPath).replace(/\/$/, "");
          setResults(
            files
              .filter((f) => !f.endsWith("/") && isMarkdownFilePath(f))
              .slice(0, 50)
              .map((relativePath) => ({ relativePath, absolutePath: `${root}/${relativePath}` }))
          );
        })
        .catch((err) => {
          if (!cancelled) setResults([]);
          logError("[MarkdownPane] file search failed", err);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rootPath, query]);

  return results;
}

function ToolbarIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="p-1 rounded transition-colors text-muted-foreground hover:text-daintree-text hover:bg-daintree-border"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function MarkdownPane({
  id,
  title,
  isFocused,
  isMaximized,
  location,
  isMultiPanelGrid,
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  onRestore,
  tabs,
  onTabClick,
  onTabClose,
  onTabRename,
  onAddTab,
}: MarkdownPaneProps) {
  const panel = usePanelStore(
    useCallback(
      (state) => {
        const candidate = state.panelsById[id];
        return candidate && isMarkdownPanel(candidate) ? candidate : undefined;
      },
      [id]
    )
  );
  const setMarkdownViewMode = usePanelStore((state) => state.setMarkdownViewMode);
  const setMarkdownFilePath = usePanelStore((state) => state.setMarkdownFilePath);

  const filePath = panel?.markdownFilePath;
  const viewMode: MarkdownViewMode = panel?.markdownViewMode ?? "rendered";

  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (panel?.worktreeId ? (state.worktrees.get(panel.worktreeId)?.path ?? "") : ""),
      [panel?.worktreeId]
    )
  );
  const projectPath = useProjectStore((state) => state.currentProject?.path ?? "");

  // Containment root for files.read / daintree-file://: the worktree or
  // project that contains the file, else its parent directory (same
  // outside-root fallback as FileViewerModal).
  const effectiveRootPath = useMemo(() => {
    if (!filePath) return worktreePath || projectPath;
    return (
      [worktreePath, projectPath].find((root) => isUnderRoot(filePath, root)) ??
      parentDirectory(filePath)
    );
  }, [filePath, worktreePath, projectPath]);

  const [content, setContent] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorCode, setErrorCode] = useState<FileReadErrorCode | null>(null);
  const [pathCopied, setPathCopied] = useState(false);
  const requestRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const loadFile = useCallback(
    (silent: boolean) => {
      if (!filePath) {
        requestRef.current++;
        setContent(null);
        setLoadState("idle");
        setErrorCode(null);
        return;
      }
      const requestId = ++requestRef.current;
      if (!silent) {
        setLoadState("loading");
        setErrorCode(null);
      }
      filesClient
        .read({ path: filePath, rootPath: effectiveRootPath })
        .then(({ content: fileContent }) => {
          if (requestRef.current !== requestId) return;
          setContent((previous) => (previous === fileContent ? previous : fileContent));
          setLoadState("loaded");
          setErrorCode(null);
        })
        .catch((error: unknown) => {
          if (requestRef.current !== requestId) return;
          const code = isClientAppError(error) ? toFileReadErrorCode(error.code) : "INVALID_PATH";
          // Silent background refreshes keep showing the last good content on
          // transient failures, but a permanently-gone file (deleted, perms
          // revoked) must surface rather than display stale text forever.
          const permanent =
            code === "NOT_FOUND" || code === "PERMISSION" || code === "OUTSIDE_ROOT";
          if (silent && !permanent) return;
          setErrorCode(code);
          setLoadState("error");
        });
    },
    [filePath, effectiveRootPath]
  );

  useEffect(() => {
    loadFile(false);
  }, [loadFile]);

  // Agents rewrite specs while the user reads them: silently re-read when the
  // pane regains focus or the app window returns to the foreground.
  const wasFocusedRef = useRef(isFocused);
  useEffect(() => {
    if (isFocused && !wasFocusedRef.current && loadState === "loaded") {
      loadFile(true);
    }
    wasFocusedRef.current = isFocused;
  }, [isFocused, loadState, loadFile]);

  useEffect(() => {
    if (loadState !== "loaded") return;
    const handleWindowFocus = () => loadFile(true);
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [loadState, loadFile]);

  const handleCopyPath = useCallback(() => {
    if (!filePath) return;
    navigator.clipboard
      .writeText(filePath)
      .then(() => {
        useAnnouncerStore.getState().announce("Path copied");
        setPathCopied(true);
        if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = setTimeout(() => setPathCopied(false), COPY_FEEDBACK_MS);
      })
      .catch((err) => logError("[MarkdownPane] copy path failed", err));
  }, [filePath]);

  const handleOpenInEditor = useCallback(() => {
    if (!filePath) return;
    actionService
      .dispatch("file.openInEditor", { path: filePath }, { source: "user" })
      .catch((err) => logError("[MarkdownPane] openInEditor failed", err));
  }, [filePath]);

  const [pickerQuery, setPickerQuery] = useState("");
  const pickerRoot = worktreePath || projectPath;
  const pickerResults = useMarkdownFileSearch(filePath ? "" : pickerRoot, pickerQuery);

  const fileName = filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : undefined;
  // A user-locked rename outranks the derived file name (title layering: the
  // user rung always wins); otherwise the file name is the live title.
  const displayTitle = panel?.titleMode === "user" ? title : (fileName ?? title);
  const displayPath =
    filePath && isUnderRoot(filePath, pickerRoot)
      ? toForwardSlashes(filePath).slice(toForwardSlashes(pickerRoot).replace(/\/$/, "").length + 1)
      : filePath;

  const toolbar = filePath ? (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-daintree-border bg-surface-panel">
      <SegmentedToggle<MarkdownViewMode>
        options={[
          { value: "rendered", label: "Rendered" },
          { value: "source", label: "Source" },
        ]}
        value={viewMode}
        onChange={(mode) => setMarkdownViewMode(id, mode)}
      />
      <span
        className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono"
        title={filePath}
      >
        {displayPath}
      </span>
      <div className="flex items-center gap-0.5 shrink-0">
        <ToolbarIconButton label="Refresh" onClick={() => loadFile(false)}>
          <RefreshCw className="w-3.5 h-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton
          label={pathCopied ? "Copied!" : "Copy file path"}
          onClick={handleCopyPath}
        >
          {pathCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </ToolbarIconButton>
        <ToolbarIconButton label="Open in editor" onClick={handleOpenInEditor}>
          <ExternalLink className="w-3.5 h-3.5" />
        </ToolbarIconButton>
      </div>
    </div>
  ) : undefined;

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="markdown"
      isFocused={isFocused}
      isMaximized={isMaximized}
      location={location}
      isMultiPanelGrid={isMultiPanelGrid}
      onFocus={onFocus}
      onClose={onClose}
      onToggleMaximize={onToggleMaximize}
      onTitleChange={onTitleChange}
      onMinimize={onMinimize}
      onRestore={onRestore}
      toolbar={toolbar}
      tabs={tabs}
      onTabClick={onTabClick}
      onTabClose={onTabClose}
      onTabRename={onTabRename}
      onAddTab={onAddTab}
    >
      <div className="flex-1 min-h-0 overflow-auto bg-daintree-bg" data-testid="markdown-pane-body">
        {!filePath && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<FileText className="h-6 w-6" />}
              title="Open a markdown file"
              description={
                pickerRoot
                  ? "Search the project's markdown files, or click a .md path in any terminal."
                  : "Open a project, then search its markdown files here."
              }
            />
            {pickerRoot && (
              <div className="w-full max-w-md flex flex-col gap-1 min-h-0">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-daintree-border bg-daintree-sidebar focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20">
                  <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <input
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    placeholder="Search markdown files"
                    aria-label="Search markdown files"
                    className="w-full bg-transparent text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden"
                    data-testid="markdown-file-search"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto flex flex-col" role="listbox">
                  {pickerResults.map((result) => (
                    <button
                      key={result.absolutePath}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setMarkdownFilePath(id, result.absolutePath)}
                      className="text-left px-2 py-1.5 rounded text-xs font-mono truncate text-muted-foreground transition-colors hover:text-daintree-text hover:bg-daintree-border"
                      data-testid="markdown-file-result"
                    >
                      {result.relativePath}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {filePath && loadState === "loading" && (
          <div className="p-4 space-y-3">
            <Skeleton label="Loading markdown file">
              <SkeletonBone className="h-5 w-1/3" />
              <SkeletonText lines={12} />
            </Skeleton>
          </div>
        )}

        {filePath && loadState === "error" && errorCode && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
            <p className="text-sm text-muted-foreground">{FILE_READ_ERROR_MESSAGES[errorCode]}</p>
            <button
              type="button"
              onClick={() => loadFile(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-daintree-text bg-daintree-border hover:bg-daintree-border/80 rounded transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
          </div>
        )}

        {filePath && loadState === "loaded" && content !== null && (
          <MarkdownViewer
            content={content}
            filePath={filePath}
            rootPath={effectiveRootPath}
            viewMode={viewMode}
            className={cn(viewMode === "source" && "min-h-full")}
          />
        )}
      </div>
    </ContentPanel>
  );
}
