import { useState, useCallback, useRef, useEffect } from "react";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Copy, Check, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeBrowserUrl, getDisplayUrl } from "./browserUtils";

interface BrowserToolbarProps {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
}

export function BrowserToolbar({
  url,
  canGoBack,
  canGoForward,
  isLoading,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
}: BrowserToolbarProps) {
  const [inputValue, setInputValue] = useState(getDisplayUrl(url));
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy URL:", err);
    }
  }, [url]);

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

      {/* URL input */}
      <form onSubmit={handleSubmit} className="flex-1 min-w-0">
        <div className="relative flex items-center">
          <Globe className="absolute left-2 w-3.5 h-3.5 text-canopy-text/40 pointer-events-none" />
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
