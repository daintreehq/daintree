import { PLUGIN_CATEGORIES } from "@shared/config/pluginCategoryRegistry";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { categoryIconFor, PluginIconTile } from "./pluginIcons";
import { pluginLabel } from "./PluginDetailPane";
import { groupPluginsByCategory } from "./pluginGrouping";
import { pluginSignalFor } from "./pluginStatus";

const CARD_BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-border-default/50 text-text-secondary uppercase tracking-wide";

const CARD_GRID_CLASS = "grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]";

function PluginCard({ plugin, onSelect }: { plugin: LoadedPluginInfo; onSelect: () => void }) {
  const disabled = plugin.disabled === true;
  const blurb = plugin.manifest.tagline ?? plugin.manifest.description;
  // The same one signal the master row shows. The cards were the only place a
  // failed plugin still looked healthy, and they are the first thing the wide
  // pane shows on open.
  const signal = pluginSignalFor(plugin);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 p-4 text-left rounded-[var(--radius-lg)] border border-border-default bg-overlay-subtle transition-colors",
        "hover:bg-overlay-soft hover:border-border-interactive",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
      )}
    >
      <PluginIconTile
        manifest={plugin.manifest}
        size="md"
        dimmed={disabled || plugin.loadError != null || plugin.blocklisted === true}
      />
      <span className="min-w-0 flex-1">
        {/* One line, no wrap: the Disabled badge used to wrap onto a line of
            its own and made that card taller than its row neighbours. */}
        <span className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              "text-sm font-medium truncate",
              disabled ? "text-text-secondary" : "text-text-primary"
            )}
          >
            {pluginLabel(plugin)}
          </span>
          <span className="text-2xs font-normal text-text-secondary shrink-0">
            v{plugin.manifest.version}
          </span>
          {disabled && <span className={cn(CARD_BADGE_CLASS, "shrink-0")}>Disabled</span>}
        </span>
        {signal ? (
          <span className={cn("mt-1 flex items-center gap-1 text-xs font-medium", signal.tone)}>
            <signal.icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{signal.label}</span>
          </span>
        ) : (
          blurb && (
            <span className="mt-1 text-xs line-clamp-2 text-text-secondary">{blurb}</span>
          )
        )}
      </span>
    </button>
  );
}

/**
 * Catalog home for the detail pane — what fills the wide right side when no
 * plugin is selected. Reads as a small first-party marketplace: category
 * sections (header, blurb, card grid) in `PLUGIN_CATEGORIES` order, empty
 * sections omitted. Cards are the wide-pane treatment only; the 320px master
 * column stays dense rows — card grids degrade badly in narrow columns
 * (plugin-manager research run 2026-06-10). Selecting a card populates the
 * detail pane, same as selecting the matching row.
 *
 * While a search is active the pane is a result set, not a storefront: one flat
 * grid in the master list's own order under a heading that says what it is, so
 * the two panes present the same matches the same way. A search that matched
 * nothing gets the recovery action here — the canvas owns the one CTA when both
 * panes are empty.
 */
export function PluginCatalog({
  plugins,
  filtered = false,
  hasOtherMatches = false,
  onSelect,
  onClearSearch,
}: {
  plugins: readonly LoadedPluginInfo[];
  /** A search or filter chip is narrowing `plugins`. */
  filtered?: boolean;
  /** The filter matched project plugins, which the catalog does not show. */
  hasOtherMatches?: boolean;
  onSelect: (pluginName: string) => void;
  onClearSearch?: () => void;
}) {
  if (filtered) {
    if (plugins.length === 0 && !hasOtherMatches) {
      return (
        <div className="h-full flex items-start justify-center pt-16">
          <EmptyState
            variant="filtered-empty"
            scale="canvas"
            title="No plugins match your search"
            description="Try a different name, or clear the search to see everything installed."
            action={
              onClearSearch && (
                <Button variant="outline" size="sm" onClick={onClearSearch}>
                  Clear search
                </Button>
              )
            }
          />
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-text-primary">Matching plugins</h3>
          <p className="text-sm text-text-secondary mt-1">
            {plugins.length === 0
              ? "Only this project's plugins match. Pick one in the list."
              : plugins.length === 1
                ? "1 installed plugin matches"
                : `${plugins.length} installed plugins match`}
          </p>
        </div>
        {plugins.length > 0 && (
          <div className={CARD_GRID_CLASS}>
            {plugins.map((plugin) => (
              <PluginCard
                key={plugin.manifest.name}
                plugin={plugin}
                onSelect={() => onSelect(plugin.manifest.name)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const sections = groupPluginsByCategory(plugins);

  return (
    <div className="space-y-8">
      <div>
        {/* This grid is built from every INSTALLED plugin, whatever its
            source — it said "First-party plugins that ship with Daintree" while
            listing things the user had sideloaded from a URL. */}
        <h3 className="text-lg font-semibold text-text-primary">Installed plugins</h3>
        <p className="text-sm text-text-secondary mt-1">
          Pick one to see what it adds, what it can reach, and how to turn it off
        </p>
      </div>
      {PLUGIN_CATEGORIES.map((category) => {
        const sectionPlugins = sections.get(category.id);
        if (!sectionPlugins || sectionPlugins.length === 0) return null;
        const CategoryIcon = categoryIconFor(category.id);
        return (
          <section key={category.id} aria-label={category.label}>
            <div className="flex items-center gap-2">
              <CategoryIcon className="w-4 h-4 text-text-secondary" aria-hidden="true" />
              <h4 className="text-sm font-medium text-text-primary">{category.label}</h4>
              <span className="text-2xs text-text-secondary">{sectionPlugins.length}</span>
            </div>
            <p className="text-xs text-text-secondary mt-0.5">{category.blurb}</p>
            <div className={cn("mt-3", CARD_GRID_CLASS)}>
              {sectionPlugins.map((plugin) => (
                <PluginCard
                  key={plugin.manifest.name}
                  plugin={plugin}
                  onSelect={() => onSelect(plugin.manifest.name)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
