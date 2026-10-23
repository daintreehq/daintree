import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginSetupUiStatus } from "@shared/types/plugin";
import { usePluginContextKeyStore } from "@/store/pluginContextKeyStore";
import {
  resolvePluginSetupProgress,
  type PluginSetupProgress,
} from "@/services/plugin/pluginSetupProgress";
import { logError } from "@/utils/logger";

export interface PluginSetupState extends PluginSetupProgress {
  /** Whether this plugin and project's first read has landed. */
  loaded: boolean;
  /** Skip or restore a step in this view's project. */
  setSkipped: (stepId: string, skipped: boolean) => void;
  /** The step whose last skip or restore couldn't be saved, if any. */
  saveErrorStepId: string | null;
}

const EMPTY_STATUS: PluginSetupUiStatus = { steps: [] };

/**
 * A plugin's setup checklist (#13824) for `projectId`, kept current: main
 * announces every settings write, account change and skip on the same
 * `plugin:settings-changed` event, and context steps follow the context keys
 * this view already mirrors.
 */
export function usePluginSetupStatus(pluginId: string, projectId: string | null): PluginSetupState {
  const whenContext = usePluginContextKeyStore((s) => s.whenContext);
  const initContextKeys = usePluginContextKeyStore((s) => s.init);
  useEffect(() => initContextKeys(), [initContextKeys]);

  const target = `${pluginId}\u0000${projectId ?? ""}`;
  const [loaded, setLoaded] = useState<{ target: string; status: PluginSetupUiStatus } | null>(
    null
  );
  const [saveError, setSaveError] = useState<{ target: string; stepId: string } | null>(null);
  // Only the latest skip reports: an older one failing after a newer one is
  // superseded, not the state of the row.
  const skipAttemptRef = useRef(0);

  useEffect(() => {
    const bridge = window.electron?.plugin;
    if (typeof bridge?.getSetupStatus !== "function") return;
    let cancelled = false;
    // Sequenced so a slow read can never overwrite a newer one.
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      bridge
        .getSetupStatus(pluginId, projectId)
        .then((status) => {
          if (!cancelled && current === generation) setLoaded({ target, status });
        })
        .catch((err: unknown) => {
          // A refused request (a foreign project, a malformed id) says nothing
          // about the plugin's setup, so it shows nothing.
          if (!cancelled && current === generation) setLoaded({ target, status: EMPTY_STATUS });
          logError(`Failed to read setup steps for ${pluginId}`, err);
        });
    };
    const unsubscribe = bridge.onSettingsChanged?.((payload) => {
      if (payload.pluginId === pluginId) refresh();
    });
    refresh();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [pluginId, projectId, target]);

  // A view switched to another plugin or project shows nothing until its own read lands.
  const status = loaded?.target === target ? loaded.status : EMPTY_STATUS;
  // A bridge without the read (a partial stub) has no checklist to wait for.
  const readable = typeof window.electron?.plugin?.getSetupStatus === "function";
  const progress = useMemo(
    () => resolvePluginSetupProgress(status.steps, whenContext),
    [status, whenContext]
  );

  const setSkipped = useCallback(
    (stepId: string, skipped: boolean) => {
      const bridge = window.electron?.plugin;
      if (typeof bridge?.setSetupStepSkipped !== "function") return;
      const attempt = ++skipAttemptRef.current;
      setSaveError(null);
      bridge.setSetupStepSkipped(pluginId, stepId, skipped).catch((err: unknown) => {
        if (attempt === skipAttemptRef.current) setSaveError({ target, stepId });
        logError(`Failed to save a setup step skip for ${pluginId}`, err);
      });
    },
    [pluginId, target]
  );

  return {
    ...progress,
    loaded: !readable || loaded?.target === target,
    setSkipped,
    saveErrorStepId: saveError?.target === target ? saveError.stepId : null,
  };
}
