import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, CircleCheck, CircleX } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { appClient, systemClient, logsClient } from "@/clients";
import type { AppState, SystemHealthCheckResult } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { useSettingsStore } from "@/store/settingsStore";
import { logError, logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { ClearLogsConfirmDialog } from "@/components/Diagnostics/ClearLogsConfirmDialog";

const PROFILE_UPDATE_INTERVAL_MS = 250;

function SystemHealthSection() {
  const [result, setResult] = useState<SystemHealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  // While this section is on screen the user is already looking at the health
  // check, so the global missing-prerequisite banner stands down. Gated on the
  // active tab, not just the mount: SettingsDialog keeps visited tabs mounted
  // behind `hidden`, so a mount-scoped claim would outlive the tab being
  // visible. The dialog unmounts its children on close, so being mounted at all
  // already implies Settings is open.
  const isVisible = useSettingsStore((s) => s.activeTab === "troubleshooting");
  useEffect(() => {
    if (!isVisible) return;
    return useMissingPrerequisiteStore.getState().claimInlineSurface();
  }, [isVisible]);

  const runCheck = async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      // Forced: a manual re-check must re-probe, never replay main's cached
      // startup result.
      const data = await systemClient.healthCheck({ force: true });
      setResult(data);
    } catch (err) {
      setCheckError(formatErrorMessage(err, "Health check failed"));
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <>
      <SettingsRow
        id="troubleshooting-health"
        label="System health check"
        description="Verifies that Git, Node.js, and npm are installed and available"
        error={checkError}
        control={
          <Button variant="subtle" size="sm" onClick={() => void runCheck()} disabled={isChecking}>
            {isChecking ? "Checking…" : result ? "Run health check again" : "Run health check"}
          </Button>
        }
      />
      {result && (
        <ul className="px-4 py-2" aria-label="Health check results">
          {result.prerequisites.map((check) => {
            const labels: Record<string, string> = { git: "Git", node: "Node.js", npm: "npm" };
            const label = labels[check.tool] ?? check.tool;
            return (
              <li key={check.tool} className="flex items-center gap-2.5 py-1.5">
                {check.available ? (
                  <CircleCheck className="w-3.5 h-3.5 text-status-success shrink-0" />
                ) : (
                  <CircleX className="w-3.5 h-3.5 text-status-error shrink-0" />
                )}
                <span className="text-sm text-text-primary">{label}</span>
                {check.version && (
                  <span className="text-xs text-text-secondary">v{check.version}</span>
                )}
                {!check.available && (
                  <span className="ml-auto text-xs text-status-error">Not found</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

export function DownloadDiagnosticsSection() {
  const isCollecting = useDiagnosticsReviewStore((s) => s.isCollecting);
  const downloadError = useDiagnosticsReviewStore((s) => s.downloadError);

  const handleOpenReview = () => {
    void actionService.dispatch(
      "diagnostics.openReview",
      { scope: { source: "settings.troubleshooting" } },
      { source: "user" }
    );
  };

  return (
    <SettingsRow
      label="Diagnostics report"
      description="A snapshot of your system environment, app state, and recent logs. You review it before anything is saved."
      error={downloadError}
      control={
        <Button variant="subtle" size="sm" onClick={handleOpenReview} disabled={isCollecting}>
          {isCollecting && <Spinner size="sm" />}
          {isCollecting ? "Collecting…" : "Download diagnostics"}
        </Button>
      }
    />
  );
}

const CPU_PROFILE_DURATION_SECONDS = 15;

function RendererCpuProfileSection() {
  const [phase, setPhase] = useState<"idle" | "recording" | "saving">("idle");
  const [secondsLeft, setSecondsLeft] = useState(CPU_PROFILE_DURATION_SECONDS);
  const [error, setError] = useState<string | null>(null);
  const expiresAtRef = useRef(0);
  const stopInFlightRef = useRef(false);

  const handleStop = useCallback(async () => {
    if (stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    setPhase("saving");
    try {
      const result = await systemClient.stopRendererCpuProfile();
      if (
        result.status === "failed" &&
        result.reason !== "not-recording" &&
        result.reason !== "already-stopping"
      ) {
        setError(
          result.reason === "devtools-detached"
            ? "Recording stopped because DevTools attached to this window. Close DevTools and try again."
            : (result.message ?? "Couldn't save the profile")
        );
      }
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't capture the profile"));
    } finally {
      stopInFlightRef.current = false;
      setPhase("idle");
    }
  }, []);

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((expiresAtRef.current - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) void handleStop();
    }, PROFILE_UPDATE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [phase, handleStop]);

  const handleRecord = async () => {
    setError(null);
    try {
      const result = await systemClient.startRendererCpuProfile();
      if (result.status === "failed") {
        setError(
          result.reason === "already-recording"
            ? "A recording is already in progress. Wait for it to finish and try again."
            : (result.message ?? "Couldn't start the profiler")
        );
        return;
      }
      expiresAtRef.current = result.expiresAt;
      setSecondsLeft(CPU_PROFILE_DURATION_SECONDS);
      setPhase("recording");
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't start the profiler"));
    }
  };

  return (
    <SettingsRow
      label="CPU profile"
      description={
        phase === "recording"
          ? `Reproduce the slow interaction — auto-stops in ${secondsLeft}s`
          : "Captures 15 seconds of the interface's CPU activity to diagnose lag. The saved .cpuprofile file opens in Chrome DevTools."
      }
      error={error && <span className="select-text">{error}</span>}
      control={
        phase === "recording" ? (
          <Button variant="subtle" size="sm" onClick={() => void handleStop()}>
            Stop recording
          </Button>
        ) : (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => void handleRecord()}
            disabled={phase === "saving"}
          >
            {phase === "saving" ? "Saving…" : "Record profile"}
          </Button>
        )
      }
    />
  );
}

function HardwareAccelerationSection() {
  const [disabled, setDisabled] = useState<boolean | null>(null);
  const [angleFallback, setAngleFallback] = useState<boolean>(false);

  useEffect(() => {
    window.electron.gpu.getStatus().then((status) => {
      setDisabled(status.hardwareAccelerationDisabled);
      setAngleFallback(status.angleFallbackActive);
    });
  }, []);

  const handleToggle = () => {
    if (disabled === null) return;
    const newEnabled = disabled; // if currently disabled, we're enabling
    safeFireAndForget(window.electron.gpu.setHardwareAcceleration(newEnabled), {
      context: "Setting hardware acceleration preference",
    });
  };

  if (disabled === null) return null;

  const warning = disabled
    ? "GPU acceleration was disabled due to repeated crashes. Turn it back on to restore full performance."
    : angleFallback
      ? "GPU is running in ANGLE/Vulkan fallback mode after a crash. Performance may be reduced — turn hardware acceleration off and back on to restore the default backend."
      : null;

  return (
    <>
      <SettingsSwitchCard
        id="troubleshooting-gpu-acceleration"
        title="Hardware acceleration"
        subtitle="Uses the GPU to render the interface. Turn off if you see blank panels or repeated GPU crashes. The app restarts on change."
        isEnabled={!disabled}
        onChange={handleToggle}
      />
      {warning && <RowNote>{warning}</RowNote>}
    </>
  );
}

/** A warning attached to the row above it, inside the same group. */
function RowNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 px-4 py-2 text-xs text-text-secondary select-text">
      <AlertTriangle
        className="w-3.5 h-3.5 mt-px shrink-0 text-status-warning"
        aria-hidden="true"
      />
      <span>{children}</span>
    </p>
  );
}

export function ApplicationLogsSection() {
  const [showClearDialog, setShowClearDialog] = useState(false);

  return (
    <SettingsRow
      id="troubleshooting-logs"
      label="Application logs"
      description="Internal logs for debugging. Clearing asks for confirmation first."
      control={
        <>
          <Button
            variant="subtle"
            size="sm"
            onClick={() =>
              void actionService.dispatch("logs.openFile", undefined, { source: "user" })
            }
          >
            Open log file
          </Button>
          <Button variant="ghost-danger" size="sm" onClick={() => setShowClearDialog(true)}>
            Clear logs
          </Button>
          <ClearLogsConfirmDialog isOpen={showClearDialog} onOpenChange={setShowClearDialog} />
        </>
      }
    />
  );
}

export function TroubleshootingTab() {
  const [developerMode, setDeveloperMode] = useState(false);
  const [autoOpenDiagnostics, setAutoOpenDiagnostics] = useState(false);
  const [focusEventsTab, setFocusEventsTab] = useState(false);
  const [verboseLogging, setVerboseLogging] = useState(false);
  const [verboseLoggingPending, setVerboseLoggingPending] = useState(false);
  const [logOverrides, setLogOverrides] = useState<Record<string, string>>({});
  const [logOverridesRefreshKey, setLogOverridesRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void logsClient
      .getLevelOverrides()
      .then((overrides) => {
        if (!cancelled) setLogOverrides(overrides);
      })
      .catch(() => {
        if (!cancelled) setLogOverrides({});
      });
    return () => {
      cancelled = true;
    };
  }, [logOverridesRefreshKey, verboseLogging]);

  const handleOpenLogLevelPalette = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-log-level-palette"));
    // Refresh on a short delay after the palette closes; simplest approach is
    // to re-fetch whenever the user clicks the button again.
    setLogOverridesRefreshKey((k) => k + 1);
  };

  const handleClearLogOverrides = async () => {
    try {
      await logsClient.clearLevelOverrides();
      setLogOverrides({});
    } catch (error) {
      logError("Failed to clear log level overrides", error);
    }
  };

  useEffect(() => {
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
          setVerboseLogging((result.result as { verbose: boolean }).verbose);
        }
      })
      .catch((error) => {
        logError("Failed to get verbose logging state", error);
      });
  }, []);

  const saveDeveloperModeSettings = async (settings: NonNullable<AppState["developerMode"]>) => {
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
      logError("Failed to save developer mode settings", error);
    }
  };

  const handleToggleDeveloperMode = () => {
    const newEnabled = !developerMode;
    setDeveloperMode(newEnabled);

    if (!newEnabled) {
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("daintree:debug-toggle", { detail: { enabled: false } })
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
  };

  const handleToggleAutoOpenDiagnostics = () => {
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
  };

  const handleToggleFocusEventsTab = () => {
    const newValue = !focusEventsTab;
    setFocusEventsTab(newValue);
    saveDeveloperModeSettings({
      enabled: developerMode,
      showStateDebug: false,
      autoOpenDiagnostics,
      focusEventsTab: newValue,
    });
  };

  const handleToggleVerboseLogging = async () => {
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
      if (!result.ok) {
        logWarn("Backend rejected verbose logging toggle");
        setVerboseLogging(!newState);
      }
    } catch (error) {
      logError("Failed to set verbose logging", error);
      setVerboseLogging(!newState);
    } finally {
      setVerboseLoggingPending(false);
    }
  };

  const hasLogOverrides = Object.keys(logOverrides).length > 0;

  return (
    <div className="space-y-8">
      <SettingsSection title="System">
        <SettingsGroup>
          <HardwareAccelerationSection />
          <SystemHealthSection />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Diagnostics">
        <SettingsGroup>
          <DownloadDiagnosticsSection />
          <RendererCpuProfileSection />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Logging">
        <SettingsGroup>
          <ApplicationLogsSection />
          <SettingsSwitchCard
            id="troubleshooting-verbose-logging"
            title="Verbose logging"
            subtitle="Captures detailed debug output for troubleshooting. Resets on app restart."
            isEnabled={verboseLogging}
            onChange={handleToggleVerboseLogging}
            disabled={verboseLoggingPending}
            colorScheme="amber"
          />
          {verboseLogging && (
            <RowNote>Verbose logging may impact performance and increase log file size.</RowNote>
          )}
          <SettingsRow
            layout="stacked"
            label="Persistent verbose logging"
            description="The switch above resets on restart. To keep verbose logs across restarts, launch the app with this environment variable."
            control={
              <code className="block text-xs bg-surface-canvas p-2 rounded-[var(--radius-sm)] border border-border-default font-mono text-text-primary select-text">
                DAINTREE_DEBUG=1 npm run dev
              </code>
            }
          />
          <SettingsRow
            label="Per-module log levels"
            description="Override the log level for one module, or a process-wide wildcard. Overrides persist across restarts."
            control={
              <>
                <Button variant="subtle" size="sm" onClick={handleOpenLogLevelPalette}>
                  Set log level…
                </Button>
                {hasLogOverrides && (
                  <Button
                    variant="ghost-danger"
                    size="sm"
                    onClick={() => void handleClearLogOverrides()}
                  >
                    Clear all overrides
                  </Button>
                )}
              </>
            }
          />
          {hasLogOverrides && (
            <div className="px-4 py-2">
              <h5 className="text-xs font-medium text-text-secondary mb-1">Active overrides</h5>
              <ul>
                {Object.entries(logOverrides)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, level]) => (
                    <li key={name} className="flex items-center justify-between gap-3 py-1">
                      <span className="text-xs font-mono text-text-primary truncate">{name}</span>
                      <span className="text-xs font-mono text-text-secondary">{level}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Developer tools">
        <SettingsGroup>
          <SettingsSwitchCard
            id="troubleshooting-devmode"
            title="Developer mode"
            subtitle="Turns on the debugging features below"
            isEnabled={developerMode}
            onChange={handleToggleDeveloperMode}
            // e2e selectors (SEL.settings.developerModeToggle) find the switch by this name.
            ariaLabel="Developer Mode Toggle"
          />
          <SettingsDependents
            disabled={!developerMode}
            reason="Turn on developer mode to use these"
          >
            <SettingsSwitchCard
              id="troubleshooting-auto-diagnostics"
              title="Auto-open diagnostics dock"
              subtitle="Opens the diagnostics panel on app startup"
              isEnabled={autoOpenDiagnostics}
              onChange={handleToggleAutoOpenDiagnostics}
            />
            <SettingsDependents
              disabled={developerMode && !autoOpenDiagnostics}
              reason="Turn on auto-open diagnostics dock to use this"
            >
              <SettingsSwitchCard
                id="troubleshooting-focus-events"
                title="Focus events tab"
                subtitle="Opens diagnostics on the Events tab"
                isEnabled={focusEventsTab}
                onChange={handleToggleFocusEventsTab}
              />
            </SettingsDependents>
          </SettingsDependents>
          {/*
            Named by route, not by chord. The dev-only Alt+Cmd+I accelerator this
            used to advertise was removed when that chord became the fleet
            overview's scoped shortcut (#11950), and a settings page promising a
            key that now does something else entirely is worse than one that does
            not mention a key at all.
          */}
          <SettingsRow
            label="DevTools"
            description="In development builds, open DevTools from View → Toggle Developer Tools, or run the Toggle DevTools command from the command palette."
          />
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
