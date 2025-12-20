import React, { useState, useEffect, useRef, useCallback } from "react";
import { Info, Check, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface GeminiAlternateBufferBannerProps {
  terminalId: string;
  onDismiss: () => void;
  className?: string;
}

type BannerState = "prompt" | "enabling" | "success" | "error";

function GeminiAlternateBufferBannerComponent({
  terminalId,
  onDismiss,
  className,
}: GeminiAlternateBufferBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [bannerState, setBannerState] = useState<BannerState>("prompt");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const successTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setIsVisible(true);
    });

    return () => {
      isMountedRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (successTimeoutRef.current) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
    };
  }, []);

  const handleEnable = useCallback(async () => {
    if (bannerState === "enabling") return;

    setBannerState("enabling");
    setErrorMessage(null);

    try {
      await window.electron.gemini.enableAlternateBuffer();
      if (!isMountedRef.current) return;
      setBannerState("success");

      successTimeoutRef.current = setTimeout(() => {
        onDismiss();
      }, 3000);
    } catch (error) {
      if (!isMountedRef.current) return;
      const message = error instanceof Error ? error.message : "Failed to update settings";
      setErrorMessage(message);
      setBannerState("error");
    }
  }, [bannerState, onDismiss]);

  const handleDismiss = useCallback(() => {
    localStorage.setItem("gemini-alt-buffer-dismissed", "true");
    onDismiss();
  }, [onDismiss]);

  const handleLearnMore = useCallback(() => {
    void window.electron.system
      .openExternal("https://github.com/google-gemini/gemini-cli/blob/main/docs/settings.md")
      .catch(() => {});
  }, []);

  const getIcon = () => {
    switch (bannerState) {
      case "success":
        return <Check className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-status-success)]" />;
      case "error":
        return <X className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-status-error)]" />;
      default:
        return <Info className="w-4 h-4 shrink-0 mt-0.5 text-canopy-accent" />;
    }
  };

  const getMessage = () => {
    switch (bannerState) {
      case "enabling":
        return "Updating Gemini settings...";
      case "success":
        return "Alternate buffer enabled! Restart Gemini terminal to apply.";
      case "error":
        return errorMessage || "Failed to update settings.";
      default:
        return "Gemini flicker can be reduced by enabling alternate buffer mode.";
    }
  };

  const getBackgroundColor = () => {
    switch (bannerState) {
      case "success":
        return "bg-[color-mix(in_oklab,var(--color-status-success)_10%,transparent)] border-[var(--color-status-success)]/20";
      case "error":
        return "bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)] border-[var(--color-status-error)]/20";
      default:
        return "bg-[color-mix(in_oklab,var(--color-canopy-accent)_10%,transparent)] border-canopy-accent/20";
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2 shrink-0",
        getBackgroundColor(),
        "border-b",
        "transition-all duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
        className
      )}
      role={bannerState === "error" ? "alert" : "status"}
      aria-live={bannerState === "error" ? "assertive" : "polite"}
      data-terminal-id={terminalId}
    >
      <div className="flex items-start gap-2">
        {getIcon()}
        <div className="flex-1 min-w-0">
          <span
            className={cn(
              "text-sm font-medium",
              bannerState === "success" && "text-[var(--color-status-success)]",
              bannerState === "error" && "text-[var(--color-status-error)]",
              bannerState !== "success" && bannerState !== "error" && "text-canopy-accent"
            )}
          >
            {getMessage()}
          </span>
        </div>
      </div>

      {bannerState === "prompt" && (
        <div className="flex items-center gap-2 ml-6">
          <button
            type="button"
            onClick={handleEnable}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-accent/10 text-canopy-accent hover:bg-canopy-accent/20 rounded transition-colors"
            title="Enable alternate buffer"
            aria-label="Enable alternate buffer"
          >
            <Check className="w-3 h-3" aria-hidden="true" />
            Enable
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-border text-canopy-text hover:bg-canopy-border/80 rounded transition-colors"
            title="Dismiss"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" aria-hidden="true" />
            Dismiss
          </button>

          <button
            type="button"
            onClick={handleLearnMore}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-canopy-text/70 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors"
            title="Learn more about alternate buffer"
            aria-label="Learn more"
          >
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
            Learn More
          </button>
        </div>
      )}

      {bannerState === "error" && (
        <div className="flex items-center gap-2 ml-6">
          <button
            type="button"
            onClick={handleEnable}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-border text-canopy-text hover:bg-canopy-border/80 rounded transition-colors"
            title="Retry"
            aria-label="Retry"
          >
            Retry
          </button>

          <button
            type="button"
            onClick={handleDismiss}
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-canopy-text/70 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors"
            title="Dismiss"
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export const GeminiAlternateBufferBanner = React.memo(GeminiAlternateBufferBannerComponent);
