import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type { ActionId } from "@shared/types/actions";
import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { describeChord } from "@/lib/kbdShortcut";
import { UI_PALETTE_EXIT_DURATION } from "@/lib/animationUtils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import { shortcutHintStore, type ShortcutHintRect } from "@/store/shortcutHintStore";
import { actionService } from "@/services/ActionService";
import { KbdChord } from "./Kbd";

const AUTO_DISMISS_MS = 2500;
const OFFSET_X = 12;
const OFFSET_Y = 12;
/** Room kept between the card and every viewport edge. */
const GUTTER = 8;
/** Slack around the trigger and card before a hover hint counts as left. */
const HOVER_SLOP = 4;
/** Used for the first layout pass only; placement settles on the measured card. */
const SIZE_ESTIMATE = { width: 200, height: 32 };

function contains(rect: ShortcutHintRect, x: number, y: number): boolean {
  return (
    x >= rect.left - HOVER_SLOP &&
    x <= rect.right + HOVER_SLOP &&
    y >= rect.top - HOVER_SLOP &&
    y <= rect.bottom + HOVER_SLOP
  );
}

export function ShortcutHint() {
  const activeHint = useStore(shortcutHintStore, (s) => s.activeHint);
  const hide = useStore(shortcutHintStore, (s) => s.hide);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(SIZE_ESTIMATE);
  const skipMotion = useShouldSkipMotion();
  // Keep the last visible hint in state so we can keep rendering it while
  // the exit animation plays (after activeHint has cleared).
  const [lastHint, setLastHint] = useState(activeHint);
  if (activeHint && activeHint !== lastHint) {
    setLastHint(activeHint);
  }

  const isOpen = activeHint !== null;

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen,
    animationDuration: UI_PALETTE_EXIT_DURATION,
  });

  // Only a hint that follows a click times out. Hover and focus hints are
  // content on hover or focus and stay until the user moves on (WCAG 1.4.13).
  useEffect(() => {
    if (!activeHint || activeHint.origin !== "dispatch") return;

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

  useEffect(() => {
    if (!activeHint) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeHint, hide]);

  // A hover hint lives while the pointer is on its trigger or on the card
  // itself. The card takes no pointer events, so this tracks coordinates
  // rather than enter/leave on the card.
  useEffect(() => {
    if (!activeHint || activeHint.origin !== "hover") return;
    const trigger = activeHint.trigger;
    const onPointerMove = (e: PointerEvent) => {
      const card = cardRef.current?.getBoundingClientRect();
      if (trigger && contains(trigger, e.clientX, e.clientY)) return;
      if (card && contains(card, e.clientX, e.clientY)) return;
      hide();
    };
    const onPointerDown = () => hide();
    const onLeaveWindow = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerout", onLeaveWindow, true);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerout", onLeaveWindow, true);
    };
  }, [activeHint, hide]);

  const hint = lastHint;

  // Place against the card's real size, before paint. An estimate either
  // pushes a long card off the right edge or squeezes a short one into wrapping.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!shouldRender || !card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  }, [shouldRender, hint, size.width, size.height]);

  // Live region must stay mounted at all times. If the node is created fresh on
  // each activation (as it was when the visual tooltip carried the aria-live
  // attributes and the whole portal unmounted), Chromium treats the text it
  // finds at mount as pre-existing static content and never announces it. Keep
  // a dedicated sr-only status node always in the DOM and only swap its text.
  // Lead the announcement with the action's name so the shortcut has meaning;
  // fall back to the generic "Shortcut:" prefix for unnamed/plugin actions. The
  // keys are spoken by name — "Command Shift P" — never as the glyphs.
  const liveTitle = activeHint
    ? actionService.getTitle(activeHint.actionId as ActionId).trim()
    : "";
  const spoken = activeHint ? describeChord(activeHint.combo, isMac()) : "";
  const liveRegion = (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {activeHint ? (liveTitle ? `${liveTitle}: ${spoken}` : `Shortcut: ${spoken}`) : ""}
    </div>
  );

  if (!shouldRender || !hint) return liveRegion;

  const title = actionService.getTitle(hint.actionId as ActionId).trim();

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxLeft = Math.max(GUTTER, vw - size.width - GUTTER);
  const left = Math.min(Math.max(hint.x + OFFSET_X, GUTTER), maxLeft);
  // Above the pointer by default; below the trigger (or pointer) when the top
  // edge would cut it off.
  let top = hint.y - OFFSET_Y - size.height;
  if (top < GUTTER) {
    const below = hint.trigger ? hint.trigger.bottom : hint.y + OFFSET_Y;
    top = below + OFFSET_Y / 2;
  }
  top = Math.max(GUTTER, Math.min(top, vh - size.height - GUTTER));

  return (
    <>
      {liveRegion}
      {createPortal(
        <div
          ref={cardRef}
          data-shortcut-hint-surface
          className={cn(
            "fixed z-[var(--z-toast)] pointer-events-none",
            "flex items-center gap-3 whitespace-nowrap px-2.5 py-1.5",
            "max-w-[calc(100vw-16px)]",
            "rounded-[var(--radius-md)] surface-overlay shadow-overlay",
            "text-xs text-text-primary",
            !skipMotion && "transition-[opacity,translate]",
            !skipMotion && (isVisible ? "duration-150 ease-out" : "duration-100 ease-in"),
            isVisible ? "opacity-100" : "opacity-0",
            !skipMotion && !isVisible && "translate-y-1"
          )}
          style={{ left, top }}
          aria-hidden="true"
        >
          {title && <span className="min-w-0 truncate">{title}</span>}
          <KbdChord shortcut={hint.combo} foreground="primary" className="shrink-0" />
        </div>,
        document.body
      )}
    </>
  );
}
