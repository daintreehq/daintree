import { useCallback, useEffect, useMemo } from "react";
import type {
  PluginApplicationNavigationApi,
  PluginNavigationIntent,
  PluginNavigationResult,
} from "@shared/types/plugin";
import {
  applicationNavigationContext,
  applicationNavigationSnapshot,
  currentProjectNavigationKey,
  navigateApplication,
  navigateApplicationBack,
  navigateApplicationForward,
  registerApplicationNavigationView,
  resolveApplicationNavigationHistory,
} from "@/services/plugin/applicationNavigation";
import {
  selectApplicationNavigationRecord,
  useApplicationNavigationStore,
} from "@/store/applicationNavigationStore";
import { useProjectPluginStore } from "@/store/projectPluginStore";

const STALE: PluginNavigationResult = Object.freeze({ ok: false, reason: "stale" });

/**
 * The project application's navigation for one view attempt (#14108), or
 * `undefined` when this view isn't the application's: another plugin's, no
 * application in force, none declaring navigation, or a host that belongs to
 * no project.
 *
 * Live, from the same store every view of the application reads, so a move
 * made in the sidebar re-renders Home and the panels with the new location.
 * The callbacks are bound to `attempt` and re-check it when called, so one a
 * view held past its own teardown refuses with `stale` instead of moving the
 * location for whatever mounted next.
 */
export function useApplicationNavigation({
  pluginId,
  panelId,
  enabled,
  attempt,
  isAttemptCurrent,
}: {
  pluginId: string;
  panelId: string;
  enabled: boolean;
  attempt: number;
  isAttemptCurrent: (attempt: number) => boolean;
}): PluginApplicationNavigationApi | undefined {
  const application = useProjectPluginStore((s) => s.application);
  const key = currentProjectNavigationKey();
  const context = useMemo(() => {
    if (!enabled) return null;
    const resolved = applicationNavigationContext(application, key);
    return resolved !== null && resolved.instanceId === pluginId ? resolved : null;
  }, [enabled, application, key, pluginId]);
  const record = useApplicationNavigationStore((s) =>
    context === null
      ? null
      : selectApplicationNavigationRecord(s, context.key, {
          ownerId: context.ownerId,
          version: context.navigation.version,
        })
  );
  const snapshot = useMemo(
    () =>
      context === null
        ? null
        : applicationNavigationSnapshot(
            context,
            resolveApplicationNavigationHistory(context, record)
          ),
    [context, record]
  );

  const owned = context !== null;
  // Registered for the leave check: while this view says it holds unsaved
  // work, no view of the application may move the location out from under it.
  useEffect(() => {
    if (!owned) return;
    return registerApplicationNavigationView(pluginId, panelId);
  }, [owned, pluginId, panelId]);

  const navigate = useCallback(
    (intent: PluginNavigationIntent): PluginNavigationResult =>
      isAttemptCurrent(attempt) ? navigateApplication(pluginId, intent) : STALE,
    [isAttemptCurrent, attempt, pluginId]
  );
  const back = useCallback(
    (): PluginNavigationResult =>
      isAttemptCurrent(attempt) ? navigateApplicationBack(pluginId) : STALE,
    [isAttemptCurrent, attempt, pluginId]
  );
  const forward = useCallback(
    (): PluginNavigationResult =>
      isAttemptCurrent(attempt) ? navigateApplicationForward(pluginId) : STALE,
    [isAttemptCurrent, attempt, pluginId]
  );

  return useMemo(
    () =>
      snapshot === null
        ? undefined
        : Object.freeze({
            location: snapshot.location,
            sections: snapshot.sections,
            canGoBack: snapshot.canGoBack,
            canGoForward: snapshot.canGoForward,
            navigate,
            back,
            forward,
          }),
    [snapshot, navigate, back, forward]
  );
}
