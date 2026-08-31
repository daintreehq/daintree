import { SCOPED_PLUGIN_NAME_PATTERN } from "../../schemas/pluginIdentifiers.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import { parseProjectPluginInstanceKey } from "../../../shared/types/plugin.js";

export {
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  makeProjectPluginInstanceKey,
  parseProjectPluginInstanceKey,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../../shared/types/plugin.js";

/**
 * Whether `id` is a plugin instance id this host is willing to join onto a
 * filesystem path or accept from a renderer.
 *
 * Two shapes are legal and no others: a bare `publisher.name` manifest id (an
 * installed or builtin plugin), or `project__{projectId}__{publisher.name}`
 * with a real project id in the middle. Both are closed alphabets with no
 * separators and no `..`, which is what makes them safe to concatenate into
 * `~/.daintree/plugin-settings/{id}.json` and friends.
 *
 * This is the widened form of the bare `SCOPED_PLUGIN_NAME_PATTERN` test that
 * guarded those joins before project plugins existed. Widened, not relaxed —
 * an instance id is checked segment by segment against the same alphabets.
 */
export function isSafePluginInstanceId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const parsed = parseProjectPluginInstanceKey(id);
  if (!parsed) return SCOPED_PLUGIN_NAME_PATTERN.test(id);
  return (
    isProjectWorkspaceId(parsed.projectId) && SCOPED_PLUGIN_NAME_PATTERN.test(parsed.manifestId)
  );
}
