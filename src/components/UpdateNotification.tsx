import { useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Download, RefreshCw, X, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUpdateStore } from "@/store/updateStore";

export function UpdateNotification() {
  const { status, version, progress, dismissed, dismiss } = useUpdateStore();
  const [isVisible, setIsVisible] = useState(false);
  const dismissTimerRef = useRef<NodeJS.Timeout | null>(null);

  const shouldShow =
    !dismissed && (status === "available" || status === "downloading" || status === "downloaded" || status === "error");

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
      style={{ right: "calc(var(--sidecar-right-offset, 0px))" }}
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
        <div className={cn("mt-0.5 shrink-0", status === "error" ? "text-[var(--color-status-error)]" : "text-canopy-accent")}>
          {status === "downloaded" ? (
            <RefreshCw className="h-4 w-4" />
          ) : status === "error" ? (
            <AlertCircle className="h-4 w-4" />
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
              <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
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
              <button
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
              </button>
            </>
          )}

          {status === "error" && (
            <>
              <h4 className="font-medium leading-tight tracking-tight text-xs font-mono text-[var(--color-status-error)]">
                Update Failed
              </h4>
              <div className="text-xs text-canopy-text/90 leading-snug">
                Unable to check for updates. Please try again later.
              </div>
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
              "hover:text-canopy-text/90 hover:bg-white/10",
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
