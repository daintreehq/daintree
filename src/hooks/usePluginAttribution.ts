import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

export interface PluginAttribution {
  /** The plugin's own display name, or its manifest id before the runtime snapshot lands. */
  name: string;
  /**
   * The manifest id, set only when it differs from `name`. A display name is
   * self-authored — a plugin can call itself "Daintree (official)" — so the id
   * is shown beside it as the part a user can match against the plugin list.
   */
  manifestId: string | null;
  /** `'<name>' plugin`, with the manifest id in parentheses when it differs. */
  label: string;
  /** The attribution as one sentence, for accessible names and descriptions. */
  text: string;
}

function describe(instanceKey: string, displayName: string | undefined): PluginAttribution {
  const manifestId = pluginManifestIdFromInstanceKey(instanceKey);
  const name = displayName ?? manifestId;
  const distinctId = name === manifestId ? null : manifestId;
  const label = `'${name}' plugin${distinctId ? ` (${distinctId})` : ""}`;
  return { name, manifestId: distinctId, label, text: `Requested by the ${label}` };
}

/**
 * The same attribution outside React, for copy built in a callback (a toast).
 * `instanceKey` is never shown: for a project plugin it carries a
 * machine-local project id (#12211).
 */
export function resolvePluginAttribution(instanceKey: string): PluginAttribution {
  return describe(
    instanceKey,
    usePluginRuntimeStore.getState().pluginMetaById.get(instanceKey)?.displayName
  );
}

/**
 * Who is asking, for a prompt a plugin raised. `instanceKey` is the host's
 * plugin instance key, which for a project plugin is
 * `project__{projectId}__{manifestId}` — a machine-local id that must never
 * reach copy (#12211), so it is resolved here once for every plugin surface.
 */
export function usePluginAttribution(instanceKey: string): PluginAttribution {
  const displayName = usePluginRuntimeStore((s) => s.pluginMetaById.get(instanceKey)?.displayName);
  return describe(instanceKey, displayName);
}
