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
  Terminal,
  Code,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeBrowserUrl, getDisplayUrl } from "./browserUtils";
import { actionService } from "@/services/ActionService";
import { useUrlHistoryStore, getFrecencySuggestions } from "@/store/urlHistoryStore";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

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
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  onZoomChange?: (zoomFactor: number) => void;
  onCaptureScreenshot?: () => void;
  onToggleConsole?: () => void;
  onToggleDevTools?: () => void;
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
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  onZoomChange,
  onCaptureScreenshot,
  onToggleConsole,
  onToggleDevTools,
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

  const projectEntries = useUrlHistoryStore((state) =>
    projectId ? (state.entries[projectId] ?? []) : []
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
        onNavigate(result.url);
      }
    },
    [inputValue, onNavigate]
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
          const selected = suggestions[highlightedIndex];
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
      }
      if (e.key === "Escape") {
        setIsEditing(false);
        setError(null);
        inputRef.current?.blur();
      }
    },
    [isDropdownOpen, suggestions, highlightedIndex, onNavigate]
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
      const minZoom = ZOOM_VALUES[0];
      const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1];
      const clampedZoom = Math.max(minZoom, Math.min(maxZoom, zoomFactor));
      const exactIndex = ZOOM_VALUES.findIndex((value) => Math.abs(value - clampedZoom) < 0.01);
      let nextZoom = clampedZoom;

      if (exactIndex !== -1) {
        const nextIndex =
          direction === "in"
            ? Math.min(exactIndex + 1, ZOOM_VALUES.length - 1)
            : Math.max(exactIndex - 1, 0);
        nextZoom = ZOOM_VALUES[nextIndex];
      } else if (direction === "in") {
        nextZoom = ZOOM_VALUES.find((value) => value > clampedZoom) ?? maxZoom;
      } else {
        const lowerValues = ZOOM_VALUES.filter((value) => value < clampedZoom);
        nextZoom = lowerValues.length > 0 ? lowerValues[lowerValues.length - 1] : minZoom;
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
  const minZoom = ZOOM_VALUES[0];
  const maxZoom = ZOOM_VALUES[ZOOM_VALUES.length - 1];
  const canZoomOut = zoomFactor > minZoom + 0.001;
  const canZoomIn = zoomFactor < maxZoom - 0.001;

  const buttonClass =
    "p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-surface border-b border-overlay">
      {/* Navigation buttons */}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button type="button" onClick={onBack} disabled={!canGoBack} className={buttonClass}>
                <ArrowLeft className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go back</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={onForward}
                disabled={!canGoForward}
                className={buttonClass}
              >
                <ArrowRight className="w-4 h-4" />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Go forward</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onReload}
              className={cn(buttonClass, isLoading && "animate-spin")}
            >
              <RotateCw className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Zoom controls */}
      {onZoomChange && (
        <div className="flex items-center gap-0.5">
          <TooltipProvider>
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
          </TooltipProvider>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <button
                    type="button"
                    onClick={handleZoomReset}
                    disabled={!isNonDefaultZoom}
                    className={cn(
                      "px-1.5 py-1 rounded text-xs font-medium transition-colors",
                      "hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed",
                      isNonDefaultZoom ? "text-status-info" : "text-canopy-text/60"
                    )}
                    aria-label="Reset zoom"
                  >
                    {currentZoomLabel}
                  </button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reset zoom to 100%</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider>
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
          </TooltipProvider>
        </div>
      )}

      {/* URL input */}
      <div ref={containerRef} className="relative flex-1 min-w-0">
        <form onSubmit={handleSubmit}>
          <div className="relative flex items-center">
            <Globe className="absolute left-2 w-3.5 h-3.5 text-canopy-text/40 pointer-events-none" />
            {urlMightBeStale && !isEditing && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="absolute left-6 w-1.5 h-1.5 rounded-full bg-status-warning/60" />
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    URL may differ from page shown (in-page navigation)
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
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
                "bg-canopy-bg border border-overlay",
                "focus:outline-none focus:border-white/20",
                "text-canopy-text placeholder:text-canopy-text/40",
                error && "border-status-error/50"
              )}
              placeholder="localhost:3000"
            />
          </div>
          {error && (
            <div className="absolute mt-1 text-xs text-status-error bg-canopy-bg border border-status-error/30 rounded px-2 py-1 z-10">
              {error}
            </div>
          )}
        </form>

        {isDropdownOpen && suggestions.length > 0 && (
          <div
            ref={dropdownRef}
            className="absolute left-0 right-0 top-full mt-1 z-50 bg-canopy-bg border border-overlay rounded shadow-lg overflow-hidden"
          >
            {suggestions.map((entry, index) => (
              <button
                key={entry.url}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsEditing(false);
                  setIsDropdownOpen(false);
                  setHighlightedIndex(-1);
                  onNavigate(entry.url);
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
                className={cn(
                  "w-full text-left px-2.5 py-1.5 flex flex-col gap-0.5 cursor-pointer",
                  index === highlightedIndex ? "bg-white/10" : "hover:bg-white/5"
                )}
              >
                {entry.title && (
                  <span className="text-xs text-canopy-text truncate">{entry.title}</span>
                )}
                <span className="text-xs text-canopy-text/50 truncate">{entry.url}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <TooltipProvider>
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
      </TooltipProvider>

      {onCaptureScreenshot && (
        <TooltipProvider>
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
        </TooltipProvider>
      )}

      {onToggleConsole && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onToggleConsole}
                className={cn(buttonClass, isConsoleOpen && "bg-white/15 text-canopy-text")}
                aria-label="Toggle console"
                aria-pressed={isConsoleOpen}
              >
                <Terminal className="w-4 h-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isConsoleOpen ? "Hide console" : "Show console"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {onToggleDevTools && (
        <TooltipProvider>
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
        </TooltipProvider>
      )}

      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={onOpenExternal} className={buttonClass}>
              <ExternalLink className="w-4 h-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Open in browser</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
