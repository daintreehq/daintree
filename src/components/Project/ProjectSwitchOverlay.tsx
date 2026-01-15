import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getUiAnimationDuration } from "@/lib/animationUtils";

export interface ProjectSwitchOverlayProps {
  isSwitching: boolean;
  projectName?: string;
}

const MIN_DISPLAY_DURATION = 200;

export function ProjectSwitchOverlay({ isSwitching, projectName }: ProjectSwitchOverlayProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const [cachedProjectName, setCachedProjectName] = useState<string | undefined>(undefined);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minDurationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);
  const showStartTimeRef = useRef<number>(0);
  const pendingCloseRef = useRef(false);

  useEffect(() => {
    if (isSwitching) {
      pendingCloseRef.current = false;
      if (projectName) {
        setCachedProjectName(projectName);
      }
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (minDurationTimeoutRef.current) {
        clearTimeout(minDurationTimeoutRef.current);
        minDurationTimeoutRef.current = null;
      }
      showStartTimeRef.current = Date.now();
      setShouldRender(true);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setIsVisible(true);
      });
    } else {
      const elapsed = Date.now() - showStartTimeRef.current;
      const remaining = MIN_DISPLAY_DURATION - elapsed;

      const doClose = () => {
        setIsVisible(false);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        const duration = getUiAnimationDuration();
        if (duration === 0) {
          setShouldRender(false);
          setCachedProjectName(undefined);
        } else {
          closeTimeoutRef.current = setTimeout(() => {
            closeTimeoutRef.current = null;
            setShouldRender(false);
            setCachedProjectName(undefined);
          }, duration);
        }
      };

      if (remaining > 0 && showStartTimeRef.current > 0) {
        pendingCloseRef.current = true;
        minDurationTimeoutRef.current = setTimeout(() => {
          minDurationTimeoutRef.current = null;
          if (pendingCloseRef.current) {
            pendingCloseRef.current = false;
            doClose();
          }
        }, remaining);
      } else {
        doClose();
      }
    }

    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (minDurationTimeoutRef.current) {
        clearTimeout(minDurationTimeoutRef.current);
        minDurationTimeoutRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
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
