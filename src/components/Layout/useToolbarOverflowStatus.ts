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
import { useOverflowAgentObservations, useOverflowBadgeSeverity } from "./useOverflowBadgeSeverity";
import { pluralize } from "@/lib/pluralize";

export interface ToolbarOverflowStatusInput {
  leftOverflow: AnyToolbarButtonId[];
  rightOverflow: AnyToolbarButtonId[];
  hasActiveVoiceRecording: boolean;
  errorCount: number;
  canopyUrgentCount: number;
  pluginConfigs: ReadonlyMap<string, ToolbarButtonConfig>;
  pinnedButtons: Partial<Record<string, boolean>>;
}

// What each `…` menu holds once the inactive voice slot is set aside, and what
// its badge and accessible name report about the buttons folded into it.
export function useToolbarOverflowStatus({
  leftOverflow,
  rightOverflow,
  hasActiveVoiceRecording,
  errorCount,
  canopyUrgentCount,
  pluginConfigs,
  pinnedButtons,
}: ToolbarOverflowStatusInput) {
  // Voice recording reserves layout via an always-available slot but should
  // not pollute the overflow badge or dropdown when no session is active —
  // an inactive placeholder pushed into overflow would otherwise count as a
  // hidden item and trigger the warning severity in useOverflowBadgeSeverity.
  const visibleLeftOverflow = useMemo(
    () =>
      hasActiveVoiceRecording
        ? leftOverflow
        : leftOverflow.filter((id) => id !== "voice-recording"),
    [leftOverflow, hasActiveVoiceRecording]
  );
  const visibleRightOverflow = useMemo(
    () =>
      hasActiveVoiceRecording
        ? rightOverflow
        : rightOverflow.filter((id) => id !== "voice-recording"),
    [rightOverflow, hasActiveVoiceRecording]
  );

  const leftOverflowSeverity = useOverflowBadgeSeverity(
    visibleLeftOverflow,
    errorCount,
    canopyUrgentCount
  );
  const rightOverflowSeverity = useOverflowBadgeSeverity(
    visibleRightOverflow,
    errorCount,
    canopyUrgentCount
  );
  const leftAgentObservations = useOverflowAgentObservations(visibleLeftOverflow);
  const rightAgentObservations = useOverflowAgentObservations(visibleRightOverflow);

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
  const leftObservations = useMemo(
    () =>
      leftPluginBadgeCount > 0
        ? [...leftAgentObservations, pluralize(leftPluginBadgeCount, "plugin badge")]
        : leftAgentObservations,
    [leftAgentObservations, leftPluginBadgeCount]
  );
  const rightObservations = useMemo(
    () =>
      rightPluginBadgeCount > 0
        ? [...rightAgentObservations, pluralize(rightPluginBadgeCount, "plugin badge")]
        : rightAgentObservations,
    [rightAgentObservations, rightPluginBadgeCount]
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
