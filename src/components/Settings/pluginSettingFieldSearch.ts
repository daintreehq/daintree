import type { SettingDefinition } from "@shared/types/plugin";
import type { SettingsSearchEntry } from "./settingsSearchIndex";
import { filterSettings, MIN_MATCH_CHARS } from "./settingsSearchUtils";

/**
 * What a declared plugin setting is found by, in the Settings dialog and in the
 * plugin's own settings: its label (its key when it has none), its description,
 * and its key.
 */
export function pluginSettingSearchText(
  def: SettingDefinition
): Pick<SettingsSearchEntry, "title" | "description"> & { keywords: string[] } {
  return { title: def.label ?? def.id, description: def.description ?? "", keywords: [def.id] };
}

/**
 * The rows a plugin's settings form filters: the dialog's rows for the same
 * fields, without the plugin's name and the tab label every one of them carries.
 * Those would keep every field the moment the query named the plugin.
 */
export function pluginSettingFilterIndex(
  defs: readonly SettingDefinition[]
): SettingsSearchEntry[] {
  return defs.map((def) => ({
    id: def.id,
    tab: "plugins",
    tabLabel: "",
    scope: "global",
    kind: "section",
    section: "",
    ...pluginSettingSearchText(def),
  }));
}

/**
 * The keys of the fields `query` matches, through the Settings dialog's matcher,
 * or `null` when there is nothing to filter by yet. Every word has to match, and
 * a single character finds a field only by chance (a doubled letter makes a
 * two-character match), so a word that short is left out until it grows rather
 * than emptying the form on the keystroke that starts it.
 */
export function matchPluginSettingFields(
  index: readonly SettingsSearchEntry[],
  query: string
): ReadonlySet<string> | null {
  const words = query.split(/\s+/).filter((word) => word.length >= MIN_MATCH_CHARS);
  if (words.length === 0) return null;
  return new Set(filterSettings(index, words.join(" ")).map((entry) => entry.id));
}
