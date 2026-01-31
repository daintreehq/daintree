import { useEffect, useRef } from "react";
import { useAssistantChatStore } from "@/store/assistantChatStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import { useTerminalStore } from "@/store/terminalStore";
import { getAssistantContext } from "@/components/Assistant/assistantContext";

/**
 * Syncs assistant context whenever relevant stores change.
 * Debounces rapid changes (e.g., multiple worktree switches) to avoid spam.
 */
export function useAssistantContextSync() {
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const updateContext = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        const context = getAssistantContext();
        useAssistantChatStore.getState().setCurrentContext(context);
      }, 200);
    };

    // Subscribe to relevant stores
    const unsubProject = useProjectStore.subscribe(() => updateContext());
    const unsubWorktreeSelection = useWorktreeSelectionStore.subscribe(() => updateContext());
    const unsubWorktreeData = useWorktreeDataStore.subscribe(() => updateContext());
    const unsubTerminal = useTerminalStore.subscribe((state, prevState) => {
      // Update if focused terminal ID changed
      if (state.focusedId !== prevState.focusedId) {
        updateContext();
        return;
      }

      // Update if focused terminal's metadata changed (title, kind, type)
      if (state.focusedId) {
        const currentTerminal = state.terminals.find((t) => t.id === state.focusedId);
        const prevTerminal = prevState.terminals.find((t) => t.id === state.focusedId);
        if (
          currentTerminal &&
          prevTerminal &&
          (currentTerminal.title !== prevTerminal.title ||
            currentTerminal.kind !== prevTerminal.kind ||
            currentTerminal.type !== prevTerminal.type)
        ) {
          updateContext();
        }
      }
    });

    // Initialize context on mount
    updateContext();

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      unsubProject();
      unsubWorktreeSelection();
      unsubWorktreeData();
      unsubTerminal();
    };
  }, []);
}
