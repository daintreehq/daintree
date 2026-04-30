import { useState, useEffect, useCallback } from "react";
import { Signal, FolderOpen, Trash2, Clock, HardDrive, AlertTriangle, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubtabBar } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { ANALYTICS_EVENTS } from "@shared/config/telemetry";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

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

const TELEMETRY_DISCLOSURE: Array<{
  level: TelemetryLevel;
  title: string;
  summary: string;
  fields: string[];
  events?: readonly string[];
}> = [
  {
    level: "off",
    title: "Off level",
    summary: "No data is collected or transmitted.",
    fields: [],
  },
  {
    level: "errors",
    title: "Errors Only level",
    summary:
      "A sampled subset (roughly 10%) of crash reports is sent to Sentry. Home-directory paths are redacted from stack frames and error messages before transmission. If onboarding analytics events were buffered before you made a consent choice, they may be flushed once when telemetry is first enabled.",
    fields: [
      "Exception type and message (home directory redacted)",
      "Stack frames with sanitized file paths, line and column numbers",
      "App version, Node.js version, and build environment (production or development)",
      "Operating system name, version, and architecture",
      "Default runtime metadata provided by the Sentry Electron SDK (CPU, memory, GPU, locale, timezone, and similar vendor-supplied fields)",
      "Main-process breadcrumbs of recent app activity preceding the crash (lifecycle events and main-process console logs)",
    ],
  },
  {
    level: "full",
    title: "Full Usage level",
    summary:
      "Everything above, plus the following anonymous onboarding analytics events. Each event carries its name, a timestamp, and event-specific properties — never file contents, prompts, or credentials. Like crash reports, these events pass through the same roughly 10% sampling before transmission.",
    fields: [],
    events: ANALYTICS_EVENTS,
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
    window.electron.privacy
      .getSettings()
      .then((settings) => {
        setTelemetryLevel(settings.telemetryLevel);
        setLogRetentionDays(settings.logRetentionDays);
        setDataFolderPath(settings.dataFolderPath);
      })
      .catch((err) => {
        const fetchAndSet = async () => {
          const settings = await window.electron.privacy.getSettings();
          setTelemetryLevel(settings.telemetryLevel);
          setLogRetentionDays(settings.logRetentionDays);
          setDataFolderPath(settings.dataFolderPath);
        };
        const retry = async () => {
          try {
            await fetchAndSet();
          } catch (retryErr) {
            notify({
              type: "error",
              title: "Failed to load settings",
              message: "Privacy settings could not be loaded.",
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
            logError("Failed to load privacy settings", retryErr);
          }
        };
        notify({
          type: "error",
          title: "Failed to load settings",
          message: "Privacy settings could not be loaded.",
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        });
        logError("Failed to load privacy settings", err);
      });
  }, []);

  // Reset confirmation state when leaving tab
  useEffect(() => {
    if (currentSubtab !== "storage") {
      setResetState("idle");
    }
  }, [currentSubtab]);

  const handleTelemetryChange = useCallback(
    async (level: TelemetryLevel) => {
      const prev = telemetryLevel;
      setTelemetryLevel(level);
      try {
        await window.electron.privacy.setTelemetryLevel(level);
      } catch (err) {
        setTelemetryLevel(prev);
        const retry = async () => {
          try {
            await window.electron.privacy.setTelemetryLevel(level);
            setTelemetryLevel(level);
          } catch (retryErr) {
            setTelemetryLevel(prev);
            notify({
              type: "error",
              title: "Failed to save setting",
              message: "Telemetry level could not be saved.",
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
            logError("Failed to set telemetry level", retryErr);
          }
        };
        notify({
          type: "error",
          title: "Failed to save setting",
          message: "Telemetry level could not be saved.",
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        });
        logError("Failed to set telemetry level", err);
      }
    },
    [telemetryLevel]
  );

  const handleRetentionChange = useCallback(
    async (days: LogRetention) => {
      const prev = logRetentionDays;
      setLogRetentionDays(days);
      try {
        await window.electron.privacy.setLogRetention(days);
      } catch (err) {
        setLogRetentionDays(prev);
        const retry = async () => {
          try {
            await window.electron.privacy.setLogRetention(days);
            setLogRetentionDays(days);
          } catch (retryErr) {
            setLogRetentionDays(prev);
            notify({
              type: "error",
              title: "Failed to save setting",
              message: "Log retention could not be saved.",
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
            logError("Failed to set log retention", retryErr);
          }
        };
        notify({
          type: "error",
          title: "Failed to save setting",
          message: "Log retention could not be saved.",
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        });
        logError("Failed to set log retention", err);
      }
    },
    [logRetentionDays]
  );

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
      logError("Failed to clear cache", err);
    } finally {
      setCacheClearing(false);
    }
  }, []);

  const handleResetAllData = useCallback(() => {
    window.electron.privacy.resetAllData();
  }, []);

  const handleOpenTelemetryPreview = useCallback(() => {
    void actionService.dispatch("telemetry.togglePreview", { active: true }, { source: "user" });
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
          description="Control what data Daintree collects. No personal data, file contents, or credentials are ever collected."
        >
          <div className="contents">
            {TELEMETRY_OPTIONS.map((option) => (
              <button
                key={option.level}
                type="button"
                onClick={() => void handleTelemetryChange(option.level)}
                className={cn(
                  "w-full text-left p-4 rounded-[var(--radius-lg)] border transition-colors",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                  telemetryLevel === option.level
                    ? "border-border-strong bg-overlay-selected"
                    : "border-daintree-border hover:bg-tint/5"
                )}
              >
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
                      telemetryLevel === option.level
                        ? "border-border-strong"
                        : "border-daintree-text/30"
                    )}
                  >
                    {telemetryLevel === option.level && (
                      <div className="w-2 h-2 rounded-full bg-daintree-text" />
                    )}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-daintree-text">{option.title}</div>
                    <div className="text-xs text-daintree-text/50 mt-0.5 select-text">
                      {option.description}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
          <p className="text-xs text-daintree-text/40 mt-2 select-text">
            Changes to telemetry level take effect on next app restart.
          </p>

          <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-md)] border border-daintree-border/60 bg-daintree-bg/40 p-3">
            <Eye className="w-4 h-4 mt-0.5 text-daintree-accent/80 shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-daintree-text">Preview outbound telemetry</p>
              <p className="text-xs text-daintree-text/60 mt-0.5 select-text">
                Inspect every sanitised payload Daintree would send — live, for this session only,
                with no transmission to any server.
              </p>
            </div>
            <Button variant="subtle" size="xs" onClick={handleOpenTelemetryPreview}>
              Open preview
            </Button>
          </div>

          <div
            aria-labelledby="telemetry-disclosure-heading"
            className="mt-6 pt-4 border-t border-daintree-border/40"
          >
            <h3
              id="telemetry-disclosure-heading"
              className="text-xs font-medium text-daintree-text/70 uppercase tracking-wide"
            >
              What's collected at each level
            </h3>
            <p className="text-xs text-daintree-text/50 mt-1 select-text">
              This disclosure describes the data transmitted externally. File contents, prompts, API
              keys, and other credentials are never collected.
            </p>
            <dl className="mt-3 space-y-4">
              {TELEMETRY_DISCLOSURE.map((entry) => (
                <div
                  key={entry.level}
                  className="rounded-[var(--radius-md)] border border-daintree-border/60 bg-daintree-bg/40 p-3"
                >
                  <dt className="text-xs font-medium text-daintree-text">{entry.title}</dt>
                  <dd className="mt-1 space-y-2 text-xs text-daintree-text/60 select-text">
                    <p>{entry.summary}</p>
                    {entry.fields.length > 0 && (
                      <ul className="list-disc pl-4 space-y-0.5">
                        {entry.fields.map((field) => (
                          <li key={field}>{field}</li>
                        ))}
                      </ul>
                    )}
                    {entry.events && entry.events.length > 0 && (
                      <ul className="flex flex-wrap gap-1.5 pt-1">
                        {entry.events.map((name) => (
                          <li
                            key={name}
                            className="font-mono text-[11px] text-daintree-text/70 bg-daintree-bg px-1.5 py-0.5 rounded border border-daintree-border/60"
                          >
                            {name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </SettingsSection>
      )}

      {currentSubtab === "storage" && (
        <>
          <SettingsSection
            icon={FolderOpen}
            title="Data Folder"
            description="Location where Daintree stores settings, logs, and session data."
          >
            <div className="flex items-center gap-3">
              <code className="flex-1 text-xs bg-daintree-bg p-2.5 rounded-[var(--radius-md)] border border-daintree-border font-mono text-daintree-text/70 truncate">
                {dataFolderPath}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenDataFolder}
                className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text shrink-0"
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
                    "px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
                    logRetentionDays === option.value
                      ? "bg-overlay-selected text-daintree-text font-medium border border-border-strong"
                      : "text-daintree-text/60 border border-daintree-border hover:bg-tint/5 hover:text-daintree-text"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-daintree-text/40 mt-2 select-text">
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
              className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
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
                className="text-status-error border-daintree-border hover:bg-status-error/10 hover:border-status-error/20"
              >
                <AlertTriangle className="w-4 h-4" />
                Reset All Data…
              </Button>
            ) : (
              <div className="contents">
                <div className="p-3 rounded-[var(--radius-md)] border border-status-error/20 bg-status-error/5">
                  <p className="text-sm text-daintree-text font-medium mb-1">Reset all app data?</p>
                  <p className="text-xs text-daintree-text/60">
                    This will permanently delete all settings, API keys, session data, and logs. The
                    app will restart with factory defaults. This cannot be undone.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetState("idle")}
                    className="text-daintree-text border-daintree-border hover:bg-daintree-border hover:text-daintree-text"
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
                    Reset everything &amp; restart
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
