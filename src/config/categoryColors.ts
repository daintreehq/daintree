import type { EventCategory } from "@shared/types";

/**
 * Action palette category badge colors.
 * Assigns one of 12 --color-cat-* hue tokens to each action category.
 * Some categories intentionally share a hue (e.g. panels/browser both use cyan).
 */
export const ACTION_CATEGORY_COLORS: Record<string, string> = {
  terminal: "bg-cat-blue/15 text-cat-blue",
  agents: "bg-cat-purple/15 text-cat-purple",
  panels: "bg-cat-cyan/15 text-cat-cyan",
  navigation: "bg-cat-green/15 text-cat-green",
  worktree: "bg-cat-amber/15 text-cat-amber",
  github: "bg-cat-slate/15 text-cat-slate",
  git: "bg-cat-orange/15 text-cat-orange",
  project: "bg-cat-teal/15 text-cat-teal",
  preferences: "bg-cat-slate/15 text-cat-slate",
  app: "bg-cat-indigo/15 text-cat-indigo",
  system: "bg-cat-rose/15 text-cat-rose",
  logs: "bg-cat-amber/15 text-cat-amber",
  recipes: "bg-cat-pink/15 text-cat-pink",
  portal: "bg-cat-violet/15 text-cat-violet",
  browser: "bg-cat-cyan/15 text-cat-cyan",
};

export const ACTION_CATEGORY_DEFAULT_COLOR = "bg-tint/[0.06] text-daintree-text/50";

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
