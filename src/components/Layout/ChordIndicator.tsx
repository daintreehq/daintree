import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePendingChord } from "@/hooks/useGlobalKeybindings";
import { keybindingService } from "@/services/KeybindingService";

const SHOW_DELAY_MS = 200;

export function ChordIndicator() {
  const pendingChord = usePendingChord();
  const [showOverlay, setShowOverlay] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache last chord/completions so exit animation doesn't show empty content
  const lastChordRef = useRef<string>("");
  const lastCompletionsRef = useRef<ReturnType<typeof keybindingService.getChordCompletions>>([]);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: showOverlay,
  });

  useEffect(() => {
    if (pendingChord) {
      lastChordRef.current = pendingChord;
      lastCompletionsRef.current = keybindingService.getChordCompletions(pendingChord);
      // If overlay is already showing (chord deepened), keep it visible
      if (!showOverlay) {
        timerRef.current = setTimeout(() => {
          setShowOverlay(true);
        }, SHOW_DELAY_MS);
      }
    } else {
      setShowOverlay(false);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pendingChord, showOverlay]);

  if (!shouldRender) return null;

  const displayChord = keybindingService.formatComboForDisplay(lastChordRef.current);
  const completions = lastCompletionsRef.current;

  // Group completions by category
  const grouped = new Map<string, typeof completions>();
  for (const c of completions) {
    const list = grouped.get(c.category);
    if (list) {
      list.push(c);
    } else {
      grouped.set(c.category, [c]);
    }
  }

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
          "rounded-[var(--radius-lg)] bg-daintree-sidebar/95 border border-[var(--border-overlay)] shadow-xl",
          "transition duration-150",
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
          <kbd className="text-sm font-semibold text-daintree-text tracking-wide">
            {displayChord}
          </kbd>
          <span className="text-daintree-text/40">&mdash;</span>
          <span className="text-xs text-daintree-text/50">Esc to cancel</span>
        </div>

        {completions.length > 0 && (
          <div className="border-t border-[var(--border-overlay)] px-3 py-2 max-h-48 overflow-y-auto">
            {Array.from(grouped.entries()).map(([category, items], groupIdx) => (
              <div key={category}>
                {groupIdx > 0 && <div className="border-t border-[var(--border-overlay)] my-1.5" />}
                <div className="text-[10px] font-medium uppercase tracking-wider text-daintree-text/30 px-1 py-1">
                  {category}
                </div>
                {items.map((c) => (
                  <div
                    key={c.actionId || c.secondKey}
                    className="flex items-center gap-3 py-1 text-xs"
                  >
                    <kbd className="min-w-[3rem] text-right font-medium text-daintree-text/80">
                      {c.isPrefix ? `${c.displayKey} +` : c.displayKey}
                    </kbd>
                    <span className="text-daintree-text/50 truncate">{c.description}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
