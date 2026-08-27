import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type { ActionId } from "@shared/types/actions";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { shortcutHintStore } from "@/store/shortcutHintStore";
import { actionService } from "@/services/ActionService";
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

  // Live region must stay mounted at all times. If the node is created fresh on
  // each activation (as it was when the visual tooltip carried the aria-live
  // attributes and the whole portal unmounted), Chromium treats the text it
  // finds at mount as pre-existing static content and never announces it. Keep
  // a dedicated sr-only status node always in the DOM and only swap its text.
  // Lead the announcement with the action's name so the shortcut has meaning;
  // fall back to the generic "Shortcut:" prefix for unnamed/plugin actions.
  const liveTitle = activeHint
    ? actionService.getTitle(activeHint.actionId as ActionId).trim()
    : "";
  const liveRegion = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {activeHint
        ? liveTitle
          ? `${liveTitle}: ${activeHint.displayCombo}`
          : `Shortcut: ${activeHint.displayCombo}`
        : ""}
    </div>
  );

  if (!shouldRender || !hint) return liveRegion;

  const title = actionService.getTitle(hint.actionId as ActionId).trim();

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

  return (
    <>
      {liveRegion}
      {createPortal(
        <div
          className={cn(
            "fixed z-[var(--z-toast)] pointer-events-none",
            "transition-opacity duration-150",
            "motion-reduce:transition-none motion-reduce:duration-0",
            isVisible ? "opacity-100" : "opacity-0"
          )}
          style={{ left: x, top: y, transform: above ? "translateY(-100%)" : undefined }}
          aria-hidden="true"
        >
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-1.5",
              "rounded-[var(--radius-md)] surface-overlay shadow-overlay",
              "text-xs text-text-primary",
              "transition duration-150",
              "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1"
            )}
          >
            <span>{title || "Tip:"}</span>
            <Kbd>{hint.displayCombo}</Kbd>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
