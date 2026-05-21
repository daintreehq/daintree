import type { SettingsTab, SettingsScope } from "./SettingsDialog";
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
  /** Optional subtab id to activate when navigating to this result. */
  subtab?: string;
  /** Human-readable subtab label used in search breadcrumbs and haystack. */
  subtabLabel?: string;
  section: string;
  title: string;
  description: string;
  keywords?: string[];
  /** When set, indicates this setting is only visible when a parent setting is enabled. */
  requiresEnabled?: {
    /** id of the gate entry in the search index (e.g. "mcp-server-enable") */
    settingId: string;
    /** Human-readable label shown in warnings (e.g. "MCP server") */
    label: string;
  };
}

function sectionToEntry(
  section: SettingsSectionMeta,
  tab: SettingsTab,
  tabLabel: string,
  scope: SettingsScope
): SettingsSearchEntry {
  return {
    id: section.id,
    tab,
    tabLabel,
    scope,
    section: section.section,
    title: section.title,
    description: section.description,
    ...(section.keywords ? { keywords: [...section.keywords] } : {}),
    ...(section.subtab !== undefined ? { subtab: section.subtab } : {}),
    ...(section.subtabLabel !== undefined ? { subtabLabel: section.subtabLabel } : {}),
    ...(section.requiresEnabled
      ? {
          requiresEnabled: {
            settingId: section.requiresEnabled.settingId,
            label: section.requiresEnabled.label,
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
  sections: readonly SettingsSectionMeta[] | undefined
): SettingsSearchEntry[] {
  const navEntry: SettingsSearchEntry = {
    id: `tab-nav-${tab}`,
    tab,
    tabLabel,
    scope,
    section: "Settings Navigation",
    title: tabLabel,
    description: navDescription,
    ...(navKeywords ? { keywords: [...navKeywords] } : {}),
  };
  if (!sections || sections.length === 0) return [navEntry];
  return [navEntry, ...sections.map((s) => sectionToEntry(s, tab, tabLabel, scope))];
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
        tab.sections
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
        meta.sections
      )
    );
  }

  return entries;
}

export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = deriveSettingsSearchIndex();
