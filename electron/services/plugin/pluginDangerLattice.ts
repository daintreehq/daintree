import { CONFIRM_TRIGGERING_CAPABILITIES } from "../../../shared/config/pluginCapabilities.js";
import type { PluginManifest, BuiltInPluginCapability } from "../../../shared/types/plugin.js";

/**
 * Compound-capability lattice (#9247). The flat
 * {@link CONFIRM_TRIGGERING_CAPABILITIES} set only catches single capabilities
 * that are themselves irreversible. It misses the two compound threat classes:
 *
 * 1. **Exfiltration** — a sensitive read paired with an unconstrained network
 *    or shell sink. Neither side alone is destructive (read-only or merely
 *    capable of network I/O), but together they form a data-exfiltration path.
 * 2. **Remote-controlled mutation** — `network:fetch` paired with a local
 *    write or shell sink. Both sides may already elevate individually
 *    (`fs:*-write`, `git:write`, `shell:exec` are flat-elevated), but the
 *    compound rule documents the intent and is belt-and-suspenders if the
 *    flat set ever drifts.
 *
 * A plugin can attenuate the elevation by declaring tight scopes on the sink
 * — currently only `scopes.network.allowedUrls` is consulted, since
 * `shell:exec` is categorically high-risk and fs writes already elevate
 * individually. Wildcard rejection is enforced at the schema boundary so the
 * runtime only needs to check non-empty presence; see
 * `electron/schemas/plugin.ts`.
 */
const SENSITIVE_READ_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "agent:read",
  "git:read",
  "fs:project-read",
  "fs:user-data-read",
]);
const REMOTE_MUTATION_SINK_CAPABILITIES: ReadonlySet<BuiltInPluginCapability> = new Set([
  "fs:project-write",
  "fs:user-data-write",
  "git:write",
  "shell:exec",
]);

function manifestHasTightNetworkScope(manifest: PluginManifest | undefined): boolean {
  const urls = manifest?.scopes?.network?.allowedUrls;
  return Array.isArray(urls) && urls.length > 0;
}

export function manifestTriggersCompoundElevation(
  manifest: PluginManifest | undefined,
  declaredCapabilities: readonly BuiltInPluginCapability[]
): boolean {
  if (declaredCapabilities.length < 2) return false;
  const capSet = new Set<BuiltInPluginCapability>(declaredCapabilities);
  const hasSensitiveRead = [...SENSITIVE_READ_CAPABILITIES].some((c) => capSet.has(c));
  const hasNetworkFetch = capSet.has("network:fetch");
  const hasShellExec = capSet.has("shell:exec");
  const networkScoped = manifestHasTightNetworkScope(manifest);

  // Exfiltration class: sensitive read + unconstrained sink.
  if (hasSensitiveRead) {
    if (hasShellExec) return true;
    if (hasNetworkFetch && !networkScoped) return true;
  }

  // Remote-controlled mutation class: network:fetch (the remote control
  // channel) + any local write or shell sink. A tightly-scoped network:fetch
  // can't be remote-controlled, so the scope attenuates this class too.
  if (hasNetworkFetch && !networkScoped) {
    for (const sink of REMOTE_MUTATION_SINK_CAPABILITIES) {
      if (capSet.has(sink)) return true;
    }
  }

  return false;
}

/**
 * Aggregate danger verdict for a whole plugin (vs. the per-action
 * `effectiveDanger` computed in `PluginService.validateAndBuildActionDescriptor`).
 * Surfaced on `LoadedPluginInfo.pluginDanger` so the manager UI can show
 * an effective-danger summary without re-deriving the lattice in the renderer.
 * Single source of truth on main: reuses {@link CONFIRM_TRIGGERING_CAPABILITIES}
 * and {@link manifestTriggersCompoundElevation} rather than spawning a third copy.
 */
export function computePluginDanger(manifest: PluginManifest | undefined): "safe" | "confirm" {
  const caps = manifest?.capabilities ?? [];
  if (caps.some((c) => CONFIRM_TRIGGERING_CAPABILITIES.has(c))) return "confirm";
  if (manifestTriggersCompoundElevation(manifest, caps)) return "confirm";
  return "safe";
}
