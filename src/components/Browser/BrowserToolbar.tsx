import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Copy,
  Check,
  Globe,
  ZoomIn,
  ZoomOut,
  Camera,
  SquareTerminal,
  Code,
  Smartphone,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeBrowserUrl, getDisplayUrl } from "./browserUtils";
import { actionService } from "@/services/ActionService";
import { useUrlHistoryStore, getFrecencySuggestions } from "@/store/urlHistoryStore";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ViewportPresetId } from "@shared/types/panel";
import { VIEWPORT_PRESET_LIST, getViewportPreset } from "@/panels/dev-preview/viewportPresets";

const ZOOM_PRESETS = [
  { value: 0.25, label: "25%" },
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1.0, label: "100%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
  { value: 2.0, label: "200%" },
];
const ZOOM_VALUES = ZOOM_PRESETS.map((preset) => preset.value);
const EMPTY_ENTRIES: import("@shared/types/browser").UrlHistoryEntry[] = [];

interface BrowserToolbarProps {
  terminalId?: string;
  projectId?: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  urlMightBeStale?: boolean;
  zoomFactor?: number;
  isConsoleOpen?: boolean;
  isWebviewReady?: boolean;
  viewportPreset?: ViewportPresetId;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onHardReload?: () => void;
  onOpenExternal: () => void;
  onZoomChange?: (zoomFactor: number) => void;
  onCaptureScreenshot?: () => void;
  onToggleConsole?: () => void;
  onToggleDevTools?: () => void;
  onViewportPresetChange?: (preset: ViewportPresetId | undefined) => void;
}

