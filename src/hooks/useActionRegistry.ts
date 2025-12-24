import { useEffect, useRef } from "react";
import { actionService } from "@/services/ActionService";
import {
  createActionDefinitions,
  type ActionCallbacks,
} from "@/services/actions/actionDefinitions";

export type { ActionCallbacks };

export function useActionRegistry(options: ActionCallbacks): void {
  const registeredRef = useRef(false);

  useEffect(() => {
    if (registeredRef.current) return;

    const actionFactories = createActionDefinitions(options);

    for (const createAction of actionFactories.values()) {
      const action = createAction();
      actionService.register(action);
    }

    registeredRef.current = true;
  }, [
    options.onOpenSettings,
    options.onOpenSettingsTab,
    options.onToggleSidebar,
    options.onToggleFocusMode,
    options.onOpenAgentPalette,
    options.onOpenWorktreePalette,
    options.onOpenNewTerminalPalette,
    options.onOpenShortcuts,
    options.onLaunchAgent,
    options.onInject,
    options.onOpenTerminalInfo,
    options.onRenameTerminal,
    options.getDefaultCwd,
    options.getActiveWorktreeId,
    options.getWorktrees,
    options.getFocusedId,
    options.getGridNavigation,
  ]);
}
