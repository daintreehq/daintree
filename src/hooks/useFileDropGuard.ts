import { useEffect } from "react";
import { hasFileDrag } from "@/lib/fileDragPayload";

/**
 * Prevents browser-default file navigation when files are dropped on
 * non-terminal areas. Uses bubble phase so components that call
 * stopPropagation (terminal, HybridInputBar) handle their own drops.
 * Skips events already handled by a child (defaultPrevented check).
 *
 * Covers in-app file drags (#11576) on the same terms as OS ones. That is what
 * makes an invalid target say so: with no handler claiming the drag, Chromium
 * has no reason to show anything but the copy cursor, and the drop would read
 * as accepted right up until nothing happened.
 */
export function useFileDropGuard() {
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!e.dataTransfer || !hasFileDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };

    const handleDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!e.dataTransfer || !hasFileDrag(e.dataTransfer.types)) return;
      e.preventDefault();
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, []);
}
