import React, { Activity, useState, useLayoutEffect, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
  getUiTransitionDuration,
} from "@/lib/animationUtils";
import { useEscapeStack } from "@/hooks/useEscapeStack";
import { useUIStore } from "@/store/uiStore";

// Grace window after the dropdown opens during which overlay-count rises are
// treated as in-flight modals (e.g. cold-start AgentSetupWizard) rather than
// user-initiated dismiss triggers. Absorbs the cold-start race from issue
// #5084 where deferred IPC mounts a modal shortly after the user clicks a
// GitHub toolbar dropdown.
const OVERLAY_RACE_GRACE_MS = 300;

// Signals to descendants whether the keepMounted dropdown body is currently
// visible (`true`) or has transitioned to Activity-hidden (`false`). The
// shared `Tooltip` wrapper consumes this to force `open={false}` on Radix
// Tooltip roots once the body is hidden, killing strand-in-top-left ghosts
// caused by portaled overlay content escaping Activity's `display:none`
// (issue #8001). Default `true` keeps non-keepMounted dropdowns and any
// tooltip rendered outside a FixedDropdown unaffected.
/**
 * Whether the dropdown this subtree belongs to is OPEN — not whether it is
 * still painted. Under `keepMounted` the two diverge for the exit animation;
 * consumers that need to close something of their own want the intent, which
 * is `open`. See the provider below.
 */
export const FixedDropdownVisibleContext = React.createContext<boolean>(true);

interface FixedDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  sideOffset?: number;
  persistThroughChildOverlays?: boolean;
  // Keep the body in the React tree across open/close cycles after the first
  // open, hiding it via React 19.2 `<Activity>` instead of unmounting. State
  // (Virtuoso scroll, filter selections) survives, while effects re-fire on
  // each reveal so the SWR revalidate path still runs. Costs ~one body's
  // worth of memory per dropdown — opt in only for hot paths.
  keepMounted?: boolean;
}

