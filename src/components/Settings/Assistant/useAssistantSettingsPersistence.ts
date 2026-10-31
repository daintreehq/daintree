import { useCallback, useEffect, useRef, useState } from "react";
import { useDebounce } from "@/hooks/useDebounce";
import { logError } from "@/utils/logger";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HelpAssistantSettings } from "@shared/types";
import { useSettingsTabValidation } from "../SettingsValidationRegistry";
import { useSettingsTabFlush, type SettingsFlushFailure } from "../SettingsFlushRegistry";
import {
  ASSISTANT_LAUNCH_SECTION_ID,
  DEFAULT_SETTINGS,
  applySettingsPatch,
  revertSettingsPatch,
  saveGroupOf,
  type SaveFailure,
} from "./assistantSettingsModel";

const CUSTOM_ARGS_DEBOUNCE_MS = 500;

export interface CustomArgsFailure {
  value: string;
  message: string;
}

interface CustomArgsSave {
  value: string;
  promise: Promise<boolean>;
}

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
  // spam IPC. The typed draft lives in `pendingCustomArgs` (null mirrors the
  // saved value) and only becomes `settings.customArgs` once main has stored
  // it, so a value main refuses stays in the field with its reason instead of
  // reading as saved (#15576). Saves run one at a time in the order they were
  // asked for, so an older response never lands on top of a newer one, and a
  // flush catches the draft before the dialog dismisses (#7260).
  const [pendingCustomArgs, setPendingCustomArgs] = useState<string | null>(null);
  const [customArgsFailure, setCustomArgsFailure] = useState<CustomArgsFailure | null>(null);
  const [customArgsSavesInFlight, setCustomArgsSavesInFlight] = useState(0);
  const debouncedPendingCustomArgs = useDebounce(pendingCustomArgs, CUSTOM_ARGS_DEBOUNCE_MS);
  const displayedCustomArgs = pendingCustomArgs ?? settings.customArgs;
  const isCustomArgsDirty = pendingCustomArgs !== null && pendingCustomArgs !== settings.customArgs;
  // A failure only speaks for the text it was about; typing past it clears the message.
  const customArgsError =
    pendingCustomArgs !== null && customArgsFailure?.value === pendingCustomArgs
      ? customArgsFailure.message
      : null;

  // Saves and the close flush read these after an await, so they're written
  // alongside the state rather than mirrored after a render.
  const pendingCustomArgsRef = useRef<string | null>(null);
  const savedCustomArgsRef = useRef(DEFAULT_SETTINGS.customArgs);
  const customArgsFailureRef = useRef<CustomArgsFailure | null>(null);
  const customArgsSaveRef = useRef<CustomArgsSave | null>(null);
  // Bumped on every edit, so a save only clears the draft it was started for:
  // the same text typed again after a reset is a newer edit than the save of it.
  const customArgsRevisionRef = useRef(0);

  useSettingsTabValidation("assistant", Boolean(loadError || saveFailure || customArgsError));

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
        savedCustomArgsRef.current = s.customArgs;
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

  const editCustomArgs = useCallback((value: string | null) => {
    customArgsRevisionRef.current += 1;
    pendingCustomArgsRef.current = value;
    setPendingCustomArgs(value);
  }, []);

  // Resolves with whether main stored the value; never rejects. A request for
  // the value already queued last joins it instead of sending it twice.
  const saveCustomArgs = useCallback(
    (value: string): Promise<boolean> => {
      const previous = customArgsSaveRef.current;
      if (previous?.value === value) return previous.promise;
      const revision = customArgsRevisionRef.current;
      setCustomArgsSavesInFlight((count) => count + 1);
      const send = async (): Promise<boolean> => {
        if (previous) await previous.promise;
        try {
          await window.electron.helpAssistant.setSettings({ customArgs: value });
        } catch (err) {
          const failure = {
            value,
            message: formatErrorMessage(err, "Couldn't save custom CLI args"),
          };
          customArgsFailureRef.current = failure;
          setCustomArgsFailure(failure);
          logError("Failed to save Daintree Assistant custom CLI args", err);
          return false;
        }
        savedCustomArgsRef.current = value;
        customArgsFailureRef.current = null;
        setCustomArgsFailure(null);
        setSettings((current) => ({ ...current, customArgs: value }));
        // Text typed since this save started stays in the field for its own save.
        if (customArgsRevisionRef.current === revision) editCustomArgs(null);
        return true;
      };
      const save: CustomArgsSave = { value, promise: send() };
      customArgsSaveRef.current = save;
      void save.promise.finally(() => {
        if (customArgsSaveRef.current === save) customArgsSaveRef.current = null;
        setCustomArgsSavesInFlight((count) => count - 1);
      });
      return save.promise;
    },
    [editCustomArgs]
  );

  // Persist the draft once the debounce settles. While a save is running it
  // decides what's stored, so this waits and re-runs once it settles: a draft
  // typed back to the stored value mid-save still has to be sent. A value that
  // already failed is sent once, here or by a close: re-firing it would retry a
  // refusal in a loop, so Retry lives on the error banner instead.
  useEffect(() => {
    if (debouncedPendingCustomArgs === null) return;
    if (customArgsSavesInFlight > 0) return;
    if (debouncedPendingCustomArgs !== pendingCustomArgsRef.current) return;
    if (debouncedPendingCustomArgs === customArgsFailureRef.current?.value) return;
    if (debouncedPendingCustomArgs === settings.customArgs) return;
    void saveCustomArgs(debouncedPendingCustomArgs);
  }, [debouncedPendingCustomArgs, settings.customArgs, customArgsSavesInFlight, saveCustomArgs]);

  // A draft typed back to the stored value lets the input mirror it again, but
  // only once nothing is in flight that could still move the stored value.
  useEffect(() => {
    if (customArgsSavesInFlight > 0) return;
    if (pendingCustomArgs !== null && pendingCustomArgs === settings.customArgs) {
      editCustomArgs(null);
    }
  }, [pendingCustomArgs, settings.customArgs, customArgsSavesInFlight, editCustomArgs]);

  const resetCustomArgs = () => {
    const value = DEFAULT_SETTINGS.customArgs;
    editCustomArgs(value);
    if (!customArgsSaveRef.current && savedCustomArgsRef.current === value) return;
    void saveCustomArgs(value);
  };

  const retryCustomArgs = () => {
    const draft = pendingCustomArgsRef.current;
    if (draft !== null) void saveCustomArgs(draft);
  };

  // A close reports the draft's real outcome: it waits out any save in flight,
  // sends a draft not yet tried (bypassing the debounce), and holds the dialog
  // on Launch options while the field's text isn't what main has stored.
  const flushCustomArgs = async (): Promise<SettingsFlushFailure | undefined> => {
    for (;;) {
      const running = customArgsSaveRef.current;
      if (running) {
        await running.promise;
        continue;
      }
      const draft = pendingCustomArgsRef.current;
      if (draft === null || draft === savedCustomArgsRef.current) return undefined;
      if (customArgsFailureRef.current?.value === draft) {
        return { landOn: ASSISTANT_LAUNCH_SECTION_ID };
      }
      await saveCustomArgs(draft);
    }
  };

  useSettingsTabFlush(
    "assistant",
    flushCustomArgs,
    isCustomArgsDirty || customArgsSavesInFlight > 0
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
        savedCustomArgsRef.current = s.customArgs;
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
    editCustomArgs,
    resetCustomArgs,
    customArgsError,
    retryCustomArgs,
    mcpStatus,
    retryMcpStatus,
    updateApiKey,
  };
}
