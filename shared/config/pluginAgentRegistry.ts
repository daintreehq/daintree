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

/**
 * Render-path subscribers for `useSyncExternalStore`. The renderer's plugin
 * agents are mirrored into {@link snapshot} by {@link setPluginAgentRegistry},
 * but nothing re-renders consumers that read the snapshot during render unless
 * they're notified — so icon/name/color stayed stale mid-session until an
 * unrelated re-render (#9879). Mirrors the panel-kind listener set in
 * `src/panels/registry.tsx`. Pure `Set`, no DOM/React imports, so it stays
 * safe to import from the main process (which never subscribes).
 */
const registryListeners = new Set<() => void>();

function notifyRegistryListeners(): void {
  for (const listener of [...registryListeners]) {
    try {
      listener();
    } catch (err) {
      console.error("[pluginAgentRegistry] registry listener threw", err);
    }
  }
}

/**
 * Subscribe to plugin-agent registry changes. Stable module-scope reference so
 * `useSyncExternalStore` doesn't re-subscribe on every render.
 */
export function subscribeToPluginAgentRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the live {@link snapshot}
 * reference as-is — stable until a mutation replaces it. Never clone or spread
 * here: a fresh object on each call breaks React 19's identity check and forces
 * synchronous/infinite re-renders.
 */
export function getPluginAgentRegistrySnapshot(): Record<string, AgentConfig> {
  return snapshot;
}

/**
 * Resolve a plugin-relative `./` command to an absolute path against the
 * plugin's install dir so node-pty can spawn it (node-pty resolves the command
 * before switching cwd, so a relative path would ENOENT). A bare PATH name
 * (e.g. "claude") is returned unchanged. Done with a pure separator-aware join
 * rather than `node:path` so this module stays safe to bundle in the renderer
 * (which imports it via `agentRegistry`); the manifest schema
 * (`AgentContributionSchema.command`) already guarantees the relative form is
 * POSIX (`./seg/seg`) with no backslashes or `..` traversal segments.
 */
function resolvePluginAgentCommand(command: string, pluginDir?: string): string {
  if (!pluginDir || !command.startsWith("./")) return command;
  const sep = pluginDir.includes("\\") && !pluginDir.includes("/") ? "\\" : "/";
  const base = pluginDir.endsWith(sep) ? pluginDir.slice(0, -1) : pluginDir;
  return base + sep + command.slice(2).split("/").join(sep);
}

function contributionToAgentConfig(
  contribution: PluginAgentContribution,
  pluginDir?: string
): AgentConfig {
  // Surface the launch-relevant fields plus the optional output-pattern
  // `detection` block (#10587) so a contributed agent can drive the
  // working/waiting/completed UI. Mapped explicitly (not spread) so no other
  // contribution field can leak onto the resolved config. `detection` is
  // forwarded only when present, keeping the field absent for the common
  // launch-only case.
  return {
    id: contribution.id,
    name: contribution.name,
    command: resolvePluginAgentCommand(contribution.command, pluginDir),
    args: contribution.args,
    color: contribution.color,
    iconId: contribution.iconId,
    supportsContextInjection: contribution.supportsContextInjection ?? false,
    ...(contribution.detection ? { detection: contribution.detection } : {}),
  };
}

/**
 * Rebuild the flattened {@link snapshot} from {@link byPlugin}. Iteration
 * follows insertion order (plugin load order, then per-plugin contribution
 * order), so a cross-plugin id collision resolves first-registered-wins with a
 * warning rather than silently clobbering.
 */
function rebuildSnapshot(): void {
  // Null-prototype object so a reserved id like `__proto__` is written as an own
  // property rather than reassigning the prototype (defense in depth — the
  // manifest schema also rejects reserved ids before they reach here).
  const next: Record<string, AgentConfig> = Object.create(null) as Record<string, AgentConfig>;
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
  notifyRegistryListeners();
}

/**
 * Register the agents one plugin contributes. Replaces any prior set for the
 * same `pluginId` (idempotent reload). Pass an empty array to clear the
 * plugin's entries. `pluginDir` is the plugin's install dir; when provided, a
 * `./`-prefixed command is resolved to an absolute path against it (see
 * {@link resolvePluginAgentCommand}). Main-process only.
 */
export function registerPluginAgents(
  pluginId: string,
  contributions: PluginAgentContribution[],
  pluginDir?: string
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    if (byPlugin.delete(pluginId)) rebuildSnapshot();
    return;
  }
  const agents = new Map<string, AgentConfig>();
  for (const contribution of contributions) {
    agents.set(contribution.id, Object.freeze(contributionToAgentConfig(contribution, pluginDir)));
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
  const next = record ?? {};
  // Reference-identity guard: a no-op replace must not churn snapshot identity
  // or wake subscribers.
  if (next === snapshot) return;
  snapshot = next;
  notifyRegistryListeners();
}

/**
 * Reverse lookup: which plugin contributed `agentId`? Iterates {@link byPlugin},
 * so it is **main-process only** — the renderer mirrors a flat {@link snapshot}
 * with no per-plugin tracking and must never call this. Returns the first plugin
 * declaring the id (matching the first-registered-wins resolution in
 * {@link rebuildSnapshot}), or `undefined` for a built-in / unknown agent. Used
 * by the terminal spawn handler to gate `${settings:*}` resolution on
 * plugin-contributed agents only (#10619).
 */
export function getPluginIdForAgent(agentId: string): string | undefined {
  for (const [pluginId, agents] of byPlugin) {
    if (agents.has(agentId)) return pluginId;
  }
  return undefined;
}

/** Test-isolation helper: clear the per-plugin map, snapshot, and subscribers. */
export function clearPluginAgentRegistryForTests(): void {
  byPlugin.clear();
  snapshot = {};
  registryListeners.clear();
}
