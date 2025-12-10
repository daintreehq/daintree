import { useCallback, useEffect, useRef, useState } from "react";
import { useTerminalStore, type AddTerminalOptions } from "@/store/terminalStore";
import { useProjectStore } from "@/store/projectStore";
import { useWorktrees } from "./useWorktrees";
import { isElectronAvailable } from "./useElectron";
import { cliAvailabilityClient, agentSettingsClient } from "@/clients";
import type { AgentSettings, CliAvailability } from "@shared/types";
import { generateClaudeFlags, generateGeminiFlags, generateCodexFlags } from "@shared/types";

export type AgentType = "claude" | "gemini" | "codex" | "terminal";

/**
 * Detect if running on Windows using browser APIs.
 * Works in renderer process where Node's `process` global is unavailable.
 */
function isWindows(): boolean {
  return navigator.platform.toLowerCase().startsWith("win");
}

/**
 * Escape a string for safe use as a shell argument.
 * Platform-aware escaping for POSIX (macOS/Linux) and Windows.
 */
function escapeShellArg(arg: string): string {
  // On Windows, cmd.exe and PowerShell require different quoting
  if (isWindows()) {
    // Escape double quotes and wrap in double quotes for Windows
    // This works for both cmd.exe and PowerShell
    return `"${arg.replace(/"/g, '""')}"`;
  }

  // POSIX (macOS/Linux): Use single quotes and escape embedded single quotes
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the command string for an agent with an optional prompt.
 *
 * Command formats:
 * - Claude: `claude 'prompt'` (interactive) or `claude -p 'prompt'` (one-shot)
 * - Gemini: `gemini -i 'prompt'` (interactive) or `gemini 'prompt'` (one-shot)
 * - Codex: `codex 'prompt'` (interactive) or `codex exec 'prompt'` (one-shot)
 *
 * Note: Actual quote style depends on platform (single quotes on POSIX, double on Windows)
 */
function buildAgentCommand(
  baseCommand: string,
  agentType: AgentType,
  prompt?: string,
  interactive: boolean = true,
  flags: string[] = []
): string {
  const parts: string[] = [baseCommand];

  // Add settings-based flags
  // IMPORTANT: Flags from generateXxxFlags() may contain user-controlled values (systemPrompt, model, etc.)
  // We need to properly escape any flag arguments that might contain spaces or special characters
  if (flags.length > 0) {
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i];

      // If this is a flag name (starts with -), add it as-is
      if (flag.startsWith("-")) {
        parts.push(flag);
      } else {
        // This is a flag value - escape it for safety
        parts.push(escapeShellArg(flag));
      }
    }
  }

  // Add prompt-related flags and the prompt itself
  if (prompt && prompt.trim()) {
    const escapedPrompt = escapeShellArg(prompt);

    switch (agentType) {
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
        // For shell or unknown types, just append the prompt
        parts.push(escapedPrompt);
    }
  }

  return parts.join(" ");
}

interface AgentConfig {
  type: AgentType;
  title: string;
  command?: string;
}

const AGENT_CONFIGS: Record<AgentType, AgentConfig> = {
  claude: {
    type: "claude",
    title: "Claude",
    command: "claude",
  },
  gemini: {
    type: "gemini",
    title: "Gemini",
    command: "gemini",
  },
  codex: {
    type: "codex",
    title: "Codex",
    command: "codex",
  },
  terminal: {
    type: "terminal",
    title: "Terminal",
    command: undefined, // Plain shell, no command
  },
};

export interface LaunchAgentOptions {
  /** Override terminal location (default: "grid") */
  location?: AddTerminalOptions["location"];
  /** Override working directory */
  cwd?: string;
  /** Override worktree ID (derives cwd from worktree if provided) */
  worktreeId?: string;
  /**
   * Initial prompt to send to the agent.
   * The prompt will be properly escaped for shell safety - you don't need to escape it yourself.
   * Multi-line prompts and prompts containing special characters (&&, ;, etc.) are supported.
   */
  prompt?: string;
  /**
   * Whether to keep the session interactive after the prompt (default: true)
   * - Claude: true = `claude 'prompt'`, false = `claude -p 'prompt'`
   * - Gemini: true = `gemini -i 'prompt'`, false = `gemini 'prompt'`
   * - Codex: true = `codex 'prompt'`, false = `codex exec 'prompt'`
   *
   * Note: Quotes shown are for illustration - actual quoting is platform-specific.
   */
  interactive?: boolean;
}

