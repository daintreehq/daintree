import type { SettingsTab, SettingsScope } from "./SettingsDialog";
import { sharedSettingOwner, type SettingRef } from "@/hooks/useSettingsOwner";
import {
  PROJECT_SETTINGS_SECTIONS,
  PROJECT_TAB_IDS,
  SETTINGS_REGISTRY,
  type AnySettingsTabEntry,
  type SettingsSectionMeta,
} from "./settingsTabRegistry";

export interface SettingsSearchEntry {
  id: string;
  tab: SettingsTab;
  tabLabel: string;
  scope: SettingsScope;
  /**
   * What the setting writes to, when that differs from the nav scope it is filed under
   * (`scope`). Drives the scope the result's chip names; `scope` still decides where
   * opening it navigates.
   */
  effectScope?: SettingsScope;
  /**
   * Classifies the entry for the post-scoring pass. `tab-nav` is the
   * synthetic row generated for each tab's nav target (id `tab-nav-${tab}`);
   * `section` is a content section surfaced inside a tab. Required so the
   * ranker can distinguish tab-navigation rows from real content sections
   * without depending on id-prefix conventions — historical content ids
   * like `tab-nav-project:environments` would otherwise be misclassified.
   */
  kind: "tab-nav" | "section";
  /** Optional subtab id to activate when navigating to this result. */
  subtab?: string;
  /** Human-readable subtab label used in search breadcrumbs and haystack. */
  subtabLabel?: string;
  section: string;
  title: string;
  description: string;
  keywords?: string[];
  /**
   * What the match writes, when one machine owns it. The result names that owner
   * the way the page does, from the same declarations.
   */
  settings?: readonly SettingRef[];
  /**
   * Set on a plugin's settings: a declared setting, a section of its settings
   * home, or the home itself. Opening it goes through `plugin.openSettings`, the
   * same landing as `host.settings.open(key)`, instead of tab navigation.
   */
  plugin?: PluginSettingsSearchTarget;
  /** When set, indicates this setting is only visible when a parent setting is enabled. */
  requiresEnabled?: {
    /** id of the gate entry in the search index (e.g. "mcp-server-enable") */
    settingId: string;
    /** Human-readable label shown in warnings (e.g. "MCP server") */
    label: string;
    /** A proper noun, never lowercased mid-sentence (e.g. "Decisions") */
    keepCase?: boolean;
  };
}

/** What a plugin search result asks `plugin.openSettings` to land on. */
export interface PluginSettingsSearchTarget {
  instanceId: string;
  /** A declared setting id. */
  settingId?: string;
  /** A section of the home, when the result is not one setting. */
  section?: "account" | "setup" | "custom";
  /** A declared page of the custom section. */
  page?: string;
  /** Which home, for what an installed plugin shows in both. */
  scope?: "user" | "project";
}

function sectionToEntry(
  section: SettingsSectionMeta,
  tab: SettingsTab,
  tabLabel: string,
  scope: SettingsScope,
  effectScope: SettingsScope | undefined,
  settings: readonly SettingRef[] | undefined
): SettingsSearchEntry {
  return {
    id: section.id,
    tab,
    tabLabel,
    scope,
    ...(effectScope && effectScope !== scope ? { effectScope } : {}),
    kind: "section",
    section: section.section,
    title: section.title,
    description: section.description,
    ...(section.keywords ? { keywords: [...section.keywords] } : {}),
    ...(settings ? { settings } : {}),
    ...(section.subtab !== undefined ? { subtab: section.subtab } : {}),
    ...(section.subtabLabel !== undefined ? { subtabLabel: section.subtabLabel } : {}),
    ...(section.requiresEnabled
      ? {
          requiresEnabled: {
            settingId: section.requiresEnabled.settingId,
            label: section.requiresEnabled.label,
            ...(section.requiresEnabled.keepCase ? { keepCase: true } : {}),
          },
        }
      : {}),
  };
}

function buildEntriesForTab(
  tab: SettingsTab,
  tabLabel: string,
  scope: SettingsScope,
  navDescription: string,
  navKeywords: readonly string[] | undefined,
  sections: readonly SettingsSectionMeta[] | undefined,
  effectScope: SettingsScope | undefined,
  tabSettings: readonly SettingRef[],
  sectionSettings: Readonly<Record<string, readonly SettingRef[]>> | undefined
): SettingsSearchEntry[] {
  // A page that holds both owners names none of its own; its sections say which.
  const pageSettings = sharedSettingOwner(tabSettings) === null ? undefined : tabSettings;
  const navEntry: SettingsSearchEntry = {
    id: `tab-nav-${tab}`,
    tab,
    tabLabel,
    scope,
    ...(effectScope && effectScope !== scope ? { effectScope } : {}),
    kind: "tab-nav",
    section: "Settings Navigation",
    title: tabLabel,
    description: navDescription,
    ...(navKeywords ? { keywords: [...navKeywords] } : {}),
    ...(pageSettings ? { settings: pageSettings } : {}),
  };
  if (!sections || sections.length === 0) return [navEntry];
  return [
    navEntry,
    ...sections.map((s) =>
      sectionToEntry(
        s,
        tab,
        tabLabel,
        scope,
        effectScope,
        s.settings ?? sectionSettings?.[s.section] ?? pageSettings
      )
    ),
  ];
}

function projectTabSettings(tab: SettingsTab): readonly SettingRef[] {
  const entry: AnySettingsTabEntry | undefined = SETTINGS_REGISTRY.find((e) => e.id === tab);
  return entry?.settings ?? [];
}

function deriveSettingsSearchIndex(): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];

  for (const tab of SETTINGS_REGISTRY as readonly AnySettingsTabEntry[]) {
    if (tab.scope === "project") continue;
    entries.push(
      // Use tab.label (the short form, e.g. "GitHub") rather than
      // tab.headerTitle (e.g. "GitHub Integration") for the search-side
      // tabLabel. headerTitle is the in-panel H1 — it's longer and more
      // descriptive but it never matches what the user types (they type
      // "github", not "github integration"), and project-scope tabs only
      // expose the short label, so this also keeps tabLabel consistent
      // across scopes for the result-row breadcrumb.
      ...buildEntriesForTab(
        tab.id,
        tab.label,
        tab.scope,
        tab.searchNavDescription ?? "",
        tab.searchNavKeywords,
        tab.sections,
        tab.contentScope,
        tab.settings,
        tab.sectionSettings
      )
    );
  }

  for (const projectTabId of PROJECT_TAB_IDS) {
    const meta = PROJECT_SETTINGS_SECTIONS[projectTabId];
    if (!meta) continue;
    entries.push(
      ...buildEntriesForTab(
        projectTabId,
        meta.tabLabel,
        "project",
        meta.searchNavDescription,
        meta.searchNavKeywords,
        meta.sections,
        undefined,
        projectTabSettings(projectTabId),
        undefined
      )
    );
  }

  return entries;
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = deriveSettingsSearchIndex();
