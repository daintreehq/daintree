import { useEffect, useRef } from "react";
import { actionService } from "@/services/ActionService";
import { createActionDefinitions } from "@/services/actions/actionDefinitions";

export interface UseActionRegistryOptions {
  onOpenSettings: () => void;
  onOpenSettingsTab: (tab: string) => void;
  onToggleSidebar: () => void;
  onOpenAgentPalette: () => void;
  onLaunchAgent: (
    agentId: string,
    options?: { cwd?: string; worktreeId?: string }
  ) => Promise<void>;
  getDefaultCwd: () => string;
  getActiveWorktreeId: () => string | undefined;
}

export function useActionRegistry(options: UseActionRegistryOptions): void {
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
    options.onOpenAgentPalette,
    options.onLaunchAgent,
    options.getDefaultCwd,
    options.getActiveWorktreeId,
  ]);
}
