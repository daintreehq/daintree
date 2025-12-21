import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { AlertTriangle, ExternalLink, Globe, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/store";
import { BrowserToolbar } from "./BrowserToolbar";
import { normalizeBrowserUrl, extractHostPort } from "./browserUtils";

interface BrowserHistory {
  past: string[];
  present: string;
  future: string[];
}

export interface BrowserPaneProps {
  id: string;
  title: string;
  initialUrl: string;
  worktreeId?: string;
  isFocused: boolean;
  isMaximized?: boolean;
  location?: "grid" | "dock";
  onFocus: () => void;
  onClose: (force?: boolean) => void;
  onToggleMaximize?: () => void;
  onTitleChange?: (newTitle: string) => void;
  onMinimize?: () => void;
  isTrashing?: boolean;
  gridTerminalCount?: number;
}

export function BrowserPane({
  id,
  title,
  initialUrl,
  isFocused,
  isMaximized = false,
  location = "grid",
  onFocus,
  onClose,
  onToggleMaximize,
  onTitleChange,
  onMinimize,
  isTrashing = false,
  gridTerminalCount,
}: BrowserPaneProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const setBrowserUrl = useTerminalStore((state) => state.setBrowserUrl);

  const [history, setHistory] = useState<BrowserHistory>(() => ({
    past: [],
    present: initialUrl,
    future: [],
  }));

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editingValue, setEditingValue] = useState(title);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const currentUrl = history.present;
  const canGoBack = history.past.length > 0;
  const canGoForward = history.future.length > 0;

  // Sync URL changes to store
  useEffect(() => {
    setBrowserUrl(id, currentUrl);
  }, [id, currentUrl, setBrowserUrl]);

  const handleNavigate = useCallback((url: string) => {
    const result = normalizeBrowserUrl(url);
    if (result.error || !result.url) return;

    setHistory((prev) => ({
      past: [...prev.past, prev.present],
      present: result.url!,
      future: [],
    }));
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.past.length === 0) return prev;
      const newPast = [...prev.past];
      const previousUrl = newPast.pop()!;
      return {
        past: newPast,
        present: previousUrl,
        future: [prev.present, ...prev.future],
      };
    });
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleForward = useCallback(() => {
    setHistory((prev) => {
      if (prev.future.length === 0) return prev;
      const [nextUrl, ...restFuture] = prev.future;
      return {
        past: [...prev.past, prev.present],
        present: nextUrl,
        future: restFuture,
      };
    });
    setIsLoading(true);
    setLoadError(null);
  }, []);

  const handleReload = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    if (iframeRef.current) {
      // Force reload by toggling src
      const currentSrc = iframeRef.current.src;
      iframeRef.current.src = "";
      requestAnimationFrame(() => {
        if (iframeRef.current) {
          iframeRef.current.src = currentSrc;
        }
      });
    }
  }, []);

  const handleOpenExternal = useCallback(() => {
    window.electron.system.openExternal(currentUrl);
  }, [currentUrl]);

  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setLoadError("Failed to load page. The site may refuse embedding or be unavailable.");
  }, []);

  const handleTitleDoubleClick = useCallback(() => {
    setEditingValue(title);
    setIsEditingTitle(true);
    requestAnimationFrame(() => titleInputRef.current?.select());
  }, [title]);

  const handleTitleSave = useCallback(() => {
    setIsEditingTitle(false);
    if (editingValue.trim() && editingValue !== title) {
      onTitleChange?.(editingValue.trim());
    }
  }, [editingValue, title, onTitleChange]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleTitleSave();
      } else if (e.key === "Escape") {
        setIsEditingTitle(false);
        setEditingValue(title);
      }
    },
    [handleTitleSave, title]
  );

  const displayTitle = useMemo(() => {
    if (title && title !== "Browser") return title;
    return extractHostPort(currentUrl);
  }, [title, currentUrl]);

  const showGridAttention = location === "grid" && !isMaximized && (gridTerminalCount ?? 2) > 1;

  return (
    <div
      className={cn(
        "flex flex-col h-full overflow-hidden group",
        location === "grid" && !isMaximized && "bg-[var(--color-surface)]",
        (location === "dock" || isMaximized) && "bg-canopy-bg",
        location === "grid" && !isMaximized && "rounded border shadow-md",
        location === "grid" &&
          !isMaximized &&
          (isFocused && showGridAttention
            ? "terminal-selected"
            : "border-overlay hover:border-white/[0.08]"),
        location === "grid" && isMaximized && "border-0 rounded-none z-[var(--z-maximized)]",
        isTrashing && "terminal-trashing"
      )}
      onClick={onFocus}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center h-8 px-2 gap-2 shrink-0",
          "border-b border-overlay bg-[var(--color-surface)]"
        )}
      >
        <Globe className="w-4 h-4 text-blue-400 shrink-0" />

        {isEditingTitle ? (
          <input
            ref={titleInputRef}
            type="text"
            value={editingValue}
            onChange={(e) => setEditingValue(e.target.value)}
            onBlur={handleTitleSave}
            onKeyDown={handleTitleKeyDown}
            className="flex-1 min-w-0 text-sm bg-canopy-bg border border-overlay rounded px-1 py-0.5 focus:outline-none focus:border-white/20"
          />
        ) : (
          <span
            className="flex-1 min-w-0 text-sm truncate cursor-default"
            onDoubleClick={handleTitleDoubleClick}
          >
            {displayTitle}
          </span>
        )}

        <div className="flex items-center gap-1">
          {onMinimize && location === "grid" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMinimize();
              }}
              className="p-1 rounded hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
              title="Move to dock"
            >
              <div className="w-3 h-0.5 bg-current rounded-full" />
            </button>
          )}
          {onToggleMaximize && location === "grid" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleMaximize();
              }}
              className="p-1 rounded hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
              title={isMaximized ? "Restore" : "Maximize"}
            >
              <div className="w-3 h-3 border border-current rounded-sm" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="p-1 rounded hover:bg-red-500/20 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
            title="Close"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Browser toolbar */}
      <BrowserToolbar
        url={currentUrl}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        isLoading={isLoading}
        onNavigate={handleNavigate}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onOpenExternal={handleOpenExternal}
      />

      {/* Content area */}
      <div className="flex-1 min-h-0 relative bg-white">
        {loadError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-canopy-bg text-canopy-text p-6">
            <AlertTriangle className="w-12 h-12 text-amber-400 mb-4" />
            <h3 className="text-lg font-medium mb-2">Unable to Display Page</h3>
            <p className="text-sm text-canopy-text/60 text-center mb-4 max-w-md">{loadError}</p>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="flex items-center gap-2 px-4 py-2 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 rounded-lg border border-blue-500/30 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Open in External Browser
            </button>
          </div>
        ) : (
          <>
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center bg-canopy-bg z-10">
                <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            <iframe
              ref={iframeRef}
              src={currentUrl}
              title={displayTitle}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
            />
          </>
        )}
      </div>
    </div>
  );
}
