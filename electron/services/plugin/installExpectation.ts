import { SCOPED_PLUGIN_NAME_PATTERN } from "../../schemas/pluginIdentifiers.js";
import type { PluginInstallExpectation } from "../../../shared/types/plugin.js";

/** A lowercase hex SHA-256, the form `computeArchiveHash` produces. */
export const ARCHIVE_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Rebuild an install binding from untrusted input, with `kind` made explicit.
 * Returns `null` for anything malformed, and every caller treats `null` as a
 * refusal: falling back to an unbound install would drop the guarantee the
 * caller asked for. A binding without `kind` is an update, the stricter reading,
 * so a caller that predates fresh-install bindings keeps its meaning.
 */
export function parseInstallExpectation(value: unknown): PluginInstallExpectation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { kind, pluginId, archiveHash } = value as Record<string, unknown>;
  if (typeof archiveHash !== "string" || !ARCHIVE_HASH_PATTERN.test(archiveHash)) return null;
  if (pluginId !== undefined) {
    if (typeof pluginId !== "string" || !SCOPED_PLUGIN_NAME_PATTERN.test(pluginId)) return null;
  }
  if (kind === undefined || kind === "update") {
    return pluginId === undefined ? null : { kind: "update", pluginId, archiveHash };
  }
  if (kind === "install") {
    return pluginId === undefined
      ? { kind: "install", archiveHash }
      : { kind: "install", pluginId, archiveHash };
  }
  return null;
}
