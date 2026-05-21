import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { usePendingChord, useLastInvalidKey } from "@/hooks/useGlobalKeybindings";
import { keybindingService } from "@/services/KeybindingService";
import { CHORD_SHOW_DELAY_MS } from "@/lib/animationUtils";

export function ChordIndicator() {
  const pendingChord = usePendingChord();
  const lastInvalidKey = useLastInvalidKey();
  const [showOverlay, setShowOverlay] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache last chord/completions so exit animation doesn't show empty content
  const lastChordRef = useRef<string>("");
  const lastCompletionsRef = useRef<ReturnType<typeof keybindingService.getChordCompletions>>([]);
  // Mirror into state so JSX doesn't read refs during render (React Compiler).
  const [lastChord, setLastChord] = useState<string>("");
  const [lastCompletions, setLastCompletions] = useState<
    ReturnType<typeof keybindingService.getChordCompletions>
  >([]);

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: showOverlay,
    onAnimateOut: () => keybindingService.clearLastInvalidKey(),
  });

  useEffect(() => {
    if (pendingChord) {
      // A fresh chord prefix supersedes any lingering invalid-key echo from a
      // prior attempt; clear it so the new prefix renders its completions.
      keybindingService.clearLastInvalidKey();
      lastChordRef.current = pendingChord;
      lastCompletionsRef.current = keybindingService.getChordCompletions(pendingChord);
      setLastChord(lastChordRef.current);
      setLastCompletions(lastCompletionsRef.current);
      // If overlay is already showing (chord deepened), keep it visible
      if (!showOverlay) {
        timerRef.current = setTimeout(() => {
          setShowOverlay(true);
        }, CHORD_SHOW_DELAY_MS);
      }
    } else {
      // Close the overlay; useAnimatedPresence's exit animation runs while
      // the JSX echoes lastInvalidKey, then onAnimateOut clears it. If the
      // HUD never opened (invalid key arrived inside the 200ms show delay),
      // there's no exit animation, so clear lastInvalidKey directly to avoid
      // a stuck-state leak.
      if (lastInvalidKey && !showOverlay) {
        keybindingService.clearLastInvalidKey();
      }
      setShowOverlay(false);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pendingChord, lastInvalidKey, showOverlay]);

  if (!shouldRender) return null;

  const displayChord = keybindingService.formatComboForDisplay(lastChord);
  const displayInvalidKey = lastInvalidKey
    ? keybindingService.formatComboForDisplay(lastInvalidKey)
    : null;
  const completions = lastCompletions;

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
        "fixed bottom-6 left-1/2 -translate-x-1/2 z-[var(--z-toast)] pointer-events-none",
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
          {displayInvalidKey ? (
            <>
              <kbd className="text-sm font-medium text-daintree-text/50 tracking-wide line-through">
                {displayInvalidKey}
              </kbd>
              <span className="text-daintree-text/40">&mdash;</span>
              <span className="text-xs text-daintree-text/50">Unrecognized</span>
            </>
          ) : (
            <>
              <span className="text-daintree-text/40">&mdash;</span>
              <span className="text-xs text-daintree-text/50">Backspace or Esc to cancel</span>
            </>
          )}
        </div>

        {!displayInvalidKey && completions.length > 0 && (
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
