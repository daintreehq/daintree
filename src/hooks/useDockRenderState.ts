import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import { isAgentTerminal } from "@/utils/terminalType";
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
  shouldFadeForInput: boolean;
  compactMinimal: boolean;
} {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const { mode, behavior, compactMinimal, isHydrated, setPeek } = useDockStore(
    useShallow((state) => ({
      mode: state.mode,
      behavior: state.behavior,
      compactMinimal: state.compactMinimal,
      isHydrated: state.isHydrated,
      setPeek: state.setPeek,
    }))
  );

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

  // Compute effective mode based on behavior setting
  // CRITICAL: This is the single source of truth for effectiveMode
  const effectiveMode: DockMode = useMemo(() => {
    // Before hydration, use "compact" as a safe default
    if (!isHydrated) return "compact";

    if (behavior === "auto") {
      // Auto mode: compact by default, expanded when there are docked terminals
      return hasDocked ? "expanded" : "compact";
    }
    // Manual mode: use the stored mode
    return mode;
  }, [isHydrated, behavior, mode, hasDocked]);

  // Dock is always visible now - no hidden mode
  const shouldShowInLayout = isHydrated;

  // Compute density for ContentDock - compact mode uses compact density
  const density: DockRenderState["density"] = effectiveMode === "compact" ? "compact" : "normal";

  return {
    effectiveMode,
    shouldShowInLayout,
    density,
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
