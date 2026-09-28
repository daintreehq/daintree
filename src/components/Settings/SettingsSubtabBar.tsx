import { UnderlineTabs, type UnderlineTabItem } from "@/components/ui/UnderlineTabs";

export type SettingsSubtabItem = UnderlineTabItem;

interface SettingsSubtabBarProps {
  subtabs: SettingsSubtabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /**
   * Distinguishes this bar's ids from every other subtab bar in the dialog, and keys
   * `subtabPanelProps` so a consumer can point its panel back at the right tab.
   */
  group: string;
  /**
   * The tablist's accessible name. Required because the settings dialog nests this bar
   * inside the sidebar's own tablist, and the WAI-ARIA Tabs pattern needs each of two
   * nested tablists to say which one it is — "Subtab navigation" on all five of them
   * told a screen-reader user nothing about which level they were driving.
   */
  ariaLabel: string;
}

const tabId = (group: string, id: string) => `settings-subtab-${group}-${id}`;
const panelId = (group: string, id: string) => `settings-subtabpanel-${group}-${id}`;

/**
 * Props for the element holding the active subtab's content. Spread onto a wrapper the
 * consumer renders, so the tab and its panel reference each other the way the sidebar
 * tablist and its panels already do.
 */
export function subtabPanelProps(group: string, activeId: string) {
  return {
    role: "tabpanel" as const,
    id: panelId(group, activeId),
    "aria-labelledby": tabId(group, activeId),
    tabIndex: -1,
  };
}

export function SettingsSubtabBar({
  subtabs,
  activeId,
  onChange,
  group,
  ariaLabel,
}: SettingsSubtabBarProps) {
  if (subtabs.length === 0) return null;

  return (
    <div className="border-b border-border-default mb-6">
      <UnderlineTabs
        tabs={subtabs}
        activeId={activeId}
        onChange={onChange}
        aria-label={ariaLabel}
        tabId={(id) => tabId(group, id)}
        panelId={(id) => panelId(group, id)}
      />
      {subtabs
        .filter((subtab) => subtab.id !== activeId)
        .map((subtab) => (
          <div
            key={subtab.id}
            role="tabpanel"
            id={panelId(group, subtab.id)}
            aria-labelledby={tabId(group, subtab.id)}
            hidden
          />
        ))}
    </div>
  );
}
