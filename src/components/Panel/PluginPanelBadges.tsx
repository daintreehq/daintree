import { useEffect, useMemo } from "react";
import type { PluginPanelBadge, PluginPanelBadgeColor } from "@shared/types/plugin";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelBadges, usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";

/**
 * Live badges a plugin set on this panel via `host.setPanelBadge` (#10585),
 * rendered inline in the panel header's indicator cluster. A `dot` is a small
 * status circle; a `label` is a short pill. Color maps to the app's status
 * palette — never the accent (these are secondary, possibly-multiple markers),
 * and never green: a plugin badge stands for as long as the plugin leaves it
 * there, and the host cannot name what its `success` means, so it carries
 * emphasis rather than a health hue (#12002). It stays distinct from
 * `default`, because a typed value that renders identically to another is
 * worse than no value at all.
 * Multiple plugins on one panel render in plugin-id order for stability.
 */
// `success` sits at the ink end of the neutral ramp rather than one step off
// `default`: secondary and muted are within a few percent of each other in
// several built-in themes, which on a 2px dot is no distinction at all.
const DOT_COLOR: Record<PluginPanelBadgeColor, string> = {
  default: "bg-text-muted",
  success: "bg-text-primary",
  warning: "bg-status-warning",
  error: "bg-status-error",
};

const LABEL_COLOR: Record<PluginPanelBadgeColor, string> = {
  default: "bg-overlay-subtle text-text-secondary",
  success: "bg-overlay-medium text-text-primary",
  warning: "bg-status-warning/15 text-status-warning",
  error: "bg-status-error/15 text-status-error",
};

function BadgeIndicator({ pluginId, badge }: { pluginId: string; badge: PluginPanelBadge }) {
  const color = badge.color ?? "default";
  // A primitive selector, read per badge rather than once over the whole map in
  // the parent: the meta record is rebuilt on every provenance pull, so
  // selecting it whole would re-render every badge on pulls that changed
  // nothing (same reasoning as PluginViewContent). `pluginId` here is the
  // instance key main broadcasts, which is what the store keys on — and the
  // `?? pluginId` fallback keeps the pre-snapshot render fail-open.
  // The fallback is the manifest id, never the raw key: this renders before the
  // first snapshot lands, and a machine-local project id is not a name.
  const pluginName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginManifestIdFromInstanceKey(pluginId)
  );
  const indicator =
    badge.kind === "dot" ? (
      <span
        role="status"
        aria-label={badge.tooltip ?? `${pluginName} status`}
        className={`status-mark w-2 h-2 rounded-full shrink-0 ${DOT_COLOR[color]}`}
      />
    ) : (
      <span
        role="status"
        aria-label={badge.tooltip ?? `${pluginName}: ${badge.text}`}
        className={`shrink-0 rounded px-1 text-3xs font-medium leading-4 ${LABEL_COLOR[color]}`}
      >
        {badge.text}
      </span>
    );

  if (!badge.tooltip) return indicator;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent side="bottom">{badge.tooltip}</TooltipContent>
    </Tooltip>
  );
}

export function PluginPanelBadges({ panelId }: { panelId: string }) {
  const init = usePluginPanelBadgeStore((s) => s.init);
  useEffect(() => init(), [init]);

  const badges = usePanelBadges(panelId);
  const entries = useMemo(
    () => Object.entries(badges).sort(([a], [b]) => a.localeCompare(b)),
    [badges]
  );

  // Pull the plugin list when a badge arrives from a plugin we have no snapshot
  // for. `init()` would not do: it only pulls for whoever subscribes *first*,
  // and by the time a panel renders the toolbar has long since initialised the
  // store — so a plugin that never announced itself (`daintree-plugin dev`
  // broadcasts no provenance) would keep its raw id here forever. Keyed on the
  // owners actually missing rather than on mount, so the common case where
  // every owner is already known costs no round-trip, and a badge pushed later
  // still triggers exactly one pull.
  const refreshPluginRuntime = usePluginRuntimeStore((s) => s.refresh);
  const hasUnresolvedOwner = usePluginRuntimeStore((s) =>
    entries.some(([pluginId]) => !s.pluginMetaById.has(pluginId))
  );
  useEffect(() => {
    // No loop: a pull that resolves the owner flips this false, and one that
    // does not leaves the boolean unchanged, so the effect does not re-fire.
    if (hasUnresolvedOwner) refreshPluginRuntime();
  }, [hasUnresolvedOwner, refreshPluginRuntime]);

  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([pluginId, badge]) => (
        <BadgeIndicator key={pluginId} pluginId={pluginId} badge={badge} />
      ))}
    </>
  );
}
