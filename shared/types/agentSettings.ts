import { z } from "zod";
import { AGENT_REGISTRY, getEffectiveAgentConfig } from "../config/agentRegistry.js";
import { escapeShellArg, escapeShellArgOptional } from "../utils/shellEscape.js";

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
  /**
   * Pin state for the toolbar. Opt-in semantics: `undefined` means unpinned,
   * and only explicit `true` pins the agent. The renderer normalizer
   * synthesizes `pinned: true` for registered agents whose CLI is installed,
   * so uninstalled agents stay off the toolbar until the user pins them
   * explicitly. Use `isAgentPinned()` from `shared/utils/agentPinned.ts`
   * rather than reading this field directly so the default stays consistent.
   */
  pinned?: boolean;
  customFlags?: string;
  /** Additional args appended when dangerous mode is enabled */
  dangerousArgs?: string;
  /** Toggle to include dangerousArgs in the final command */
  dangerousEnabled?: boolean;
  /** Use inline rendering instead of fullscreen alt-screen TUI */
  inlineMode?: boolean;
  /** When true, inject --include-directories for the clipboard temp directory (Gemini only) */
  shareClipboardDirectory?: boolean;
  /**
   * Agent-level default preset ID (persists across worktrees). Used as the
   * fallback when a worktree has no scoped override. Set from Settings →
   * Presets; the toolbar dropdown writes to `worktreePresets` instead so
   * picking a preset in one worktree doesn't silently change what launches
   * in another.
   */
  presetId?: string;
  /**
   * Per-worktree preset overrides, keyed by worktreeId. Wins over `presetId`
   * when resolving the effective launch preset. Updates via
   * `updateWorktreePreset` in the renderer store so the IPC shallow-merge
   * doesn't clobber sibling worktree keys.
   */
  worktreePresets?: Record<string, string>;
  /** User-defined custom presets for this agent (persisted, editable from Settings) */
  customPresets?: Array<{
    id: string;
    name: string;
    description?: string;
    env?: Record<string, string>;
    args?: string[];
    dangerousEnabled?: boolean;
    customFlags?: string;
    inlineMode?: boolean;
    color?: string;
    /** Ordered preset IDs to fall over to when provider is unreachable. */
    fallbacks?: string[];
  }>;
  /**
   * Environment variables applied to every launch of this agent, regardless of preset.
   * Preset-level env overrides these when keys overlap.
   */
  globalEnv?: Record<string, string>;
  [key: string]: unknown;
}

export interface AgentSettings {
  agents: Record<string, AgentSettingsEntry>;
}

