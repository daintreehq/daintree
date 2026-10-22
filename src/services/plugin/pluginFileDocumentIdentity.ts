/**
 * Every host-owned plugin file document's `identityKey` (#13809) carries this
 * prefix, so the file panel can tell a draft the plugin document controller
 * owns from one the built-in editor owns without loading the controller.
 */
const PREFIX = "plugin-file-editor\u0000";

export function pluginFileDocumentIdentity(projectId: string, filePath: string): string {
  return `${PREFIX}${projectId}\u0000${filePath}`;
}

export function isPluginFileDocumentIdentity(identityKey: string): boolean {
  return identityKey.startsWith(PREFIX);
}
