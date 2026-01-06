import React, { useState, useEffect, useRef, useCallback } from "react";
import { Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GeminiAlternateBufferBannerProps {
  terminalId: string;
  onDismiss: () => void;
  className?: string;
}

function GeminiAlternateBufferBannerComponent({
  terminalId,
  onDismiss,
  className,
}: GeminiAlternateBufferBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setIsVisible(true);
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem("gemini-alt-buffer-dismissed", "true");
    onDismiss();
  }, [onDismiss]);

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 shrink-0",
        "bg-[color-mix(in_oklab,var(--color-status-info)_6%,transparent)]",
        "border-b border-[color-mix(in_oklab,var(--color-status-info)_15%,transparent)]",
        "transition-all duration-200 ease-out",
        "motion-reduce:transition-none",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1",
        className
      )}
      role="status"
      aria-live="polite"
      data-terminal-id={terminalId}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Terminal className="w-4 h-4 shrink-0 text-[var(--color-status-info)]" aria-hidden="true" />
        <span className="text-sm text-canopy-text/80">
          For flicker-free output, run{" "}
          <code className="px-1 py-0.5 bg-canopy-text/10 rounded text-canopy-text/90 font-mono text-xs">
            /settings
          </code>{" "}
          and enable{" "}
          <code className="px-1 py-0.5 bg-canopy-text/10 rounded text-canopy-text/90 font-mono text-xs">
            Use Alternate Screen Buffer
          </code>
        </span>
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        className={cn(
          "p-1 rounded transition-colors shrink-0",
          "text-canopy-text/30 hover:text-canopy-text/60 hover:bg-white/5"
        )}
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export const GeminiAlternateBufferBanner = React.memo(GeminiAlternateBufferBannerComponent);
