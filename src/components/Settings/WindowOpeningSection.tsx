import { useEffect, useRef, useState } from "react";
import { AppWindow } from "lucide-react";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "@/components/Settings/SettingsSelect";
import { SettingsLoadErrorBanner } from "@/components/Settings/SettingsLoadErrorBanner";
import { actionService } from "@/services/ActionService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import type { ActionDispatchResult } from "@shared/types/actions";
import {
  DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW,
  isOpenFoldersInNewWindowMode,
  OPEN_FOLDERS_IN_NEW_WINDOW_MODES,
  type OpenFoldersInNewWindowMode,
} from "@shared/types/ipc/windowOpening";

const MODE_COPY: Record<OpenFoldersInNewWindowMode, { label: string; description: string }> = {
  default: {
    label: "Only from outside Daintree",
    description:
      "Folders opened from the Dock, Finder or command line get a new window; folders picked in Daintree use the current one",
  },
  on: {
    label: "Always",
    description: "Every folder you open gets a window of its own",
  },
  off: {
    label: "Never",
    description: "Every folder you open replaces the current window's project",
  },
};

const MODE_OPTIONS: SettingsSelectOption[] = OPEN_FOLDERS_IN_NEW_WINDOW_MODES.map((mode) => ({
  value: mode,
  ...MODE_COPY[mode],
}));

interface SaveFailure {
  mode: OpenFoldersInNewWindowMode;
  message: string;
}

function modeFromResult(result: ActionDispatchResult): OpenFoldersInNewWindowMode {
  if (!result.ok) throw new Error(result.error.message);
  const config: unknown = result.result;
  const mode =
    typeof config === "object" && config !== null && "openFoldersInNewWindow" in config
      ? config.openFoldersInNewWindow
      : undefined;
  if (!isOpenFoldersInNewWindowMode(mode)) {
    throw new Error("The stored value isn't one Daintree recognises.");
  }
  return mode;
}

/**
 * Whether opening a folder reuses the current window or opens a new one
 * (#12595). Governs opening a folder only — switching to a project that's
 * already known keeps its window whatever this says.
 */
export function WindowOpeningSection() {
  const [mode, setMode] = useState<OpenFoldersInNewWindowMode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const [pendingMode, setPendingMode] = useState<OpenFoldersInNewWindowMode | null>(null);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void actionService
      .dispatch("windowOpening.getConfig", undefined, { source: "user" })
      .then(modeFromResult)
      .then(
        (loaded) => {
          if (cancelled) return;
          setMode(loaded);
          setLoadError(null);
        },
        (error: unknown) => {
          if (cancelled) return;
          logError("Failed to load window opening config", error);
          setLoadError(formatErrorMessage(error, "The setting couldn't be read."));
        }
      );
    return () => {
      cancelled = true;
    };
  }, [loadNonce]);

  // Carries the value being saved rather than toggling what the select shows,
  // so a retry resends exactly what failed. Promise chaining rather than
  // try/finally, which the React Compiler can't lower.
  const save = (next: OpenFoldersInNewWindowMode): Promise<void> => {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    setPendingMode(next);
    setSaveFailure(null);
    return actionService
      .dispatch("windowOpening.updateConfig", { openFoldersInNewWindow: next }, { source: "user" })
      .then(modeFromResult)
      .then(
        (saved) => {
          setMode(saved);
        },
        (error: unknown) => {
          logError("Failed to update window opening config", error);
          setSaveFailure({
            mode: next,
            message: formatErrorMessage(error, "The setting couldn't be written."),
          });
        }
      )
      .finally(() => {
        savingRef.current = false;
        setPendingMode(null);
      });
  };

  const value = pendingMode ?? mode ?? DEFAULT_OPEN_FOLDERS_IN_NEW_WINDOW;

  return (
    <SettingsSection
      icon={AppWindow}
      title="Opening folders"
      description="Where a folder goes when you open it. Switching between projects isn't affected."
      id="general-window-opening"
    >
      {mode === null && loadError !== null ? (
        <SettingsLoadErrorBanner
          title="Couldn't load window settings"
          message={loadError}
          onRetry={() => {
            setLoadError(null);
            setLoadNonce((n) => n + 1);
          }}
        />
      ) : (
        <>
          <SettingsSelect
            label="Open folders in a new window"
            options={MODE_OPTIONS}
            value={value}
            onValueChange={(next) => {
              if (isOpenFoldersInNewWindowMode(next) && next !== value) void save(next);
            }}
            disabled={mode === null || pendingMode !== null}
          />
          {saveFailure && (
            <SettingsLoadErrorBanner
              title="Couldn't save window setting"
              message={saveFailure.message}
              onRetry={() => void save(saveFailure.mode)}
            />
          )}
        </>
      )}
    </SettingsSection>
  );
}
