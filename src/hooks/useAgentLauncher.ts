import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalStore, type AddTerminalOptions } from "@/store/terminalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { useWorktrees } from "./useWorktrees";
import { isElectronAvailable } from "./useElectron";

import { agentSettingsClient, systemClient } from "@/clients";
import type { AgentSettings, CliAvailability } from "@shared/types";
import { generateAgentCommand, buildAgentLaunchFlags } from "@shared/types";
import { getAgentConfig, isRegisteredAgent, getAgentDisplayTitle } from "@/config/agents";

const CLIPBOARD_DIR_NAME = "canopy-clipboard";

export interface LaunchAgentOptions {
  location?: AddTerminalOptions["location"];
  cwd?: string;
  worktreeId?: string;
  prompt?: string;
  interactive?: boolean;
  modelId?: string;
}

export interface UseAgentLauncherReturn {
  launchAgent: (agentId: string, options?: LaunchAgentOptions) => Promise<string | null>;
  availability: CliAvailability;
  isCheckingAvailability: boolean;
  agentSettings: AgentSettings | null;
  refreshSettings: () => Promise<void>;
}

export function useAgentLauncher(): UseAgentLauncherReturn {
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const { worktreeMap } = useWorktrees();
  const activeWorktreeId = useWorktreeSelectionStore((state) => state.activeWorktreeId);
  const currentProject = useProjectStore((state) => state.currentProject);
  const availability = useCliAvailabilityStore((state) => state.availability);
  const isLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshing = useCliAvailabilityStore((state) => state.isRefreshing);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);

  const isMounted = useRef(true);

  const checkAvailabilityAndLoadSettings = useCallback(async () => {
    if (!isElectronAvailable()) {
      return;
    }

    const [, settingsResult] = await Promise.allSettled([
      refreshCliAvailability(),
      agentSettingsClient.get(),
    ]);

    if (isMounted.current && settingsResult.status === "fulfilled") {
      setAgentSettings(settingsResult.value);
    }
  }, [refreshCliAvailability]);

  useEffect(() => {
    isMounted.current = true;
    void initializeCliAvailability();
    agentSettingsClient
      .get()
      .then((settings) => {
        if (isMounted.current) setAgentSettings(settings);
      })
      .catch((error) => {
        console.error("Failed to load agent settings:", error);
      });

    return () => {
      isMounted.current = false;
    };
  }, [initializeCliAvailability]);

  const launchAgent = useCallback(
    async (agentId: string, launchOptions?: LaunchAgentOptions): Promise<string | null> => {
      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return null;
      }

      const targetWorktreeId = launchOptions?.worktreeId ?? activeWorktreeId;
      const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;

      if (targetWorktreeId && !targetWorktree) {
        console.warn(`Worktree ${targetWorktreeId} not found, cannot launch agent`);
        return null;
      }

      const cwd = launchOptions?.cwd ?? targetWorktree?.path ?? currentProject?.path ?? "";

      // Handle browser pane specially
      if (agentId === "browser") {
        try {
          const terminalId = await addTerminal({
            kind: "browser",
            cwd,
            worktreeId: targetWorktreeId || undefined,
            location: launchOptions?.location,
          });
          return terminalId;
        } catch (error) {
          console.error("Failed to launch browser pane:", error);
          return null;
        }
      }

      // Get agent config from registry, fall back for "terminal" type
      const agentConfig = getAgentConfig(agentId);
      const isAgent = isRegisteredAgent(agentId);

      let command: string | undefined;
      let launchFlags: string[] | undefined;
      if (agentConfig) {
        const entry = agentSettings?.agents?.[agentId] ?? {};

        // Resolve clipboard directory for agents that need it (e.g. Gemini)
        let clipboardDirectory: string | undefined;
        if (agentId === "gemini" && entry.shareClipboardDirectory !== false) {
          try {
            const tmpDir = await systemClient.getTmpDir();
            clipboardDirectory = `${tmpDir}/${CLIPBOARD_DIR_NAME}`;
          } catch {
            // Non-critical: Gemini will work without clipboard access
          }
        }

        command = generateAgentCommand(agentConfig.command, entry, agentId, {
          initialPrompt: launchOptions?.prompt,
          interactive: launchOptions?.interactive ?? true,
          clipboardDirectory,
          modelId: launchOptions?.modelId,
        });

        // Capture process-level flags for session resume persistence
        if (isAgent) {
          launchFlags = buildAgentLaunchFlags(entry, agentId, {
            modelId: launchOptions?.modelId,
          });
        }
      }

      const title =
        launchOptions?.modelId && isAgent
          ? getAgentDisplayTitle(agentId, launchOptions.modelId)
          : (agentConfig?.name ?? "Terminal");

      const options: AddTerminalOptions = {
        kind: isAgent ? "agent" : "terminal",
        type: isAgent ? (agentId as any) : "terminal",
        agentId: isAgent ? agentId : undefined,
        title,
        cwd,
        worktreeId: targetWorktreeId || undefined,
        command,
        location: launchOptions?.location,
        agentLaunchFlags: launchFlags,
        agentModelId: launchOptions?.modelId,
      };

      try {
        const terminalId = await addTerminal(options);
        return terminalId;
      } catch (error) {
        console.error(`Failed to launch ${agentId} agent:`, error);
        return null;
      }
    },
    [activeWorktreeId, worktreeMap, addTerminal, currentProject, agentSettings]
  );

  return {
    launchAgent,
    availability,
    isCheckingAvailability: isLoading || isRefreshing,
    agentSettings,
    refreshSettings: checkAvailabilityAndLoadSettings,
  };
}
