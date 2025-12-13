import React, { useState, useLayoutEffect, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { getUiAnimationDuration } from "@/lib/animationUtils";

interface FixedDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  sideOffset?: number;
}

export function FixedDropdown({
  open,
  onOpenChange,
  anchorRef,
  children,
  className,
  sideOffset = 8,
}: FixedDropdownProps) {
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [shouldRender, setShouldRender] = useState(false);
  const closeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (open) {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      setShouldRender(true);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        setIsVisible(true);
      });
    } else {
      setIsVisible(false);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const duration = getUiAnimationDuration();
      if (duration === 0) {
        setShouldRender(false);
      } else {
        closeTimeoutRef.current = setTimeout(() => {
          closeTimeoutRef.current = null;
          setShouldRender(false);
        }, duration);
      }
    }

    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [open]);

  const updatePosition = useCallback(() => {
    if (!anchorRef.current || typeof window === "undefined") return;
    const rect = anchorRef.current.getBoundingClientRect();
    // Distance from button's right edge to viewport's right edge
    const buttonRightGap = Math.max(window.innerWidth - rect.right, 8);
    // Position dropdown so its right edge aligns with button's right edge,
    // BUT stays clear of the sidecar (using CSS max for reactivity)
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
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (contentRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
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
  }, [open, onOpenChange, anchorRef]);

  if (!shouldRender || !mounted || !position) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-popover)] pointer-events-none">
      <div
        ref={contentRef}
        className={cn(
          "absolute pointer-events-auto overflow-hidden rounded-[var(--radius-lg)] border border-canopy-border bg-canopy-sidebar text-canopy-text shadow-lg",
          "transition-all duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:transform-none",
          isVisible
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 -translate-y-1 scale-[0.98]",
          className
        )}
        style={{ top: position.top, right: position.right }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
