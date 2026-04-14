import type { ComponentType } from "react";
import {
  AGENT_REGISTRY as BASE_AGENT_REGISTRY,
  type AgentConfig as BaseAgentConfig,
  type AgentFlavor,
  getEffectiveAgentConfig,
  getEffectiveAgentIds,
  isEffectivelyRegisteredAgent,
  getAgentDisplayTitle,
} from "../../shared/config/agentRegistry";

export { getAgentDisplayTitle };
export type { AgentFlavor };
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
};

export function getMergedFlavors(
  agentId: string,
  customFlavors?: AgentFlavor[],
  ccrFlavors?: AgentFlavor[]
): AgentFlavor[] {
  const registryFlavors = ccrFlavors ?? getAgentConfig(agentId)?.flavors ?? [];
  const custom = customFlavors ?? [];

  // Sanitize and validate env vars to prevent injection attacks
  const sanitizeEnv = (env?: Record<string, string>) => {
    if (!env || typeof env !== "object") return undefined;
    const sanitized: Record<string, string> = {};
    let entries: [string, unknown][];
    try {
      entries = Object.entries(env);
    } catch {
      return undefined;
    }
    for (const [key, rawValue] of entries) {
      // Reject non-string values (circular refs, objects, etc.)
      if (typeof rawValue !== "string") continue;
      const value = rawValue;
      // Reject keys that could cause prototype pollution
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      // Reject values with shell injection patterns
      if (value.includes("$(") || value.includes("`") || value.includes(";") || value.includes("|"))
        continue;
      // Limit value length to prevent resource exhaustion
      if (value.length > 10000) continue;
      // Reject dangerous system environment variables
      if (
        ["PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"].includes(key.toUpperCase())
      )
        continue;
      sanitized[key] = value;
    }
    return sanitized;
  };

  // Validate and sanitize flavor objects
  const validateFlavor = (flavor: AgentFlavor): AgentFlavor | null => {
    if (!flavor.id || !flavor.name) return null;
    if (flavor.name.length > 200) return null;
    if (/[<>'"&]/.test(flavor.name)) return null; // Basic XSS prevention
    if (flavor.id.length > 100) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(flavor.id)) return null; // Only safe ID chars

    return {
      ...flavor,
      name: flavor.name.trim(),
      env: sanitizeEnv(flavor.env),
    };
  };

  const sanitizedRegistry = registryFlavors.map(validateFlavor).filter(Boolean) as AgentFlavor[];
  const sanitizedCustom = custom.map(validateFlavor).filter(Boolean) as AgentFlavor[];

  // Remove duplicates by ID (custom flavors take precedence)
  const seenIds = new Set<string>();
  const result: AgentFlavor[] = [];

  // Add custom first (they override registry)
  for (const flavor of [...sanitizedCustom, ...sanitizedRegistry]) {
    if (!seenIds.has(flavor.id)) {
      seenIds.add(flavor.id);
      result.push(flavor);
    }
  }

  return result;
}

export function getMergedFlavor(
  agentId: string,
  flavorId: string | undefined,
  customFlavors?: AgentFlavor[],
  ccrFlavors?: AgentFlavor[]
): AgentFlavor | undefined {
  if (!flavorId) {
    const merged = getMergedFlavors(agentId, customFlavors, ccrFlavors);
    const config = getAgentConfig(agentId);
    const defaultId = config?.defaultFlavorId;
    if (defaultId) return merged.find((f) => f.id === defaultId);
    return merged[0];
  }
  const merged = getMergedFlavors(agentId, customFlavors, ccrFlavors);
  return merged.find((f) => f.id === flavorId);
}
