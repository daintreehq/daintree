import type { BuiltInAgentId } from "../../../shared/config/agentIds.js";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import { getPluginProcessToolRegistry } from "../../../shared/config/pluginProcessToolRegistry.js";
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

/**
 * Command name → built-in agent id. Null-prototype: this map is indexed by a
 * name read off a live process, and on a plain object a process named
 * `constructor` or `toString` would resolve to an inherited function and be
 * treated as a detected agent.
 */
export const AGENT_CLI_NAMES: Record<string, BuiltInAgentId> = Object.assign(
  Object.create(null) as Record<string, BuiltInAgentId>,
  Object.fromEntries(
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
  )
);

/** Command name → icon id derived from `AGENT_REGISTRY`. Built-in agents only. */
const AGENT_ICON_BY_COMMAND: Record<string, string> = Object.fromEntries(
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
);

let cachedPluginSnapshot: Record<string, string> | null = null;
let cachedProcessIconMap: Record<string, string> = {};

/**
 * Command name → icon id for every recognized process. Tools come from the
 * shared registry; agent entries are derived from `AGENT_REGISTRY` and spread
 * after them so a command shared with a tool still resolves to the agent.
 *
 * Plugin-contributed detections (#11613) are spread FIRST, so both built-in
 * layers override them. The manifest schema already rejects a plugin command
 * that collides with either, making this defense in depth for anything that
 * reaches the registry without passing the schema.
 *
 * This is a function rather than the module-level const it replaced because the
 * plugin layer arrives over IPC after this module is evaluated — a const would
 * be permanently stale in the pty-host. The merged map is cached against the
 * plugin snapshot's reference identity, which
 * `shared/config/pluginProcessToolRegistry.ts` only replaces on a real
 * mutation, so the rebuild cost is paid per registry change and not per lookup.
 */
export function getProcessIconMap(): Readonly<Record<string, string>> {
  const pluginSnapshot = getPluginProcessToolRegistry();
  if (pluginSnapshot === cachedPluginSnapshot) {
    return cachedProcessIconMap;
  }
  cachedPluginSnapshot = pluginSnapshot;
  cachedProcessIconMap = Object.assign(
    // Null-prototype so a command named `constructor`/`toString` resolves to
    // undefined rather than an inherited member on a plain-object lookup.
    Object.create(null) as Record<string, string>,
    pluginSnapshot,
    PROCESS_TOOL_ICON_BY_COMMAND,
    AGENT_ICON_BY_COMMAND
  );
  return cachedProcessIconMap;
}
