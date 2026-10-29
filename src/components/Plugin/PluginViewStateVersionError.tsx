import { useEffect } from "react";
import {
  panelExtensionStateVersionDiagnostic,
  panelExtensionStateVersionMessage,
} from "@shared/utils/panelExtensionState";
import { PluginViewLoadError } from "@/components/Plugin/PluginViewLoadError";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

/**
 * A view refused because its saved state was written by a newer build of its
 * plugin. The heading names the view; the message names the plugin that owns
 * it, read from the runtime store by instance id, since that is what has an
 * update to get. The state formats go to the log.
 */
export function PluginViewStateVersionError({
  pluginId,
  displayName,
  persistedVersion,
  declaredVersion,
}: {
  pluginId: string;
  /** The view's own name, for the heading. */
  displayName: string;
  persistedVersion: number;
  declaredVersion: number;
}) {
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);
  const pluginName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? null
  );
  return (
    <PluginViewLoadError
      pluginId={pluginId}
      displayName={displayName}
      message={panelExtensionStateVersionMessage(pluginName)}
      diagnostic={panelExtensionStateVersionDiagnostic(persistedVersion, declaredVersion)}
    />
  );
}
