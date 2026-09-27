import { createHash } from "node:crypto";

export const PLUGIN_SERVER_KEY_PREFIX = "daintree-";
// Claude names a server's tools `mcp__<server>__<tool>` under a 64-character
// tool-name limit. Tool names are capped at 32 (AGENT_MCP_TOOL_NAME_PATTERN),
// which leaves 25 for the key. Codex reads the key as a bare TOML key, so it
// also stays inside `[a-z0-9-]`.
export const MAX_PLUGIN_SERVER_KEY_LENGTH = 25;
const MAX_NAME_LENGTH = MAX_PLUGIN_SERVER_KEY_LENGTH - PLUGIN_SERVER_KEY_PREFIX.length;
const HASH_LENGTH = 8;
const FALLBACK_NAME = "plugin";

export interface PluginServerNameInput {
  readonly pluginInstanceId: string;
  readonly pluginManifestId: string;
  readonly origin: "global" | "project";
  readonly mcpName?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

function withHashSuffix(base: string, hash: string): string {
  return `${base.slice(0, MAX_PLUGIN_SERVER_KEY_LENGTH - hash.length - 1)}-${hash}`;
}

/** A name for a plugin that declares no `mcpName`: the last segment of its manifest id. */
export function fallbackPluginMcpName(manifestId: string): string {
  const name = (manifestId.split(".").pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, "");
  return name === "" ? FALLBACK_NAME : name;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The MCP server key each plugin is handed to agents under, keyed by instance.
 *
 * A plugin is `daintree-<mcpName>`, or `daintree-<last segment of its manifest
 * id>` when it declares no name, so a key depends on the plugin and never on
 * the project. When plugins share a name, one keeps it: installed plugins
 * before project plugins, then manifest ids in code-point order. Every other
 * member of the group gets eight hex characters of a hash of its origin and
 * manifest id, so a project copy of an installed plugin is named the same in
 * every project, and an installed plugin keeps its name when a project copy of
 * it appears. Only the set of plugins decides the keys, never the order they
 * are listed in.
 */
export function pluginServerKeysFor(
  plugins: readonly PluginServerNameInput[]
): Map<string, string> {
  const identity = (p: PluginServerNameInput) => `${p.origin}\0${p.pluginManifestId}`;
  const ordered = [...plugins].sort(
    (a, b) =>
      (a.origin === b.origin ? 0 : a.origin === "global" ? -1 : 1) ||
      compare(a.pluginManifestId, b.pluginManifestId) ||
      compare(a.pluginInstanceId, b.pluginInstanceId)
  );
  const baseOf = (p: PluginServerNameInput) =>
    `${PLUGIN_SERVER_KEY_PREFIX}${p.mcpName ?? fallbackPluginMcpName(p.pluginManifestId)}`;

  const keys = new Map<string, string>();
  const used = new Set<string>();
  const losers: PluginServerNameInput[] = [];
  // Every plain name is claimed before any hashed one is chosen, so a hashed
  // key can never take a name its owner would otherwise have kept.
  for (const plugin of ordered) {
    const base = baseOf(plugin);
    if (used.has(base)) {
      losers.push(plugin);
      continue;
    }
    used.add(base);
    keys.set(plugin.pluginInstanceId, base);
  }
  for (const plugin of losers) {
    const base = baseOf(plugin);
    let key = withHashSuffix(base, shortHash(identity(plugin)));
    for (let n = 2; used.has(key); n++) {
      key = withHashSuffix(base, shortHash(`${identity(plugin)}\0${n}`));
    }
    used.add(key);
    keys.set(plugin.pluginInstanceId, key);
  }
  return keys;
}
