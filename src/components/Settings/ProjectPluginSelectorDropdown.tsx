import { FolderCog, Package } from "lucide-react";
import { SettingsSubjectPicker } from "./SettingsSubjectPicker";

/** The pseudo-entry that selects the project-wide pane rather than one plugin. */
export const PROJECT_PLUGINS_OVERVIEW_ID = "overview";

/**
 * One selectable plugin. `origin` decides which group it lands in and what the
 * off switch beside it will mean — a project plugin is muted (never loaded), an
 * installed one is hidden (still running, filtered out of this project's views).
 */
export interface ProjectPluginOption {
  /**
   * Opaque selection key, unique across both origins. A project plugin can
   * share its manifest id with an installed one, so the caller namespaces this;
   * filtering uses `pluginId` so that namespacing never becomes search text.
   */
  id: string;
  /** The plugin's own id, as someone would type it into the filter. */
  pluginId: string;
  name: string;
  origin: "project" | "installed";
  /** Short state word beside the name — "Running", "Staged", "Off", "Invalid". */
  status: string;
  /** Whether the plugin is doing anything in this project right now. */
  active: boolean;
}

interface ProjectPluginSelectorDropdownProps {
  options: readonly ProjectPluginOption[];
  activeId: string;
  onChange: (id: string) => void;
}

type PickerItem =
  | { kind: "overview"; id: typeof PROJECT_PLUGINS_OVERVIEW_ID }
  | (ProjectPluginOption & { kind: "plugin" });

const OVERVIEW_ITEM: PickerItem = { kind: "overview", id: PROJECT_PLUGINS_OVERVIEW_ID };

/**
 * Named for where the plugins come from. "This project" is already the fixed
 * first entry's name, and a group header reading the same words sat directly
 * under it meaning something else.
 */
const GROUP_LABEL: Record<ProjectPluginOption["origin"], string> = {
  project: "Project plugins",
  installed: "Installed plugins",
};

/**
 * Plugin picker for the project Plugins tab: the shared settings subject picker,
 * with the plugins grouped by where they come from — a project's own folder or
 * installed everywhere — because the off switch beside each means something
 * different (muted, never loaded, vs hidden from this project's views).
 */
export function ProjectPluginSelectorDropdown({
  options,
  activeId,
  onChange,
}: ProjectPluginSelectorDropdownProps) {
  const entries: PickerItem[] = options.map((plugin) => ({ ...plugin, kind: "plugin" }));
  const selected = options.find((p) => p.id === activeId) ?? null;

  return (
    <SettingsSubjectPicker<PickerItem>
      idPrefix="project-plugin-selector"
      overview={OVERVIEW_ITEM}
      entries={entries}
      // By the plugin's own id, never the namespaced selection key.
      matches={(item, q) =>
        item.kind === "plugin" &&
        (item.name.toLowerCase().includes(q) || item.pluginId.toLowerCase().includes(q))
      }
      groupOf={(item) => (item.kind === "plugin" ? GROUP_LABEL[item.origin] : undefined)}
      activeId={selected ? selected.id : PROJECT_PLUGINS_OVERVIEW_ID}
      onChange={onChange}
      listLabel="Plugins"
      filterLabel="Filter plugins"
      placeholder="Filter plugins…"
      noMatches={(q) => <>No plugins match &ldquo;{q}&rdquo;</>}
      switchLabel="Switch plugin"
      triggerLabel={`Switch plugin, current: ${selected ? selected.name : "This project"}`}
      status={
        selected ? (
          <span data-testid="project-plugin-selector-status">{selected.status}</span>
        ) : undefined
      }
      current={
        selected ? (
          <>
            <Package size={18} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-base font-semibold">{selected.name}</span>
          </>
        ) : (
          <>
            <FolderCog size={18} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-base font-semibold">This project</span>
          </>
        )
      }
      renderRow={(item) =>
        item.kind === "overview" ? (
          <>
            <FolderCog size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="truncate">This project</div>
              <div className="text-xs text-text-secondary truncate">
                Trust and reload for the whole folder
              </div>
            </div>
          </>
        ) : (
          <>
            <Package size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
            <span className="flex-1 min-w-0 truncate">{item.name}</span>
            <span className="text-xs text-text-secondary shrink-0">{item.status}</span>
          </>
        )
      }
    />
  );
}