export function BrowserToolbar({
  terminalId,
  projectId,
  url,
  canGoBack,
  canGoForward,
  isLoading,
  urlMightBeStale = false,
  zoomFactor = 1.0,
  isConsoleOpen = false,
  isWebviewReady = false,
  viewportPreset,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onHardReload,
  onOpenExternal,
  onZoomChange,
  onCaptureScreenshot,
  onToggleConsole,
  onToggleDevTools,
  onViewportPresetChange,
}: BrowserToolbarProps) {
  const [inputValue, setInputValue] = useState(getDisplayUrl(url));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const projectEntries = useUrlHistoryStore(
    (state) => (projectId ? state.entries[projectId] : undefined) ?? EMPTY_ENTRIES
  );

  const suggestions = useMemo(
    () => (isEditing && projectId ? getFrecencySuggestions(projectEntries, inputValue) : []),
    [isEditing, projectId, projectEntries, inputValue]
  );

  useEffect(() => {
    setHighlightedIndex(-1);
    setIsDropdownOpen(isEditing && suggestions.length > 0);
  }, [suggestions, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      setInputValue(getDisplayUrl(url));
    }
  }, [url, isEditing]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const result = normalizeBrowserUrl(inputValue);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.url) {
        setError(null);
        setIsEditing(false);
        setIsDropdownOpen(false);
        setHighlightedIndex(-1);
        if (result.url === url) {
          onReload();
        } else {
          onNavigate(result.url);
        }
      }
    },
    [inputValue, url, onNavigate, onReload]
  );

  const handleFocus = useCallback(() => {
    setIsEditing(true);
    setInputValue(url);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [url]);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      if (dropdownRef.current?.contains(e.relatedTarget as Node)) return;
      setIsEditing(false);
      setIsDropdownOpen(false);
      setHighlightedIndex(-1);
      setError(null);
      setInputValue(getDisplayUrl(url));
    },
    [url]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isDropdownOpen && suggestions.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHighlightedIndex((i) => Math.min(i + 1, suggestions.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHighlightedIndex((i) => Math.max(i - 1, -1));
          return;
        }
        if (e.key === "Enter" && highlightedIndex >= 0) {
          e.preventDefault();
          const selected = suggestions[highlightedIndex]!;
          setIsEditing(false);
          setIsDropdownOpen(false);
          setHighlightedIndex(-1);
          onNavigate(selected.url);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setIsDropdownOpen(false);
          setHighlightedIndex(-1);
          return;
        }
        if (e.shiftKey && (e.key === "Delete" || e.key === "Backspace") && highlightedIndex >= 0) {
          e.preventDefault();
          const entry = suggestions[highlightedIndex]!;
          if (projectId) {
            useUrlHistoryStore.getState().removeUrl(projectId, entry.url);
          }
          const remaining = suggestions.length - 1;
          if (remaining === 0) {
            setIsDropdownOpen(false);
            setHighlightedIndex(-1);
          } else if (highlightedIndex >= remaining) {
            setHighlightedIndex(remaining - 1);
          }
          return;
        }
      }
      if (e.key === "Escape") {
        setIsEditing(false);
        setError(null);
        inputRef.current?.blur();
      }
    },
    [isDropdownOpen, suggestions, highlightedIndex, onNavigate, projectId]
  );

  const handleCopy = useCallback(async () => {
    try {
      const result = await actionService.dispatch(
        "browser.copyUrl",
        { terminalId, url },
        { source: "user" }
      );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  }, [terminalId, url]);

  const handleZoomStep = useCallback(
    (direction: "in" | "out") => {
      if (!onZoomChange) return;
      const minZoom = ZOOM_VALUES[0]!;
      const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1]!;
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, zoomFactor));
      const exactIndex = ZOOM_VALUES.findIndex((value) => Math.abs(value - clampedZoom) < 0.01);
      let nextZoom: number;

      if (exactIndex !== -1) {
        const nextIndex =
          direction === "in"
            ? Math.min(exactIndex + 1, ZOOM_VALUES.length - 1)
            : Math.max(exactIndex - 1, 0);
        nextZoom = ZOOM_VALUES[nextIndex]!;
      } else if (direction === "in") {
        nextZoom = ZOOM_VALUES.find((value) => value > clampedZoom) ?? maxZoom;
      } else {
        const lowerValues = ZOOM_VALUES.filter((value) => value < clampedZoom);
        nextZoom = lowerValues.length > 0 ? lowerValues[lowerValues.length - 1]! : minZoom;
      }

      if (Math.abs(nextZoom - zoomFactor) >= 0.001) {
        onZoomChange(nextZoom);
      }
    },
    [onZoomChange, zoomFactor]
  );

  const handleZoomReset = useCallback(() => {
    if (!onZoomChange) return;
    if (Math.abs(zoomFactor - 1.0) < 0.01) return;
    onZoomChange(1.0);
  }, [onZoomChange, zoomFactor]);

  const isNonDefaultZoom = Math.abs(zoomFactor - 1.0) >= 0.01;
  const currentZoomLabel =
    ZOOM_PRESETS.find((p) => Math.abs(p.value - zoomFactor) < 0.01)?.label ??
    `${Math.round(zoomFactor * 100)}%`;
  const minZoom = ZOOM_VALUES[0]!;
  const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1]!;
  const canZoomOut = zoomFactor > minZoom + 0.001;
  const canZoomIn = zoomFactor < maxZoom - 0.001;

  const buttonClass =
    "p-1.5 rounded hover:bg-overlay-medium disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-surface border-b border-overlay">
      {/* Navigation buttons */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              onClick={onBack}
              disabled={!canGoBack}
              className={buttonClass}
              aria-label="Go back"
              data-testid="browser-back"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Go back</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <button
              type="button"
              onClick={onForward}
              disabled={!canGoForward}
              className={buttonClass}
              aria-label="Go forward"
              data-testid="browser-forward"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">Go forward</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => {
              if (e.shiftKey && onHardReload) {
                onHardReload();
              } else {
                onReload();
              }
            }}
            className={cn(buttonClass, isLoading && "animate-spin")}
            aria-label="Reload"
            data-testid="browser-reload"
          >
            <RotateCw className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {onHardReload ? "Reload (Shift+click for hard reload)" : "Reload"}
        </TooltipContent>
      </Tooltip>

      {/* Zoom controls */}
      {onZoomChange && (
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={() => handleZoomStep("out")}
                  disabled={!canZoomOut}
                  className={buttonClass}
                  aria-label="Zoom out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Zoom out</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={handleZoomReset}
                  disabled={!isNonDefaultZoom}
                  className={cn(
                    "px-1.5 py-1 rounded text-xs font-medium transition-colors",
                    "hover:bg-overlay-medium disabled:opacity-40 disabled:cursor-not-allowed",
                    isNonDefaultZoom ? "text-status-info" : "text-daintree-text/60"
                  )}
                  aria-label="Reset zoom"
                >
                  {currentZoomLabel}
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reset zoom to 100%</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={() => handleZoomStep("in")}
                  disabled={!canZoomIn}
                  className={buttonClass}
                  aria-label="Zoom in"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">Zoom in</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Viewport preset selector (dev-preview only) */}
      {onViewportPresetChange && (
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => {
                  if (viewportPreset) {
                    onViewportPresetChange(undefined);
                  } else {
                    onViewportPresetChange("iphone");
                  }
                }}
                className={cn(
                  buttonClass,
                  viewportPreset && "bg-overlay-emphasis text-daintree-text"
                )}
                aria-label="Viewport preset"
                aria-pressed={!!viewportPreset}
              >
                <Smartphone className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {viewportPreset
                ? `Viewport: ${getViewportPreset(viewportPreset).label}`
                : "Responsive viewport"}
            </TooltipContent>
          </Tooltip>
          {viewportPreset && (
            <div className="flex items-center ml-0.5">
              {VIEWPORT_PRESET_LIST.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() =>
                    onViewportPresetChange(viewportPreset === preset.id ? undefined : preset.id)
                  }
                  className={cn(
                    "px-1.5 py-1 rounded text-[10px] font-medium transition-colors",
                    "hover:bg-overlay-medium",
                    viewportPreset === preset.id
                      ? "bg-overlay-emphasis text-daintree-text"
                      : "text-daintree-text/50"
                  )}
                  aria-label={preset.label}
                  aria-pressed={viewportPreset === preset.id}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* URL input */}
      <div ref={containerRef} className="relative flex-1 min-w-0">
        <form onSubmit={handleSubmit}>
          <div className="relative flex items-center">
            <Globe className="absolute left-2 w-3.5 h-3.5 text-daintree-text/40 pointer-events-none" />
            {urlMightBeStale && !isEditing && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="absolute left-6 w-1.5 h-1.5 rounded-full bg-status-warning/60" />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  URL may differ from page shown (in-page navigation)
                </TooltipContent>
              </Tooltip>
            )}
            <input
              ref={inputRef}
              type="text"
              data-testid="browser-address-bar"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setError(null);
              }}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              className={cn(
                "w-full pl-7 pr-2 py-1 text-xs rounded",
                "bg-daintree-bg border border-overlay",
                "focus:outline-none focus:border-border-strong",
                "text-daintree-text placeholder:text-daintree-text/40",
                error && "border-status-error/50"
              )}
              placeholder="localhost:3000"
            />
          </div>
          {error && (
            <div className="absolute mt-1 text-xs text-status-error bg-daintree-bg border border-status-error/30 rounded px-2 py-1 z-10">
              {error}
            </div>
          )}
        </form>

        {isDropdownOpen && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 top-full mt-1 z-50 bg-daintree-bg border border-overlay rounded shadow-[var(--theme-shadow-floating)] overflow-hidden"
          >
            {suggestions.map((entry, index) => (
              <div
                key={entry.url}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  "group/row w-full text-left px-2.5 py-1.5 flex items-center gap-2 cursor-pointer",
                  index === highlightedIndex ? "bg-overlay-medium" : "hover:bg-overlay-soft"
                )}
              >
                {entry.favicon ? (
                  <span className="relative w-4 h-4 shrink-0">
                    <img
                      src={entry.favicon}
                      alt=""
                      className="w-4 h-4 rounded-sm object-contain"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.style.display = "none";
                        const fallback = img.nextElementSibling;
                        if (fallback) (fallback as HTMLElement).style.display = "";
                      }}
                    />
                    <Globe
                      className="w-4 h-4 text-daintree-text/30 absolute inset-0"
                      style={{ display: "none" }}
                    />
                  </span>
                ) : (
                  <Globe className="w-4 h-4 shrink-0 text-daintree-text/30" />
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setIsEditing(false);
                    setIsDropdownOpen(false);
                    setHighlightedIndex(-1);
                    onNavigate(entry.url);
                  }}
                  className="flex-1 min-w-0 flex flex-col gap-0.5 text-left"
                >
                  {entry.title && (
                    <span className="text-xs text-daintree-text truncate">{entry.title}</span>
                  )}
                  <span className="text-xs text-daintree-text/50 truncate">{entry.url}</span>
                </button>
                {projectId && (
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      useUrlHistoryStore.getState().removeUrl(projectId, entry.url);
                      const remaining = suggestions.length - 1;
                      if (remaining === 0) {
                        setIsDropdownOpen(false);
                        setHighlightedIndex(-1);
                      } else if (index === highlightedIndex && highlightedIndex >= remaining) {
                        setHighlightedIndex(remaining - 1);
                      }
                    }}
                    className="shrink-0 p-0.5 rounded opacity-0 group-hover/row:opacity-100 hover:bg-overlay-strong transition-opacity text-daintree-text/40 hover:text-daintree-text/70"
                    aria-label={`Remove ${entry.url} from history`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={handleCopy} className={buttonClass}>
            {copied ? (
              <Check className="w-4 h-4 text-status-success" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Copy URL</TooltipContent>
      </Tooltip>

      {onCaptureScreenshot && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onCaptureScreenshot}
              disabled={!isWebviewReady}
              className={buttonClass}
              aria-label="Capture screenshot"
            >
              <Camera className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Copy screenshot to clipboard</TooltipContent>
        </Tooltip>
      )}

      {onToggleConsole && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleConsole}
              className={cn(buttonClass, isConsoleOpen && "bg-overlay-emphasis text-daintree-text")}
              aria-label="Toggle console"
              aria-pressed={isConsoleOpen}
            >
              <SquareTerminal className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {isConsoleOpen ? "Hide console" : "Show console"}
          </TooltipContent>
        </Tooltip>
      )}

      {onToggleDevTools && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleDevTools}
              disabled={!isWebviewReady}
              className={buttonClass}
              aria-label="Toggle DevTools"
            >
              <Code className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open DevTools</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={onOpenExternal} className={buttonClass}>
            <ExternalLink className="w-4 h-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in browser</TooltipContent>
      </Tooltip>
    </div>
  );
}
