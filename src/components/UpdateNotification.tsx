import { useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/store/updateStore";
import { getQuietPeriodRemaining } from "@/lib/notify";

import { Button } from "@/components/ui/button";

export function UpdateNotification() {
  const { status, version, progress, dismissed, dismiss } = useUpdateStore();
  const [isVisible, setIsVisible] = useState(false);
  const [startupQuiet, setStartupQuiet] = useState(() => getQuietPeriodRemaining() > 0);
  const dismissTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const remaining = getQuietPeriodRemaining();
    if (remaining <= 0) {
      setStartupQuiet(false);
      return;
    }
    const id = setTimeout(() => setStartupQuiet(false), remaining);
    return () => clearTimeout(id);
  }, []);

  const shouldShow =
    !dismissed &&
    !startupQuiet &&
    (status === "available" || status === "downloading" || status === "downloaded");

  useEffect(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }

    if (shouldShow) {
      const rafId = requestAnimationFrame(() => setIsVisible(true));
      return () => cancelAnimationFrame(rafId);
    } else {
      setIsVisible(false);
      return undefined;
    }
  }, [shouldShow]);

  const handleDismiss = useCallback(() => {
    setIsVisible(false);
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }
    dismissTimerRef.current = setTimeout(() => {
      dismiss();
      dismissTimerRef.current = null;
    }, 300);
  }, [dismiss]);

  const handleRestart = useCallback(() => {
    window.electron?.update?.quitAndInstall();
  }, []);

  if (!shouldShow) return null;

  return createPortal(
    <div
      className={cn(
        "fixed bottom-20 z-[var(--z-toast)] pointer-events-none p-4",
        "flex justify-end w-full max-w-[420px]"
      )}
      style={{ right: "calc(var(--portal-right-offset, 0px))" }}
    >
      <div
        className={cn(
          "pointer-events-auto relative flex w-full items-start gap-2.5",
          "rounded-[var(--radius-sm)] border",
          "px-3 py-2.5 pr-10",
          "text-sm text-canopy-text",
          "shadow-[0_4px_12px_rgba(0,0,0,0.2)]",
          "transition-[transform,opacity] duration-300 ease-out",
          isVisible ? "translate-x-0 opacity-100" : "translate-x-8 opacity-0",
          "bg-[color-mix(in_oklab,var(--color-canopy-accent)_12%,transparent)]",
          "border-[color:color-mix(in_oklab,var(--color-canopy-accent)_25%,transparent)]",
          "backdrop-blur-sm"
        )}
      >
        <div className="mt-0.5 shrink-0 text-canopy-accent">
          {status === "downloaded" ? (
            <RefreshCw className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </div>

        <div className="flex-1 space-y-1.5 min-w-0">
          {status === "available" && (
            <>
              <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-canopy-accent">
                Update Available
              </h4>
              <div className="text-xs text-canopy-text/90 leading-snug">
                Version {version} is downloading...
              </div>
            </>
          )}

          {status === "downloading" && (
            <>
              <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-canopy-accent">
                Downloading Update
              </h4>
              <div className="text-xs text-canopy-text/90 leading-snug">
                {Math.round(progress)}% complete
              </div>
              <div className="h-1 w-full rounded-full bg-tint/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-canopy-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </>
          )}

          {status === "downloaded" && (
            <>
              <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-canopy-accent">
                Update Ready
              </h4>
              <div className="text-xs text-canopy-text/90 leading-snug">
                Version {version} is ready to install.
              </div>
              <Button
                type="button"
                onClick={handleRestart}
                className={cn(
                  "mt-1 px-2.5 py-1 rounded-[var(--radius-xs)]",
                  "text-xs font-medium",
                  "bg-canopy-accent/15 text-canopy-accent",
                  "hover:bg-canopy-accent/25 transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
                )}
              >
                Restart to Update
              </Button>
            </>
          )}
        </div>

        {status !== "downloading" && (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss notification"
            className={cn(
              "absolute right-1.5 top-1.5 rounded-[var(--radius-xs)]",
              "h-6 w-6 flex items-center justify-center",
              "text-canopy-text/60 transition-colors",
              "hover:text-canopy-text/90 hover:bg-tint/10",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2"
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
