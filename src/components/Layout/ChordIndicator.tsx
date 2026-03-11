import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePendingChord } from "@/hooks/useGlobalKeybindings";
import { keybindingService } from "@/services/KeybindingService";

const EXPAND_DELAY_MS = 600;

export function ChordIndicator() {
  const pendingChord = usePendingChord();
  const [expanded, setExpanded] = useState(false);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: pendingChord !== null,
  });

  useEffect(() => {
    if (pendingChord) {
      expandTimerRef.current = setTimeout(() => {
        setExpanded(true);
      }, EXPAND_DELAY_MS);
    } else {
      setExpanded(false);
    }

    return () => {
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
    };
  }, [pendingChord]);

  if (!shouldRender) return null;

  const displayChord = pendingChord ? keybindingService.formatComboForDisplay(pendingChord) : "";
  const completions = pendingChord ? keybindingService.getChordCompletions(pendingChord) : [];

  return createPortal(
    <div
      className={cn(
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)]",
        "transition-opacity duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
    >
      <div
        className={cn(
          "rounded-[var(--radius-lg)] bg-canopy-sidebar/95 border border-[var(--border-overlay)] shadow-xl",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-2 scale-[0.96]"
        )}
      >
        <div
          className="flex items-center gap-3 px-4 py-2.5"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <kbd className="text-sm font-semibold text-canopy-text tracking-wide">{displayChord}</kbd>
          <span className="text-canopy-text/40">&mdash;</span>
          <span className="text-xs text-canopy-text/50">Esc to cancel</span>
        </div>

        {expanded && completions.length > 0 && (
          <div className="border-t border-[var(--border-overlay)] px-3 py-2 max-h-48 overflow-y-auto">
            {completions.map((c) => (
              <div key={c.actionId} className="flex items-center gap-3 py-1 text-xs">
                <kbd className="min-w-[3rem] text-right font-medium text-canopy-text/80">
                  {c.displayKey}
                </kbd>
                <span className="text-canopy-text/50 truncate">{c.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
