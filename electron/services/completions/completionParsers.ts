import type { FileHandle } from "fs/promises";
import { promises as fs } from "fs";
import * as path from "path";
import type { CompletionParserName } from "../../../shared/types/completionSources.js";

const FRONTMATTER_MAX_BYTES = 8 * 1024;
const TOML_MAX_BYTES = 16 * 1024;
// config.toml carries per-project/notice/tui tables alongside plugins, so it is
// read with a larger bound than a skill's inline TOML. A file past this bound
// fails closed — plugins declared beyond the cut simply do not surface.
const CODEX_CONFIG_MAX_BYTES = 256 * 1024;
const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * Raw output of a directory parser — deliberately free of `agentId`, trigger,
 * scope, label, or final id. The engine derives all of that from the source
 * config, so the same file layout can surface under different triggers/labels
 * for different agents (e.g. a skill dir as `/name` vs `$name`) without the
 * parser knowing anything about the consumer.
 */
export interface RawCompletionEntry {
  /** Name segments (nested dirs); joined by the source's nesting joiner. */
  nameParts: string[];
  /** Path of the source file relative to the scanned root. */
  relativeSourcePath: string;
  description: string | null;
  userInvocable: boolean;
}

export type CompletionParser = (rootDir: string) => Promise<RawCompletionEntry[]>;

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

async function readYamlFrontmatter(
  filePath: string
): Promise<{ description: string | null; userInvocable: boolean }> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(FRONTMATTER_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FRONTMATTER_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
    if (!normalized.startsWith("---")) return { description: null, userInvocable: true };

    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      console.warn(
        `[SlashCommandService] frontmatter truncated: closing --- not found within ${FRONTMATTER_MAX_BYTES} bytes in ${filePath}`
      );
      return { description: null, userInvocable: true };
    }

    const frontmatter = normalized.slice(3, endIndex);

    const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
    const description = descMatch ? stripWrappingQuotes(descMatch[1] ?? "") : null;

    const invocableMatch = frontmatter.match(/^user-invocable:\s*(.+)$/m);
    let userInvocable = true;
    if (invocableMatch) {
      const val = stripWrappingQuotes(invocableMatch[1] ?? "").toLowerCase();
      if (val === "false" || val === "no") userInvocable = false;
    }

    return { description, userInvocable };
  } catch {
    return { description: null, userInvocable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readTomlDescription(
  filePath: string
): Promise<{ description: string | null; userInvocable: boolean }> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(TOML_MAX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, TOML_MAX_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");

    const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;

    let description: string | null = null;
    const multilineDouble = normalized.match(/^description\s*=\s*"""\s*([\s\S]*?)\s*"""/m);
    if (multilineDouble?.[1]) {
      description = multilineDouble[1].trim();
    } else {
      const multilineSingle = normalized.match(/^description\s*=\s*'''\s*([\s\S]*?)\s*'''/m);
      if (multilineSingle?.[1]) {
        description = multilineSingle[1].trim();
      } else {
        const singleLine = normalized.match(/^description\s*=\s*(["'])(.*?)\1/m);
        if (singleLine?.[2]) description = singleLine[2].trim();
      }
    }

    const invocableMatch = normalized.match(/^user-invocable\s*=\s*(.+)$/m);
    let userInvocable = true;
    if (invocableMatch) {
      const raw = invocableMatch[1]!.trim().toLowerCase();
      if (raw === "false" || raw === "no") userInvocable = false;
    }

    return { description, userInvocable };
  } catch {
    return { description: null, userInvocable: true };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Recursively collect files with `extension`, skipping hidden entries. */
async function scanRecursiveFiles(
  rootDir: string,
  extension: string,
  read: (filePath: string) => Promise<{ description: string | null; userInvocable: boolean }>
): Promise<RawCompletionEntry[]> {
  const results: RawCompletionEntry[] = [];

  const walk = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;

    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name.startsWith(".")) return;

        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          return;
        }

        if (!entry.isFile()) return;
        if (path.extname(entry.name).toLowerCase() !== extension) return;

        const relPath = path.relative(rootDir, fullPath);
        const relNoExt = relPath.slice(0, relPath.length - path.extname(relPath).length);
        const nameParts = relNoExt.split(path.sep);
        const { description, userInvocable } = await read(fullPath);

        results.push({ nameParts, relativeSourcePath: relPath, description, userInvocable });
      })
    );
  };

  await walk(rootDir);
  return sortByPath(results);
}

