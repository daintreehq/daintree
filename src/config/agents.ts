import type { ComponentType } from "react";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  type AgentPreset,
  type AgentProviderTemplate,
  FALLBACK_CHAIN_MAX,
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
  isEffectivelyRegisteredAgent,
  getAgentDisplayTitle,
  getAssistantSupportedAgentIds,
} from "../../shared/config/agentRegistry";

export { getAgentDisplayTitle, getAssistantSupportedAgentIds };
export type { AgentPreset, AgentProviderTemplate };
import { resolveAgentIcon } from "./agentIcons";

export interface AgentIconProps {
  className?: string;
  size?: number;
  brandColor?: string;
}

export interface AgentConfig extends BaseAgentConfig {
  icon: ComponentType<AgentIconProps>;
}

export const AGENT_REGISTRY: Record<string, AgentConfig> = Object.fromEntries(
  Object.entries(BASE_AGENT_REGISTRY).map(([id, config]) => {
    return [id, { ...config, icon: resolveAgentIcon(config.iconId) }];
  })
) as Record<string, AgentConfig>;

export const AGENT_IDS = Object.keys(AGENT_REGISTRY) as string[];

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  const config = getEffectiveAgentConfig(agentId);
  if (!config) return undefined;
  return { ...config, icon: resolveAgentIcon(config.iconId) };
}

export function isRegisteredAgent(agentId: string): boolean {
  return isEffectivelyRegisteredAgent(agentId);
}

export function getAgentIds(): string[] {
  return getEffectiveAgentIds();
}

export const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
  cursor: "Cursor's agentic coding assistant",
  kiro: "Spec-driven development with autonomous execution",
  copilot: "GitHub's AI assistant with broad model choice",
  crush: "Charmbracelet's multi-provider Bubble Tea TUI agent",
  interpreter: "Local code execution — Python, shell, and JavaScript on your machine",
  mistral: "Mistral's terminal coding agent with local model support",
  kimi: "Moonshot AI's fast coding assistant",
};

/**
 * Sanitizes an env var map: rejects dangerous keys, injection patterns,
 * non-string values, and prototype-polluting keys.
 * Returns undefined when no safe entries remain.
 */
export function sanitizeAgentEnv(
  env: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!env || typeof env !== "object") return undefined;
  const sanitized: Record<string, string> = {};
  let entries: [string, unknown][];
  try {
    entries = Object.entries(env);
  } catch {
    return undefined;
  }
  for (const [key, rawValue] of entries) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (value.includes("$(") || value.includes("`") || value.includes(";") || value.includes("|"))
      continue;
    if (value.length > 10000) continue;
    if (["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"].includes(key.toUpperCase()))
      continue;
    sanitized[key] = value;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function getMergedPresets(
  agentId: string,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentPreset[] {
  const registryPresets = ccrPresets ?? getAgentConfig(agentId)?.presets ?? [];
  const custom = customPresets ?? [];
  const project = projectPresets ?? [];

  // Validate and sanitize preset objects
  const validatePreset = (preset: AgentPreset): AgentPreset | null => {
    // Trim name first so a whitespace-only string is caught by the empty check below
    const trimmedName = preset.name?.trim() ?? "";
    if (!preset.id || !trimmedName) return null;
    if (trimmedName.length > 200) return null;
    if (/[<>]/.test(trimmedName)) return null; // Block XSS-relevant angle brackets only
    if (preset.id.length > 100) return null;
    if (!/^[a-zA-Z0-9_.-]+$/.test(preset.id)) return null; // Only safe ID chars

    // Sanitize args array — filter out non-string, empty, injection-containing, or oversized entries
    const sanitizeArgs = (args?: string[]): string[] | undefined => {
      if (!Array.isArray(args)) return undefined;
      const safe = args.filter(
        (a) =>
          typeof a === "string" &&
          a.length > 0 &&
          a.length <= 10000 &&
          !a.includes(";") &&
          !a.includes("|") &&
          !a.includes("$(") &&
          !a.includes("`") &&
          !a.includes("&") &&
          !a.includes(">")
      );
      return safe.length > 0 ? safe : undefined;
    };

    const sanitizeFallbacks = (fallbacks?: string[], selfId?: string): string[] | undefined => {
      if (!Array.isArray(fallbacks)) return undefined;
      const seen = new Set<string>();
      const safe: string[] = [];
      for (const entry of fallbacks) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim();
        if (!trimmed || trimmed.length > 100) continue;
        if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) continue;
        if (trimmed === selfId) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        safe.push(trimmed);
        if (safe.length >= FALLBACK_CHAIN_MAX) break;
      }
      return safe.length > 0 ? safe : undefined;
    };

    return {
      ...preset,
      name: trimmedName,
      env: sanitizeAgentEnv(preset.env),
      args: sanitizeArgs(preset.args),
      dangerousEnabled:
        typeof preset.dangerousEnabled === "boolean" ? preset.dangerousEnabled : undefined,
      customFlags:
        typeof preset.customFlags === "string" &&
        !preset.customFlags.includes(";") &&
        !preset.customFlags.includes("|") &&
        !preset.customFlags.includes("$(") &&
        !preset.customFlags.includes("`")
          ? preset.customFlags.slice(0, 10000)
          : undefined,
      inlineMode: typeof preset.inlineMode === "boolean" ? preset.inlineMode : undefined,
      color:
        typeof preset.color === "string" &&
        /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(preset.color)
          ? preset.color
          : undefined,
      fallbacks: sanitizeFallbacks(preset.fallbacks, preset.id),
    };
  };

  const sanitizedRegistry = registryPresets.map(validatePreset).filter(Boolean) as AgentPreset[];
  const sanitizedCustom = custom.map(validatePreset).filter(Boolean) as AgentPreset[];
  const sanitizedProject = project.map(validatePreset).filter(Boolean) as AgentPreset[];

  // Precedence (first-seen-wins): custom > project > CCR/registry. Custom
  // overrides team-shared project presets, which override CCR-discovered or
  // built-in registry defaults on ID collision.
  const seenIds = new Set<string>();
  const result: AgentPreset[] = [];

  for (const preset of [...sanitizedCustom, ...sanitizedProject, ...sanitizedRegistry]) {
    if (!seenIds.has(preset.id)) {
      seenIds.add(preset.id);
      result.push(preset);
    }
  }

  // Second pass: filter fallbacks[] against known preset IDs so unknown
  // references don't propagate to the launcher.
  const knownIds = new Set(result.map((p) => p.id));
  for (const preset of result) {
    if (preset.fallbacks?.length) {
      const filtered = preset.fallbacks.filter((id) => knownIds.has(id));
      preset.fallbacks = filtered.length > 0 ? filtered : undefined;
    }
  }

  return result;
}

export function getMergedPreset(
  agentId: string,
  presetId: string | undefined,
  customPresets?: AgentPreset[],
  ccrPresets?: AgentPreset[],
  projectPresets?: AgentPreset[]
): AgentPreset | undefined {
  if (presetId !== undefined && !presetId) return undefined;
  const config = getAgentConfig(agentId);
  const merged = getMergedPresets(
    agentId,
    customPresets,
    ccrPresets ?? config?.presets ?? [],
    projectPresets
  );
  if (presetId === undefined) {
    const defaultId = config?.defaultPresetId;
    if (defaultId) return merged.find((f) => f.id === defaultId);
    return merged[0];
  }
  return merged.find((f) => f.id === presetId);
}
