import type { PluginProcessToolContribution } from "../types/plugin.js";

/**
 * Process-global registry of plugin-contributed terminal process detections
 * (#11613). Mirrors the structure of {@link ./pluginAgentRegistry.ts} because
 * it solves the same problem: main owns the authoritative set, and a second
 * process needs a copy.
 *
 * Two population paths converge here, one per process:
 *
 * - **Main** calls {@link registerPluginProcessTools} /
 *   {@link unregisterPluginProcessTools} from `PluginService` load/unload.
 *   Entries are tracked per-plugin in {@link byPlugin} so unloading plugin A
 *   never evicts a command plugin B also declared. The flattened
 *   {@link snapshot} is rebuilt on every mutation.
 * - **pty-host** (a separate utility process, where `ProcessDetector` actually
 *   runs) never registers anything itself; it mirrors main's set via
 *   {@link setPluginProcessToolRegistry} from the
 *   `set-plugin-process-tool-registry` host message. `PtyClient` replays that
 *   message on every host-ready, so a crashed-and-restarted host re-syncs
 *   before any spawn replay.
 *
 * `getProcessIconMap()` in `electron/services/ProcessDetector/registries.ts`
 * merges {@link snapshot} beneath the built-in tool and agent maps, so plugin
 * detections are purely additive and can never shadow a built-in.
 */
const byPlugin = new Map<string, Map<string, string>>();

let snapshot: Record<string, string> = {};

/**
 * Rebuild the flattened {@link snapshot} from {@link byPlugin}. Iteration
 * follows insertion order (plugin load order, then per-plugin contribution
 * order), so a cross-plugin command collision resolves first-registered-wins
 * with a warning rather than silently clobbering. When the winner unloads, the
 * next declaring plugin takes over on the following rebuild.
 */
function rebuildSnapshot(): void {
  // Null-prototype object so a command like `__proto__` is written as an own
  // property rather than reassigning the prototype (defense in depth — the
  // manifest schema's command pattern also rejects it before it reaches here).
  const next: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [pluginId, commands] of byPlugin) {
    for (const [command, iconId] of commands) {
      if (Object.prototype.hasOwnProperty.call(next, command)) {
        console.warn(
          `[pluginProcessToolRegistry] Plugin "${pluginId}" declares process-tool command "${command}" already registered by another plugin — ignoring the later registration`
        );
        continue;
      }
      next[command] = iconId;
    }
  }
  snapshot = next;
}

/**
 * Register the process-tool detections one plugin contributes. Replaces any
 * prior set for the same `pluginId` (idempotent reload). Pass an empty array to
 * clear the plugin's entries. Main-process only.
 *
 * Commands are lower-cased on the way in: `ProcessDetector` lower-cases every
 * candidate name before looking it up, so a mixed-case key could never match.
 * The manifest schema already rejects uppercase at parse time — this is the
 * belt-and-braces half, covering any caller that bypasses the schema.
 */
export function registerPluginProcessTools(
  pluginId: string,
  contributions: PluginProcessToolContribution[]
): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (!Array.isArray(contributions) || contributions.length === 0) {
    if (byPlugin.delete(pluginId)) rebuildSnapshot();
    return;
  }
  const commands = new Map<string, string>();
  for (const contribution of contributions) {
    if (typeof contribution?.command !== "string" || typeof contribution?.iconId !== "string") {
      continue;
    }
    commands.set(contribution.command.toLowerCase(), contribution.iconId);
  }
  byPlugin.set(pluginId, commands);
  rebuildSnapshot();
}

/** Remove every process-tool detection contributed by `pluginId`. Idempotent. Main-process only. */
export function unregisterPluginProcessTools(pluginId: string): void {
  if (typeof pluginId !== "string" || pluginId.length === 0) return;
  if (byPlugin.delete(pluginId)) rebuildSnapshot();
}

/**
 * The flattened command → icon-id record mirrored to the pty-host and merged
 * into the detector's lookup map. Returns the live snapshot reference — callers
 * must not mutate it, and `getProcessIconMap()` relies on that reference
 * staying stable to skip rebuilding.
 */
export function getPluginProcessToolRegistry(): Record<string, string> {
  return snapshot;
}

/**
 * Replace the flattened snapshot wholesale. Used by the pty-host to mirror the
 * `set-plugin-process-tool-registry` message; the pty-host has no per-plugin
 * tracking of its own. No-op-safe with an empty record.
 */
export function setPluginProcessToolRegistry(record: Record<string, string>): void {
  const next = record ?? {};
  // Reference-identity guard: a no-op replace must not churn snapshot identity,
  // which `getProcessIconMap()` uses as its rebuild trigger.
  if (next === snapshot) return;
  snapshot = next;
}

/** Test-isolation helper: clear the per-plugin map and the snapshot. */
export function clearPluginProcessToolRegistryForTests(): void {
  byPlugin.clear();
  snapshot = {};
}
