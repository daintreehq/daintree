import { useEffect, useRef } from "react";
import { useUIStore } from "@/store/uiStore";

/**
 * Hook for modal/overlay components to register their open state.
 * When an overlay is open, the portal will be hidden.
 *
 * Usage:
 * ```tsx
 * function YourModal({ isOpen, onClose }: ModalProps) {
 *   useOverlayState(isOpen);
 *   return <Dialog open={isOpen}>...</Dialog>;
 * }
 * ```
 */
export function useOverlayState(isOpen: boolean): void {
  const pushOverlay = useUIStore((state) => state.pushOverlay);
  const popOverlay = useUIStore((state) => state.popOverlay);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      pushOverlay();
      wasOpenRef.current = true;
    } else if (!isOpen && wasOpenRef.current) {
      popOverlay();
      wasOpenRef.current = false;
    }
  }, [isOpen, pushOverlay, popOverlay]);

  // Cleanup on unmount if still open
  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        popOverlay();
      }
    };
  }, [popOverlay]);
}
