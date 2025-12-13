import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { FileText, Trash2, Bug, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { appClient, logsClient } from "@/clients";
import type { AppState } from "@shared/types";

interface TroubleshootingTabProps {
  openLogs: () => void;
  clearLogs: () => void;
}

export function TroubleshootingTab({ openLogs, clearLogs }: TroubleshootingTabProps) {
  const [developerMode, setDeveloperMode] = useState(false);
  const [autoOpenDiagnostics, setAutoOpenDiagnostics] = useState(false);
  const [focusEventsTab, setFocusEventsTab] = useState(false);
  const [verboseLogging, setVerboseLogging] = useState(false);
  const [verboseLoggingPending, setVerboseLoggingPending] = useState(false);

  useEffect(() => {
    appClient.getState().then((appState) => {
      if (appState?.developerMode) {
        setDeveloperMode(appState.developerMode.enabled);
        setAutoOpenDiagnostics(appState.developerMode.autoOpenDiagnostics);
        setFocusEventsTab(appState.developerMode.focusEventsTab);
      }
    });

    logsClient
      .getVerbose()
      .then((enabled) => {
        setVerboseLogging(enabled);
      })
      .catch((error) => {
        console.error("Failed to get verbose logging state:", error);
      });
  }, []);

  const saveDeveloperModeSettings = useCallback(
    async (settings: NonNullable<AppState["developerMode"]>) => {
      try {
        await appClient.setState({ developerMode: settings });
      } catch (error) {
        console.error("Failed to save developer mode settings:", error);
      }
    },
    []
  );

  const handleToggleDeveloperMode = useCallback(() => {
    const newEnabled = !developerMode;
    setDeveloperMode(newEnabled);

    if (!newEnabled) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("canopy:debug-toggle", { detail: { enabled: false } })
        );
      }
      setAutoOpenDiagnostics(false);
      setFocusEventsTab(false);
      saveDeveloperModeSettings({
        enabled: false,
        showStateDebug: false,
        autoOpenDiagnostics: false,
        focusEventsTab: false,
      });
    } else {
      saveDeveloperModeSettings({
        enabled: true,
        showStateDebug: false,
        autoOpenDiagnostics,
        focusEventsTab,
      });
    }
  }, [developerMode, autoOpenDiagnostics, focusEventsTab, saveDeveloperModeSettings]);

  const handleToggleAutoOpenDiagnostics = useCallback(() => {
    const newState = !autoOpenDiagnostics;
    setAutoOpenDiagnostics(newState);
    if (!newState) {
      setFocusEventsTab(false);
      saveDeveloperModeSettings({
        enabled: developerMode,
        showStateDebug: false,
        autoOpenDiagnostics: false,
        focusEventsTab: false,
      });
    } else {
      saveDeveloperModeSettings({
        enabled: developerMode,
        showStateDebug: false,
        autoOpenDiagnostics: true,
        focusEventsTab,
      });
    }
  }, [autoOpenDiagnostics, developerMode, focusEventsTab, saveDeveloperModeSettings]);

  const handleToggleFocusEventsTab = useCallback(() => {
    const newState = !focusEventsTab;
    setFocusEventsTab(newState);
    saveDeveloperModeSettings({
      enabled: developerMode,
      showStateDebug: false,
      autoOpenDiagnostics,
      focusEventsTab: newState,
    });
  }, [focusEventsTab, developerMode, autoOpenDiagnostics, saveDeveloperModeSettings]);

  const handleToggleVerboseLogging = useCallback(async () => {
    if (verboseLoggingPending) return;

    const newState = !verboseLogging;
    setVerboseLoggingPending(true);
    setVerboseLogging(newState);

    try {
      const result = await logsClient.setVerbose(newState);
      if (!result.success) {
        console.error("Backend rejected verbose logging toggle");
        setVerboseLogging(!newState);
      }
    } catch (error) {
      console.error("Failed to set verbose logging:", error);
      setVerboseLogging(!newState);
    } finally {
      setVerboseLoggingPending(false);
    }
  }, [verboseLogging, verboseLoggingPending]);

  const handleClearLogs = async () => {
    try {
      clearLogs();
      await logsClient.clear();
    } catch (error) {
      console.error("Failed to clear logs:", error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-1">Application Logs</h4>
          <p className="text-xs text-canopy-text/60 mb-3">
            View internal application logs for debugging purposes.
          </p>
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openLogs()}
              className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
            >
              <FileText className="w-4 h-4 mr-2" />
              Open Log File
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearLogs}
              className="text-[var(--color-status-error)] border-canopy-border hover:bg-red-900/20 hover:text-red-300 hover:border-red-900/30"
            >
              <Trash2 className="w-4 h-4 mr-2" />
              Clear Logs
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-1 flex items-center gap-2">
            <Bug className="w-4 h-4" />
            Developer Mode
          </h4>
          <p className="text-xs text-canopy-text/60 mb-3">
            Enable enhanced debugging features for development and troubleshooting.
          </p>

          <label className="flex items-center gap-3 cursor-pointer mb-4 p-3 border border-canopy-border rounded-[var(--radius-md)]">
            <button
              onClick={handleToggleDeveloperMode}
              className={cn(
                "relative w-11 h-6 rounded-full transition-colors shrink-0",
                developerMode ? "bg-canopy-accent" : "bg-canopy-border"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                  developerMode && "translate-x-5"
                )}
              />
            </button>
            <div>
              <span className="text-sm text-canopy-text font-medium">Enable Developer Mode</span>
              <p className="text-xs text-canopy-text/60">Activates all debugging features below</p>
            </div>
          </label>

          <div
            className={cn(
              "ml-4 space-y-3 border-l-2 border-canopy-border pl-4 transition-opacity",
              !developerMode && "opacity-50"
            )}
          >
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={autoOpenDiagnostics}
                onChange={handleToggleAutoOpenDiagnostics}
                disabled={!developerMode}
                className="w-4 h-4 rounded border-canopy-border bg-canopy-bg text-canopy-accent focus:ring-canopy-accent focus:ring-offset-0 disabled:opacity-50"
              />
              <div>
                <span className="text-sm text-canopy-text">Auto-Open Diagnostics Dock</span>
                <p className="text-xs text-canopy-text/60">
                  Automatically open diagnostics panel on app startup
                </p>
              </div>
            </label>

            <label
              className={cn(
                "flex items-center gap-3 cursor-pointer ml-4",
                !autoOpenDiagnostics && "opacity-50"
              )}
            >
              <input
                type="checkbox"
                checked={focusEventsTab}
                onChange={handleToggleFocusEventsTab}
                disabled={!developerMode || !autoOpenDiagnostics}
                className="w-4 h-4 rounded border-canopy-border bg-canopy-bg text-canopy-accent focus:ring-canopy-accent focus:ring-offset-0 disabled:opacity-50"
              />
              <div>
                <span className="text-sm text-canopy-text">Focus Events Tab</span>
                <p className="text-xs text-canopy-text/60">
                  Default to Events tab when diagnostics opens
                </p>
              </div>
            </label>
          </div>

          <div className="mt-4 p-3 border border-canopy-border rounded-[var(--radius-md)]">
            <label
              className="flex items-center gap-3 cursor-pointer"
              onClick={handleToggleVerboseLogging}
            >
              <button
                type="button"
                role="switch"
                aria-checked={verboseLogging}
                aria-label="Enable verbose logging"
                disabled={verboseLoggingPending}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors shrink-0",
                  verboseLogging ? "bg-amber-500" : "bg-canopy-border",
                  verboseLoggingPending && "opacity-50 cursor-wait"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                    verboseLogging && "translate-x-5"
                  )}
                />
              </button>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-canopy-text font-medium">
                    Enable Verbose Logging
                  </span>
                  <span className="text-xs px-1.5 py-0.5 bg-canopy-border rounded text-canopy-text/70">
                    This session only
                  </span>
                </div>
                <p className="text-xs text-canopy-text/60">
                  Captures detailed debug output for troubleshooting. Resets on app restart.
                </p>
              </div>
            </label>
            {verboseLogging && (
              <div className="mt-2 flex items-start gap-2 text-xs text-amber-400/90">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Verbose logging may impact performance and increase log file size.</span>
              </div>
            )}
          </div>

          <div className="mt-4 p-3 bg-canopy-border/30 rounded-[var(--radius-md)]">
            <h5 className="text-xs font-medium text-canopy-text mb-2">
              Advanced: Persistent Verbose Logging
            </h5>
            <p className="text-xs text-canopy-text/60 mb-2">
              Use the toggle above for quick debugging. For persistent verbose logs across restarts,
              launch the app with environment variables:
            </p>
            <code className="block text-xs bg-canopy-bg p-2 rounded border border-canopy-border font-mono text-canopy-text">
              CANOPY_DEBUG=1 npm run dev
            </code>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-canopy-text mb-1">Keyboard Shortcuts</h4>
          <p className="text-xs text-canopy-text/60 mb-3">
            Use Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows/Linux) to open DevTools.
          </p>
        </div>
      </div>
    </div>
  );
}
