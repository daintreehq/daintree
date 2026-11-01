import type { PluginPanelBadge, PluginPanelBadgeColor } from "@shared/types/plugin";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import { toolbarBadgeFor } from "@/store/pluginToolbarBadgeStore";
import type { OverflowBadgeSeverity } from "./useOverflowBadgeSeverity";

/**
 * What a promoted plugin button's count pill shows for a badge, or null when
 * the badge draws as a pip instead. Only a whole-number label is a count, and
 * it caps at Canopy's `9+` so the pill keeps two characters (#13503).
 */
export function toolbarBadgeCountGlyph(badge: PluginPanelBadge): string | null {
  if (badge.kind !== "label") return null;
  const text = badge.text.trim();
  if (!/^\d+$/.test(text)) return null;
  const count = Number(text);
  return count > 9 ? "9+" : String(count);
}

/**
 * The words behind a badge, for a tooltip or an accessible name. A label keeps
 * its full text even beside a tooltip, since the promoted pill may have shown
 * it only as a pip or a capped count. An unexplained dot is named by the
 * colour the plugin asked for, so adding one never goes unheard.
 */
export function describeToolbarBadge(badge: PluginPanelBadge): string {
  if (badge.kind === "label") {
    return badge.tooltip ? `${badge.text} — ${badge.tooltip}` : badge.text;
  }
  if (badge.tooltip) return badge.tooltip;
  if (badge.color === "error") return "error";
  if (badge.color === "warning") return "warning";
  return "badge";
}

const COLOR_RANK: Record<PluginPanelBadgeColor, number> = {
  default: 0,
  success: 1,
  warning: 2,
  error: 3,
};

/** The most severe colour among several badges, for one mark standing in for them all. */
export function mostSevereBadgeColor(
  badges: readonly PluginPanelBadge[]
): PluginPanelBadgeColor | null {
  let top: PluginPanelBadgeColor | null = null;
  for (const badge of badges) {
    const color = badge.color ?? "default";
    if (top === null || COLOR_RANK[color] > COLOR_RANK[top]) top = color;
  }
  return top;
}

/**
 * The plugin badges folded into one overflow `…` menu: a promoted button that
 * overflowed carries its own, and an overflowed tray carries those of its rows
 * that have no top-level button (the same rows its own dot counts).
 */
export function overflowedPluginBadges(
  overflowIds: readonly string[],
  configs: ReadonlyMap<string, ToolbarButtonConfig>,
  pinnedButtons: Readonly<Record<string, boolean | undefined>>,
  badgesByPlugin: Readonly<Record<string, Readonly<Record<string, PluginPanelBadge>>>>
): PluginPanelBadge[] {
  const out: PluginPanelBadge[] = [];
  const trayOverflowed = overflowIds.includes("plugin-tray");
  for (const config of configs.values()) {
    const promoted = pinnedButtons[config.id] === true;
    if (promoted ? !overflowIds.includes(config.id) : !trayOverflowed) continue;
    const badge = toolbarBadgeFor(badgesByPlugin, config);
    if (badge) out.push(badge);
  }
  return out;
}

/** The overflow trigger's tier for a set of plugin badges, on the colour each one asked for. */
export function pluginBadgeOverflowSeverity(
  badges: readonly PluginPanelBadge[]
): OverflowBadgeSeverity {
  const color = mostSevereBadgeColor(badges);
  if (color === null) return null;
  if (color === "error") return "critical";
  if (color === "warning") return "warning";
  return "info";
}

const SEVERITY_RANK = { critical: 5, waiting: 4, warning: 3, notice: 2, info: 1 } as const;

/** The higher of two overflow tiers. */
export function maxOverflowSeverity(
  a: OverflowBadgeSeverity,
  b: OverflowBadgeSeverity
): OverflowBadgeSeverity {
  if (a === null) return b;
  if (b === null) return a;
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
