import { useShallow } from "zustand/react/shallow";
import { usePanelStore, useWorktreeSelectionStore, useDockStore } from "@/store";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDemandTerminalCount } from "@/hooks/useTerminalSelectors";
import { isRuntimeAgentTerminal } from "@/utils/terminalType";
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

  // A count, not the panels: this hook only needs "is anything docked", and a
  // raw `PanelInstance` list would re-render the consumer on every status flush
  // of a streaming docked agent (#17053).
  const dockedCount = usePanelStore((state) => {
    let count = 0;
    for (const id of state.panelIds) {
      const t = state.panelsById[id];
      if (
        t &&
        t.location === "dock" &&
        !state.trashedTerminals.has(t.id) &&
        // Show terminals that match active worktree OR have no worktree (global terminals)
        (t.worktreeId == null || t.worktreeId === activeWorktreeId)
      ) {
        count += 1;
      }
    }
    return count;
  });

  const trashedCount = usePanelStore((state) => state.trashedTerminals.size);

  // The agents behind the Waiting and Unread pills, so a dock holding only an
  // unread hand-back still announces itself as a landmark.
  const demandCount = useDemandTerminalCount();

  const hybridInputEnabled = useTerminalInputStore((state) => state.hybridInputEnabled);

  const shouldFadeForInput = usePanelStore(
    useShallow((state) => {
      if (!hybridInputEnabled) return false;
      const focusedTerminal = state.focusedId ? state.panelsById[state.focusedId] : undefined;
      if (!focusedTerminal) return false;
      return isRuntimeAgentTerminal(focusedTerminal);
    })
  );

  const hasDocked = dockedCount > 0;
  const hasStatus = demandCount > 0 || trashedCount > 0;

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
    trashedCount,
    shouldFadeForInput,
  };
}
