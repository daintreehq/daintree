import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HelpAssistantSettings } from "@shared/types";
import { useSettingsTabValidation } from "../SettingsValidationRegistry";
import { useSettingsTabFlush } from "../SettingsFlushRegistry";
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  revertSettingsPatch,
  saveGroupOf,
  type SaveFailure,
} from "./assistantSettingsModel";

const CUSTOM_ARGS_DEBOUNCE_MS = 500;

export interface McpStatusSnapshot {
  enabled: boolean;
  port: number | null;
  apiKey: string;
}

// The settings read and the fetched MCP status share one `loading` flag on
// purpose: the page stays inert until both land, while a settings retry drives
// the same flag on its own.
export function useAssistantSettingsPersistence() {
  const [settings, setSettings] = useState<HelpAssistantSettings>(DEFAULT_SETTINGS);
  const [mcpStatus, setMcpStatus] = useState<McpStatusSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);

  // customArgs is a free-form text input; persisting on every keystroke would
  // spam IPC. We track a pending edit alongside the persisted value: when the
  // pending value is null the input mirrors `settings.customArgs` directly
  // (no extra render round-trip on initial load), and when non-null it holds
  // the user's in-flight edit until the debounced persist catches up. A flush
  // hook captures the pending value before dialog dismissal (#7260).
  const [pendingCustomArgs, setPendingCustomArgs] = useState<string | null>(null);
  const debouncedPendingCustomArgs = useDebounce(pendingCustomArgs, CUSTOM_ARGS_DEBOUNCE_MS);
  const displayedCustomArgs = pendingCustomArgs ?? settings.customArgs;
  const isCustomArgsDirty = pendingCustomArgs !== null && pendingCustomArgs !== settings.customArgs;
  const pendingCustomArgsRef = useRef(pendingCustomArgs);
  useEffect(() => {
    pendingCustomArgsRef.current = pendingCustomArgs;
  }, [pendingCustomArgs]);

  useSettingsTabValidation("assistant", Boolean(loadError || saveFailure));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const refreshStatus = (): Promise<void> =>
      window.electron.mcpServer
        .getStatus()
        .then((status) => {
          if (cancelled) return;
          setMcpStatus({
            enabled: status.enabled,
            port: status.port,
            apiKey: status.apiKey,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setMcpStatus(null);
          logError("Failed to load MCP status for assistant tab", err);
        });

    const settingsLoad = window.electron.helpAssistant
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(formatErrorMessage(err, "Couldn't load assistant settings"));
        logError("Failed to load Daintree Assistant settings", err);
      });

    const mcpLoad = refreshStatus().catch((err) => {
      if (cancelled) return;
      logError("Failed initial MCP status load for assistant tab", err);
    });

    // Refetch the connection panel whenever the runtime state transitions.
    // Without this, toggling Daintree control on triggers main-process
    // auto-coupling (`helpAssistant.setSettings` calls `mcpServer.setEnabled`),
    // but this tab still shows "MCP server is off" until the user reopens it.
    const unsubscribe = window.electron.mcpServer.onRuntimeStateChanged(() => {
      void refreshStatus();
    });

    void Promise.all([settingsLoad, mcpLoad]).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Optimistic apply; a rejected save puts the attempted keys back (unless a later
  // change has already moved them) and parks the failure on the group it belongs to.
  const persist = useCallback(
    async (patch: Partial<HelpAssistantSettings>) => {
      const previous = settings;
      const group = saveGroupOf(patch);
      setSettings((current) => applySettingsPatch(current, patch));
      try {
        await window.electron.helpAssistant.setSettings(patch);
        setSaveFailure((current) => (current?.group === group ? null : current));
      } catch (err) {
        setSettings((current) => revertSettingsPatch(current, previous, patch));
        setSaveFailure({ group, patch });
        logError("Failed to save Daintree Assistant settings", err);
      }
    },
    [settings]
  );

  // Persist the pending value once the debounce settles. Skipped when pending
  // matches what's already persisted (e.g., user typed and undid, or the
  // value just landed via the optimistic update inside `persist`).
  // Each settled value is attempted once: a rejected save rolls settings.customArgs
  // back, which would otherwise re-fire this effect and retry in a loop. Retry
  // lives on the group's error banner instead.
  const lastAttemptedCustomArgsRef = useRef<string | null>(null);
  useEffect(() => {
    if (debouncedPendingCustomArgs === null) {
      lastAttemptedCustomArgsRef.current = null;
      return;
    }
    if (debouncedPendingCustomArgs === lastAttemptedCustomArgsRef.current) return;
    if (debouncedPendingCustomArgs !== settings.customArgs) {
      lastAttemptedCustomArgsRef.current = debouncedPendingCustomArgs;
      void persist({ customArgs: debouncedPendingCustomArgs });
    }
  }, [debouncedPendingCustomArgs, settings.customArgs, persist]);

  // Once the persisted value catches up, clear the pending flag so the input
  // resumes mirroring `settings.customArgs` directly.
  useEffect(() => {
    if (pendingCustomArgs !== null && pendingCustomArgs === settings.customArgs) {
      setPendingCustomArgs(null);
    }
  }, [pendingCustomArgs, settings.customArgs]);

  // Pre-close flush bypasses the debounce so closing the dialog mid-edit
  // still captures the in-flight value.
  useSettingsTabFlush(
    "assistant",
    () => {
      const pending = pendingCustomArgsRef.current;
      if (pending === null) return;
      return persist({ customArgs: pending });
    },
    isCustomArgsDirty
  );

  // Rotation replaces only the fetched key; a snapshot that never loaded stays empty.
  const updateApiKey = (key: string) => {
    setMcpStatus((prev) => (prev ? { ...prev, apiKey: key } : prev));
  };

  const retryMcpStatus = () => {
    window.electron.mcpServer
      .getStatus()
      .then((status) =>
        setMcpStatus({ enabled: status.enabled, port: status.port, apiKey: status.apiKey })
      )
      .catch((err) => logError("Failed to reload MCP status for assistant tab", err));
  };

  // Controls stay inert for the whole retry and only unlock once real values land.
  const retryLoadSettings = () => {
    setLoading(true);
    window.electron.helpAssistant
      .getSettings()
      .then((s) => {
        setSettings(s);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(formatErrorMessage(err, "Couldn't load assistant settings"));
        logError("Failed to reload Daintree Assistant settings", err);
      })
      .finally(() => setLoading(false));
  };

  return {
    settings,
    loading,
    loadError,
    retryLoadSettings,
    saveFailure,
    persist,
    displayedCustomArgs,
    setPendingCustomArgs,
    mcpStatus,
    retryMcpStatus,
    updateApiKey,
  };
}
