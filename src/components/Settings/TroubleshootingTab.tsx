import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Activity,
  FileText,
  Trash2,
  Bug,
  AlertTriangle,
  ShieldCheck,
  CircleCheck,
  CircleX,
  RotateCw,
  Download,
  Monitor,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { appClient } from "@/clients/appClient";
import { systemClient } from "@/clients/systemClient";
import { logsClient } from "@/clients/logsClient";
import type { AppState, SystemHealthCheckResult } from "@shared/types";
import { actionService } from "@/services/ActionService";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
import { logError, logWarn } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { ClearLogsConfirmDialog } from "@/components/Diagnostics/ClearLogsConfirmDialog";

const PROFILE_UPDATE_INTERVAL_MS = 250;

function SystemHealthSection() {
  const [result, setResult] = useState<SystemHealthCheckResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const runCheck = async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const data = await systemClient.healthCheck();
      setResult(data);
    } catch (err) {
      setCheckError(formatErrorMessage(err, "Health check failed"));
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <SettingsSection
      icon={ShieldCheck}
      title="System health check"
      description="Verify that required tools (Git, Node.js, npm) are installed and available."
    >
      <Button
        variant="outline"
        size="sm"
        onClick={() => void runCheck()}
        disabled={isChecking}
        className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text mb-3"
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
                className="flex items-center gap-2.5 px-3 py-2 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
              >
                {check.available ? (
                  <CircleCheck className="w-3.5 h-3.5 text-status-success shrink-0" />
                ) : (
                  <CircleX className="w-3.5 h-3.5 text-status-error shrink-0" />
                )}
                <span className="text-sm text-daintree-text">{label}</span>
                {check.version && (
                  <span className="text-xs text-daintree-text/40">v{check.version}</span>
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

function DownloadDiagnosticsSection() {
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
    <SettingsSection
      icon={Download}
      title="Download diagnostics"
      description="Export a detailed snapshot of your system environment, app state, and recent logs for troubleshooting."
    >
      <Button
        variant="outline"
        size="sm"
        onClick={handleOpenReview}
        disabled={isCollecting}
        className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text mb-3"
      >
        <Download className={cn("w-4 h-4", isCollecting && "animate-spin")} />
        {isCollecting ? "Collecting..." : "Download Diagnostics"}
      </Button>
      {downloadError && <p className="text-xs text-status-error mb-3">{downloadError}</p>}
    </SettingsSection>
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
    <SettingsSection
      icon={Activity}
      title="Record CPU profile"
      description="Capture a 15-second CPU profile of the app's interface to diagnose lag or slow interactions. The saved .cpuprofile file opens in Chrome DevTools."
    >
      <div className="flex items-center gap-3">
        {phase === "recording" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleStop()}
            className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
          >
            <Square className="w-4 h-4" />
            Stop recording
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleRecord()}
            disabled={phase === "saving"}
            className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
          >
            <Activity className="w-4 h-4" />
            {phase === "saving" ? "Saving…" : "Record profile"}
          </Button>
        )}
        {phase === "recording" && (
          <span className="text-xs text-daintree-text/60">
            Reproduce the slow interaction — auto-stops in {secondsLeft}s
          </span>
        )}
      </div>
      {error && <p className="text-xs text-status-error mt-3 select-text">{error}</p>}
    </SettingsSection>
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

  return (
    <SettingsSection
      icon={Monitor}
      title="Hardware acceleration"
      description="GPU hardware acceleration improves rendering performance. Disable if you experience blank panels or repeated GPU crashes."
    >
      <SettingsSwitchCard
        icon={Monitor}
        title="Hardware acceleration"
        subtitle="Uses GPU to improve rendering performance. Disable if you experience blank panels or rendering issues. App restarts on change."
        isEnabled={!disabled}
        onChange={handleToggle}
        ariaLabel="Hardware Acceleration Toggle"
      />

      {disabled && (
        <p className="text-xs text-status-warning/80 flex items-center gap-1.5 select-text">
          <AlertTriangle className="w-3 h-3" />
          GPU acceleration was disabled due to repeated crashes. Re-enable to restore full
          performance.
        </p>
      )}

      {!disabled && angleFallback && (
        <p className="text-xs text-status-warning/80 flex items-start gap-1.5 select-text">
          <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            GPU is running in ANGLE/Vulkan fallback mode after a crash. Performance may be reduced —
            toggle hardware acceleration off and back on to restore the default backend.
          </span>
        </p>
      )}
    </SettingsSection>
  );
}

