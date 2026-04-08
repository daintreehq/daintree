import { useShallow } from "zustand/react/shallow";
import { usePanelStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useTerminalNotificationCounts } from "@/hooks/useTerminalSelectors";
import { isAgentTerminal } from "@/utils/terminalType";
import type { DockRenderState } from "@shared/types";

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
  trashedCount: number;
  shouldFadeForInput: boolean;
} {
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);

  const { isHydrated, setPeek } = useDockStore(
    useShallow((state) => ({
      isHydrated: state.isHydrated,
      setPeek: state.setPeek,
    }))
  );

  const dockTerminals = usePanelStore(
    useShallow((state) =>
      state.panelIds
        .map((id) => state.panelsById[id])
        .filter(
          (t) =>
            t &&
            t.location === "dock" &&
            // Show terminals that match active worktree OR have no worktree (global terminals)
            (t.worktreeId == null || t.worktreeId === activeWorktreeId)
        )
    )
  );

  const trashedCount = usePanelStore(useShallow((state) => state.trashedTerminals.size));

  const { waitingCount } = useTerminalNotificationCounts();

  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);

  const shouldFadeForInput = usePanelStore(
    useShallow((state) => {
      if (!hybridInputEnabled) return false;
      const focusedTerminal = state.focusedId ? state.panelsById[state.focusedId] : undefined;
      if (!focusedTerminal) return false;
      return isAgentTerminal(focusedTerminal.kind ?? focusedTerminal.type, focusedTerminal.agentId);
    })
  );

  const hasDocked = dockTerminals.length > 0;
  const dockedCount = dockTerminals.length;
  const hasStatus = waitingCount > 0 || trashedCount > 0;

  // Dock is always visible now - no hidden mode
  const shouldShowInLayout = isHydrated;

  return {
    effectiveMode: "expanded",
    shouldShowInLayout,
    density: "normal",
    isHydrated,
    setPeek,
    hasDocked,
    dockedCount,
    hasStatus,
    waitingCount,
    trashedCount,
    shouldFadeForInput,
  };
}
