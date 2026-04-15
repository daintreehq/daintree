import React, { useState, useLayoutEffect, useEffect, useCallback, useRef } from "react";
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

interface FixedDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  sideOffset?: number;
  persistThroughChildOverlays?: boolean;
}

export function FixedDropdown({
  open,
  onOpenChange,
  anchorRef,
  children,
  className,
  sideOffset = 8,
  persistThroughChildOverlays = false,
}: FixedDropdownProps) {
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { isVisible, shouldRender } = useAnimatedPresence({
    isOpen: open,
    animationDuration: getUiTransitionDuration("exit"),
  });
  const overlayCount = useUIStore((state) => state.overlayCount);
  const [overlayGraceActive, setOverlayGraceActive] = useState(false);
  const baselineOverlayCountRef = useRef<number>(0);
  // Carry the latest overlay count into the grace-setup effect without
  // adding it as a reactive dependency — re-running on every count change
  // would wrongly reset the grace window on each in-flight rise.
  const latestOverlayCountRef = useRef<number>(overlayCount);
  latestOverlayCountRef.current = overlayCount;

  useEffect(() => {
    if (!open) {
      setOverlayGraceActive(false);
      baselineOverlayCountRef.current = 0;
      return;
    }
    setOverlayGraceActive(true);
    baselineOverlayCountRef.current = latestOverlayCountRef.current;
    const handle = setTimeout(() => {
      setOverlayGraceActive(false);
    }, OVERLAY_RACE_GRACE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [open]);

  useEffect(() => setMounted(true), []);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || typeof window === "undefined") return;
    const rect = anchorRef.current.getBoundingClientRect();
    const buttonRightGap = Math.max(window.innerWidth - rect.right, 8);
    setPosition({
      top: rect.bottom + sideOffset,
      right: `max(${buttonRightGap}px, calc(var(--portal-right-offset, 0px) + 8px))`,
    });
  }, [anchorRef, sideOffset]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const childOverlayActive = persistThroughChildOverlays && overlayCount > 0;
  useEscapeStack(open && !childOverlayActive, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (persistThroughChildOverlays && overlayCount > 0) return;
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
  }, [open, onOpenChange, anchorRef, persistThroughChildOverlays, overlayCount]);

  useEffect(() => {
    if (persistThroughChildOverlays || !open) return;
    if (overlayGraceActive) {
      // During the grace window, absorb any overlay rises as "already in
      // flight when the dropdown opened." This keeps the baseline tracking
      // the current count so rises after grace are measured against the
      // settled baseline.
      baselineOverlayCountRef.current = overlayCount;
      return;
    }
    // Decay the baseline when the overlay count drops — e.g. the in-flight
    // modal that was absorbed during grace has since closed. Without this,
    // a subsequent user-initiated modal at the same numeric level would
    // fail to dismiss the dropdown.
    if (overlayCount < baselineOverlayCountRef.current) {
      baselineOverlayCountRef.current = overlayCount;
      return;
    }
    if (overlayCount > baselineOverlayCountRef.current) {
      onOpenChange(false);
    }
  }, [open, overlayCount, onOpenChange, persistThroughChildOverlays, overlayGraceActive]);

  if (!shouldRender || !mounted || !position) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-popover)] pointer-events-none">
      <div
        ref={contentRef}
        className={cn(
          "absolute pointer-events-auto overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-daintree-text",
          "transition-[opacity,transform]",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 -translate-y-0.5 scale-[0.99]",
          className
        )}
        style={{
          top: position.top,
          right: position.right,
          transitionDuration: isVisible ? `${UI_ENTER_DURATION}ms` : `${UI_EXIT_DURATION}ms`,
          transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
