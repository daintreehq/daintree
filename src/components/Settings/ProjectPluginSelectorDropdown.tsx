import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderCog, Package, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

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
  /** Short state word beside the name — "Running", "Staged", "Off", "Unreadable". */
  status: string;
  /** Whether the plugin is doing anything in this project right now. */
  active: boolean;
}

interface ProjectPluginSelectorDropdownProps {
  options: readonly ProjectPluginOption[];
  activeId: string;
  onChange: (id: string) => void;
}

type Item =
  | { kind: "overview"; id: typeof PROJECT_PLUGINS_OVERVIEW_ID }
  | { kind: "plugin"; id: string; plugin: ProjectPluginOption };

const GROUP_LABEL: Record<ProjectPluginOption["origin"], string> = {
  project: "This project",
  installed: "Installed",
};

/**
 * Plugin picker for the project Plugins tab, in the shape the agents page
 * established: a filterable listbox in a popover, with a fixed first entry for
 * the settings that belong to the project as a whole rather than to any one
 * plugin.
 *
 * Deliberately a sibling of `AgentSelectorDropdown` rather than a generalization
 * of it. That component's option shape is agent vocabulary — brand colour, an
 * icon component, "skip permissions" — and widening it to carry plugin
 * vocabulary as well would leave both pages reading each other's fields. What is
 * worth sharing here is the interaction, and that is small enough to say twice.
 */
export function ProjectPluginSelectorDropdown({
  options,
  activeId,
  onChange,
}: ProjectPluginSelectorDropdownProps) {
  const [open, setOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const activeItemRef = useRef<HTMLDivElement>(null);

  const items: Item[] = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return [
      { kind: "overview", id: PROJECT_PLUGINS_OVERVIEW_ID },
      ...options
        .filter(
          (p) => !q || p.name.toLowerCase().includes(q) || p.pluginId.toLowerCase().includes(q)
        )
        .map((plugin) => ({ kind: "plugin" as const, id: plugin.id, plugin })),
    ];
  }, [options, filterQuery]);

  useEffect(() => {
    // Land on the first real match when filtering, and on the overview when not.
    setActiveIndex(filterQuery.trim() && items.length > 1 ? 1 : 0);
  }, [filterQuery, items]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    if (!open) setFilterQuery("");
  }, [open]);

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((prev) => Math.min(prev + 1, items.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((prev) => Math.max(prev - 1, 0));
        break;
      case "Enter": {
        const item = items[activeIndex];
        if (item) {
          e.preventDefault();
          handleSelect(item.id);
        }
        break;
      }
    }
  };

  const selected = options.find((p) => p.id === activeId) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          data-testid="project-plugin-selector-trigger"
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 text-sm rounded-[var(--radius-md)]",
            "border border-border-default bg-surface-canvas text-text-primary",
            // Hover is neutral on purpose. Accent is at most one load-bearing
            // signal per focus region, and here that one is the focus ring
            // below — spending it on a hover border as well would make the
            // colour mean "you could click this" and "this is focused" at once.
            "hover:border-border-strong transition-colors",
            "focus:outline-hidden focus:ring-2 focus:ring-accent-primary/50"
          )}
        >
          {selected ? (
            <>
              <Package
                size={16}
                className={cn(
                  "shrink-0",
                  selected.active ? "text-text-secondary" : "text-text-placeholder"
                )}
                aria-hidden="true"
              />
              <span className="flex-1 text-left truncate">{selected.name}</span>
              <span className="text-2xs text-text-secondary shrink-0">{selected.status}</span>
            </>
          ) : (
            <>
              <FolderCog size={16} className="shrink-0 text-text-secondary" aria-hidden="true" />
              <span className="flex-1 text-left truncate">This project</span>
            </>
          )}
          <ChevronDown
            size={14}
            className={cn(
              "shrink-0 text-text-secondary transition-transform",
              open && "rotate-180"
            )}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="p-0"
        style={{ width: "var(--radix-popover-trigger-width)" }}
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border-default">
          <Search size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
          <input
            type="text"
            autoFocus
            placeholder="Filter plugins…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            role="combobox"
            aria-label="Filter plugins"
            aria-expanded={open}
            aria-autocomplete="list"
            aria-controls="project-plugin-selector-list"
            aria-activedescendant={
              items[activeIndex]
                ? `project-plugin-selector-item-${items[activeIndex].id}`
                : undefined
            }
            className="flex-1 min-w-0 px-1 py-0.5 text-xs bg-transparent text-text-primary placeholder:text-text-placeholder rounded-[var(--radius-sm)] focus:outline-hidden focus-visible:ring-1 focus-visible:ring-accent-primary"
          />
        </div>
        <div
          role="listbox"
          id="project-plugin-selector-list"
          aria-label="Plugins"
          className="overflow-y-auto max-h-60 p-1"
        >
          {items.map((item, index) => {
            const isActive = index === activeIndex;
            const isSelected = activeId === item.id;
            // A group header before the first row of each origin, so "this
            // project's own folder" and "installed everywhere" never blur into
            // one list — they mean different things and their switches do too.
            const previous = index > 0 ? items[index - 1] : undefined;
            const groupLabel =
              item.kind === "plugin" &&
              (previous?.kind !== "plugin" || previous.plugin.origin !== item.plugin.origin)
                ? GROUP_LABEL[item.plugin.origin]
                : null;

            return (
              <div key={item.id}>
                {groupLabel && (
                  // A disabled option rather than a role="group" label — group
                  // labels drop under Chromium + VoiceOver (LESSON #9006).
                  <div
                    role="option"
                    aria-disabled="true"
                    aria-selected="false"
                    aria-label={groupLabel}
                    className="px-2 pt-2 pb-1 text-3xs font-medium uppercase tracking-wider text-text-secondary select-none"
                  >
                    {groupLabel}
                  </div>
                )}
                <div
                  ref={isActive ? activeItemRef : undefined}
                  id={`project-plugin-selector-item-${item.id}`}
                  role="option"
                  aria-selected={isSelected}
                  data-highlighted={isActive || undefined}
                  onClick={() => handleSelect(item.id)}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-sm)] cursor-pointer text-sm text-text-primary",
                    isActive && "bg-overlay-selected",
                    isSelected && "font-medium"
                  )}
                >
                  {item.kind === "overview" ? (
                    <>
                      <FolderCog size={16} className="shrink-0 text-text-secondary" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate">This project</div>
                        <div className="text-xs text-text-secondary truncate">
                          Trust and reload for the whole folder
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <Package
                        size={16}
                        className={cn(
                          "shrink-0",
                          item.plugin.active ? "text-text-secondary" : "text-text-placeholder"
                        )}
                      />
                      <span className="flex-1 min-w-0 truncate">{item.plugin.name}</span>
                      <span className="text-2xs text-text-secondary shrink-0">
                        {item.plugin.status}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
