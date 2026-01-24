import React, { useState, useEffect, useRef } from "react";
import { Clock, RotateCcw, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalReconnectError } from "@/types";

export interface ReconnectErrorBannerProps {
  terminalId: string;
  error: TerminalReconnectError;
  onDismiss: (id: string) => void;
  onRestart: (id: string) => void;
  className?: string;
}

function getErrorTitle(type: TerminalReconnectError["type"]): string {
  switch (type) {
    case "timeout":
      return "Reconnection Timed Out";
    case "not_found":
      return "Previous Session Not Found";
    default:
      return "Reconnection Failed";
  }
}

function getErrorSeverity(type: TerminalReconnectError["type"]): "warning" | "error" {
  switch (type) {
    case "timeout":
      return "warning";
    case "not_found":
    case "error":
      return "error";
    default:
      return "warning";
  }
}

function getErrorIcon(type: TerminalReconnectError["type"]) {
  switch (type) {
    case "timeout":
      return Clock;
    default:
      return AlertTriangle;
  }
}

function ReconnectErrorBannerComponent({
  terminalId,
  error,
  onDismiss,
  onRestart,
  className,
}: ReconnectErrorBannerProps) {
  const [isVisible, setIsVisible] = useState(false);
  const rafRef = useRef<number | null>(null);
  const IconComponent = getErrorIcon(error.type);
  const severity = getErrorSeverity(error.type);
  const colorVar = severity === "error" ? "--color-status-error" : "--color-status-warning";

  useEffect(() => {
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setIsVisible(true);
    });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-3 py-2 shrink-0",
        "transition-all duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2",
        className
      )}
      style={{
        backgroundColor: `color-mix(in oklab, var(${colorVar}) 10%, transparent)`,
        borderBottom: `1px solid color-mix(in oklab, var(${colorVar}) 20%, transparent)`,
      }}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <IconComponent
          className="w-4 h-4 shrink-0 mt-0.5"
          style={{ color: `var(${colorVar})` }}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium" style={{ color: `var(${colorVar})` }}>
            {getErrorTitle(error.type)}
          </span>
          <p
            className="text-xs mt-0.5"
            style={{ color: `color-mix(in oklab, var(${colorVar}) 80%, transparent)` }}
          >
            {error.message}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-6">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRestart(terminalId);
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium bg-canopy-border text-canopy-text hover:bg-canopy-border/80 rounded transition-colors"
          title="Restart Terminal"
          aria-label="Restart terminal"
        >
          <RotateCcw className="w-3 h-3" aria-hidden="true" />
          Restart
        </button>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(terminalId);
          }}
          className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-canopy-text/60 hover:text-canopy-text hover:bg-canopy-border/50 rounded transition-colors"
          title="Dismiss"
          aria-label="Dismiss notification"
        >
          <X className="w-3 h-3" aria-hidden="true" />
          Dismiss
        </button>
      </div>
    </div>
  );
}

export const ReconnectErrorBanner = React.memo(ReconnectErrorBannerComponent);
