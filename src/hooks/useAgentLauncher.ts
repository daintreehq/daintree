import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalStore, type AddTerminalOptions } from "@/store/terminalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktrees } from "./useWorktrees";
import { isElectronAvailable } from "./useElectron";
import { cliAvailabilityClient, agentSettingsClient } from "@/clients";
import type { AgentSettings, CliAvailability } from "@shared/types";
import { generateAgentFlags } from "@shared/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";
import { getAgentIds } from "@/config/agents";

function isWindows(): boolean {
  return navigator.platform.toLowerCase().startsWith("win");
}

function escapeShellArg(arg: string): string {
  if (isWindows()) {
    return `"${arg.replace(/"/g, '""')}"`;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function buildAgentCommand(
  baseCommand: string,
  agentId: string,
  prompt?: string,
  interactive: boolean = true,
  flags: string[] = []
): string {
  const parts: string[] = [baseCommand];

  if (flags.length > 0) {
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];
      if (flag.startsWith("-")) {
        parts.push(flag);
      } else {
        parts.push(escapeShellArg(flag));
      }
    }
  }

  if (prompt && prompt.trim()) {
    const escapedPrompt = escapeShellArg(prompt);

    switch (agentId) {
      case "claude":
        if (!interactive) {
          parts.push("-p");
        }
        parts.push(escapedPrompt);
        break;

      case "gemini":
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push(escapedPrompt);
        }
        break;

      case "codex":
        if (!interactive) {
          parts.push("exec");
        }
        parts.push(escapedPrompt);
        break;

      default:
        parts.push(escapedPrompt);
    }
  }

  return parts.join(" ");
}

export interface LaunchAgentOptions {
  location?: AddTerminalOptions["location"];
  cwd?: string;
  worktreeId?: string;
  prompt?: string;
  interactive?: boolean;
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
  const { worktreeMap, activeId } = useWorktrees();
  const currentProject = useProjectStore((state) => state.currentProject);

  const [availability, setAvailability] = useState<CliAvailability>(
    Object.fromEntries(getAgentIds().map((id) => [id, false]))
  );
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(true);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);

  const isMounted = useRef(true);

  const checkAvailabilityAndLoadSettings = useCallback(async () => {
    if (!isElectronAvailable()) {
      setIsCheckingAvailability(false);
      return;
    }

    if (isMounted.current) {
      setIsCheckingAvailability(true);
    }

    try {
      const [cliAvailability, settings] = await Promise.all([
        cliAvailabilityClient.refresh(),
        agentSettingsClient.get(),
      ]);

      if (isMounted.current) {
        setAvailability(cliAvailability);
        setAgentSettings(settings);
      }
    } catch (error) {
      console.error("Failed to check CLI availability or load settings:", error);
    } finally {
      if (isMounted.current) {
        setIsCheckingAvailability(false);
      }
    }
  }, []);

  useEffect(() => {
    isMounted.current = true;
    checkAvailabilityAndLoadSettings();

    return () => {
      isMounted.current = false;
    };
  }, [checkAvailabilityAndLoadSettings]);

  const launchAgent = useCallback(
    async (agentId: string, launchOptions?: LaunchAgentOptions): Promise<string | null> => {
      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return null;
      }

      // Get agent config from registry, fall back for "terminal" type
      const agentConfig = getAgentConfig(agentId);
      const isAgent = isRegisteredAgent(agentId);

      const targetWorktreeId = launchOptions?.worktreeId ?? activeId;
      const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;

      if (launchOptions?.worktreeId && !targetWorktree) {
        console.warn(`Worktree ${launchOptions.worktreeId} not found, cannot launch agent`);
        return null;
      }

      const cwd = launchOptions?.cwd ?? targetWorktree?.path ?? currentProject?.path ?? "";

      let command: string | undefined;
      if (agentConfig) {
        const entry = agentSettings?.agents?.[agentId] ?? {};
        const flags = generateAgentFlags(entry, agentId);
        command = buildAgentCommand(
          agentConfig.command,
          agentId,
          launchOptions?.prompt,
          launchOptions?.interactive ?? true,
          flags
        );
      }

      const options: AddTerminalOptions = {
        kind: isAgent ? "agent" : "terminal",
        type: isAgent ? (agentId as any) : "terminal",
        agentId: isAgent ? agentId : undefined,
        title: agentConfig?.name ?? "Terminal",
        cwd,
        worktreeId: targetWorktreeId || undefined,
        command,
        location: launchOptions?.location,
      };

      try {
        const terminalId = await addTerminal(options);
        return terminalId;
      } catch (error) {
        console.error(`Failed to launch ${agentId} agent:`, error);
        return null;
      }
    },
    [activeId, worktreeMap, addTerminal, currentProject, agentSettings]
  );

  return {
    launchAgent,
    availability,
    isCheckingAvailability,
    agentSettings,
    refreshSettings: checkAvailabilityAndLoadSettings,
  };
}
