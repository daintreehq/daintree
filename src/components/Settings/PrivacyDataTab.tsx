import { useState, useEffect, useCallback } from "react";
import { Signal, FolderOpen, Trash2, Clock, HardDrive, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubtabBar } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";

type TelemetryLevel = "off" | "errors" | "full";
type LogRetention = 7 | 30 | 90 | 0;

const PRIVACY_SUBTABS: SettingsSubtabItem[] = [
  { id: "telemetry", label: "Telemetry" },
  { id: "storage", label: "Data & Storage" },
];

const TELEMETRY_OPTIONS: Array<{
  level: TelemetryLevel;
  title: string;
  description: string;
}> = [
  {
    level: "off",
    title: "Off",
    description: "No data is collected or sent. Crash reports are not submitted.",
  },
  {
    level: "errors",
    title: "Errors Only",
    description:
      "Crash reports and error details are sent to help improve stability. No usage analytics.",
  },
  {
    level: "full",
    title: "Full Usage",
    description:
      "Crash reports and anonymous usage analytics are sent to help improve the product.",
  },
];

const RETENTION_OPTIONS: Array<{ value: LogRetention; label: string }> = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
  { value: 0, label: "Keep forever" },
];

interface PrivacyDataTabProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

export function PrivacyDataTab({ activeSubtab, onSubtabChange }: PrivacyDataTabProps) {
  const currentSubtab = activeSubtab ?? "telemetry";

  const [telemetryLevel, setTelemetryLevel] = useState<TelemetryLevel>("off");
  const [logRetentionDays, setLogRetentionDays] = useState<LogRetention>(30);
  const [dataFolderPath, setDataFolderPath] = useState("");
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "confirming">("idle");

  useEffect(() => {
    window.electron.privacy.getSettings().then((settings) => {
      setTelemetryLevel(settings.telemetryLevel);
      setLogRetentionDays(settings.logRetentionDays);
      setDataFolderPath(settings.dataFolderPath);
    });
  }, []);

  // Reset confirmation state when leaving tab
  useEffect(() => {
    if (currentSubtab !== "storage") {
      setResetState("idle");
    }
  }, [currentSubtab]);

  const handleTelemetryChange = useCallback(async (level: TelemetryLevel) => {
    setTelemetryLevel(level);
    try {
      await window.electron.privacy.setTelemetryLevel(level);
    } catch (err) {
      console.error("Failed to set telemetry level:", err);
    }
  }, []);

  const handleRetentionChange = useCallback(async (days: LogRetention) => {
    setLogRetentionDays(days);
    try {
      await window.electron.privacy.setLogRetention(days);
    } catch (err) {
      console.error("Failed to set log retention:", err);
    }
  }, []);

  const handleOpenDataFolder = useCallback(() => {
    window.electron.privacy.openDataFolder();
  }, []);

  const handleClearCache = useCallback(async () => {
    setCacheClearing(true);
    setCacheCleared(false);
    try {
      await window.electron.privacy.clearCache();
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 3000);
    } catch (err) {
      console.error("Failed to clear cache:", err);
    } finally {
      setCacheClearing(false);
    }
  }, []);

  const handleResetAllData = useCallback(() => {
    window.electron.privacy.resetAllData();
  }, []);

  return (
    <div className="space-y-6">
      <SettingsSubtabBar
        subtabs={PRIVACY_SUBTABS}
        activeId={currentSubtab}
        onChange={onSubtabChange}
      />

      {currentSubtab === "telemetry" && (
        <SettingsSection
          icon={Signal}
          title="Telemetry & Diagnostics"
          description="Control what data Canopy collects. No personal data, file contents, or credentials are ever collected."
        >
          <div className="space-y-2">
            {TELEMETRY_OPTIONS.map((option) => (
              <button
                key={option.level}
                type="button"
                onClick={() => void handleTelemetryChange(option.level)}
                className={cn(
                  "w-full text-left p-4 rounded-[var(--radius-lg)] border transition-all",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                  telemetryLevel === option.level
                    ? "border-canopy-accent/40 bg-canopy-accent/5"
                    : "border-canopy-border hover:bg-tint/5"
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
                      telemetryLevel === option.level
                        ? "border-canopy-accent"
                        : "border-canopy-text/30"
                    )}
                  >
                    {telemetryLevel === option.level && (
                      <div className="w-2 h-2 rounded-full bg-canopy-accent" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-canopy-text">{option.title}</div>
                    <div className="text-xs text-canopy-text/50 mt-0.5">{option.description}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-canopy-text/40 mt-2">
            Changes to telemetry level take effect on next app restart.
          </p>
        </SettingsSection>
      )}

      {currentSubtab === "storage" && (
        <>
          <SettingsSection
            icon={FolderOpen}
            title="Data Folder"
            description="Location where Canopy stores settings, logs, and session data."
          >
            <div className="flex items-center gap-3">
              <code className="flex-1 text-xs bg-canopy-bg p-2.5 rounded-[var(--radius-md)] border border-canopy-border font-mono text-canopy-text/70 truncate">
                {dataFolderPath}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenDataFolder}
                className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text shrink-0"
              >
                <FolderOpen className="w-4 h-4" />
                Open Folder
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection
            icon={Clock}
            title="Log Retention"
            description="Automatically prune log files older than the selected period on startup."
          >
            <div className="flex gap-2">
              {RETENTION_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => void handleRetentionChange(option.value)}
                  className={cn(
                    "px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium transition-all",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
                    logRetentionDays === option.value
                      ? "bg-canopy-accent/10 text-canopy-accent border border-canopy-accent/30"
                      : "text-canopy-text/60 border border-canopy-border hover:bg-tint/5 hover:text-canopy-text"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-canopy-text/40 mt-2">
              Log pruning happens at startup. Changing this setting takes effect on next launch.
            </p>
          </SettingsSection>

          <SettingsSection
            icon={HardDrive}
            title="Clear Cache"
            description="Clear the HTTP disk cache and code caches. This does not affect your settings or data."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleClearCache()}
              disabled={cacheClearing}
              className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
            >
              <Trash2 className={cn("w-4 h-4", cacheClearing && "animate-spin")} />
              {cacheClearing ? "Clearing…" : cacheCleared ? "Cache Cleared" : "Clear Cache"}
            </Button>
          </SettingsSection>

          <SettingsSection
            icon={AlertTriangle}
            title="Reset All App Data"
            description="Permanently delete all settings, session data, and logs. The app will restart with factory defaults."
            iconColor="text-status-error"
          >
            {resetState === "idle" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setResetState("confirming")}
                className="text-status-error border-canopy-border hover:bg-status-error/10 hover:border-status-error/20"
              >
                <AlertTriangle className="w-4 h-4" />
                Reset All Data…
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="p-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
                  <p className="text-sm text-canopy-text font-medium mb-1">
                    Are you sure you want to reset?
                  </p>
                  <p className="text-xs text-canopy-text/60">
                    This will permanently delete all settings, API keys, session data, and logs. The
                    app will restart with factory defaults. This cannot be undone.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetState("idle")}
                    className="text-canopy-text border-canopy-border hover:bg-canopy-border hover:text-canopy-text"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleResetAllData}
                    className="text-text-inverse bg-status-error border-status-error hover:bg-status-error/80"
                  >
                    <AlertTriangle className="w-4 h-4" />
                    Reset Everything & Restart
                  </Button>
                </div>
              </div>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
