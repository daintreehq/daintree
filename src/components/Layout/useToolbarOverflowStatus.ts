import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AnyToolbarButtonId } from "@shared/types/toolbar";
import type { ToolbarButtonConfig } from "@shared/config/toolbarButtonRegistry";
import {
  maxOverflowSeverity,
  overflowedPluginBadges,
  pluginBadgeOverflowSeverity,
} from "./pluginToolbarBadge";
import { usePluginToolbarBadgeStore } from "@/store/pluginToolbarBadgeStore";
import {
  useOverflowAgentObservations,
  useOverflowBadgeSeverity,
  useOverflowLauncherDiscovery,
} from "./useOverflowBadgeSeverity";
import { pluralize } from "@/lib/pluralize";
import { PROJECT_SCOPED_TOOLBAR_IDS } from "./useToolbarItemPlacement";
import { useDiagnosticsStore } from "@/store/diagnosticsStore";

export interface ToolbarOverflowStatusInput {
  leftOverflow: AnyToolbarButtonId[];
  rightOverflow: AnyToolbarButtonId[];
  hasActiveVoiceRecording: boolean;
  /** With no project, the project-scoped slots are placeholders, not buttons. */
  hasProject?: boolean;
  errorCount: number;
  canopyUrgentCount: number;
  /** Problems' watcher warning in its own words, or null while watching is sound. */
  watcherStatus?: string | null;
  /** What the Forge capsule's warning says, while it shows one; null otherwise. */
  forgeUnavailableObservation?: string | null;
  pluginConfigs: ReadonlyMap<string, ToolbarButtonConfig>;
  pinnedButtons: Partial<Record<string, boolean>>;
}