export function ApplicationLogsSection() {
  const [showClearDialog, setShowClearDialog] = useState(false);

  return (
    <SettingsSection
      icon={FileText}
      title="Application logs"
      description="View internal application logs for debugging purposes."
    >
      <div className="flex gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void actionService.dispatch("logs.openFile", undefined, { source: "user" })
          }
          className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
        >
          <FileText />
          Open Log File
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowClearDialog(true)}
          className="text-status-error border-daintree-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
        >
          <Trash2 />
          Clear Logs
        </Button>
      </div>
      <ClearLogsConfirmDialog isOpen={showClearDialog} onOpenChange={setShowClearDialog} />
    </SettingsSection>
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

  return (
    <div className="space-y-6">
      <HardwareAccelerationSection />

      <DownloadDiagnosticsSection />

      <RendererCpuProfileSection />

      <SystemHealthSection />

      <ApplicationLogsSection />

      <SettingsSection
        icon={Bug}
        title="Developer mode"
        description="Enable enhanced debugging features for development and troubleshooting."
      >
        <SettingsSwitchCard
          icon={Bug}
          title="Developer mode"
          subtitle="Activates all debugging features below"
          isEnabled={developerMode}
          onChange={handleToggleDeveloperMode}
          ariaLabel="Developer Mode Toggle"
        />

        <div className="ml-4 space-y-3 border-l-2 border-daintree-border pl-4">
          <SettingsSwitchCard
            variant="compact"
            title="Auto-open diagnostics dock"
            subtitle="Automatically open diagnostics panel on app startup"
            isEnabled={autoOpenDiagnostics}
            onChange={handleToggleAutoOpenDiagnostics}
            ariaLabel="Auto-open diagnostics dock"
            disabled={!developerMode}
          />

          <div className="ml-4">
            <SettingsSwitchCard
              variant="compact"
              title="Focus events tab"
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
          title="Verbose logging"
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

        <div className="p-3 bg-daintree-border/30 rounded-[var(--radius-md)]">
          <h5 className="text-xs font-medium text-daintree-text mb-2">
            Advanced: Persistent Verbose Logging
          </h5>
          <p className="text-xs text-daintree-text/60 mb-2 select-text">
            Use the toggle above for quick debugging. For persistent verbose logs across restarts,
            launch the app with environment variables:
          </p>
          <code className="block text-xs bg-daintree-bg p-2 rounded border border-daintree-border font-mono text-daintree-text">
            DAINTREE_DEBUG=1 npm run dev
          </code>
        </div>
      </SettingsSection>

      <SettingsSection
        icon={SlidersHorizontal}
        title="Per-module log levels"
        description="Override the log level for a specific module (or a process-wide wildcard). Overrides persist across restarts."
      >
        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenLogLevelPalette}
            className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
          >
            <SlidersHorizontal />
            Set Log Level…
          </Button>
          {Object.keys(logOverrides).length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleClearLogOverrides()}
              className="text-status-error border-daintree-border hover:bg-status-error/10 hover:text-status-error/70 hover:border-status-error/20"
            >
              <Trash2 />
              Clear All Overrides
            </Button>
          )}
        </div>

        {Object.keys(logOverrides).length > 0 && (
          <div className="space-y-1 mt-3">
            <h5 className="text-xs font-medium text-daintree-text/80 mb-1">Active overrides</h5>
            {Object.entries(logOverrides)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, level]) => (
                <div
                  key={name}
                  className="flex items-center justify-between px-3 py-1.5 rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg/30"
                >
                  <span className="text-xs font-mono text-daintree-text truncate">{name}</span>
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-daintree-border/60 text-daintree-text/80">
                    {level}
                  </span>
                </div>
              ))}
          </div>
        )}
      </SettingsSection>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-daintree-text">Keyboard Shortcuts</h4>
        <p className="text-xs text-daintree-text/50 select-text">
          Use Cmd+Option+I (Mac) or Ctrl+Shift+I (Windows/Linux) to open DevTools.
        </p>
      </div>
    </div>
  );
}