export function FixedDropdown({
  open,
  onOpenChange,
  anchorRef,
  children,
  className,
  sideOffset = 8,
  persistThroughChildOverlays = false,
  keepMounted = false,
}: FixedDropdownProps) {
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    right: string;
    availableHeight: number;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // rAF-coalesce scroll/resize re-positions: a single in-flight frame, latest
  // wins, and `lastPositionRef` diff-gates so an unchanged anchor never fires a
  // redundant React commit (issue #9580). Mirrors `useVerticalScrollShadows`.
  const positionRafRef = useRef<number | null>(null);
  const lastPositionRef = useRef<{
    top: number;
    right: string;
    availableHeight: number;
  } | null>(null);
  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: open,
    animationDuration: getUiTransitionDuration("exit"),
  });
  const overlayStackLength = useUIStore((state) => state.overlayStack.length);
  const [overlayGraceActive, setOverlayGraceActive] = useState(false);
  const baselineOverlaySizeRef = useRef<number>(0);
  // Carry the latest overlay-claims size into the grace-setup effect without
  // adding it as a reactive dependency — re-running on every size change
  // would wrongly reset the grace window on each in-flight rise. Sync in
  // an effect so the React Compiler doesn't reject render-time ref mutation.
  const latestOverlaySizeRef = useRef<number>(overlayStackLength);
  useEffect(() => {
    latestOverlaySizeRef.current = overlayStackLength;
  }, [overlayStackLength]);

  useEffect(() => {
    if (!open) {
      setOverlayGraceActive(false);
      baselineOverlaySizeRef.current = 0;
      return;
    }
    setOverlayGraceActive(true);
    baselineOverlaySizeRef.current = latestOverlaySizeRef.current;
    const handle = setTimeout(() => {
      setOverlayGraceActive(false);
    }, OVERLAY_RACE_GRACE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [open]);

  useEffect(() => setMounted(true), []);

  // For keepMounted: latch true on first open and stay true. Before this flips,
  // we still return null so we don't pay portal/body mount cost for dropdowns
  // the user never opens. Lazy-initialized to `open` so the first open render
  // doesn't waste a frame returning null while waiting for an effect to flip it.
  const [hasEverOpened, setHasEverOpened] = useState(open);
  useEffect(() => {
    if (open && !hasEverOpened) setHasEverOpened(true);
  }, [open, hasEverOpened]);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || typeof window === "undefined") return;
    const rect = anchorRef.current.getBoundingClientRect();
    const buttonRightGap = Math.max(window.innerWidth - rect.right, 8);
    const top = rect.bottom + sideOffset;
    const next = {
      top,
      right: `max(${buttonRightGap}px, calc(var(--portal-right-offset, 0px) + 8px))`,
      // The room left between the anchor and the bottom of the viewport, minus
      // the same gutter used on the other edges. Published as a custom property
      // so content can cap itself against the space it actually has instead of
      // a constant — the convention every Radix overlay family in this app
      // already follows via `--radix-*-content-available-height`. Floored so a
      // cramped viewport yields a small panel rather than a negative one.
      availableHeight: Math.max(Math.round(window.innerHeight - top - 8), 120),
    };
    const last = lastPositionRef.current;
    if (
      last &&
      last.top === next.top &&
      last.right === next.right &&
      last.availableHeight === next.availableHeight
    )
      return;
    lastPositionRef.current = next;
    setPosition(next);
  }, [anchorRef, sideOffset]);

  useLayoutEffect(() => {
    if (!open) return;
    // Open-time positioning stays synchronous so first paint isn't a frame
    // late; only the scroll/resize re-positions defer to rAF.
    updatePosition();
    const scheduleUpdatePosition = () => {
      if (positionRafRef.current !== null) return;
      positionRafRef.current = requestAnimationFrame(() => {
        positionRafRef.current = null;
        updatePosition();
      });
    };
    window.addEventListener("resize", scheduleUpdatePosition);
    window.addEventListener("scroll", scheduleUpdatePosition, true);
    return () => {
      if (positionRafRef.current !== null) {
        cancelAnimationFrame(positionRafRef.current);
        positionRafRef.current = null;
      }
      window.removeEventListener("resize", scheduleUpdatePosition);
      window.removeEventListener("scroll", scheduleUpdatePosition, true);
    };
  }, [open, updatePosition]);

  const childOverlayActive = persistThroughChildOverlays && overlayStackLength > 0;
  useEscapeStack(open && !childOverlayActive, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (persistThroughChildOverlays && overlayStackLength > 0) return;
      const target = event.target as Node | null;
      if (contentRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open, onOpenChange, anchorRef, persistThroughChildOverlays, overlayStackLength]);

  useEffect(() => {
    if (persistThroughChildOverlays || !open) return;
    if (overlayGraceActive) {
      // During the grace window, absorb any overlay rises as "already in
      // flight when the dropdown opened." This keeps the baseline tracking
      // the current size so rises after grace are measured against the
      // settled baseline.
      baselineOverlaySizeRef.current = overlayStackLength;
      return;
    }
    // Decay the baseline when the overlay-claims size drops — e.g. the
    // in-flight modal that was absorbed during grace has since closed.
    // Without this, a subsequent user-initiated modal at the same numeric
    // level would fail to dismiss the dropdown.
    if (overlayStackLength < baselineOverlaySizeRef.current) {
      baselineOverlaySizeRef.current = overlayStackLength;
      return;
    }
    if (overlayStackLength > baselineOverlaySizeRef.current) {
      onOpenChange(false);
    }
  }, [open, overlayStackLength, onOpenChange, persistThroughChildOverlays, overlayGraceActive]);

  if (!mounted) return null;
  if (!position) return null;
  if (keepMounted ? !hasEverOpened : !shouldRender) return null;

  // While `shouldRender` is false on a keepMounted dropdown, the inner overlay
  // is fully closed — switch the Activity tree to "hidden" so React drops the
  // hidden tree's effects (Virtuoso resize observers, SWR poll loops) and
  // skips its commits, while preserving component state for sub-frame reopens.
  // The outer pointer-events:none wrapper stays in the DOM so layout doesn't
  // thrash; Activity only hides its child.
  //
  // INVARIANT for descendants: do NOT rely on exit-retaining portal overlays
  // inside a keepMounted dropdown. React 19's Activity hidden mode applies
  // `display:none` synchronously but defers effect cleanups, so any overlay
  // whose dismiss path depends on browser events (`pointerleave`, `blur`)
  // never receives them once the trigger DOM is hidden. Portaled content
  // (Radix Tooltip / Popover / HoverCard / DropdownMenu content, Framer
  // Motion `AnimatePresence` exit children) escapes the Activity subtree
  // entirely — it stays mounted on `document.body` with stale state and,
  // in Floating-UI-positioned cases, falls back to (0,0) (issue #8001).
  // For exit animation: use plain conditional render. For uncontrolled
  // overlays: route through the shared `Tooltip` wrapper, which consumes
  // `FixedDropdownVisibleContext` and force-closes on the hidden transition.
  // Direct Radix primitive usage bypasses this guard. See `BulkActionBar.tsx`
  // and `GitHubResourceList.tsx`'s skeleton/content switch for the safe
  // exit-animation pattern.
  const inner = (
    <div
      ref={contentRef}
      className={cn(
        "absolute pointer-events-auto overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-text-primary",
        // Tailwind v4 translate-*/scale-* emit the individual `translate` and
        // `scale` properties, which `transform` in a transition list does NOT
        // cover — list them explicitly or the rise/zoom snaps.
        "transition-[opacity,translate,scale]",
        "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:translate-none motion-reduce:scale-none",
        isVisible
          ? "opacity-100 translate-y-0 scale-100"
          : "opacity-0 -translate-y-0.5 scale-[0.99]",
        className
      )}
      style={
        {
          top: position.top,
          right: position.right,
          "--fixed-dropdown-available-height": `${position.availableHeight}px`,
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        } as React.CSSProperties
      }
    >
      {children}
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-popover)] pointer-events-none">
      {keepMounted ? (
        <Activity mode={shouldRender ? "visible" : "hidden"}>
          {/* The context carries `open`, NOT `shouldRender`.
              `shouldRender` stays true for the whole 120ms exit so the
              close can animate — which is exactly the window in which a
              descendant needs to have already torn its portaled overlays
              down. A consumer told "still visible" during the exit either
              leaves a menu stranded on `document.body`, or races the
              same-commit flip to hidden, where `<Activity>` defers effect
              cleanups and the teardown never runs at all. `open` is the
              intent, and it changes one frame earlier than the presence. */}
          <FixedDropdownVisibleContext.Provider value={open}>
            {inner}
          </FixedDropdownVisibleContext.Provider>
        </Activity>
      ) : (
        inner
      )}
    </div>,
    document.body
  );
}
