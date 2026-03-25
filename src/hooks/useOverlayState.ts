import { useEffect } from "react";
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

  useEffect(() => {
    if (!isOpen) return;
    pushOverlay();
    return () => {
      popOverlay();
    };
  }, [isOpen, pushOverlay, popOverlay]);
}
