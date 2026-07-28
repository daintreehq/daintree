import type { ComponentType, SVGProps } from "react";
import { GitHubIcon, GitPullRequest, LayoutPanelTop, Plug } from "@/components/icons";
import { DEFAULT_PLUGIN_ICON } from "@/components/icons/pluginIconRegistry";
import { isPluginCategoryId, resolvePluginCategory } from "@shared/config/pluginCategoryRegistry";
import type { PluginCategoryId, PluginManifest } from "@shared/types/plugin";
import { cn } from "@/lib/utils";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * First-party plugins with a recognizable third-party mark render it (brand
 * icons live in `src/components/icons/brands/`); everything else falls back to
 * its category's Lucide icon so no two adjacent categories read identically.
 * Keyed by manifest name — provenance-independent, so a dev-mode load of the
 * same plugin keeps its mark.
 */
const BRAND_PLUGIN_ICONS: Record<string, IconComponent> = {
  "daintree.github": GitHubIcon,
};

const CATEGORY_FALLBACK_ICONS: Record<PluginCategoryId, IconComponent> = {
  forge: GitPullRequest,
  ai: Plug,
  workspace: LayoutPanelTop,
  // Shared with the toolbar/settings surfaces so an uncategorized plugin reads
  // the same everywhere it appears.
  other: DEFAULT_PLUGIN_ICON,
};

export function pluginIconFor(manifest: PluginManifest): IconComponent {
  return pluginIconForIdentity(manifest.name, resolvePluginCategory(manifest));
}

/**
 * Icon resolution from bare identity, for callers that hold a manifest
 * projection rather than the full manifest (the archive-install preview
 * resolves its category on main, where `contributes` is available). The
 * category is re-validated at runtime: a projection that crossed IPC (or a
 * stale replay-buffer payload from a version-skewed build) could carry an
 * unknown value, and an undefined icon component would crash the consuming
 * dialog with a reset key that never changes — wedging its intent queue.
 */
export function pluginIconForIdentity(name: string, category: PluginCategoryId): IconComponent {
  return (
    BRAND_PLUGIN_ICONS[name] ??
    CATEGORY_FALLBACK_ICONS[isPluginCategoryId(category) ? category : "other"]
  );
}

export function categoryIconFor(category: PluginCategoryId): IconComponent {
  return CATEGORY_FALLBACK_ICONS[category];
}

const TILE_SIZE_CLASS = {
  /** Master-list row. */
  sm: "w-8 h-8 [&>svg]:w-4 [&>svg]:h-4",
  /** Catalog card. */
  md: "w-10 h-10 [&>svg]:w-5 [&>svg]:h-5",
  /** Detail-pane hero. */
  lg: "w-12 h-12 [&>svg]:w-6 [&>svg]:h-6",
} as const;

/**
 * Squircle icon tile — the catalog's identity mark for a plugin. A neutral
 * recessed surface keeps brand glyphs legible on any theme without per-brand
 * background colors (accent restraint: the tile is never a focus signal).
 */
export function PluginIconTile({
  manifest,
  size,
  dimmed = false,
  className,
}: {
  manifest: PluginManifest;
  size: keyof typeof TILE_SIZE_CLASS;
  /** Disabled-plugin treatment — mutes the glyph, keeps the tile shape. */
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <PluginGlyphTile
      icon={pluginIconFor(manifest)}
      size={size}
      dimmed={dimmed}
      className={className}
    />
  );
}

/**
 * The tile shape with an explicit glyph, for surfaces that resolve the icon
 * without a full manifest (see {@link pluginIconForIdentity}).
 */
export function PluginGlyphTile({
  icon: Icon,
  size,
  dimmed = false,
  className,
}: {
  icon: IconComponent;
  size: keyof typeof TILE_SIZE_CLASS;
  dimmed?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center shrink-0 rounded-[var(--radius-md)] bg-overlay-subtle border border-daintree-border/50",
        TILE_SIZE_CLASS[size],
        dimmed ? "text-daintree-text/30" : "text-daintree-text/70",
        className
      )}
    >
      <Icon />
    </span>
  );
}
