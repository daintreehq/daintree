import type { EventCategory } from "@shared/types";

/**
 * Action palette category badge colors.
 * Assigns one of 12 engineered category hue tokens to each action category.
 * Some categories intentionally share a hue (e.g. panels/browser both use cyan).
 *
 * Uses the `category-{hue}-subtle/-text/-border` token set (the same one Fleet
 * and recipe chips consume) rather than raw `cat-{hue}/15` opacity tints: the
 * engineered `-text` token is mixed toward `--theme-text-primary` in OKLCH so
 * the 10px chip label clears WCAG 4.5:1 in both light and dark themes, where a
 * flat 15% tint did not.
 */
export const ACTION_CATEGORY_COLORS: Record<string, string> = {
  terminal: "bg-category-blue-subtle text-category-blue-text border border-category-blue-border",
  agents:
    "bg-category-purple-subtle text-category-purple-text border border-category-purple-border",
  panels: "bg-category-cyan-subtle text-category-cyan-text border border-category-cyan-border",
  navigation:
    "bg-category-green-subtle text-category-green-text border border-category-green-border",
  worktree: "bg-category-amber-subtle text-category-amber-text border border-category-amber-border",
  github: "bg-category-slate-subtle text-category-slate-text border border-category-slate-border",
  git: "bg-category-orange-subtle text-category-orange-text border border-category-orange-border",
  project: "bg-category-teal-subtle text-category-teal-text border border-category-teal-border",
  preferences:
    "bg-category-slate-subtle text-category-slate-text border border-category-slate-border",
  app: "bg-category-indigo-subtle text-category-indigo-text border border-category-indigo-border",
  system: "bg-category-rose-subtle text-category-rose-text border border-category-rose-border",
  logs: "bg-category-amber-subtle text-category-amber-text border border-category-amber-border",
  recipes: "bg-category-pink-subtle text-category-pink-text border border-category-pink-border",
  portal:
    "bg-category-violet-subtle text-category-violet-text border border-category-violet-border",
  browser: "bg-category-cyan-subtle text-category-cyan-text border border-category-cyan-border",
};

export const ACTION_CATEGORY_DEFAULT_COLOR = "bg-tint/[0.06] text-text-secondary";

/**
 * The 12 --color-cat-* hue tokens as complete Tailwind class literals.
 * Listed in full here (not assembled from parts) so the JIT scanner keeps
 * every variant; consumers index into this array via a deterministic hash to
 * give an entity a stable colour (e.g. initials avatars). `/15` tint matches
 * the action/event chip treatment so the palette stays visually consistent.
 */
export const CAT_COLOR_CLASSES: readonly string[] = [
  "bg-cat-blue/15 text-cat-blue",
  "bg-cat-purple/15 text-cat-purple",
  "bg-cat-cyan/15 text-cat-cyan",
  "bg-cat-green/15 text-cat-green",
  "bg-cat-amber/15 text-cat-amber",
  "bg-cat-orange/15 text-cat-orange",
  "bg-cat-teal/15 text-cat-teal",
  "bg-cat-indigo/15 text-cat-indigo",
  "bg-cat-rose/15 text-cat-rose",
  "bg-cat-pink/15 text-cat-pink",
  "bg-cat-violet/15 text-cat-violet",
  "bg-cat-slate/15 text-cat-slate",
];

/**
 * Event inspector category chip styles.
 * Uses the same --color-cat-* hue tokens as action palette, assigned independently
 * to the event domain (system events ≠ system actions).
 */
export type EventCategoryStyle = {
  shortLabel: string;
  label: string;
  color: string;
};

export const EVENT_CATEGORY_STYLES: Record<EventCategory, EventCategoryStyle> = {
  system: {
    shortLabel: "SYS",
    label: "System",
    color: "bg-cat-blue/20 text-cat-blue border-cat-blue/30",
  },
  agent: {
    shortLabel: "AGT",
    label: "Agent",
    color: "bg-cat-green/20 text-cat-green border-cat-green/30",
  },
  server: {
    shortLabel: "SRV",
    label: "Server",
    color: "bg-cat-orange/20 text-cat-orange border-cat-orange/30",
  },
  file: {
    shortLabel: "FIL",
    label: "File",
    color: "bg-cat-pink/20 text-cat-pink border-cat-pink/30",
  },
  ui: {
    shortLabel: "UI",
    label: "UI",
    color: "bg-cat-indigo/20 text-cat-indigo border-cat-indigo/30",
  },
  watcher: {
    shortLabel: "WCH",
    label: "Watcher",
    color: "bg-cat-cyan/20 text-cat-cyan border-cat-cyan/30",
  },
  artifact: {
    shortLabel: "ART",
    label: "Artifact",
    color: "bg-cat-rose/20 text-cat-rose border-cat-rose/30",
  },
};
