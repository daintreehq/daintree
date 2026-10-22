import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { resolveContainedPath } from "./pluginFsContainment.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { stripUtf8Bom } from "../../utils/stripUtf8Bom.js";
import {
  compilePluginTheme,
  getPluginThemeGateFailures,
  makePluginThemeId,
  parsePluginThemeFile,
} from "../../../shared/theme/pluginThemes.js";
import type { AppColorScheme, PluginThemeSource } from "../../../shared/theme/types.js";
import type { ThemeContribution } from "../../../shared/types/plugin.js";

/**
 * Main-process registry for plugin-contributed themes (#13832). Main owns it:
 * the theme selection is persisted here, and renderers receive the compiled
 * catalog over `plugin:themes-get` / `plugin:themes-changed`.
 *
 * Loading is split from registration so the files can be read before the
 * plugin commits and the outcome recorded against the committed instance:
 * {@link loadPluginThemes} reads, validates, compiles and gates each file, and
 * {@link registerPluginThemes} indexes what passed. A theme that fails anywhere
 * is refused on its own; the plugin's other contributions are unaffected.
 */

/** Generous for a palette plus overrides; bounds what a manifest of themes can make main read. */
const MAX_THEME_FILE_BYTES = 128 * 1024;

export interface RegisteredPluginTheme {
  source: PluginThemeSource;
  scheme: AppColorScheme;
}

export interface PluginThemeLoadResult {
  accepted: RegisteredPluginTheme[];
  /** One line per refused theme, for the plugin's own log. */
  refused: Array<{ themeId: string; reason: string }>;
}

const themesById = new Map<string, RegisteredPluginTheme>();
const idsByPlugin = new Map<string, Set<string>>();

function summarize(failures: string[]): string {
  const shown = failures.slice(0, 3).join("; ");
  return failures.length > 3 ? `${shown}; and ${failures.length - 3} more` : shown;
}

async function readThemeFile(
  pluginId: string,
  pluginDir: string,
  contribution: ThemeContribution
): Promise<unknown> {
  const requested = path.resolve(pluginDir, contribution.path);
  const contained = await resolveContainedPath(pluginId, requested, [pluginDir]);
  const stats = await stat(contained);
  // A directory, device or FIFO reports a small size but could block or stream
  // past the cap through `readFile`.
  if (!stats.isFile()) throw new Error("theme path is not a regular file");
  if (stats.size > MAX_THEME_FILE_BYTES) {
    throw new Error(`theme file exceeds ${MAX_THEME_FILE_BYTES} bytes (${stats.size})`);
  }
  try {
    return JSON.parse(stripUtf8Bom(await readFile(contained, "utf8")));
  } catch (err) {
    throw new Error(formatErrorMessage(err, "theme file is not valid JSON"), { cause: err });
  }
}

/**
 * Read and vet a plugin's declared themes. Touches no registry state, so a
 * load that is overtaken by an unload can simply drop the result.
 */
export async function loadPluginThemes(
  pluginId: string,
  pluginName: string,
  pluginDir: string,
  contributions: readonly ThemeContribution[]
): Promise<PluginThemeLoadResult> {
  const result: PluginThemeLoadResult = { accepted: [], refused: [] };
  for (const contribution of contributions) {
    let raw: unknown;
    try {
      raw = await readThemeFile(pluginId, pluginDir, contribution);
    } catch (err) {
      result.refused.push({
        themeId: contribution.id,
        reason: `couldn't read ${contribution.path}: ${formatErrorMessage(err, "unreadable")}`,
      });
      continue;
    }
    const file = parsePluginThemeFile(raw, contribution.type);
    if (!file.ok) {
      result.refused.push({ themeId: contribution.id, reason: summarize(file.errors) });
      continue;
    }
    const source: PluginThemeSource = {
      id: makePluginThemeId(pluginId, contribution.id),
      name: contribution.name,
      type: contribution.type,
      pluginId,
      pluginName,
      ...file.file,
    };
    const scheme = compilePluginTheme(source);
    const failures = getPluginThemeGateFailures(scheme);
    if (failures.length > 0) {
      result.refused.push({
        themeId: contribution.id,
        reason: `failed ${failures.length} contrast ${failures.length === 1 ? "check" : "checks"}: ${summarize(failures)}`,
      });
      continue;
    }
    result.accepted.push({ source, scheme });
  }
  return result;
}

/** Index a plugin's accepted themes, replacing any it registered before. */
export function registerPluginThemes(
  pluginId: string,
  themes: readonly RegisteredPluginTheme[]
): void {
  dropPluginThemes(pluginId);
  if (themes.length === 0) return;
  const ids = new Set<string>();
  for (const theme of themes) {
    themesById.set(theme.source.id, theme);
    ids.add(theme.source.id);
  }
  idsByPlugin.set(pluginId, ids);
}

function dropPluginThemes(pluginId: string): boolean {
  const ids = idsByPlugin.get(pluginId);
  if (!ids) return false;
  for (const id of ids) themesById.delete(id);
  idsByPlugin.delete(pluginId);
  return true;
}

/** Drop every theme registered by `pluginId`. Returns whether it had any. */
export function unregisterPluginThemes(pluginId: string): boolean {
  return dropPluginThemes(pluginId);
}

/** Reset the registry (test isolation / full plugin-system teardown). */
export function clearPluginThemeRegistry(): void {
  themesById.clear();
  idsByPlugin.clear();
}

export function getPluginTheme(id: string): RegisteredPluginTheme | undefined {
  return themesById.get(id);
}

/** Every offered plugin theme, compiled, in plugin load order. Fresh copies: the array crosses IPC. */
export function getPluginThemeSchemes(): AppColorScheme[] {
  return [...themesById.values()].map(({ scheme }) => structuredClone(scheme));
}
