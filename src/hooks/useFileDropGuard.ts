import { useEffect } from "react";

/**
 * Prevents browser-default file navigation when files are dropped on
 * non-terminal areas. Uses bubble phase so components that call
 * stopPropagation (terminal, HybridInputBar) handle their own drops.
 * Skips events already handled by a child (defaultPrevented check).
 */
export function useFileDropGuard() {
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "none";
    };

    const handleDrop = (e: DragEvent) => {
      if (e.defaultPrevented) return;
      if (!e.dataTransfer?.types.includes("Files")) return;
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