export interface UseAgentLauncherReturn {
  /** Launch an agent terminal */
  launchAgent: (type: AgentType, options?: LaunchAgentOptions) => Promise<string | null>;
  /** CLI availability status */
  availability: CliAvailability;
  /** Whether availability check is in progress */
  isCheckingAvailability: boolean;
  /** Current agent settings (to check enabled status) */
  agentSettings: AgentSettings | null;
  /** Force refresh settings (e.g. after changing them) */
  refreshSettings: () => Promise<void>;
}

/**
 * Hook for launching AI agent terminals
 *
 * @example
 * ```tsx
 * function Toolbar() {
 *   const { launchAgent, availability } = useAgentLauncher()
 *
 *   // Launch an interactive agent session
 *   const handleLaunchClaude = () => launchAgent('claude')
 *
 *   // Launch with an initial prompt (interactive - stays open after response)
 *   const handleAskQuestion = () => launchAgent('claude', {
 *     prompt: 'Explain the authentication flow in this codebase',
 *     interactive: true, // default
 *   })
 *
 *   // Launch one-shot mode (exits after response)
 *   const handleQuickQuery = () => launchAgent('claude', {
 *     prompt: 'What is 2 + 2?',
 *     interactive: false,
 *   })
 *
 *   return (
 *     <div>
 *       <button onClick={handleLaunchClaude} disabled={!availability.claude}>
 *         Claude
 *       </button>
 *       <button onClick={handleAskQuestion} disabled={!availability.claude}>
 *         Ask Claude
 *       </button>
 *     </div>
 *   )
 * }
 * ```
 */
export function useAgentLauncher(): UseAgentLauncherReturn {
  // Single function selector - stable reference, no useShallow needed
  const addTerminal = useTerminalStore((state) => state.addTerminal);
  const { worktreeMap, activeId } = useWorktrees();
  const currentProject = useProjectStore((state) => state.currentProject);

  const [availability, setAvailability] = useState<CliAvailability>({
    claude: false, // Default to unavailable until checked - safer than optimistic true
    gemini: false,
    codex: false,
  });
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
      // Single IPC call instead of three separate checkCommand calls
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
      // Keep safe defaults (false) to avoid enabling unavailable CLIs
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
    async (type: AgentType, launchOptions?: LaunchAgentOptions): Promise<string | null> => {
      if (!isElectronAvailable()) {
        console.warn("Electron API not available");
        return null;
      }

      const config = AGENT_CONFIGS[type];

      // Determine target worktree: explicit override, or active worktree
      const targetWorktreeId = launchOptions?.worktreeId ?? activeId;
      const targetWorktree = targetWorktreeId ? worktreeMap.get(targetWorktreeId) : null;

      // If worktreeId was explicitly provided but doesn't exist, fail early
      if (launchOptions?.worktreeId && !targetWorktree) {
        console.warn(`Worktree ${launchOptions.worktreeId} not found, cannot launch agent`);
        return null;
      }

      // Determine cwd: explicit override, target worktree path, project root, or empty
      const cwd = launchOptions?.cwd ?? targetWorktree?.path ?? currentProject?.path ?? "";

      // Build command with settings flags and optional prompt
      let command = config.command;
      if (command) {
        let flags: string[] = [];

        if (agentSettings) {
          switch (type) {
            case "claude":
              flags = generateClaudeFlags(agentSettings.claude);
              break;
            case "gemini":
              flags = generateGeminiFlags(agentSettings.gemini);
              break;
            case "codex":
              flags = generateCodexFlags(agentSettings.codex);
              break;
          }
        }

        command = buildAgentCommand(
          command,
          type,
          launchOptions?.prompt,
          launchOptions?.interactive ?? true,
          flags
        );
      }

      const options: AddTerminalOptions = {
        type: config.type,
        title: config.title,
        cwd,
        worktreeId: targetWorktreeId || undefined,
        command,
        location: launchOptions?.location,
      };

      try {
        const terminalId = await addTerminal(options);
        return terminalId;
      } catch (error) {
        console.error(`Failed to launch ${type} agent:`, error);
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
