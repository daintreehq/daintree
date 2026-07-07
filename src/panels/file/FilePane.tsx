import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, FileText, RefreshCw, Search, WrapText } from "lucide-react";
import type { FileViewMode } from "@shared/types/panel";
import { isFilePanel } from "@shared/types/panel";
import type { FileReadErrorCode } from "@shared/types/ipc/files";
import type { BasePanelProps } from "@/components/Panel/ContentPanel";
import { ContentPanel } from "@/components/Panel/ContentPanel";
import type { TabInfo } from "@/components/Panel/TabButton";
import { MarkdownViewer, type MarkdownViewerHandle } from "@/components/Markdown/MarkdownViewer";
import { isMarkdownFilePath } from "@/components/Markdown/isMarkdownFile";
import { CodeViewer, type CodeViewerHandle } from "@/components/FileViewer/CodeViewer";
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
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { isClientAppError } from "@/utils/clientAppError";
import { logError } from "@/utils/logger";
import { cn } from "@/lib/utils";

export interface FilePaneProps extends BasePanelProps {
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

let measureContext: CanvasRenderingContext2D | null = null;

function measureTextWidth(text: string, font: string): number {
  measureContext ??= document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 8;
  measureContext.font = font;
  return measureContext.measureText(text).width;
}

/**
 * Width-fitted middle truncation: keeps as many characters from the front and
 * the back as actually fit the element, collapsing the middle with a single
 * ellipsis. The basename is reserved first so the file name always survives.
 * Re-fits on resize; measurement uses canvas measureText with the element's
 * own computed font, so no layout thrash.
 */
function useFittedPath(fullText: string | undefined): {
  spanRef: React.RefObject<HTMLElement | null>;
  display: string | undefined;
} {
  const spanRef = useRef<HTMLElement | null>(null);
  const [display, setDisplay] = useState<string | undefined>(fullText);

  useLayoutEffect(() => {
    const el = spanRef.current;
    if (!el || fullText === undefined) {
      setDisplay(fullText);
      return;
    }

    const fit = () => {
      const style = getComputedStyle(el);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const available =
        el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      if (available <= 0) {
        // Not measurable (hidden/zero-width): show the new text rather than a
        // stale fit of the previous path; CSS truncate is the backstop.
        setDisplay(fullText);
        return;
      }
      if (measureTextWidth(fullText, font) <= available) {
        setDisplay(fullText);
        return;
      }
      const slashIdx = fullText.lastIndexOf("/");
      const basename = slashIdx >= 0 ? fullText.slice(slashIdx) : fullText;
      const head = fullText.slice(0, fullText.length - basename.length);
      const build = (kept: number) => {
        const front = Math.ceil(kept / 2);
        const back = kept - front;
        return `${head.slice(0, front)}…${back > 0 ? head.slice(head.length - back) : ""}${basename}`;
      };
      // Binary search the most head characters that still fit.
      let lo = 0;
      let hi = head.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (measureTextWidth(build(mid), font) <= available) lo = mid;
        else hi = mid - 1;
      }
      const candidate = build(lo);
      if (measureTextWidth(candidate, font) <= available) {
        setDisplay(candidate);
        return;
      }
      // Very narrow pane: prefer the bare file name over "…/file.md"; if even
      // that overflows, CSS truncate is the backstop.
      const bare = basename.startsWith("/") ? basename.slice(1) : basename;
      setDisplay(measureTextWidth(`…${basename}`, font) <= available ? `…${basename}` : bare);
    };

    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullText]);

  return { spanRef, display };
}

type LoadState = "idle" | "loading" | "loaded" | "error";

const SEARCH_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 2000;

interface PickerResult {
  relativePath: string;
  absolutePath: string;
}

