import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { SeverityMark } from "@/lib/statusSeverity";
import { ErrorRetryRow, InlineErrorRow } from "./auditLogParts";
import { Spinner } from "@/components/ui/Spinner";
import { appClient, systemClient, logsClient } from "@/clients";
import type { AppState, SystemHealthCheckResult } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { useMissingPrerequisiteStore } from "@/store/missingPrerequisiteStore";
import { useSettingsStore } from "@/store/settingsStore";
import { usePaletteStore } from "@/store/paletteStore";
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

  const labels: Record<string, string> = {
    git: "Git",
    node: "Node.js",
    npm: "npm",
    gh: "GitHub CLI",
  };
  const missing = result ? result.prerequisites.filter((check) => !check.available) : [];

  return (
    <>
      <SettingsRow
        id="troubleshooting-health"
        label="System health check"
        description="Checks that the command-line tools Daintree relies on are installed and on your PATH"
        error={checkError}
        control={
          <Button variant="outline" size="sm" onClick={() => void runCheck()} disabled={isChecking}>
            {isChecking ? "Checking…" : result ? "Run health check again" : "Run health check"}
          </Button>
        }
      />
      <p className="sr-only" role="status">
        {checkError ?? ""}
      </p>
      {result && (
        <div className="py-2 pl-4 pr-4">
          <p className="sr-only" role="status">
            {missing.length === 0
              ? "Health check finished. Every tool was found."
              : `Health check finished. Not found: ${missing.map((c) => labels[c.tool] ?? c.tool).join(", ")}.`}
          </p>
          <ul aria-label="Health check results">
            {result.prerequisites.map((check) => {
              const label = labels[check.tool] ?? check.tool;
              return (
                <li key={check.tool} className="flex items-center gap-2.5 py-1.5">
                  <SeverityMark
                    severity={check.available ? "success" : "error"}
                    label={check.available ? "Found" : "Not found"}
                    className="w-3.5 h-3.5"
                  />
                  <span className="text-sm text-text-primary">{label}</span>
                  {check.available ? (
                    check.version && (
                      <span className="text-xs text-text-secondary tabular-nums">
                        {check.version}
                      </span>
                    )
                  ) : (
                    <span className="text-xs text-text-primary">Not found</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
        <Button variant="outline" size="sm" onClick={handleOpenReview} disabled={isCollecting}>
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
          <Button variant="outline" size="sm" onClick={() => void handleStop()}>
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
  const [readFailed, setReadFailed] = useState(false);
  const [readNonce, setReadNonce] = useState(0);

  useEffect(() => {
    setReadFailed(false);
    window.electron.gpu
      .getStatus()
      .then((status) => {
        setDisabled(status.hardwareAccelerationDisabled);
        setAngleFallback(status.angleFallbackActive);
      })
      .catch((err) => {
        setReadFailed(true);
        logError("Failed to read GPU status", err);
      });
  }, [readNonce]);

  const handleToggle = () => {
    if (disabled === null) return;
    const newEnabled = disabled; // if currently disabled, we're enabling
    safeFireAndForget(window.electron.gpu.setHardwareAcceleration(newEnabled), {
      context: "Setting hardware acceleration preference",
    });
  };

  if (disabled === null) {
    // Rendered from the start so the group doesn't shift when the read lands, and
    // so a failed read says so instead of the setting silently missing.
    return (
      <>
        <SettingsSwitchCard
          id="troubleshooting-gpu-acceleration"
          title="Hardware acceleration"
          subtitle="Uses the GPU to render the interface. Turn off if you see blank panels or repeated GPU crashes. The app restarts on change."
          isEnabled={false}
          onChange={() => {}}
          disabled
        />
        {readFailed && (
          <ErrorRetryRow
            message="The GPU status couldn't be read"
            onRetry={() => setReadNonce((n) => n + 1)}
          />
        )}
      </>
    );
  }

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
  return (
    <SettingsRow
      id="troubleshooting-logs"
      label="Application logs"
      description="Internal logs for debugging"
      control={
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void actionService.dispatch("logs.openFile", undefined, { source: "user" })
          }
        >
          Open log file
        </Button>
      }
    />
  );
}

/** Destructive, so it closes the logging group rather than sharing the logs row. */
export function ClearLogsRow() {
  const [showClearDialog, setShowClearDialog] = useState(false);

  return (
    <SettingsRow
      label="Clear logs"
      description="Deletes the application log files. Asks for confirmation first."
      control={
        <>
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
  // The switches show defaults until main answers; they stay disabled until then
  // so a fallback never reads as the saved setting.
  const [developerModeLoaded, setDeveloperModeLoaded] = useState(false);
  const [verboseLoaded, setVerboseLoaded] = useState(false);
  const [verboseError, setVerboseError] = useState<string | null>(null);
  const [logOverridesFailed, setLogOverridesFailed] = useState(false);
  const [clearOverridesError, setClearOverridesError] = useState<string | null>(null);
  const [developerModeError, setDeveloperModeError] = useState<string | null>(null);
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
        if (cancelled) return;
        setLogOverrides(overrides);
        setLogOverridesFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLogOverridesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [logOverridesRefreshKey, verboseLogging]);

  // The palette is where overrides change, so re-read them when it closes.
  const logLevelPaletteOpen = usePaletteStore((s) => s.activePaletteId === "log-level");
  const [wasLogLevelPaletteOpen, setWasLogLevelPaletteOpen] = useState(false);
  if (logLevelPaletteOpen !== wasLogLevelPaletteOpen) {
    setWasLogLevelPaletteOpen(logLevelPaletteOpen);
    if (!logLevelPaletteOpen) setLogOverridesRefreshKey((k) => k + 1);
  }

  const handleOpenLogLevelPalette = () => {
    window.dispatchEvent(new CustomEvent("daintree:open-log-level-palette"));
  };

  const handleClearLogOverrides = async () => {
    setClearOverridesError(null);
    try {
      await logsClient.clearLevelOverrides();
      setLogOverrides({});
    } catch (error) {
      setClearOverridesError("Overrides couldn't be cleared. Try again.");
      logError("Failed to clear log level overrides", error);
    }
  };

  const [developerModeReadFailed, setDeveloperModeReadFailed] = useState(false);
  const [developerModeNonce, setDeveloperModeNonce] = useState(0);
  const [verboseReadFailed, setVerboseReadFailed] = useState(false);
  const [verboseNonce, setVerboseNonce] = useState(0);

  useEffect(() => {
    setDeveloperModeReadFailed(false);
    appClient
      .getState()
      .then((appState) => {
        if (appState?.developerMode) {
          setDeveloperMode(appState.developerMode.enabled);
          setAutoOpenDiagnostics(appState.developerMode.autoOpenDiagnostics);
          setFocusEventsTab(appState.developerMode.focusEventsTab);
        }
        setDeveloperModeLoaded(true);
      })
      .catch((error) => {
        setDeveloperModeReadFailed(true);
        logError("Failed to read developer mode settings", error);
      });
  }, [developerModeNonce]);

  useEffect(() => {
    setVerboseReadFailed(false);
    actionService
      .dispatch("logs.getVerbose", undefined, { source: "user" })
      .then((result) => {
        if (result.ok) {
          setVerboseLogging((result.result as { verbose: boolean }).verbose);
          setVerboseLoaded(true);
        } else {
          setVerboseReadFailed(true);
        }
      })
      .catch((error) => {
        setVerboseReadFailed(true);
        logError("Failed to get verbose logging state", error);
      });
  }, [verboseNonce]);

  /** Resolves false when main refused the change, so the caller can put the switches back. */
  const saveDeveloperModeSettings = async (
    settings: NonNullable<AppState["developerMode"]>
  ): Promise<boolean> => {
    setDeveloperModeError(null);
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
      return true;
    } catch (error) {
      logError("Failed to save developer mode settings", error);
      setDeveloperModeError("Developer settings couldn't be saved. Try again.");
      return false;
    }
  };

  const restoreDeveloperMode = (previous: {
    enabled: boolean;
    autoOpenDiagnostics: boolean;
    focusEventsTab: boolean;
  }) => {
    setDeveloperMode(previous.enabled);
    setAutoOpenDiagnostics(previous.autoOpenDiagnostics);
    setFocusEventsTab(previous.focusEventsTab);
  };

  const handleToggleDeveloperMode = async () => {
    const previous = { enabled: developerMode, autoOpenDiagnostics, focusEventsTab };
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
      const saved = await saveDeveloperModeSettings({
        enabled: false,
        showStateDebug: false,
        autoOpenDiagnostics: false,
        focusEventsTab: false,
      });
      if (!saved) restoreDeveloperMode(previous);
    } else {
      const saved = await saveDeveloperModeSettings({
        enabled: true,
        showStateDebug: false,
        autoOpenDiagnostics,
        focusEventsTab,
      });
      if (!saved) restoreDeveloperMode(previous);
    }
  };

  const handleToggleAutoOpenDiagnostics = async () => {
    const previous = { enabled: developerMode, autoOpenDiagnostics, focusEventsTab };
    const newValue = !autoOpenDiagnostics;
    setAutoOpenDiagnostics(newValue);
    if (!newValue) setFocusEventsTab(false);
    const saved = await saveDeveloperModeSettings({
      enabled: developerMode,
      showStateDebug: false,
      autoOpenDiagnostics: newValue,
      focusEventsTab: newValue ? focusEventsTab : false,
    });
    if (!saved) restoreDeveloperMode(previous);
  };

  const handleToggleFocusEventsTab = async () => {
    const previous = { enabled: developerMode, autoOpenDiagnostics, focusEventsTab };
    const newValue = !focusEventsTab;
    setFocusEventsTab(newValue);
    const saved = await saveDeveloperModeSettings({
      enabled: developerMode,
      showStateDebug: false,
      autoOpenDiagnostics,
      focusEventsTab: newValue,
    });
    if (!saved) restoreDeveloperMode(previous);
  };

  const handleToggleVerboseLogging = async () => {
    if (verboseLoggingPending) return;

    const newState = !verboseLogging;
    setVerboseError(null);
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
        setVerboseError("Verbose logging couldn't be changed. Try again.");
      }
    } catch (error) {
      logError("Failed to set verbose logging", error);
      setVerboseLogging(!newState);
      setVerboseError("Verbose logging couldn't be changed. Try again.");
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
            disabled={verboseLoggingPending || !verboseLoaded}
          />
          {verboseError && <InlineErrorRow>{verboseError}</InlineErrorRow>}
          {verboseReadFailed && (
            <ErrorRetryRow
              message="Whether verbose logging is on couldn't be read"
              onRetry={() => setVerboseNonce((n) => n + 1)}
            />
          )}
          {verboseLogging && (
            <RowNote>Verbose logging may impact performance and increase log file size.</RowNote>
          )}
          <SettingsRow
            label="Verbose logging on every launch"
            description={
              <>
                Set <code className="font-mono text-text-primary">DAINTREE_DEBUG=1</code> in the
                environment Daintree starts from. In a development build that&apos;s{" "}
                <code className="font-mono text-text-primary">DAINTREE_DEBUG=1 npm run dev</code>.
              </>
            }
          />
        </SettingsGroup>
        <SettingsGroup>
          <ClearLogsRow />
        </SettingsGroup>
        <SettingsGroup label="Log levels">
          <SettingsRow
            label="Per-module log levels"
            description="Override the log level for one module, or a process-wide wildcard. Overrides persist across restarts."
            control={
              <Button variant="outline" size="sm" onClick={handleOpenLogLevelPalette}>
                Set log level…
              </Button>
            }
          />
          {logOverridesFailed && (
            <ErrorRetryRow
              message="Active overrides couldn't be read"
              onRetry={() => setLogOverridesRefreshKey((k) => k + 1)}
            />
          )}
          {hasLogOverrides && (
            <SettingsRow
              label="Active overrides"
              description={
                <ul>
                  {Object.entries(logOverrides)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, level]) => (
                      <li key={name} className="flex items-center justify-between gap-3 py-0.5">
                        <span className="font-mono text-text-primary truncate">{name}</span>
                        <span className="font-mono">{level}</span>
                      </li>
                    ))}
                </ul>
              }
              control={
                <Button
                  variant="ghost-danger"
                  size="sm"
                  onClick={() => void handleClearLogOverrides()}
                >
                  Clear all overrides
                </Button>
              }
            />
          )}
          {clearOverridesError && <InlineErrorRow>{clearOverridesError}</InlineErrorRow>}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Developer tools">
        <SettingsGroup>
          <SettingsSwitchCard
            id="troubleshooting-devmode"
            title="Developer mode"
            subtitle="Turns on the debugging features below"
            isEnabled={developerMode}
            onChange={() => void handleToggleDeveloperMode()}
            disabled={!developerModeLoaded}
            // e2e selectors (SEL.settings.developerModeToggle) find the switch by this name.
            ariaLabel="Developer Mode Toggle"
          />
          {developerModeError && <InlineErrorRow>{developerModeError}</InlineErrorRow>}
          {developerModeReadFailed && (
            <ErrorRetryRow
              message="Developer settings couldn't be read"
              onRetry={() => setDeveloperModeNonce((n) => n + 1)}
            />
          )}
          <SettingsDependents
            disabled={!developerMode}
            reason="Turn on developer mode to use these"
          >
            <SettingsSwitchCard
              id="troubleshooting-auto-diagnostics"
              title="Auto-open diagnostics dock"
              subtitle="Opens the diagnostics panel on app startup"
              isEnabled={autoOpenDiagnostics}
              onChange={() => void handleToggleAutoOpenDiagnostics()}
            />
            <SettingsSwitchCard
              id="troubleshooting-focus-events"
              title="Focus events tab"
              subtitle="Opens diagnostics on the Events tab"
              isEnabled={focusEventsTab}
              onChange={() => void handleToggleFocusEventsTab()}
              disabled={!autoOpenDiagnostics}
              disabledReason={
                developerMode ? "Turn on auto-open diagnostics dock to use this" : undefined
              }
            />
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
