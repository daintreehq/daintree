import { useMemo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useIsDragging } from "@/components/DragDrop";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import type { DockRenderState, DockMode } from "@shared/types";

/**
 * Centralized hook for dock render state.
 * All dock-related components should use this hook instead of computing derived state independently.
 * This prevents desync between components that could cause dual-state rendering issues.
 */
export function useDockRenderState(): DockRenderState & {
  setPeek: (peek: boolean) => void;
  hasDocked: boolean;
  dockedCount: number;
  hasStatus: boolean;
  waitingCount: number;
  failedCount: number;
  trashedCount: number;
} {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const isDragging = useIsDragging();

  const { mode, behavior, autoHideWhenEmpty, peek, isHydrated, setPeek } = useDockStore(
    useShallow((state) => ({
      mode: state.mode,
      behavior: state.behavior,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
      peek: state.peek,
      isHydrated: state.isHydrated,
      setPeek: state.setPeek,
    }))
  );

  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" && (t.worktreeId ?? undefined) === (activeWorktreeId ?? undefined)
      )
    )
  );

  const trashedCount = useTerminalStore(useShallow((state) => state.trashedTerminals.size));

  const { waitingCount, failedCount } = useTerminalNotificationCounts();

  const hasDocked = dockTerminals.length > 0;
  const dockedCount = dockTerminals.length;
  const hasStatus = waitingCount > 0 || failedCount > 0 || trashedCount > 0;
  const hasContent = hasDocked || hasStatus;

  // Compute effective mode based on behavior setting
  // CRITICAL: This is the single source of truth for effectiveMode
  const effectiveMode: DockMode = useMemo(() => {
    // Before hydration, use "hidden" to match shouldShowInLayout=false
    // This prevents clicks from persisting wrong state before preferences load
    if (!isHydrated) return "hidden";

    if (behavior === "auto") {
      // Auto mode: hidden by default, expanded when there are docked terminals
      return hasDocked ? "expanded" : "hidden";
    }
    // Manual mode: use the stored mode
    return mode === "slim" ? "hidden" : mode;
  }, [isHydrated, behavior, mode, hasDocked]);

  // Determine if we should show dock in layout (takes up space)
  // CRITICAL: This is the single source of truth for layout visibility
  const shouldShowInLayout = useMemo(() => {
    // Before hydration, don't show layout to prevent flash of incorrect state
    if (!isHydrated) return false;

    // Peek mode during drag always shows
    if (peek || isDragging) return true;

    // Hidden mode never shows in layout
    if (effectiveMode === "hidden") return false;

    // Expanded mode shows unless auto-hide is on and empty
    if (autoHideWhenEmpty && !hasContent) return false;

    return true;
  }, [isHydrated, effectiveMode, autoHideWhenEmpty, hasContent, peek, isDragging]);

  // Set peek when dragging starts
  useEffect(() => {
    if (isDragging && effectiveMode === "hidden" && !peek) {
      setPeek(true);
    }
    if (!isDragging && peek) {
      setPeek(false);
    }
  }, [isDragging, effectiveMode, peek, setPeek]);

  // Compute density for ContentDock
  const density: DockRenderState["density"] = "normal";

  // Show status overlay when dock is hidden and there are status indicators
  // CRITICAL: Must be mutually exclusive with shouldShowInLayout
  const showStatusOverlay =
    isHydrated && effectiveMode === "hidden" && hasStatus && !shouldShowInLayout;

  // Whether the dock handle should indicate visible/hidden state
  const isHandleVisible = effectiveMode === "expanded";

  return {
    effectiveMode,
    shouldShowInLayout,
    showStatusOverlay,
    density,
    isHandleVisible,
    isHydrated,
    setPeek,
    hasDocked,
    dockedCount,
    hasStatus,
    waitingCount,
    failedCount,
    trashedCount,
  };
}