/** Debounced file search over the panel's root — the empty-state picker. */
function useFileSearch(rootPath: string, query: string): PickerResult[] {
  const [results, setResults] = useState<PickerResult[]>([]);

  useEffect(() => {
    if (!rootPath) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      filesClient
        // The files:search IPC schema caps limit at 100; an empty query
        // lists the first files alphabetically.
        .search({ cwd: rootPath, query, limit: 100 })
        .then(({ files }) => {
          if (cancelled) return;
          const root = toForwardSlashes(rootPath).replace(/\/$/, "");
          setResults(
            files
              .filter((f) => !f.endsWith("/"))
              .slice(0, 50)
              .map((relativePath) => ({ relativePath, absolutePath: `${root}/${relativePath}` }))
          );
        })
        .catch((err) => {
          if (!cancelled) setResults([]);
          logError("[FilePane] file search failed", err);
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
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  /** Renders the button as a toggle with a pressed state. */
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "toolbar-icon-button p-1.5 rounded",
            pressed ? "text-daintree-text" : "text-daintree-text/60"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function FilePane({
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
}: FilePaneProps) {
  const panel = usePanelStore(
    useCallback(
      (state) => {
        const candidate = state.panelsById[id];
        return candidate && isFilePanel(candidate) ? candidate : undefined;
      },
      [id]
    )
  );
  const setFileViewMode = usePanelStore((state) => state.setFileViewMode);
  const setFilePanelPath = usePanelStore((state) => state.setFilePanelPath);
  const markdownWrapLines = usePreferencesStore((state) => state.markdownWrapLines);
  const setMarkdownWrapLines = usePreferencesStore((state) => state.setMarkdownWrapLines);

  const filePath = panel?.filePath;
  const isMarkdown = filePath !== undefined && isMarkdownFilePath(filePath);
  // "rendered" is a markdown-only mode; other files always view as source.
  const viewMode: FileViewMode = isMarkdown ? (panel?.fileViewMode ?? "source") : "source";

  const worktreeId = panel?.worktreeId;
  const worktreePath = useWorktreeStore(
    useCallback(
      (state) => (worktreeId ? (state.worktrees.get(worktreeId)?.path ?? "") : ""),
      [worktreeId]
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
  const markdownViewerRef = useRef<MarkdownViewerHandle>(null);
  const codeViewerRef = useRef<CodeViewerHandle>(null);

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

  // Agents rewrite files while the user reads them: silently re-read when the
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

  // Route Cmd+F to the source view's find bar while this pane is focused
  // (no-op in rendered markdown, matching the dialog).
  useEffect(() => {
    if (!isFocused) return;
    const handleFindInPanel = () => {
      markdownViewerRef.current?.openSearch();
      codeViewerRef.current?.openSearch();
    };
    window.addEventListener("daintree:find-in-panel", handleFindInPanel);
    return () => window.removeEventListener("daintree:find-in-panel", handleFindInPanel);
  }, [isFocused]);

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
      .catch((err) => logError("[FilePane] copy path failed", err));
  }, [filePath]);

  const handleOpenInEditor = useCallback(() => {
    if (!filePath) return;
    actionService
      .dispatch("file.openInEditor", { path: filePath }, { source: "user" })
      .catch((err) => logError("[FilePane] openInEditor failed", err));
  }, [filePath]);

  const [pickerQuery, setPickerQuery] = useState("");
  const pickerRoot = worktreePath || projectPath;
  const pickerResults = useFileSearch(filePath ? "" : pickerRoot, pickerQuery);

  const fileName = filePath ? filePath.split(/[/\\]/).filter(Boolean).pop() : undefined;
  // A user-locked rename outranks the derived file name (title layering: the
  // user rung always wins); otherwise the file name is the live title.
  const displayTitle = panel?.titleMode === "user" ? title : (fileName ?? title);
  const displayPath =
    filePath && isUnderRoot(filePath, pickerRoot)
      ? toForwardSlashes(filePath).slice(toForwardSlashes(pickerRoot).replace(/\/$/, "").length + 1)
      : filePath && toForwardSlashes(filePath);
  const { spanRef: pathSpanRef, display: fittedPath } = useFittedPath(displayPath);

  const toolbar = filePath ? (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-surface border-b border-overlay">
      {isMarkdown && (
        <SegmentedToggle<FileViewMode>
          options={[
            { value: "source", label: "Source" },
            { value: "rendered", label: "Rendered" },
          ]}
          value={viewMode}
          onChange={(mode) => setFileViewMode(id, mode)}
        />
      )}
      {/* Path pill — mirrors the browser toolbar's address field. Click copies
          the absolute path; the middle collapses to fit the available width
          while the file name always survives. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleCopyPath}
            aria-label="Copy file path"
            className="relative flex items-center min-w-0 flex-1 group/path"
          >
            {pathCopied ? (
              <Check className="absolute left-2 w-3.5 h-3.5 text-status-success pointer-events-none" />
            ) : (
              <FileText
                aria-hidden="true"
                className="absolute left-2 w-3.5 h-3.5 text-daintree-text/40 pointer-events-none"
              />
            )}
            <span
              ref={pathSpanRef}
              className="w-full pl-7 pr-2 py-1 text-left text-xs font-mono rounded bg-daintree-bg border border-overlay text-daintree-text/70 truncate transition-colors group-hover/path:border-border-strong group-hover/path:text-daintree-text"
            >
              {fittedPath}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{pathCopied ? "Copied!" : "Click to copy"}</TooltipContent>
      </Tooltip>
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {isMarkdown && viewMode === "source" && (
          <ToolbarIconButton
            label="Wrap long lines"
            pressed={markdownWrapLines}
            onClick={() => setMarkdownWrapLines(!markdownWrapLines)}
          >
            <WrapText className="w-4 h-4" />
          </ToolbarIconButton>
        )}
        <ToolbarIconButton label="Refresh" onClick={() => loadFile(false)}>
          <RefreshCw className="w-4 h-4" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Open in editor" onClick={handleOpenInEditor}>
          <ExternalLink className="w-4 h-4" />
        </ToolbarIconButton>
      </div>
    </div>
  ) : undefined;

  return (
    <ContentPanel
      id={id}
      title={displayTitle}
      kind="file"
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
      <div className="flex-1 min-h-0 overflow-auto bg-daintree-bg" data-testid="file-pane-body">
        {!filePath && (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6">
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<FileText className="h-6 w-6" />}
              title="Open a file"
              description={
                pickerRoot
                  ? "Search the project's files, or click a file path in any terminal."
                  : "Open a project, then search its files here."
              }
            />
            {pickerRoot && (
              <div className="w-full max-w-md flex flex-col gap-1 min-h-0">
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-md border border-daintree-border bg-daintree-sidebar focus-within:border-daintree-accent focus-within:ring-1 focus-within:ring-daintree-accent/20">
                  <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <input
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    placeholder="Search files"
                    aria-label="Search files"
                    className="w-full bg-transparent text-sm text-daintree-text placeholder:text-text-placeholder focus:outline-hidden"
                    data-testid="file-pane-search"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto flex flex-col" role="listbox">
                  {pickerResults.map((result) => (
                    <button
                      key={result.absolutePath}
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => setFilePanelPath(id, result.absolutePath)}
                      className="text-left px-2 py-1.5 rounded text-xs font-mono truncate text-muted-foreground transition-colors hover:text-daintree-text hover:bg-daintree-border"
                      data-testid="file-pane-result"
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
            <Skeleton label="Loading file">
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

        {filePath &&
          loadState === "loaded" &&
          content !== null &&
          (isMarkdown ? (
            <MarkdownViewer
              ref={markdownViewerRef}
              content={content}
              filePath={filePath}
              rootPath={effectiveRootPath}
              viewMode={viewMode}
              wrapLines={markdownWrapLines}
              className={cn(viewMode === "source" && "min-h-full")}
            />
          ) : (
            <CodeViewer
              ref={codeViewerRef}
              content={content}
              filePath={filePath}
              className="min-h-full"
            />
          ))}
      </div>
    </ContentPanel>
  );
}