// What each `…` menu holds once the inactive voice slot is set aside, and what
// its badge and accessible name report about the buttons folded into it.
export function useToolbarOverflowStatus({
  leftOverflow,
  rightOverflow,
  hasActiveVoiceRecording,
  hasProject = true,
  errorCount,
  canopyUrgentCount,
  watcherStatus = null,
  forgeUnavailableObservation = null,
  pluginConfigs,
  pinnedButtons,
}: ToolbarOverflowStatusInput) {
  // Voice recording reserves layout via an always-available slot but should
  // not pollute the overflow badge or dropdown when no session is active —
  // an inactive placeholder pushed into overflow would otherwise count as a
  // hidden item and trigger the warning severity in useOverflowBadgeSeverity.
  // A project-scoped slot with no project is a placeholder holding the strip's
  // shape; folded into the menu it would be a row that opens nothing.
  const visibleLeftOverflow = useMemo(() => {
    const shown = hasActiveVoiceRecording
      ? leftOverflow
      : leftOverflow.filter((id) => id !== "voice-recording");
    return hasProject ? shown : shown.filter((id) => !PROJECT_SCOPED_TOOLBAR_IDS.has(id));
  }, [leftOverflow, hasActiveVoiceRecording, hasProject]);
  const visibleRightOverflow = useMemo(() => {
    const shown = hasActiveVoiceRecording
      ? rightOverflow
      : rightOverflow.filter((id) => id !== "voice-recording");
    return hasProject ? shown : shown.filter((id) => !PROJECT_SCOPED_TOOLBAR_IDS.has(id));
  }, [rightOverflow, hasActiveVoiceRecording, hasProject]);

  // The dock is showing the watcher's state while it is open, so the folded
  // warning stands down like every other mark.
  const diagnosticsOpen = useDiagnosticsStore((s) => s.isOpen);
  const watcherUnreliable = watcherStatus !== null && !diagnosticsOpen;
  const watcherObservation = watcherStatus?.toLowerCase() ?? null;
  const leftOverflowSeverity = useOverflowBadgeSeverity(
    visibleLeftOverflow,
    errorCount,
    canopyUrgentCount,
    watcherUnreliable,
    forgeUnavailableObservation !== null
  );
  const rightOverflowSeverity = useOverflowBadgeSeverity(
    visibleRightOverflow,
    errorCount,
    canopyUrgentCount,
    watcherUnreliable,
    forgeUnavailableObservation !== null
  );
  const leftAgentObservations = useOverflowAgentObservations(visibleLeftOverflow);
  const rightAgentObservations = useOverflowAgentObservations(visibleRightOverflow);
  const leftLauncherDiscovery = useOverflowLauncherDiscovery(visibleLeftOverflow);
  const rightLauncherDiscovery = useOverflowLauncherDiscovery(visibleRightOverflow);

  // Plugin badges folded into each `…` menu light its dot and join its name,
  // as the built-in buttons' signals do (#9821, #13503).
  // Derived inside the selector so a badge change that moves neither menu (a
  // visible button's count, a tooltip) doesn't re-render the whole toolbar.
  const [leftPluginBadgeCount, leftPluginSeverity, rightPluginBadgeCount, rightPluginSeverity] =
    usePluginToolbarBadgeStore(
      useShallow((s) => {
        const left = overflowedPluginBadges(
          visibleLeftOverflow,
          pluginConfigs,
          pinnedButtons,
          s.badgesByPlugin
        );
        const right = overflowedPluginBadges(
          visibleRightOverflow,
          pluginConfigs,
          pinnedButtons,
          s.badgesByPlugin
        );
        return [
          left.length,
          pluginBadgeOverflowSeverity(left),
          right.length,
          pluginBadgeOverflowSeverity(right),
        ] as const;
      })
    );
  const leftMenuSeverity = maxOverflowSeverity(leftOverflowSeverity, leftPluginSeverity);
  const rightMenuSeverity = maxOverflowSeverity(rightOverflowSeverity, rightPluginSeverity);
  const leftWatcherHidden = watcherUnreliable && visibleLeftOverflow.includes("problems");
  const rightWatcherHidden = watcherUnreliable && visibleRightOverflow.includes("problems");
  const leftForgeHidden =
    forgeUnavailableObservation !== null && visibleLeftOverflow.includes("forge-stats");
  const rightForgeHidden =
    forgeUnavailableObservation !== null && visibleRightOverflow.includes("forge-stats");
  const leftObservations = useMemo(
    () => [
      ...leftAgentObservations,
      ...(leftLauncherDiscovery ? ["new agents to try"] : []),
      ...(leftWatcherHidden && watcherObservation ? [watcherObservation] : []),
      ...(leftForgeHidden && forgeUnavailableObservation ? [forgeUnavailableObservation] : []),
      ...(leftPluginBadgeCount > 0 ? [pluralize(leftPluginBadgeCount, "plugin badge")] : []),
    ],
    [
      leftAgentObservations,
      leftLauncherDiscovery,
      leftWatcherHidden,
      watcherObservation,
      leftForgeHidden,
      forgeUnavailableObservation,
      leftPluginBadgeCount,
    ]
  );
  const rightObservations = useMemo(
    () => [
      ...rightAgentObservations,
      ...(rightLauncherDiscovery ? ["new agents to try"] : []),
      ...(rightWatcherHidden && watcherObservation ? [watcherObservation] : []),
      ...(rightForgeHidden && forgeUnavailableObservation ? [forgeUnavailableObservation] : []),
      ...(rightPluginBadgeCount > 0 ? [pluralize(rightPluginBadgeCount, "plugin badge")] : []),
    ],
    [
      rightAgentObservations,
      rightLauncherDiscovery,
      rightWatcherHidden,
      watcherObservation,
      rightForgeHidden,
      forgeUnavailableObservation,
      rightPluginBadgeCount,
    ]
  );
  return {
    visibleLeftOverflow,
    visibleRightOverflow,
    leftMenuSeverity,
    rightMenuSeverity,
    leftObservations,
    rightObservations,
  };
}
