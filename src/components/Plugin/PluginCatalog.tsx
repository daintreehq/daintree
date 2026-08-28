import { PLUGIN_CATEGORIES } from "@shared/config/pluginCategoryRegistry";
import type { LoadedPluginInfo } from "@shared/types/plugin";
import { cn } from "@/lib/utils";
import { categoryIconFor, PluginIconTile } from "./pluginIcons";
import { pluginLabel } from "./PluginDetailPane";
import { groupPluginsByCategory } from "./pluginGrouping";

const CARD_BADGE_CLASS =
  "inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-daintree-border/50 text-text-secondary uppercase tracking-wide";

function PluginCard({ plugin, onSelect }: { plugin: LoadedPluginInfo; onSelect: () => void }) {
  const disabled = plugin.disabled === true;
  const blurb = plugin.manifest.tagline ?? plugin.manifest.description;
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
      <PluginIconTile manifest={plugin.manifest} size="md" dimmed={disabled} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 flex-wrap">
          <span
            className={cn(
              "text-sm font-medium truncate",
              disabled ? "text-daintree-text/50" : "text-text-primary"
            )}
          >
            {pluginLabel(plugin)}
          </span>
          <span className="text-2xs font-normal text-text-secondary">
            v{plugin.manifest.version}
          </span>
          {disabled && <span className={CARD_BADGE_CLASS}>Disabled</span>}
        </span>
        {blurb && (
          <span
            className={cn(
              "mt-1 block text-xs line-clamp-2",
              disabled ? "text-text-placeholder" : "text-text-secondary"
            )}
          >
            {blurb}
          </span>
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
 */
export function PluginCatalog({
  plugins,
  onSelect,
}: {
  plugins: readonly LoadedPluginInfo[];
  onSelect: (pluginName: string) => void;
}) {
  const sections = groupPluginsByCategory(plugins);

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-semibold text-text-primary">Explore plugins</h3>
        <p className="text-sm text-text-secondary mt-1">
          First-party plugins that ship with Daintree, with more on the way
        </p>
      </div>
      {PLUGIN_CATEGORIES.map((category) => {
        const sectionPlugins = sections.get(category.id);
        if (!sectionPlugins || sectionPlugins.length === 0) return null;
        const CategoryIcon = categoryIconFor(category.id);
        return (
          <section key={category.id} aria-label={category.label}>
            <div className="flex items-center gap-2">
              <CategoryIcon className="w-4 h-4 text-daintree-text/50" aria-hidden="true" />
              <h4 className="text-sm font-medium text-text-primary">{category.label}</h4>
              <span className="text-2xs text-daintree-text/40">{sectionPlugins.length}</span>
            </div>
            <p className="text-xs text-text-secondary mt-0.5">{category.blurb}</p>
            <div className="mt-3 grid gap-3 grid-cols-[repeat(auto-fill,minmax(260px,1fr))]">
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
