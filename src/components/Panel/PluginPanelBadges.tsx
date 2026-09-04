import { useEffect } from "react";
import type { PluginPanelBadge, PluginPanelBadgeColor } from "@shared/types/plugin";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelBadges, usePluginPanelBadgeStore } from "@/store/pluginPanelBadgeStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

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
  const pluginName = usePluginRuntimeStore(
    (s) => s.pluginMetaById.get(pluginId)?.displayName ?? pluginId
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

  // The badge store and the runtime store are subscribed independently — a
  // panel can carry badges long before anything else in this view has pulled
  // the plugin list, and without this the labels would name plugins by raw id
  // until some other surface happened to initialise it.
  const initPluginRuntime = usePluginRuntimeStore((s) => s.init);
  useEffect(() => initPluginRuntime(), [initPluginRuntime]);

  const badges = usePanelBadges(panelId);
  const entries = Object.entries(badges).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([pluginId, badge]) => (
        <BadgeIndicator key={pluginId} pluginId={pluginId} badge={badge} />
      ))}
    </>
  );
}
