import React, { useState, useLayoutEffect, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useAnimatedPresence } from "@/hooks/useAnimatedPresence";
import {
  UI_ENTER_DURATION,
  UI_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";
import { useUIStore } from "@/store/uiStore";

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
    animationDuration: UI_EXIT_DURATION,
  });
  const overlayCount = useUIStore((state) => state.overlayCount);
  const prevOverlayCountRef = useRef<number>(overlayCount);

  useEffect(() => setMounted(true), []);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || typeof window === "undefined") return;
    const rect = anchorRef.current.getBoundingClientRect();
    const buttonRightGap = Math.max(window.innerWidth - rect.right, 8);
    setPosition({
      top: rect.bottom + sideOffset,
      right: `max(${buttonRightGap}px, calc(var(--sidecar-right-offset, 0px) + 8px))`,
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

  useEffect(() => {
    if (!open) return;
    const childOverlayActive = persistThroughChildOverlays && overlayCount > 0;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (childOverlayActive) return;
      const target = event.target as Node | null;
      if (contentRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (childOverlayActive) return;
      if (event.key === "Escape") onOpenChange(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onOpenChange, anchorRef, persistThroughChildOverlays, overlayCount]);

  useEffect(() => {
    if (
      !persistThroughChildOverlays &&
      open &&
      overlayCount > prevOverlayCountRef.current &&
      overlayCount > 0
    ) {
      onOpenChange(false);
    }
    prevOverlayCountRef.current = overlayCount;
  }, [open, overlayCount, onOpenChange, persistThroughChildOverlays]);

  if (!shouldRender || !mounted || !position) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-popover)] pointer-events-none">
      <div
        ref={contentRef}
        className={cn(
          "absolute pointer-events-auto overflow-hidden rounded-[var(--radius-lg)] surface-overlay shadow-overlay text-canopy-text",
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
