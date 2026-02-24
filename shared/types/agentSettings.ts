import { z } from "zod";
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../config/agentRegistry.js";
import { escapeShellArg } from "../utils/shellEscape.js";

/**
 * Domain weights for agent routing (0-1 scale).
 * Higher values indicate stronger capability in that domain.
 */
export interface AgentDomainWeights {
  frontend?: number;
  backend?: number;
  testing?: number;
  refactoring?: number;
  debugging?: number;
  architecture?: number;
  devops?: number;
}

/**
 * Routing configuration for intelligent agent dispatch.
 * Used by orchestrators to select the best agent for a given task.
 */
export interface AgentRoutingConfig {
  /** Capability tags for filtering (e.g., ['javascript', 'react', 'typescript']) */
  capabilities: string[];
  /** Domain weights (0-1 scale) indicating agent strengths */
  domains?: AgentDomainWeights;
  /** Maximum parallel tasks this agent can handle (default: 1) */
  maxConcurrent?: number;
  /** Whether this agent can be routed to (default: true) */
  enabled: boolean;
}

/** Zod schema for domain weights validation */
export const AgentDomainWeightsSchema = z.object({
  frontend: z.number().min(0).max(1).optional(),
  backend: z.number().min(0).max(1).optional(),
  testing: z.number().min(0).max(1).optional(),
  refactoring: z.number().min(0).max(1).optional(),
  debugging: z.number().min(0).max(1).optional(),
  architecture: z.number().min(0).max(1).optional(),
  devops: z.number().min(0).max(1).optional(),
});

/** Zod schema for routing config validation */
export const AgentRoutingConfigSchema = z.object({
  capabilities: z
    .array(
      z
        .string()
        .trim()
        .min(1, "Capability string cannot be empty")
        .transform((s) => s.toLowerCase())
    )
    .default([])
    .transform((arr) => Array.from(new Set(arr))),
  domains: AgentDomainWeightsSchema.optional(),
  maxConcurrent: z.number().int().min(1).default(1),
  enabled: z.boolean().default(true),
});

/**
 * Default routing config for agents without explicit routing configuration.
 */
export const DEFAULT_ROUTING_CONFIG: AgentRoutingConfig = {
  capabilities: [],
  enabled: true,
  maxConcurrent: 1,
};

export interface AgentSettingsEntry {
  enabled?: boolean;
  customFlags?: string;
  /** Additional args appended when dangerous mode is enabled */
  dangerousArgs?: string;
  /** Toggle to include dangerousArgs in the final command */
  dangerousEnabled?: boolean;
  [key: string]: unknown;
}

export interface AgentSettings {
  agents: Record<string, AgentSettingsEntry>;
}

export const DEFAULT_DANGEROUS_ARGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  gemini: "--yolo",
  codex: "--dangerously-bypass-approvals-and-sandbox",
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agents: Object.fromEntries(
    Object.keys(AGENT_REGISTRY).map((id) => [
      id,
      {
        enabled: true,
        customFlags: "",
        dangerousArgs: DEFAULT_DANGEROUS_ARGS[id] ?? "",
        dangerousEnabled: false,
      },
    ])
  ),
};

export function getAgentSettingsEntry(
  settings: AgentSettings | null | undefined,
  agentId: string
): AgentSettingsEntry {
  if (!settings || !settings.agents) return {};
  return settings.agents[agentId] ?? {};
}

export function generateAgentFlags(entry: AgentSettingsEntry, agentId?: string): string[] {
  const flags: string[] = [];
  if (entry.dangerousEnabled) {
    // Use entry.dangerousArgs if set, otherwise fall back to default for this agent
    const dangerousArgs =
      entry.dangerousArgs?.trim() || (agentId ? DEFAULT_DANGEROUS_ARGS[agentId] : "");
    if (dangerousArgs) {
      flags.push(...dangerousArgs.split(/\s+/));
    }
  }
  if (entry.customFlags) {
    const trimmed = entry.customFlags.trim();
    if (trimmed) {
      flags.push(...trimmed.split(/\s+/));
    }
  }
  return flags;
}

export interface GenerateAgentCommandOptions {
  /** Initial prompt to pass to the agent CLI */
  initialPrompt?: string;
  /** If true, agent runs in interactive mode (default). If false, runs one-shot/print mode. */
  interactive?: boolean;
}

/**
 * Generates a complete agent command string including base command, flags, and optional initial prompt.
 *
 * @param baseCommand - The base command for the agent (e.g., "claude", "gemini")
 * @param entry - Agent settings entry containing flags configuration
 * @param agentId - The agent identifier (e.g., "claude", "gemini", "codex")
 * @param options - Optional configuration including initial prompt and interactive mode
 * @returns The complete command string to spawn the agent
 *
 * @example
 * // Claude interactive with prompt
 * generateAgentCommand("claude", entry, "claude", { initialPrompt: "Fix the bug" });
 * // => "claude --flags 'Fix the bug'"
 *
 * // Claude one-shot (print mode)
 * generateAgentCommand("claude", entry, "claude", { initialPrompt: "Fix the bug", interactive: false });
 * // => "claude --flags -p 'Fix the bug'"
 */
export function generateAgentCommand(
  baseCommand: string,
  entry: AgentSettingsEntry,
  agentId?: string,
  options?: GenerateAgentCommandOptions
): string {
  const flags = generateAgentFlags(entry, agentId);
  const parts: string[] = [baseCommand];

  // Add default args from agent registry (before user flags)
  if (agentId) {
    const agentConfig = getEffectiveAgentConfig(agentId);
    if (agentConfig?.args?.length) {
      // Apply same escaping logic as user flags
      for (const arg of agentConfig.args) {
        if (arg.startsWith("-")) {
          parts.push(arg);
        } else {
          parts.push(escapeShellArg(arg));
        }
      }
    }
  }

  // Add flags, escaping non-flag values
  for (const flag of flags) {
    if (flag.startsWith("-")) {
      parts.push(flag);
    } else {
      parts.push(escapeShellArg(flag));
    }
  }

  // Add initial prompt if provided
  const prompt = options?.initialPrompt?.trim();
  if (prompt) {
    const interactive = options?.interactive ?? true;
    // Normalize multi-line prompts to single line (replace newlines with spaces)
    const normalizedPrompt = prompt.replace(/\r\n/g, " ").replace(/\n/g, " ");
    const escapedPrompt = escapeShellArg(normalizedPrompt);

    switch (agentId) {
      case "claude":
        // Claude: -p for print mode (non-interactive), otherwise just the prompt
        if (!interactive) {
          parts.push("-p");
        }
        parts.push(escapedPrompt);
        break;

      case "gemini":
        // Gemini: -i for interactive with prompt, otherwise just the prompt
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push(escapedPrompt);
        }
        break;

      case "codex":
        // Codex: "exec" subcommand for non-interactive, otherwise just the prompt
        if (!interactive) {
          parts.push("exec");
        }
        parts.push(escapedPrompt);
        break;

      default:
        // Generic agent: just append the prompt
        parts.push(escapedPrompt);
    }
  }

  return parts.join(" ");
}
