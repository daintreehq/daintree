import { useCallback, useEffect, useRef, useState } from "react";
import type { StagingStatus } from "@shared/types";
import type { FileStageRowSection } from "./FileStageRow";

/**
 * The multi-row selection: one section at a time, with the shift-click anchor.
 * Pruned against every status so a path that left its section never lingers
 * in the selection or anchors the next range.
 */
export function useReviewHubRowSelection(status: StagingStatus | null) {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectionSection, setSelectionSection] = useState<FileStageRowSection | null>(null);
  const selectionAnchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!status || !selectionSection) return;
    const sectionFiles = selectionSection === "staged" ? status.staged : status.unstaged;
    const validPaths = new Set(sectionFiles.map((f) => f.path));
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      let mutated = false;
      const next = new Set<string>();
      for (const p of prev) {
        if (validPaths.has(p)) next.add(p);
        else mutated = true;
      }
      if (!mutated) return prev;
      if (next.size === 0) {
        setSelectionSection(null);
        selectionAnchorRef.current = null;
      } else if (
        selectionAnchorRef.current !== null &&
        !validPaths.has(selectionAnchorRef.current)
      ) {
        // Anchor evicted but selection survives — reseat anchor on a remaining
        // path so the next shift-click extends from it rather than falling
        // through to plain-click (which would wipe the selection).
        selectionAnchorRef.current = next.values().next().value ?? null;
      }
      return next;
    });
  }, [status, selectionSection]);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionSection(null);
    selectionAnchorRef.current = null;
  }, []);

  return {
    selectedPaths,
    clearSelection,
    setSelectedPaths,
    selectionSection,
    setSelectionSection,
    selectionAnchorRef,
  };
}
