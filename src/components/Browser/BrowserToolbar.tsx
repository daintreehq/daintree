import { useState, useCallback, useRef, useEffect } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ExternalLink,
  Copy,
  Check,
  Globe,
  ChevronDown,
  ZoomIn,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeBrowserUrl, getDisplayUrl } from "./browserUtils";
import { actionService } from "@/services/ActionService";

const ZOOM_PRESETS = [
  { value: 0.25, label: "25%" },
  { value: 0.5, label: "50%" },
  { value: 0.75, label: "75%" },
  { value: 1.0, label: "100%" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
  { value: 2.0, label: "200%" },
];

interface BrowserToolbarProps {
  terminalId?: string;
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  urlMightBeStale?: boolean;
  zoomFactor?: number;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  onZoomChange?: (zoomFactor: number) => void;
}

export function BrowserToolbar({
  terminalId,
  url,
  canGoBack,
  canGoForward,
  isLoading,
  urlMightBeStale = false,
  zoomFactor = 1.0,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  onZoomChange,
}: BrowserToolbarProps) {
  const [inputValue, setInputValue] = useState(getDisplayUrl(url));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isZoomDropdownOpen, setIsZoomDropdownOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const zoomDropdownRef = useRef<HTMLDivElement>(null);
  const zoomButtonRef = useRef<HTMLButtonElement>(null);
  const zoomMenuRef = useRef<HTMLDivElement>(null);

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

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    setError(null);
    setInputValue(getDisplayUrl(url));
  }, [url]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setIsEditing(false);
      setError(null);
      inputRef.current?.blur();
    }
  }, []);

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

  const handleZoomSelect = useCallback(
    (factor: number) => {
      onZoomChange?.(factor);
      setIsZoomDropdownOpen(false);
      zoomButtonRef.current?.focus();
    },
    [onZoomChange]
  );

  const handleZoomKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setIsZoomDropdownOpen(false);
      zoomButtonRef.current?.focus();
    }
  }, []);

  // Close zoom dropdown when clicking or tabbing outside
  useEffect(() => {
    if (!isZoomDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (zoomDropdownRef.current && !zoomDropdownRef.current.contains(e.target as Node)) {
        setIsZoomDropdownOpen(false);
      }
    };
    const handleFocusOut = (e: FocusEvent) => {
      if (zoomDropdownRef.current && !zoomDropdownRef.current.contains(e.target as Node)) {
        setIsZoomDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("focusin", handleFocusOut);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("focusin", handleFocusOut);
    };
  }, [isZoomDropdownOpen]);

  const isNonDefaultZoom = Math.abs(zoomFactor - 1.0) >= 0.01;
  const currentZoomLabel =
    ZOOM_PRESETS.find((p) => Math.abs(p.value - zoomFactor) < 0.01)?.label ??
    `${Math.round(zoomFactor * 100)}%`;

  const buttonClass =
    "p-1.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";

  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[var(--color-surface)] border-b border-overlay">
      {/* Navigation buttons */}
      <button
        type="button"
        onClick={onBack}
        disabled={!canGoBack}
        className={buttonClass}
        title="Go back"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canGoForward}
        className={buttonClass}
        title="Go forward"
      >
        <ArrowRight className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={onReload}
        className={cn(buttonClass, isLoading && "animate-spin")}
        title="Reload"
      >
        <RotateCw className="w-4 h-4" />
      </button>

      {/* Zoom dropdown */}
      {onZoomChange && (
        <div ref={zoomDropdownRef} className="relative">
          <button
            ref={zoomButtonRef}
            type="button"
            onClick={() => setIsZoomDropdownOpen(!isZoomDropdownOpen)}
            onKeyDown={handleZoomKeyDown}
            aria-expanded={isZoomDropdownOpen}
            aria-haspopup="menu"
            aria-controls="zoom-menu"
            className={cn(
              "flex items-center gap-0.5 px-1.5 py-1 rounded text-xs",
              "hover:bg-white/10 transition-colors",
              isNonDefaultZoom && "text-blue-400 font-medium"
            )}
            title={`Zoom level: ${currentZoomLabel}`}
          >
            <ZoomIn className="w-3.5 h-3.5" />
            <span className="min-w-[2.5rem] text-center">{currentZoomLabel}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
          {isZoomDropdownOpen && (
            <div
              ref={zoomMenuRef}
              id="zoom-menu"
              role="menu"
              aria-label="Zoom level"
              onKeyDown={handleZoomKeyDown}
              className="absolute top-full left-0 mt-1 py-1 bg-canopy-surface border border-overlay rounded shadow-lg z-20 min-w-[5rem]"
            >
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={Math.abs(preset.value - zoomFactor) < 0.01}
                  onClick={() => handleZoomSelect(preset.value)}
                  className={cn(
                    "w-full px-3 py-1.5 text-xs text-left hover:bg-white/10 transition-colors",
                    Math.abs(preset.value - zoomFactor) < 0.01 && "text-blue-400 bg-white/5"
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* URL input */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-0">
        <div className="relative flex items-center">
          <Globe className="absolute left-2 w-3.5 h-3.5 text-canopy-text/40 pointer-events-none" />
          {urlMightBeStale && !isEditing && (
            <span
              className="absolute left-6 w-1.5 h-1.5 rounded-full bg-amber-400/60"
              title="URL may differ from page shown (in-page navigation)"
            />
          )}
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              setError(null);
            }}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className={cn(
              "w-full pl-7 pr-2 py-1 text-xs rounded",
              "bg-canopy-bg border border-overlay",
              "focus:outline-none focus:border-white/20",
              "text-canopy-text placeholder:text-canopy-text/40",
              error && "border-red-500/50"
            )}
            placeholder="localhost:3000"
          />
        </div>
        {error && (
          <div className="absolute mt-1 text-xs text-red-400 bg-canopy-bg border border-red-500/30 rounded px-2 py-1 z-10">
            {error}
          </div>
        )}
      </form>

      {/* Action buttons */}
      <button type="button" onClick={handleCopy} className={buttonClass} title="Copy URL">
        {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
      </button>
      <button
        type="button"
        onClick={onOpenExternal}
        className={buttonClass}
        title="Open in browser"
      >
        <ExternalLink className="w-4 h-4" />
      </button>
    </div>
  );
}
