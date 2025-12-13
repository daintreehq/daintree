import React, { useState, useLayoutEffect, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

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

  useEffect(() => setMounted(true), []);

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

  if (!open || !mounted || !position) return null;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-popover)] pointer-events-none">
      <div
        ref={contentRef}
        className={cn(
          "absolute pointer-events-auto overflow-hidden rounded-[var(--radius-lg)] border border-canopy-border bg-canopy-sidebar text-canopy-text shadow-lg",
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
