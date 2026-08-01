import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import { PROCESS_TOOL_ICON_BY_COMMAND } from "../../../shared/config/processToolRegistry.js";

function packageTail(pkg: string | undefined): string | undefined {
  if (!pkg) return undefined;
  const tail = pkg.split("/").pop();
  return tail && tail.length > 0 ? tail : undefined;
}

/** Reads `packages.npm` first; falls back to deprecated top-level `npmGlobalPackage`. */
function effectiveNpmPackage(config: {
  packages?: { npm?: string };
  npmGlobalPackage?: string;
}): string | undefined {
  return config.packages?.npm ?? config.npmGlobalPackage;
}

export const AGENT_CLI_NAMES: Record<string, BuiltInAgentId> = Object.fromEntries(
  Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
    const entries: [string, BuiltInAgentId][] = [[config.command, id as BuiltInAgentId]];
    if (config.command !== id) {
      entries.push([id, id as BuiltInAgentId]);
    }
    const tail = packageTail(effectiveNpmPackage(config));
    if (tail && tail !== config.command && tail !== id) {
      entries.push([tail, id as BuiltInAgentId]);
    }
    return entries;
  })
);

/**
 * Command name → icon id for every recognized process. Tools come from the
 * shared registry; agent entries are derived from `AGENT_REGISTRY` and spread
 * last so a command shared with a tool still resolves to the agent.
 */
export const PROCESS_ICON_MAP: Record<string, string> = {
  ...PROCESS_TOOL_ICON_BY_COMMAND,
  ...Object.fromEntries(
    Object.entries(AGENT_REGISTRY).flatMap(([id, config]) => {
      const entries: [string, string][] = [[id, config.iconId]];
      if (config.command !== id) {
        entries.push([config.command, config.iconId]);
      }
      const tail = packageTail(effectiveNpmPackage(config));
      if (tail && tail !== config.command && tail !== id) {
        entries.push([tail, config.iconId]);
      }
      return entries;
    })
  ),
};
