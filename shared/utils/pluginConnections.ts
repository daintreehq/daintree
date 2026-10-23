import {
  DEFAULT_PLUGIN_CONNECTION_ID,
  type PluginConnectionContribution,
  type PluginManifest,
} from "../types/plugin.js";

/** Lowercase, starts with a letter: safe in a store key and never a prototype name. */
export const PLUGIN_CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

export function isPluginConnectionId(value: unknown): value is string {
  return typeof value === "string" && PLUGIN_CONNECTION_ID_PATTERN.test(value);
}

/**
 * The plugin's connections in manifest order. `contributes.account` is one
 * connection named `"default"`, so everything downstream handles one shape.
 */
export function declaredPluginConnections(
  manifest: Pick<PluginManifest, "contributes"> | undefined
): PluginConnectionContribution[] {
  const contributes = manifest?.contributes;
  if (!contributes) return [];
  if (contributes.connections && contributes.connections.length > 0) {
    return contributes.connections;
  }
  return contributes.account ? [{ ...contributes.account, id: DEFAULT_PLUGIN_CONNECTION_ID }] : [];
}

export function pluginDeclaresConnections(
  manifest: Pick<PluginManifest, "contributes"> | undefined
): boolean {
  return declaredPluginConnections(manifest).length > 0;
}
