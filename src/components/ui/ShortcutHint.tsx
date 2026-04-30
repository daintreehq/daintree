import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { Kbd } from "./Kbd";

const AUTO_DISMISS_MS = 2500;
const OFFSET_X = 12;
const OFFSET_Y = -12;
const TOOLTIP_WIDTH_ESTIMATE = 180;
const TOOLTIP_HEIGHT_ESTIMATE = 36;

export function ShortcutHint() {
  const activeHint = useStore(shortcutHintStore, (s) => s.activeHint);
  const hide = useStore(shortcutHintStore, (s) => s.hide);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the last visible hint in state so we can keep rendering it while
  // the exit animation plays (after activeHint has cleared).
  const [lastHint, setLastHint] = useState(activeHint);
  if (activeHint && activeHint !== lastHint) {
    setLastHint(activeHint);
  }

  const isOpen = activeHint !== null;

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
  });

  useEffect(() => {
    if (!activeHint) return;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      hide();
    }, AUTO_DISMISS_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [activeHint, hide]);

  const hint = lastHint;
  if (!shouldRender || !hint) return null;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = hint.x + OFFSET_X;
  let y = hint.y + OFFSET_Y;
  let above = true;

  if (x + TOOLTIP_WIDTH_ESTIMATE > vw) x = vw - TOOLTIP_WIDTH_ESTIMATE - 8;
  if (x < 8) x = 8;
  if (y - TOOLTIP_HEIGHT_ESTIMATE < 0) {
    y = hint.y + 20;
    above = false;
  }
  if (y > vh - TOOLTIP_HEIGHT_ESTIMATE) y = vh - TOOLTIP_HEIGHT_ESTIMATE - 8;

  return createPortal(
    <div
      className={cn(
        "fixed z-[var(--z-toast)] pointer-events-none",
        "transition-opacity duration-150",
        "motion-reduce:transition-none motion-reduce:duration-0",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={{ left: x, top: y, transform: above ? "translateY(-100%)" : undefined }}
      role="status"
      aria-live="polite"
    >
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1.5",
          "rounded-[var(--radius-lg)] bg-daintree-sidebar/95 border border-[var(--border-overlay)] shadow-[var(--theme-shadow-floating)]",
          "text-xs text-daintree-text/70",
          "transition duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
        )}
      >
        <span>Tip:</span>
        <Kbd>{hint.displayCombo}</Kbd>
      </div>
    </div>,
    document.body
  );
}
