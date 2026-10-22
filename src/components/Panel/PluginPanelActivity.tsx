import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ComponentType } from "react";
import { pluginManifestIdFromInstanceKey } from "@shared/types/plugin";
import {
  getPanelKindRegistrySnapshot,
  subscribeToPanelKindRegistry,
} from "@shared/config/panelKindRegistry";
import {
  BlockedCircle,
  DoneCircle,
  HollowCircle,
  SpinnerCircle,
  UnreadCircle,
} from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SESSION_COLORS, STATE_COLORS } from "@/components/Worktree/terminalStateConfig";
import { DOCK_STATE_GLYPH_CLASS } from "@/components/Layout/dockChipStyles";
import {
  describePluginPanelActivity,
  resolveActivityReporter,
  type PluginPanelActivityPresentation,
  type PluginPanelActivityShown,
} from "@/lib/pluginPanelActivityPresentation";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";
import {
  selectPanelActivityReport,
  usePluginPanelActivityStore,
} from "@/store/pluginPanelActivityStore";

export type { PluginPanelActivityPresentation } from "@/lib/pluginPanelActivityPresentation";

// The agent glyphs, so a plugin's work reads like an agent's at a glance; the
// words always say whose report it is. Failed takes the blocked ring a stopped
// subagent wears, not anything an agent's own state draws.
const GLYPHS: Record<PluginPanelActivityShown, ComponentType<{ className?: string }>> = {
  working: SpinnerCircle,
  waiting: HollowCircle,
  unread: UnreadCircle,
  finished: DoneCircle,
  failed: BlockedCircle,
};

const COLORS: Record<PluginPanelActivityShown, string> = {
  working: STATE_COLORS.working,
  waiting: STATE_COLORS.waiting,
  unread: SESSION_COLORS.unread,
  finished: STATE_COLORS.completed,
  failed: "text-status-error",
};

/**
 * The activity the owning plugin reports on this panel, ready to draw, or null.
 * Only the plugin whose kind the panel is counts, and only while that kind
 * declares `reportsActivity`: main checks the same before it stores a report,
 * and this check is what holds for an id the plugin named before its panel was
 * reported. Initialises the store itself, since a docked panel's header is not
 * mounted.
 */
export function usePluginPanelActivity(panelId: string): PluginPanelActivityPresentation | null {
  const init = usePluginPanelActivityStore((s) => s.init);
  useEffect(() => init(), [init]);

  const registry = useSyncExternalStore(
    subscribeToPanelKindRegistry,
    getPanelKindRegistrySnapshot,
    getPanelKindRegistrySnapshot
  );
  const pluginKind = usePanelStore((s) => s.panelsById[panelId]?.pluginPanelKindId);
  const kind = usePanelStore((s) => s.panelsById[panelId]?.kind);
  const reporter = resolveActivityReporter(
    (pluginKind !== undefined ? registry[pluginKind] : undefined) ??
      (kind !== undefined ? registry[kind] : undefined)
  );
  const report = usePluginPanelActivityStore((s) =>
    selectPanelActivityReport(s, panelId, reporter)
  );
  const seenRevision = usePluginPanelActivityStore((s) => s.seenRevisionByPanelId[panelId]);
  // The fallback is the manifest id, never the raw instance key: a
  // machine-local project id is not a name.
  const pluginName = usePluginRuntimeStore((s) =>
    reporter === null
      ? ""
      : (s.pluginMetaById.get(reporter)?.displayName ?? pluginManifestIdFromInstanceKey(reporter))
  );

  return useMemo(() => {
    if (reporter === null || report === undefined) return null;
    return describePluginPanelActivity(
      reporter,
      report,
      seenRevision === report.revision,
      pluginName
    );
  }, [reporter, report, seenRevision, pluginName]);
}

function ActivityGlyph({
  shown,
  className,
}: {
  shown: PluginPanelActivityShown;
  className: string;
}) {
  const Glyph = GLYPHS[shown];
  return (
    <Glyph
      className={cn(
        className,
        shown === "working" && "animate-spin-slow motion-reduce:animate-none"
      )}
    />
  );
}

/**
 * The panel header's mark for a plugin's report, beside the plugin's badges.
 * A status region named with the attribution, so a screen reader hears whose
 * report it is along with what it says.
 */
export function PluginPanelActivityIndicator({ panelId }: { panelId: string }) {
  const activity = usePluginPanelActivity(panelId);
  if (!activity) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-label={activity.description}
          data-plugin-panel-activity={activity.shown}
          className={cn("inline-flex items-center shrink-0", COLORS[activity.shown])}
        >
          <ActivityGlyph shown={activity.shown} className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{activity.description}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The dock chip's mark for a plugin's report, in the slot an agent's state
 * glyph takes. Decorative: the chip's accessible name carries the words.
 */
export function PluginPanelActivityDockCue({
  activity,
}: {
  activity: PluginPanelActivityPresentation;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          aria-hidden="true"
          data-plugin-panel-activity={activity.shown}
          className={cn(
            "ml-1.5 flex items-center shrink-0 transition-[color] duration-150 ease-out",
            COLORS[activity.shown]
          )}
        >
          <ActivityGlyph shown={activity.shown} className={DOCK_STATE_GLYPH_CLASS} />
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">{activity.description}</TooltipContent>
    </Tooltip>
  );
}

/** The words a dock chip's accessible name gains from a plugin's report. */
export function pluginPanelActivityLabelSuffix(
  activity: PluginPanelActivityPresentation | null
): string {
  return activity ? ` — ${activity.description}` : "";
}