/** Immediate child directories that contain a `SKILL.md`, skipping hidden. */
async function scanSkillDirectories(rootDir: string): Promise<RawCompletionEntry[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  const results: RawCompletionEntry[] = [];

  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      if (!entry.isDirectory()) return;

      const skillFile = path.join(rootDir, entry.name, "SKILL.md");
      try {
        const stat = await fs.stat(skillFile);
        if (!stat.isFile()) return;
      } catch {
        return;
      }

      const { description, userInvocable } = await readYamlFrontmatter(skillFile);
      results.push({
        nameParts: [entry.name],
        relativeSourcePath: path.join(entry.name, "SKILL.md"),
        description,
        userInvocable,
      });
    })
  );

  return sortByPath(results);
}

/**
 * Deterministic order — filesystem enumeration order is not portable. Uses a
 * code-unit comparison (a total order, unlike `localeCompare`, which can rank
 * NFC/NFD-equivalent distinct paths as equal and leak insertion order back in).
 */
function sortByPath(entries: RawCompletionEntry[]): RawCompletionEntry[] {
  return entries.sort((a, b) =>
    a.relativeSourcePath < b.relativeSourcePath
      ? -1
      : a.relativeSourcePath > b.relativeSourcePath
        ? 1
        : 0
  );
}

/** Bounded prefix read of a UTF-8 text file; null when the file is unreadable. */
async function readBoundedText(filePath: string, maxBytes: number): Promise<string | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Strip a leading UTF-8 BOM (U+FEFF) if present.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Collect the `name@marketplace` keys of enabled Codex plugins from
 * `config.toml`. Only a `[plugins."<key>"]` table with an explicit
 * `enabled = true` counts — a table without the key (or `enabled = false`) is
 * treated as disabled, matching Codex's fail-safe default and avoiding
 * surfacing merely-cached-but-off plugins. This is a narrow line scan rather
 * than a full TOML parse: it recognises the section-header form Codex writes
 * and fails closed (empty set) on anything it does not understand.
 */
async function readEnabledCodexPluginKeys(configPath: string): Promise<Set<string>> {
  const text = await readBoundedText(configPath, CODEX_CONFIG_MAX_BYTES);
  const enabled = new Set<string>();
  if (text === null) return enabled;

  const pluginHeader = /^\s*\[plugins\."([^"]+)"\]\s*$/;
  const anyHeader = /^\s*\[/;
  const enabledLine = /^\s*enabled\s*=\s*(true|false)\b/;

  let currentKey: string | null = null;
  let currentEnabled = false;
  const flush = () => {
    if (currentKey !== null && currentEnabled) enabled.add(currentKey);
  };

  for (const line of text.split(/\r?\n/)) {
    const header = line.match(pluginHeader);
    if (header) {
      flush();
      currentKey = header[1] ?? null;
      currentEnabled = false;
      continue;
    }
    // Any other table header (including a `[plugins."x".sub]` subtable) ends the
    // current plugin table. `enabled` is a direct key, so it is always seen
    // before a subtable — flushing here loses nothing.
    if (anyHeader.test(line)) {
      flush();
      currentKey = null;
      currentEnabled = false;
      continue;
    }
    if (currentKey !== null) {
      const match = line.match(enabledLine);
      if (match) currentEnabled = match[1] === "true";
    }
  }
  flush();
  return enabled;
}

/**
 * Choose a plugin's active version directory. `"local"` always wins outright
 * (mirroring Codex); otherwise the highest by code-unit order — a deterministic
 * best-effort stand-in for Codex's semver sort. Because the completion token is
 * derived from the enabled config key (not the manifest), the version chosen
 * only affects which manifest's description is shown.
 */
