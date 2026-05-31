import type { AgentConfig } from "./agentRegistry.js";
import type { PluginAgentContribution } from "../types/plugin.js";

/**
 * Process-global registry of plugin-contributed agents (#9560).
 *
 * Two population paths converge on this module, one per process:
 *
 * - **Main** calls {@link registerPluginAgents} / {@link unregisterPluginAgents}
 *   from `PluginService` load/unload. Entries are tracked per-plugin in
 *   {@link byPlugin} (a compound map) so unloading plugin A never evicts an
 *   agent that plugin B also declared with the same id. The flattened
 *   {@link snapshot} is rebuilt on every mutation.
 * - **Renderer** (a separate V8 context) never registers agents directly; it
 *   mirrors main's authoritative set by calling {@link setPluginAgentRegistry}
 *   with the flattened record carried on the `plugin:agents-changed` broadcast.
 *
 * `getEffectiveRegistry()` in `./agentRegistry.ts` merges {@link snapshot} at
 * the lowest priority (below user-registry and built-in agents), so plugin
 * agents are purely additive for new IDs and can never shadow a built-in.
 */
const byPlugin = new Map<string, Map<string, AgentConfig>>();

let snapshot: Record<string, AgentConfig> = {};

function contributionToAgentConfig(contribution: PluginAgentContribution): AgentConfig {
  // Minimal tier: surface only the launch-relevant fields. `detection` is
  // validated at the manifest gate but deliberately not mapped here — the
  // full-tracking tier wires it into the PTY matcher separately.
  return {
    id: contribution.id,
    name: contribution.name,
    command: contribution.command,
    args: contribution.args,
    color: contribution.color,
    iconId: contribution.iconId,
    supportsContextInjection: contribution.supportsContextInjection ?? false,
  };
}

/**
 * Rebuild the flattened {@link snapshot} from {@link byPlugin}. Iteration
 * follows insertion order (plugin load order, then per-plugin contribution
 * order), so a cross-plugin id collision resolves first-registered-wins with a
 * warning rather than silently clobbering.
 */
function rebuildSnapshot(): void {
  const next: Record<string, AgentConfig> = {};
  for (const [pluginId, agents] of byPlugin) {
    for (const [agentId, config] of agents) {
      if (Object.prototype.hasOwnProperty.call(next, agentId)) {
        console.warn(
          `[pluginAgentRegistry] Plugin "${pluginId}" declares agent id "${agentId}" already registered by another plugin — ignoring the later registration`
        );
        continue;
      }
      next[agentId] = config;
    }
  }
  snapshot = next;
}

/**
 * Register the agents one plugin contributes. Replaces any prior set for the
 * same `pluginId` (idempotent reload). Pass an empty array to clear the
 * plugin's entries. Main-process only.
 */
export function registerPluginAgents(
  pluginId: string,
  contributions: PluginAgentContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    if (byPlugin.delete(pluginId)) rebuildSnapshot();
    return;
  }
  const agents = new Map<string, AgentConfig>();
  for (const contribution of contributions) {
    agents.set(contribution.id, Object.freeze(contributionToAgentConfig(contribution)));
  }
  byPlugin.set(pluginId, agents);
  rebuildSnapshot();
}

/** Remove every agent contributed by `pluginId`. Idempotent. Main-process only. */
export function unregisterPluginAgents(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (byPlugin.delete(pluginId)) rebuildSnapshot();
}

/**
 * The flattened plugin-agent record consulted by `getEffectiveRegistry()` and
 * broadcast to the renderer. Returns the live snapshot reference — callers must
 * not mutate it.
 */
export function getPluginAgentRegistry(): Record<string, AgentConfig> {
  return snapshot;
}

/**
 * Replace the flattened snapshot wholesale. Used by the renderer to mirror the
 * `plugin:agents-changed` broadcast; the renderer has no per-plugin tracking of
 * its own. No-op-safe with an empty record.
 */
export function setPluginAgentRegistry(record: Record<string, AgentConfig>): void {
  snapshot = record ?? {};
}

/** Test-isolation helper: clear both the per-plugin map and the snapshot. */
export function clearPluginAgentRegistryForTests(): void {
  byPlugin.clear();
  snapshot = {};
}
