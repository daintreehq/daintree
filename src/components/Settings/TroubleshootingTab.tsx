import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Trash2,
  Bug,
  AlertTriangle,
  Shield,
  ShieldCheck,
  CircleCheck,
  CircleX,
  RotateCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { appClient, systemClient } from "@/clients";
import type { AppState, SystemHealthCheckResult } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";

function SystemHealthSection() {
  const [result, setResult] = useState<SystemHealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const runCheck = useCallback(async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const data = await systemClient.healthCheck();
      setResult(data);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : "Health check failed");
    } finally {
      setIsChecking(false);
    }
  }, []);

  return (
    <SettingsSection
      icon={ShieldCheck}
      title="System Health Check"
      description="Verify that required tools (Git, Node.js, npm) are installed and available."
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => void runCheck()}
        disabled={isChecking}
        className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text mb-3"
      >
        <RotateCw className={cn("w-4 h-4", isChecking && "animate-spin")} />
        {isChecking ? "Checking…" : result ? "Re-run Check" : "Run Health Check"}
      </Button>
      {checkError && <p className="text-xs text-status-error mb-3">{checkError}</p>}
      {result && (
        <div className="space-y-1.5">
          {result.prerequisites.map((check) => {
            const labels: Record<string, string> = { git: "Git", node: "Node.js", npm: "npm" };
            const label = labels[check.tool] ?? check.tool;
            return (
              <div
                key={check.tool}
                className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
              >
                {check.available ? (
                  <CircleCheck className="w-3.5 h-3.5 text-status-success shrink-0" />
                ) : (
                  <CircleX className="w-3.5 h-3.5 text-status-error shrink-0" />
                )}
                <span className="text-sm text-canopy-text">{label}</span>
                {check.version && (
                  <span className="text-xs text-canopy-text/40">v{check.version}</span>
                )}
                {!check.available && (
                  <span className="ml-auto text-xs text-status-error">Not found</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SettingsSection>
  );
}

export function TroubleshootingTab() {
  const [developerMode, setDeveloperMode] = useState(false);
  const [autoOpenDiagnostics, setAutoOpenDiagnostics] = useState(false);
  const [focusEventsTab, setFocusEventsTab] = useState(false);
  const [verboseLogging, setVerboseLogging] = useState(false);
  const [verboseLoggingPending, setVerboseLoggingPending] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetryPending, setTelemetryPending] = useState(false);

  useEffect(() => {
    if (window.electron?.telemetry) {
      window.electron.telemetry.get().then(({ enabled }) => {
        setTelemetryEnabled(enabled);
      });
    }

    appClient.getState().then((appState) => {
      if (appState?.developerMode) {
        setDeveloperMode(appState.developerMode.enabled);
        setAutoOpenDiagnostics(appState.developerMode.autoOpenDiagnostics);
        setFocusEventsTab(appState.developerMode.focusEventsTab);
      }
    });

    actionService
      .dispatch("logs.getVerbose", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) {
          setVerboseLogging(result.result as boolean);
        }
      })
      .catch((error) => {
        console.error("Failed to get verbose logging state:", error);
      });
  }, []);

  const handleToggleTelemetry = useCallback(async () => {
    if (telemetryPending || !window.electron?.telemetry) return;
    const newState = !telemetryEnabled;
    setTelemetryPending(true);
    setTelemetryEnabled(newState);
    try {
      await window.electron.telemetry.setEnabled(newState);
    } catch (err) {
      console.error("Failed to set telemetry:", err);
      setTelemetryEnabled(!newState);
    } finally {
      setTelemetryPending(false);
    }
  }, [telemetryEnabled, telemetryPending]);

  const saveDeveloperModeSettings = useCallback(
    async (settings: NonNullable<AppState["developerMode"]>) => {
      try {
        const result = await actionService.dispatch(
          "app.developerMode.set",
          {
            enabled: settings.enabled,
            autoOpenDiagnostics: settings.autoOpenDiagnostics,
            focusEventsTab: settings.focusEventsTab,
          },
          { source: "user" }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }
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
    const newValue = !autoOpenDiagnostics;
    setAutoOpenDiagnostics(newValue);
    if (!newValue) {
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
  }, [developerMode, autoOpenDiagnostics, focusEventsTab, saveDeveloperModeSettings]);

  const handleToggleFocusEventsTab = useCallback(() => {
    const newValue = !focusEventsTab;
    setFocusEventsTab(newValue);
    saveDeveloperModeSettings({
      enabled: developerMode,
      showStateDebug: false,
      autoOpenDiagnostics,
      focusEventsTab: newValue,
    });
  }, [developerMode, autoOpenDiagnostics, focusEventsTab, saveDeveloperModeSettings]);

  const handleToggleVerboseLogging = useCallback(async () => {
    if (verboseLoggingPending) return;

    const newState = !verboseLogging;
    setVerboseLoggingPending(true);
    setVerboseLogging(newState);

    try {
      const result = await actionService.dispatch(
        "logs.setVerbose",
        { enabled: newState },
        { source: "user" }
      );
      const payload = result.ok ? (result.result as { success: boolean }) : null;
      if (!result.ok || !payload?.success) {
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
      const result = await actionService.dispatch("logs.clear", undefined, {
        source: "user",
      });
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      console.error("Failed to clear logs:", error);
    }
  };

  return (
    <div className="space-y-6">
      <SystemHealthSection />

      <SettingsSection
        icon={FileText}
        title="Application Logs"
        description="View internal application logs for debugging purposes."
      >
        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void actionService.dispatch("logs.openFile", undefined, { source: "user" })
            }
            className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
          >
            <FileText />
            Open Log File
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearLogs}
            className="text-status-error border-canopy-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
          >
            <Trash2 />
            Clear Logs
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={Shield}
        title="Crash Reporting"
        description="Automatically send crash reports and error details to help improve Canopy. No personal data, file contents, or credentials are collected."
      >
        <SettingsSwitchCard
          icon={Shield}
          title="Enable Crash Reporting"
          subtitle="Collects: error messages, stack traces, app version, OS. Changes apply on next app restart."
          isEnabled={telemetryEnabled}
          onChange={handleToggleTelemetry}
          ariaLabel="Enable crash reporting"
          disabled={telemetryPending}
        />
      </SettingsSection>

      <SettingsSection
        icon={Bug}
        title="Developer Mode"
        description="Enable enhanced debugging features for development and troubleshooting."
      >
        <SettingsSwitchCard
          icon={Bug}
          title={developerMode ? "Developer Mode Enabled" : "Enable Developer Mode"}
          subtitle="Activates all debugging features below"
          isEnabled={developerMode}
          onChange={handleToggleDeveloperMode}
          ariaLabel="Developer Mode Toggle"
        />

        <div className="ml-4 space-y-3 border-l-2 border-canopy-border pl-4">
          <SettingsSwitchCard
            variant="compact"
            title="Auto-Open Diagnostics Dock"
            subtitle="Automatically open diagnostics panel on app startup"
            isEnabled={autoOpenDiagnostics}
            onChange={handleToggleAutoOpenDiagnostics}
            ariaLabel="Auto-open diagnostics dock"
            disabled={!developerMode}
          />

          <div className="ml-4">
            <SettingsSwitchCard
              variant="compact"
              title="Focus Events Tab"
              subtitle="Default to Events tab when diagnostics opens"
              isEnabled={focusEventsTab}
              onChange={handleToggleFocusEventsTab}
              ariaLabel="Focus events tab"
              disabled={!developerMode || !autoOpenDiagnostics}
            />
          </div>
        </div>

        <SettingsSwitchCard
          icon={AlertTriangle}
          title={verboseLogging ? "Verbose Logging Enabled" : "Enable Verbose Logging"}
          subtitle="Captures detailed debug output for troubleshooting. Resets on app restart."
          isEnabled={verboseLogging}
          onChange={handleToggleVerboseLogging}
          ariaLabel="Enable verbose logging"
          disabled={verboseLoggingPending}
          colorScheme="amber"
        />

        {verboseLogging && (
          <div className="flex items-start gap-2 text-xs text-status-warning/90">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Verbose logging may impact performance and increase log file size.</span>
          </div>
        )}

        <div className="p-3 bg-canopy-border/30 rounded-[var(--radius-md)]">
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
      </SettingsSection>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">Keyboard Shortcuts</h4>
        <p className="text-xs text-canopy-text/50">
          Use Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows/Linux) to open DevTools.
        </p>
      </div>
    </div>
  );
}