export const DEFAULT_DANGEROUS_ARGS: Record<string, string> = {
  claude: "--dangerously-skip-permissions",
  gemini: "--yolo",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  cursor: "--force",
  interpreter: "--auto_run",
  amp: "--dangerously-allow-all",
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  agents: Object.fromEntries(
    Object.keys(AGENT_REGISTRY).map((id) => [
      id,
      {
        customFlags: "",
        dangerousArgs: DEFAULT_DANGEROUS_ARGS[id] ?? "",
        dangerousEnabled: false,
        inlineMode: !!AGENT_REGISTRY[id]?.capabilities?.inlineModeFlag,
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

/**
 * Resolves the effective preset ID for a launch: worktree-scoped override
 * wins, then agent-level default, else `undefined`. Single source of truth
 * shared by `useAgentLauncher` and the toolbar components so resolution
 * can't drift between call sites.
 */
export function resolveEffectivePresetId(
  entry: AgentSettingsEntry | null | undefined,
  worktreeId: string | null | undefined
): string | undefined {
  if (!entry) return undefined;
  const scoped =
    worktreeId && entry.worktreePresets ? entry.worktreePresets[worktreeId] : undefined;
  return scoped ?? entry.presetId;
}

export interface GenerateAgentFlagsOptions {
  /** Absolute path to the clipboard temp directory (e.g. /tmp/daintree-clipboard) */
  clipboardDirectory?: string;
}

export function generateAgentFlags(
  entry: AgentSettingsEntry,
  agentId?: string,
  options?: GenerateAgentFlagsOptions
): string[] {
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

  // Inject --include-directories for Gemini clipboard image access
  if (
    agentId === "gemini" &&
    entry.shareClipboardDirectory !== false &&
    options?.clipboardDirectory
  ) {
    const dir = options.clipboardDirectory;
    // Deduplicate: skip if user already added this exact directory in custom flags
    const alreadyIncluded = flags.some(
      (f, i) => f === "--include-directories" && flags[i + 1] === dir
    );
    if (!alreadyIncluded) {
      flags.push("--include-directories", dir);
    }
  }

  return flags;
}

export interface GenerateAgentCommandOptions {
  /** Initial prompt to pass to the agent CLI */
  initialPrompt?: string;
  /** If true, agent runs in interactive mode (default). If false, runs one-shot/print mode. */
  interactive?: boolean;
  /** Absolute path to the clipboard temp directory for --include-directories injection */
  clipboardDirectory?: string;
  /** Model ID to pass via --model flag (e.g., "claude-opus-4-6") */
  modelId?: string;
  /** Additional CLI arguments from recipe terminal (whitespace-separated string) */
  recipeArgs?: string;
  /** Additional CLI arguments from agent preset (whitespace-separated string) */
  presetArgs?: string;
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
  const flags = generateAgentFlags(entry, agentId, {
    clipboardDirectory: options?.clipboardDirectory,
  });
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

    // Add inline mode flag when enabled and agent supports it
    // Default to true when agent supports it (handles pre-existing stored settings without this field)
    const inlineModeFlag = agentConfig?.capabilities?.inlineModeFlag;
    if (inlineModeFlag && entry.inlineMode !== false) {
      parts.push(inlineModeFlag);
    }
  }

  // Add --model flag if a specific model was selected for this launch
  if (options?.modelId) {
    parts.push("--model", options.modelId);
  }

  // Add preset-level args (env overrides applied separately via spawn env)
  if (options?.presetArgs) {
    for (const token of options.presetArgs.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) {
        parts.push(token);
      } else {
        parts.push(escapeShellArg(token));
      }
    }
  }

  // Add recipe-level args (per-terminal overrides from recipe editor)
  if (options?.recipeArgs) {
    for (const token of options.recipeArgs.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) {
        parts.push(token);
      } else {
        parts.push(escapeShellArg(token));
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

      case "copilot":
        // Copilot: -i flag for initial prompt injection (interactive mode)
        if (interactive) {
          parts.push("-i", escapedPrompt);
        } else {
          parts.push(escapedPrompt);
        }
        break;

      default:
        // Generic agent: just append the prompt
        parts.push(escapedPrompt);
    }
  }

  return parts.join(" ");
}

/**
 * Builds the array of process-level launch flags to persist alongside the session ID.
 * These flags must be re-supplied on every CLI invocation (they are not embedded in the session).
 *
 * Includes: registry default args, inline mode flag, dangerous args, custom flags.
 * Excludes: clipboard directory (dynamic runtime value), initial prompt.
 */
export function buildAgentLaunchFlags(
  entry: AgentSettingsEntry,
  agentId: string,
  options?: { modelId?: string; presetArgs?: string[] }
): string[] {
  const agentConfig = getEffectiveAgentConfig(agentId);
  const flags: string[] = [];

  // Registry default args (e.g. fixed CLI flags)
  if (agentConfig?.args?.length) {
    flags.push(...agentConfig.args);
  }

  // Inline mode flag when agent supports it and it's enabled
  const inlineModeFlag = agentConfig?.capabilities?.inlineModeFlag;
  if (inlineModeFlag && entry.inlineMode !== false) {
    flags.push(inlineModeFlag);
  }

  // Model flag for per-panel model selection
  if (options?.modelId) {
    flags.push("--model", options.modelId);
  }

  // Preset-level args are process-level launch configuration. Persist them so
  // restart/resume paths reproduce the same provider/mode selection as launch.
  if (options?.presetArgs?.length) {
    flags.push(...options.presetArgs);
  }

  // Dangerous args and custom flags (from generateAgentFlags, excluding clipboard dir)
  const settingsFlags = generateAgentFlags(entry, agentId);
  flags.push(...settingsFlags);

  return flags;
}

/**
 * Builds a resume command for an agent using a previously captured session ID.
 * When launchFlags are provided, they are prepended before the resume args
 * to restore the original process-level configuration.
 *
 * Dispatches on `resume.kind` (see {@link AgentResume}). The `sessionId`
 * parameter is passed verbatim — for `named-target` it is reinterpreted as
 * the user-named target — so existing call sites that pass a session ID
 * positionally continue to work without an API change.
 *
 * @returns The resume command string, or undefined if the agent has no resume config.
 */
export function buildResumeCommand(
  agentId: string,
  sessionId: string,
  launchFlags?: string[]
): string | undefined {
  const agentConfig = getEffectiveAgentConfig(agentId);
  const resume = agentConfig?.resume;
  if (!agentConfig || !resume) return undefined;

  const parts = [agentConfig.command];

  // Prepend persisted launch flags (original process-level flags)
  if (launchFlags?.length) {
    for (const flag of launchFlags) {
      if (flag.startsWith("-")) {
        parts.push(flag);
      } else {
        parts.push(escapeShellArg(flag));
      }
    }
  }

  let args: string[];
  switch (resume.kind) {
    case "session-id":
      args = resume.args(sessionId);
      break;
    case "rolling-history":
      args = resume.args();
      break;
    case "named-target":
      args = resume.argsForTarget(sessionId);
      break;
    case "project-scoped":
      args = resume.args();
      break;
    default: {
      const _exhaustive: never = resume;
      void _exhaustive;
      return undefined;
    }
  }

  for (const arg of args) {
    if (arg.startsWith("-")) {
      parts.push(arg);
    } else {
      parts.push(escapeShellArgOptional(arg));
    }
  }
  return parts.join(" ");
}

export interface BuildLaunchCommandFromFlagsOptions {
  /** Absolute path to the clipboard temp directory (re-injected for agents that support it) */
  clipboardDirectory?: string;
  /**
   * Current `shareClipboardDirectory` setting for the agent entry. When not `false`
   * and the agent supports clipboard injection (e.g. Gemini), `--include-directories
   * <clipboardDirectory>` is appended if not already present.
   */
  shareClipboardDirectory?: boolean;
}

/**
 * Reconstructs an agent launch command from persisted launch flags.
 *
 * Used on respawn/restart paths when no resumable session is available but
 * the original `agentLaunchFlags` are persisted. Mirrors the shell-escaping
 * rules of `buildResumeCommand` (raw for flag-style `-`-prefixed tokens,
 * `escapeShellArg` for positional values).
 *
 * Re-injects runtime-dynamic values that `buildAgentLaunchFlags` deliberately
 * excluded at capture time — today, only Gemini's `--include-directories
 * <clipboardDirectory>` (with dedup if already present in the persisted flags).
 */
export function buildLaunchCommandFromFlags(
  baseCommand: string,
  agentId: string,
  launchFlags: readonly string[],
  options?: BuildLaunchCommandFromFlagsOptions
): string {
  const flags: string[] = [...launchFlags];

  if (
    agentId === "gemini" &&
    options?.shareClipboardDirectory !== false &&
    options?.clipboardDirectory
  ) {
    const dir = options.clipboardDirectory;
    const alreadyIncluded = flags.some(
      (flag, i) => flag === "--include-directories" && flags[i + 1] === dir
    );
    if (!alreadyIncluded) {
      flags.push("--include-directories", dir);
    }
  }

  const parts: string[] = [baseCommand];
  for (const flag of flags) {
    if (flag.startsWith("-")) {
      parts.push(flag);
    } else {
      parts.push(escapeShellArg(flag));
    }
  }
  return parts.join(" ");
}
