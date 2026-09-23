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
  /** The attribution as one sentence, for accessible names and descriptions. */
  text: string;
}

/**
 * Who is asking, for a prompt a plugin raised. `instanceKey` is the host's
 * plugin instance key, which for a project plugin is
 * `project__{projectId}__{manifestId}` — a machine-local id that must never
 * reach copy (#12211), so it is resolved here once for every prompt surface.
 */
export function usePluginAttribution(instanceKey: string): PluginAttribution {
  const manifestId = pluginManifestIdFromInstanceKey(instanceKey);
  const name = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(instanceKey)?.displayName ?? manifestId
  );
  const distinctId = name === manifestId ? null : manifestId;
  const text = `Requested by the '${name}' plugin${distinctId ? ` (${distinctId})` : ""}`;
  return { name, manifestId: distinctId, text };
}
