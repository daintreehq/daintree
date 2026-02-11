import { useEffect, useRef } from "react";
import { actionService } from "@/services/ActionService";
import {
  createActionDefinitions,
  type ActionCallbacks,
} from "@/services/actions/actionDefinitions";

export type { ActionCallbacks };

/**
 * Registers action definitions with the ActionService.
 *
 * Uses a ref pattern to ensure callbacks always return fresh values,
 * avoiding stale closure issues where worktree/focus state could drift.
 */
export function useActionRegistry(options: ActionCallbacks): void {
  const registeredRef = useRef(false);
  const callbacksRef = useRef<ActionCallbacks>(options);

  // Always keep the ref updated with latest callbacks
  callbacksRef.current = options;

  useEffect(() => {
    if (registeredRef.current) return;

    // Create a proxy that reads from the ref, ensuring fresh values on every call
    const callbackProxy: ActionCallbacks = {
      onOpenSettings: () => callbacksRef.current.onOpenSettings(),
      onOpenSettingsTab: (tab) => callbacksRef.current.onOpenSettingsTab(tab),
      onToggleSidebar: () => callbacksRef.current.onToggleSidebar(),
      onToggleFocusMode: () => callbacksRef.current.onToggleFocusMode(),
      onOpenAgentPalette: () => callbacksRef.current.onOpenAgentPalette(),
      onOpenActionPalette: () => callbacksRef.current.onOpenActionPalette(),
      onOpenQuickSwitcher: () => callbacksRef.current.onOpenQuickSwitcher(),
      onOpenWorktreePalette: () => callbacksRef.current.onOpenWorktreePalette(),
      onToggleWorktreeOverview: () => callbacksRef.current.onToggleWorktreeOverview(),
      onOpenWorktreeOverview: () => callbacksRef.current.onOpenWorktreeOverview(),
      onCloseWorktreeOverview: () => callbacksRef.current.onCloseWorktreeOverview(),
      onOpenNewTerminalPalette: () => callbacksRef.current.onOpenNewTerminalPalette(),
      onOpenPanelPalette: () => callbacksRef.current.onOpenPanelPalette(),
      onOpenProjectSwitcherPalette: () => callbacksRef.current.onOpenProjectSwitcherPalette(),
      onOpenShortcuts: () => callbacksRef.current.onOpenShortcuts(),
      onLaunchAgent: (agentId, opts) => callbacksRef.current.onLaunchAgent(agentId, opts),
      onInject: (worktreeId) => callbacksRef.current.onInject(worktreeId),
      getDefaultCwd: () => callbacksRef.current.getDefaultCwd(),
      getActiveWorktreeId: () => callbacksRef.current.getActiveWorktreeId(),
      getWorktrees: () => callbacksRef.current.getWorktrees(),
      getFocusedId: () => callbacksRef.current.getFocusedId(),
      getGridNavigation: () => callbacksRef.current.getGridNavigation(),
    };

    const actionFactories = createActionDefinitions(callbackProxy);

    for (const createAction of actionFactories.values()) {
      const action = createAction();
      actionService.register(action);
    }

    registeredRef.current = true;
  }, []);
}
