import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
} from "@/lib/animationUtils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  dismissCopyFlash,
  getCopyFlash,
  invalidateCopyFlash,
  noteCopyFlashKeyboard,
  noteCopyFlashPointer,
  subscribeCopyFlash,
  type CopyOrigin,
} from "@/lib/copyFlash";
import { subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { COPIED_LABEL } from "./CopyButton";
import { TOOLTIP_CARD_PADDING } from "./tooltip";

/** Space between the origin and the card. */
const GAP = 8;
/** Room kept between the card and every viewport edge. */
const GUTTER = 8;
/** Distance from the bottom edge when there is no origin to sit beside. */
const BOTTOM_INSET = 48;
/** Used for the first layout pass only; placement settles on the measured card. */
const SIZE_ESTIMATE = { width: 64, height: 28 };

function place(
  origin: CopyOrigin | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number }
): { left: number; top: number } {
  let centerX: number;
  let top: number;
  if (!origin) {
    centerX = viewport.width / 2;
    top = viewport.height - BOTTOM_INSET - size.height;
  } else {
    const above = origin.kind === "point" ? origin.y : origin.top;
    const below = origin.kind === "point" ? origin.y : origin.bottom;
    centerX = origin.kind === "point" ? origin.x : (origin.left + origin.right) / 2;
    top = above - GAP - size.height;
    if (top < GUTTER) top = below + GAP;
  }
  const maxLeft = Math.max(GUTTER, viewport.width - size.width - GUTTER);
  const left = Math.min(Math.max(centerX - size.width / 2, GUTTER), maxLeft);
  const maxTop = Math.max(GUTTER, viewport.height - size.height - GUTTER);
  return { left, top: Math.min(Math.max(top, GUTTER), maxTop) };
}

/**
 * The visual half of a menu-row copy confirmation (`copyWithToast`): a
 * "Copied" card beside where the copy was asked for, gone after the success
 * dwell. It is decoration only — the announcement is made by the helper, so
 * the card is hidden from assistive tech and never takes focus or pointer.
 */
export function CopyFlash() {
  const flash = useSyncExternalStore(subscribeCopyFlash, getCopyFlash, getCopyFlash);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(SIZE_ESTIMATE);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // Kept through the exit fade, after the flash itself has cleared.
  const [lastFlash, setLastFlash] = useState(flash);
  if (flash && flash !== lastFlash) {
    setLastFlash(flash);
  }

  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: flash !== null,
    animationDuration: UI_PALETTE_EXIT_DURATION,
  });

  // The origin is a snapshot, so record the input that will produce it before
  // any menu closes and moves focus.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => noteCopyFlashPointer(e.clientX, e.clientY);
    const onKeyDown = () => noteCopyFlashKeyboard();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // A switched-away project view must not come back to a stale "Copied".
  useEffect(
    () =>
      subscribeProjectViewObservability((observable) => {
        if (!observable) invalidateCopyFlash();
      }),
    []
  );

  useEffect(() => {
    if (!flash) return;
    // Wheel rather than scroll: terminals scroll on their own output, and the
    // flash only has to leave when the user moves the content under it.
    const onWheel = () => dismissCopyFlash();
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    onResize();
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [flash]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!shouldRender || !card) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    if (width !== size.width || height !== size.height) setSize({ width, height });
  }, [shouldRender, lastFlash, size.width, size.height]);

  if (!shouldRender || !lastFlash) return null;

  const { left, top } = place(lastFlash.origin, size, viewport);

  return createPortal(
    <div
      ref={cardRef}
      data-copy-flash
      className={cn(
        "fixed z-[var(--z-toast)] pointer-events-none whitespace-nowrap",
        TOOLTIP_CARD_PADDING,
        "rounded-[var(--radius-md)] surface-overlay shadow-overlay",
        "text-xs text-text-primary",
        // Opacity only, so reduced motion has nothing to drop.
        "transition-opacity",
        isVisible ? "opacity-100" : "opacity-0"
      )}
      style={{
        left,
        top,
        transitionDuration: `${isVisible ? UI_PALETTE_ENTER_DURATION : UI_PALETTE_EXIT_DURATION}ms`,
        transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
      }}
      aria-hidden="true"
    >
      {COPIED_LABEL}
    </div>,
    document.body
  );
}