async function pickActivePluginVersion(pluginDir: string): Promise<string | null> {
  const entries = await fs.readdir(pluginDir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return null;

  const versions = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
  if (versions.length === 0) return null;
  if (versions.includes("local")) return "local";

  return versions.reduce((best, name) => (name > best ? name : best));
}

interface PluginManifestEntry {
  relativeSourcePath: string;
  description: string | null;
}

/**
 * Read a plugin's manifest, trying `.codex-plugin/plugin.json` then the
 * Claude-plugin-compatible `.claude-plugin/plugin.json`. Bounded read + guarded
 * `JSON.parse`; returns null (fail closed) on any read/parse error.
 * `relativeSourcePath` is relative to `codexHome` so the engine can rebuild the
 * absolute manifest path.
 */
async function readCodexPluginManifest(
  codexHome: string,
  versionDir: string
): Promise<PluginManifestEntry | null> {
  for (const manifestRel of [".codex-plugin", ".claude-plugin"]) {
    const manifestPath = path.join(versionDir, manifestRel, "plugin.json");
    const text = await readBoundedText(manifestPath, PLUGIN_MANIFEST_MAX_BYTES);
    if (text === null) continue;

    let manifest: unknown;
    try {
      manifest = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof manifest !== "object" || manifest === null) continue;

    const record = manifest as Record<string, unknown>;
    const iface =
      typeof record.interface === "object" && record.interface !== null
        ? (record.interface as Record<string, unknown>)
        : undefined;
    const pick = (value: unknown): string | null => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };
    const description = pick(iface?.shortDescription) ?? pick(record.description);

    return { relativeSourcePath: path.relative(codexHome, manifestPath), description };
  }
  return null;
}

/**
 * Registry parser for Codex plugins. Given `$CODEX_HOME`, intersects the
 * enabled `[plugins."name@market"]` tables in `config.toml` with the manifests
 * cached under `plugins/cache/<marketplace>/<plugin>/<version>/`, emitting one
 * entry per enabled plugin. Un-enabled marketplaces (e.g. a stale remote cache)
 * are skipped, so no duplicate/`disabled` plugin surfaces. Bounded, fail-closed,
 * no watcher — same contract as the directory parsers.
 */
async function scanCodexPluginRegistry(codexHome: string): Promise<RawCompletionEntry[]> {
  const enabledKeys = await readEnabledCodexPluginKeys(path.join(codexHome, "config.toml"));
  if (enabledKeys.size === 0) return [];

  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const marketplaces = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => null);
  if (marketplaces === null) return [];

  const results: RawCompletionEntry[] = [];

  await Promise.all(
    marketplaces.map(async (marketplace) => {
      if (marketplace.name.startsWith(".") || !marketplace.isDirectory()) return;

      const marketplaceDir = path.join(cacheRoot, marketplace.name);
      const plugins = await fs.readdir(marketplaceDir, { withFileTypes: true }).catch(() => null);
      if (plugins === null) return;

      await Promise.all(
        plugins.map(async (plugin) => {
          if (plugin.name.startsWith(".") || !plugin.isDirectory()) return;
          if (!enabledKeys.has(`${plugin.name}@${marketplace.name}`)) return;

          const pluginDir = path.join(marketplaceDir, plugin.name);
          const version = await pickActivePluginVersion(pluginDir);
          if (version === null) return;

          const manifest = await readCodexPluginManifest(codexHome, path.join(pluginDir, version));
          if (manifest === null) return;

          results.push({
            nameParts: [plugin.name],
            relativeSourcePath: manifest.relativeSourcePath,
            description: manifest.description,
            userInvocable: true,
          });
        })
      );
    })
  );

  return sortByPath(results);
}

/** The closed allow-list of named parsers, resolved from config strings. */
export const COMPLETION_PARSERS: Record<CompletionParserName, CompletionParser> = {
  "markdown-frontmatter": (rootDir) => scanRecursiveFiles(rootDir, ".md", readYamlFrontmatter),
  toml: (rootDir) => scanRecursiveFiles(rootDir, ".toml", readTomlDescription),
  "skill-dir": (rootDir) => scanSkillDirectories(rootDir),
  "codex-plugin-registry": (rootDir) => scanCodexPluginRegistry(rootDir),
};

export function getCompletionParser(name: CompletionParserName): CompletionParser | undefined {
  return COMPLETION_PARSERS[name];
}
