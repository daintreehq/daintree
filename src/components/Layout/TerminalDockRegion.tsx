import { useMemo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useIsDragging } from "@/components/DragDrop";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ContentDock } from "./ContentDock";
import { DockHandleOverlay } from "./DockHandleOverlay";
import { DockStatusOverlay } from "./DockStatusOverlay";

export function TerminalDockRegion() {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const isDragging = useIsDragging();

  const { mode, autoHideWhenEmpty, peek, setPeek } = useDockStore(
    useShallow((state) => ({
      mode: state.mode,
      autoHideWhenEmpty: state.autoHideWhenEmpty,
      peek: state.peek,
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
  const hasStatus = waitingCount > 0 || failedCount > 0 || trashedCount > 0;
  const hasContent = hasDocked || hasStatus;

  // Determine if we should show dock in layout (takes up space)
  const shouldShowInLayout = useMemo(() => {
    // Peek mode during drag always shows
    if (peek || isDragging) return true;

    // Hidden mode never shows in layout
    if (mode === "hidden") return false;

    // Expanded/slim modes show unless auto-hide is on and empty
    if (autoHideWhenEmpty && !hasContent) return false;

    return true;
  }, [mode, autoHideWhenEmpty, hasContent, peek, isDragging]);

  // Set peek when dragging starts
  useEffect(() => {
    if (isDragging && mode === "hidden") {
      setPeek(true);
    }
    if (!isDragging && peek) {
      setPeek(false);
    }
  }, [isDragging, mode, peek, setPeek]);

  // Compute density for ContentDock
  const density = mode === "slim" ? "compact" : "normal";

  // Show status overlay when dock is hidden/slim and there are status indicators
  const showStatusOverlay =
    (mode === "hidden" || mode === "slim") && hasStatus && !shouldShowInLayout;

  return (
    <>
      {/* ContentDock in layout when visible */}
      {shouldShowInLayout && (
        <ErrorBoundary variant="section" componentName="ContentDock">
          <ContentDock density={density} />
        </ErrorBoundary>
      )}

      {/* Handle overlay is always visible at bottom edge for discoverability */}
      <DockHandleOverlay />

      {/* Status overlay when dock is hidden but has status counts */}
      {showStatusOverlay && (
        <DockStatusOverlay
          waitingCount={waitingCount}
          failedCount={failedCount}
          trashedCount={trashedCount}
        />
      )}
    </>
  );
}
