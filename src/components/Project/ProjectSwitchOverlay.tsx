import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";

export interface ProjectSwitchOverlayProps {
  isSwitching: boolean;
  projectName?: string;
}

const MIN_DISPLAY_DURATION = 200;

export function ProjectSwitchOverlay({ isSwitching, projectName }: ProjectSwitchOverlayProps) {
  const [cachedProjectName, setCachedProjectName] = useState<string | undefined>(undefined);

  const clearCachedName = useCallback(() => {
    setCachedProjectName(undefined);
  }, []);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: isSwitching,
    minimumDisplayDuration: MIN_DISPLAY_DURATION,
    onAnimateOut: clearCachedName,
  });

  useEffect(() => {
    if (isSwitching && projectName) {
      setCachedProjectName(projectName);
    }
  }, [isSwitching, projectName]);

  if (!shouldRender) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-sm",
        "transition-opacity duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy={isSwitching}
    >
      <div
        className={cn(
          "flex flex-col items-center gap-4 text-center px-8 py-6 rounded-[var(--radius-xl)] bg-canopy-sidebar/95 border border-[var(--border-overlay)] shadow-xl",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.96]"
        )}
      >
        <Loader2
          className="h-8 w-8 text-canopy-accent animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div>
          {cachedProjectName ? (
            <>
              <p className="text-sm font-medium text-canopy-text">
                Switching to {cachedProjectName}
              </p>
              <p className="text-xs text-canopy-text/60 mt-1">Loading workspace...</p>
            </>
          ) : (
            <p className="text-sm font-medium text-canopy-text">Switching projects</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
