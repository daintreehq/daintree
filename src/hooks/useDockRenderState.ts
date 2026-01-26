import { useMemo, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useIsDragging } from "@/components/DragDrop";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import { isAgentTerminal } from "@/utils/terminalType";
import type { DockRenderState, DockMode } from "@shared/types";

const DEBUG_DOCK = false;
function dockStateLog(message: string, ...args: unknown[]) {
  if (DEBUG_DOCK) {
    console.log(`[DockRenderState] ${message}`, ...args);
  }
}

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
  shouldFadeForInput: boolean;
  compactMinimal: boolean;
} {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const isDragging = useIsDragging();

  const { mode, behavior, autoHideWhenEmpty, compactMinimal, peek, isHydrated, setPeek } =
    useDockStore(
      useShallow((state) => ({
        mode: state.mode,
        behavior: state.behavior,
        autoHideWhenEmpty: state.autoHideWhenEmpty,
        compactMinimal: state.compactMinimal,
        peek: state.peek,
        isHydrated: state.isHydrated,
        setPeek: state.setPeek,
      }))
    );

  const allTerminals = useTerminalStore((state) => state.terminals);
  const dockTerminals = useTerminalStore(
    useShallow((state) =>
      state.terminals.filter(
        (t) =>
          t.location === "dock" &&
          // Show terminals that match active worktree OR have no worktree (global terminals)
          (t.worktreeId == null || t.worktreeId === activeWorktreeId)
      )
    )
  );

  // Log terminal state for debugging
  useEffect(() => {
    dockStateLog("Terminal store state:", {
      totalTerminals: allTerminals.length,
      allLocations: allTerminals.map((t) => ({ id: t.id, location: t.location, kind: t.kind })),
      dockTerminalCount: dockTerminals.length,
      dockTerminals: dockTerminals.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
      activeWorktreeId,
      dockStoreHydrated: isHydrated,
      mode,
      behavior,
    });
  }, [allTerminals, dockTerminals, activeWorktreeId, isHydrated, mode, behavior]);

  const trashedCount = useTerminalStore(useShallow((state) => state.trashedTerminals.size));

  const { waitingCount, failedCount } = useTerminalNotificationCounts();

  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);

  const shouldFadeForInput = useTerminalStore(
    useShallow((state) => {
      if (!hybridInputEnabled) return false;
      const focusedTerminal = state.terminals.find((t) => t.id === state.focusedId);
      if (!focusedTerminal) return false;
      return isAgentTerminal(focusedTerminal.kind ?? focusedTerminal.type, focusedTerminal.agentId);
    })
  );

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
    // Manual mode: use the stored mode (slim is legacy, maps to hidden)
    if (mode === "slim") return "hidden";
    return mode;
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

    // Compact and expanded modes take up layout space
    // For expanded mode, auto-hide when empty can hide it
    if (effectiveMode === "compact") return true;

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

  // Compute density for ContentDock - compact mode uses compact density
  const density: DockRenderState["density"] = effectiveMode === "compact" ? "compact" : "normal";

  // Show color strip when dock is hidden and there are status indicators or docked panels
  // This replaces the old floating status overlay with a minimal 6px color bar
  const showColorStrip =
    isHydrated && effectiveMode === "hidden" && (hasStatus || hasDocked) && !shouldShowInLayout;

  // Whether the dock handle should indicate visible/hidden state
  // Both expanded and compact modes are "visible" states
  const isHandleVisible = effectiveMode === "expanded" || effectiveMode === "compact";

  return {
    effectiveMode,
    shouldShowInLayout,
    showColorStrip,
    density,
    isHandleVisible,
    isHydrated,
    compactMinimal,
    setPeek,
    hasDocked,
    dockedCount,
    hasStatus,
    waitingCount,
    failedCount,
    trashedCount,
    shouldFadeForInput,
  };
}
