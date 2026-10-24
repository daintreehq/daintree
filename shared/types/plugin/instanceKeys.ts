/**
 * Prefix marking a plugin instance key as project-owned.
 *
 * A project plugin is keyed `project__{projectId}__{manifestId}` everywhere the
 * host indexes a plugin instance — `PluginService.plugins`, the contribution
 * registries' `pluginId`/`extensionId`, the `plugin://` authority map, the
 * capability-consent subject, the per-plugin settings/storage filename. That is
 * what keeps two projects shipping the same manifest id genuinely separate:
 * separate contributions, separate authority, separate grants, separate
 * teardown. Keying them by bare manifest id would give one project's revoke the
 * power to sweep the other's registrations, and one project's grant the power
 * to answer for both.
 *
 * The separator is `__` rather than `/` or `:` on purpose: an instance key is
 * joined onto a filesystem path for the user-scope settings and storage files,
 * and both of those characters are either a path separator or illegal on
 * Windows. A project id is 64 lowercase hex (`mintProjectId`) and a manifest id
 * is `publisher.name` in `[a-z0-9-]`, so neither half can contain `__` and the
 * parse below is unambiguous.
 */
export const PROJECT_PLUGIN_INSTANCE_PREFIX = "project__";

const PROJECT_PLUGIN_INSTANCE_SEPARATOR = "__";

/**
 * Marks the manifest half of an installed `instanceMode: "project"` package's
 * per-project instance: `project__{projectId}__installed__{manifestId}`.
 *
 * The instance is project-bound like a repository plugin, so it keeps the
 * `project__` prefix and every project-ownership check reads it the same way.
 * It must never share a key with a repository plugin of the same manifest id in
 * the same project, though: the two have different trust principals, and grants,
 * user-scope settings, secrets, storage and revocation are all keyed by the
 * instance key. A manifest id is `[a-z0-9-]` around a dot, so no repository
 * plugin's key can ever contain this marker.
 */
const INSTALLED_PROJECT_INSTANCE_MARKER = `installed${PROJECT_PLUGIN_INSTANCE_SEPARATOR}`;

/** Build the instance key a project-owned plugin loads under. */
export function makeProjectPluginInstanceKey(projectId: string, manifestId: string): string {
  return `${PROJECT_PLUGIN_INSTANCE_PREFIX}${projectId}${PROJECT_PLUGIN_INSTANCE_SEPARATOR}${manifestId}`;
}

/** Build the instance key an installed package loads under in one project. */
export function makeInstalledProjectInstanceKey(projectId: string, manifestId: string): string {
  return makeProjectPluginInstanceKey(
    projectId,
    `${INSTALLED_PROJECT_INSTANCE_MARKER}${manifestId}`
  );
}

/** Whether a key names an installed package's per-project instance. */
export function isInstalledProjectInstanceKey(instanceKey: string): boolean {
  return parseProjectPluginInstanceKey(instanceKey)?.installed === true;
}

/**
 * Split an instance key back into its project and manifest halves, or `null`
 * when the key is not a project instance key (an installed or builtin plugin
 * id, which is its own manifest id).
 */
export function parseProjectPluginInstanceKey(
  instanceKey: string
): { projectId: string; manifestId: string; installed: boolean } | null {
  if (!instanceKey.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) return null;
  const rest = instanceKey.slice(PROJECT_PLUGIN_INSTANCE_PREFIX.length);
  const cut = rest.indexOf(PROJECT_PLUGIN_INSTANCE_SEPARATOR);
  if (cut <= 0) return null;
  const projectId = rest.slice(0, cut);
  let manifestId = rest.slice(cut + PROJECT_PLUGIN_INSTANCE_SEPARATOR.length);
  const installed = manifestId.startsWith(INSTALLED_PROJECT_INSTANCE_MARKER);
  if (installed) manifestId = manifestId.slice(INSTALLED_PROJECT_INSTANCE_MARKER.length);
  if (projectId.length === 0 || manifestId.length === 0) return null;
  return { projectId, manifestId, installed };
}

/**
 * The manifest id behind a plugin instance key. Identity for an installed or
 * builtin plugin; the bare `publisher.name` for a project instance.
 *
 * This is what belongs in anything the *repository* sees — the project-scope
 * settings and storage filenames under `<projectRoot>/.daintree/` are
 * git-tracked, so writing a machine-local project id into them would commit one
 * developer's identity into everyone's checkout.
 */
export function pluginManifestIdFromInstanceKey(instanceKey: string): string {
  return parseProjectPluginInstanceKey(instanceKey)?.manifestId ?? instanceKey;
}

/** The owning project of a plugin instance key, or null for an app-global one. */
export function projectIdFromPluginInstanceKey(instanceKey: string): string | null {
  return parseProjectPluginInstanceKey(instanceKey)?.projectId ?? null;
}
