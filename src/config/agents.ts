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

export function getMergedFlavors(
  agentId: string,
  customFlavors?: AgentFlavor[],
  ccrFlavors?: AgentFlavor[]
): AgentFlavor[] {
  const registryFlavors = ccrFlavors ?? getAgentConfig(agentId)?.flavors ?? [];
  const custom = customFlavors ?? [];

  // Validate and sanitize flavor objects
  const validateFlavor = (flavor: AgentFlavor): AgentFlavor | null => {
    // Trim name first so a whitespace-only string is caught by the empty check below
    const trimmedName = flavor.name?.trim() ?? "";
    if (!flavor.id || !trimmedName) return null;
    if (trimmedName.length > 200) return null;
    if (/[<>]/.test(trimmedName)) return null; // Block XSS-relevant angle brackets only
    if (flavor.id.length > 100) return null;
    if (!/^[a-zA-Z0-9_.-]+$/.test(flavor.id)) return null; // Only safe ID chars

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

    return {
      ...flavor,
      name: trimmedName,
      env: sanitizeAgentEnv(flavor.env),
      args: sanitizeArgs(flavor.args),
      dangerousEnabled:
        typeof flavor.dangerousEnabled === "boolean" ? flavor.dangerousEnabled : undefined,
      customFlags:
        typeof flavor.customFlags === "string" &&
        !flavor.customFlags.includes(";") &&
        !flavor.customFlags.includes("|") &&
        !flavor.customFlags.includes("$(") &&
        !flavor.customFlags.includes("`")
          ? flavor.customFlags.slice(0, 10000)
          : undefined,
      inlineMode: typeof flavor.inlineMode === "boolean" ? flavor.inlineMode : undefined,
      color:
        typeof flavor.color === "string" &&
        /^#[0-9a-fA-F]{3,4}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(flavor.color)
          ? flavor.color
          : undefined,
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
  if (flavorId !== undefined && !flavorId) return undefined;
  const config = getAgentConfig(agentId);
  const merged = getMergedFlavors(agentId, customFlavors, ccrFlavors ?? config?.flavors ?? []);
  if (flavorId === undefined) {
    const defaultId = config?.defaultFlavorId;
    if (defaultId) return merged.find((f) => f.id === defaultId);
    return merged[0];
  }
  return merged.find((f) => f.id === flavorId);
}
