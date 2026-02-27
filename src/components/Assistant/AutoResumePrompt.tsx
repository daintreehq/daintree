import React, { useEffect, useState, useCallback, useRef } from "react";
import { Play, X, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

const AUTO_RESUME_GRACE_PERIOD_MS = 15000;

export interface AutoResumePromptProps {
  eventSummary: string;
  queuedAt: number;
  onResume: () => void;
  onCancel: () => void;
  className?: string;
}

function AutoResumePromptComponent({
  eventSummary,
  queuedAt,
  onResume,
  onCancel,
  className,
}: AutoResumePromptProps) {
  const deadline = queuedAt + AUTO_RESUME_GRACE_PERIOD_MS;
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    Math.ceil((deadline - Date.now()) / 1000)
  );
  const hasTriggeredRef = useRef(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [deadline]);

  useEffect(() => {
    if (remainingSeconds <= 0 && !hasTriggeredRef.current) {
      hasTriggeredRef.current = true;
      onResume();
    }
  }, [remainingSeconds, onResume]);

  const handleResume = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasTriggeredRef.current) return;
      hasTriggeredRef.current = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      onResume();
    },
    [onResume]
  );

  const handleCancel = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (hasTriggeredRef.current) return;
      hasTriggeredRef.current = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      onCancel();
    },
    [onCancel]
  );

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 shrink-0",
        "bg-[color-mix(in_oklab,var(--color-canopy-accent)_10%,transparent)]",
        "border-b border-[var(--color-canopy-accent)]/20",
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Clock className="w-4 h-4 shrink-0 text-[var(--color-canopy-accent)]" aria-hidden="true" />
        <span className="text-sm text-canopy-text truncate">
          Agent event: <span className="font-medium">{eventSummary}</span>
        </span>
        <span className="text-xs text-canopy-text/60 shrink-0" aria-hidden="true">
          Auto-resuming in {remainingSeconds}s
        </span>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleResume}
                className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-[var(--color-canopy-accent)]/10 text-[var(--color-canopy-accent)] hover:bg-[var(--color-canopy-accent)]/20 rounded transition-colors"
                aria-label="Resume conversation now"
              >
                <Play className="w-3 h-3" aria-hidden="true" />
                Resume now
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Resume now</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleCancel}
                className="p-1 text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-text/10 rounded transition-colors"
                aria-label="Cancel auto-resume"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Cancel</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

export const AutoResumePrompt = React.memo(AutoResumePromptComponent);
