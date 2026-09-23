import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SettingsSection } from "./SettingsSection";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import type { SettingsPresetOption } from "./SettingsPresetGroup";
import { SettingsSubtabBar, subtabPanelProps } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { ANALYTICS_EVENTS } from "@shared/config/telemetry";
import { actionService } from "@/services/ActionService";
import { useActionPrefsStore } from "@/store/actionPrefsStore";
import { logError } from "@/utils/logger";

type TelemetryLevel = "off" | "errors" | "full";
type LogRetention = 7 | 30 | 90 | 0;

const PRIVACY_SUBTABS: SettingsSubtabItem[] = [
  { id: "telemetry", label: "Telemetry" },
  { id: "storage", label: "Data & storage" },
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
    title: "Errors only",
    description:
      "Crash reports and error details are sent to help improve stability. No usage analytics.",
  },
  {
    level: "full",
    title: "Full usage",
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
    title: "Errors only level",
    summary:
      "Crash reports and error details are sent to Sentry. Home-directory paths are redacted from stack frames and error messages before transmission. Usage analytics aren't sent, and any analytics events recorded before you chose a level are discarded.",
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
    title: "Full usage level",
    summary:
      "Crash reports and error details, plus anonymous usage analytics events, including those listed below. Each event carries its name, a timestamp, and event-specific properties — never file contents, prompts, or credentials. Analytics events recorded before you chose a level may be sent when you choose Full usage.",
    fields: [],
    events: ANALYTICS_EVENTS,
  },
];

/** How long the "History cleared" confirmation label stays visible. */
const CLEARED_FLASH_MS = 3000;

const DEFAULT_RETENTION_DAYS: LogRetention = 30;

const RETENTION_OPTIONS: SettingsPresetOption<LogRetention>[] = [
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
  const [logRetentionDays, setLogRetentionDays] = useState<LogRetention>(DEFAULT_RETENTION_DAYS);
  const [dataFolderPath, setDataFolderPath] = useState("");
  const [cacheClearing, setCacheClearing] = useState(false);
  const [cacheCleared, setCacheCleared] = useState(false);
  const [resetState, setResetState] = useState<"idle" | "confirming">("idle");
  const [sessionRetentionDays, setSessionRetentionDays] =
    useState<LogRetention>(DEFAULT_RETENTION_DAYS);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [historyCleared, setHistoryCleared] = useState(false);

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
              title: "Couldn't load settings",
              message: "Privacy settings couldn't be loaded.",
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
            logError("Failed to load privacy settings", retryErr);
          }
        };
        notify({
          type: "error",
          title: "Couldn't load settings",
          message: "Privacy settings couldn't be loaded.",
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

  const handleTelemetryChange = async (level: TelemetryLevel) => {
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
            title: "Couldn't save setting",
            message: "Telemetry level couldn't be saved.",
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
          logError("Failed to set telemetry level", retryErr);
        }
      };
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Telemetry level couldn't be saved.",
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
      logError("Failed to set telemetry level", err);
    }
  };

  const handleRetentionChange = async (days: LogRetention) => {
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
            title: "Couldn't save setting",
            message: "Log retention couldn't be saved.",
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
          logError("Failed to set log retention", retryErr);
        }
      };
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Log retention couldn't be saved.",
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
      logError("Failed to set log retention", err);
    }
  };

  useEffect(() => {
    let cancelled = false;
    window.electron.agentSessionHistory
      .getRetentionDays()
      .then((days) => {
        if (!cancelled) setSessionRetentionDays(days);
      })
      .catch((err) => {
        // Non-blocking: the picker falls back to the 30-day default already in
        // state. No error toast — the setting is still adjustable and re-reads
        // on the next open (Doherty: silent recovery over interrupting the user).
        logError("Failed to load agent session retention", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSessionRetentionChange = async (days: LogRetention) => {
    const prev = sessionRetentionDays;
    setSessionRetentionDays(days);
    try {
      await window.electron.agentSessionHistory.setRetentionDays(days);
    } catch (err) {
      setSessionRetentionDays(prev);
      const retry = async () => {
        try {
          await window.electron.agentSessionHistory.setRetentionDays(days);
          setSessionRetentionDays(days);
        } catch (retryErr) {
          setSessionRetentionDays(prev);
          notify({
            type: "error",
            title: "Couldn't save setting",
            message: "Session history retention couldn't be saved.",
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            context: { eventKind: "uiFeedback" },
          });
          logError("Failed to set session history retention", retryErr);
        }
      };
      notify({
        type: "error",
        title: "Couldn't save setting",
        message: "Session history retention couldn't be saved.",
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        context: { eventKind: "uiFeedback" },
      });
      logError("Failed to set session history retention", err);
    }
  };

  const handleClearSessionHistory = async () => {
    // Close the confirm dialog up front — ConfirmDialog doesn't self-close on
    // confirm, and the clear is fast + surfaces its own error toast on failure.
    setShowClearHistoryConfirm(false);
    try {
      await window.electron.agentSessionHistory.clear();
      setHistoryCleared(true);
      setTimeout(() => setHistoryCleared(false), CLEARED_FLASH_MS);
    } catch (err) {
      notify({
        type: "error",
        title: "Couldn't clear history",
        message: "Session history couldn't be cleared.",
        actions: [
          {
            label: "Try again",
            variant: "primary",
            onClick: () => void handleClearSessionHistory(),
          },
        ],
        context: { eventKind: "uiFeedback" },
      });
      logError("Failed to clear agent session history", err);
    }
  };

  const handleOpenDataFolder = () => {
    window.electron.privacy.openDataFolder();
  };

  const notifyClearCacheFailed = (title: string, message: string, onRetry: () => void) => {
    notify({
      type: "error",
      // uiFeedback defaults to inbox-only, which would drop the Try again callback.
      priority: "high",
      title,
      message,
      actions: [{ label: "Try again", variant: "primary", onClick: onRetry }],
      context: { eventKind: "uiFeedback" },
    });
  };

  const handleClearCache = async () => {
    setCacheClearing(true);
    setCacheCleared(false);
    try {
      const { failed } = await window.electron.privacy.clearCache();
      if (failed === 0) {
        setCacheCleared(true);
        setTimeout(() => setCacheCleared(false), 3000);
      } else {
        notifyClearCacheFailed(
          "Couldn't clear all caches",
          "Some cached data may remain. Try again to finish clearing it.",
          () => void handleClearCache()
        );
      }
    } catch (err) {
      notifyClearCacheFailed(
        "Couldn't clear cache",
        "Cached data may remain. Try again to finish clearing it.",
        () => void handleClearCache()
      );
      logError("Failed to clear cache", err);
    } finally {
      setCacheClearing(false);
    }
  };

  const handleResetAllData = () => {
    window.electron.privacy.resetAllData();
  };

  const handleOpenTelemetryPreview = () => {
    void actionService.dispatch("telemetry.togglePreview", { active: true }, { source: "user" });
  };

  const hiddenActionCount = useActionPrefsStore((state) => state.hiddenActionIds.length);
  const handleResetHiddenCommands = () => {
    useActionPrefsStore.getState().resetHiddenActions();
    notify({
      type: "success",
      title: "Hidden commands reset",
      message: "All previously hidden commands will appear in Recently used again.",
      transient: true,
    });
  };

  return (
    <div className="space-y-6">
      <SettingsSubtabBar
        subtabs={PRIVACY_SUBTABS}
        activeId={currentSubtab}
        onChange={onSubtabChange}
        group="privacy"
        ariaLabel="Privacy and data sections"
      />

      <div {...subtabPanelProps("privacy", currentSubtab)} className="space-y-8">
        {currentSubtab === "telemetry" && (
          <>
            <SettingsSection
              id="privacy-telemetry-level"
              title="Telemetry & diagnostics"
              description="Control what data Daintree collects. No personal data, file contents, or credentials are ever collected. Turning telemetry off stops sending immediately."
            >
              <SettingsGroup id="troubleshooting-crash" className="overflow-hidden">
                <RadioChoiceGroup
                  legend="Telemetry level"
                  legendHidden
                  className="space-y-0 divide-y divide-border-subtle"
                >
                  {TELEMETRY_OPTIONS.map((option) => (
                    <RadioChoiceRow
                      key={option.level}
                      bare
                      name="telemetryLevel"
                      value={option.level}
                      checked={telemetryLevel === option.level}
                      onChange={() => void handleTelemetryChange(option.level)}
                      label={option.title}
                      description={option.description}
                      className={cn(
                        "px-4 py-3 transition-colors",
                        "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                        telemetryLevel === option.level
                          ? "bg-overlay-selected"
                          : "hover:bg-overlay-soft"
                      )}
                    />
                  ))}
                </RadioChoiceGroup>
                <SettingsRow
                  label="Preview outbound telemetry"
                  description="Inspect every sanitized payload Daintree would send — live, for this session only, with no transmission to any server."
                  control={
                    <Button variant="outline" size="sm" onClick={handleOpenTelemetryPreview}>
                      Open preview
                    </Button>
                  }
                />
              </SettingsGroup>
            </SettingsSection>

            <SettingsSection
              title="What's collected at each level"
              description="This disclosure describes the data transmitted externally. File contents, prompts, API keys, and other credentials are never collected."
            >
              <SettingsGroup>
                <dl className="divide-y divide-border-subtle">
                  {TELEMETRY_DISCLOSURE.map((entry) => (
                    <div key={entry.level} className="px-4 py-3">
                      <dt className="text-sm font-medium text-text-primary">{entry.title}</dt>
                      <dd className="mt-1 space-y-2 text-xs text-text-secondary select-text">
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
                                className="font-mono text-2xs text-text-secondary bg-surface-canvas px-1.5 py-0.5 rounded-[var(--radius-sm)] border border-border-subtle"
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
              </SettingsGroup>
            </SettingsSection>
          </>
        )}

        {currentSubtab === "storage" && (
          <>
            <SettingsSection
              title="Local data"
              description="Where Daintree keeps settings, logs, and session data on this machine."
            >
              <SettingsGroup>
                <SettingsRow
                  id="privacy-data-folder"
                  label="Data folder"
                  description={
                    <TruncatedTooltip content={dataFolderPath}>
                      <code className="block truncate font-mono">{dataFolderPath}</code>
                    </TruncatedTooltip>
                  }
                  control={
                    <Button variant="outline" size="sm" onClick={handleOpenDataFolder}>
                      Open folder
                    </Button>
                  }
                />
                <SettingsPresetGroup
                  id="privacy-log-retention"
                  label="Log retention"
                  description="Log files older than this are pruned at startup, so a change takes effect on next launch"
                  options={RETENTION_OPTIONS}
                  value={logRetentionDays}
                  onChange={(days) => void handleRetentionChange(days)}
                  isModified={logRetentionDays !== DEFAULT_RETENTION_DAYS}
                  onReset={() => void handleRetentionChange(DEFAULT_RETENTION_DAYS)}
                />
                <SettingsRow
                  id="privacy-clear-cache"
                  label="Clear cache"
                  description="Clears the HTTP disk and code caches for the app, browser panels, portal, and dev previews. Sign-ins, site data, and settings aren't affected."
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleClearCache()}
                      disabled={cacheClearing}
                    >
                      {cacheClearing ? "Clearing…" : cacheCleared ? "Cache cleared" : "Clear cache"}
                    </Button>
                  }
                />
                <SettingsRow
                  label="Hidden commands"
                  description={
                    hiddenActionCount === 0
                      ? "No commands are hidden from 'Recently used' in the action palette"
                      : `${hiddenActionCount} ${hiddenActionCount === 1 ? "command is" : "commands are"} hidden from 'Recently used' in the action palette. Resetting restores all of them.`
                  }
                  control={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetHiddenCommands}
                      disabled={hiddenActionCount === 0}
                      aria-label="Reset hidden commands"
                    >
                      Reset
                    </Button>
                  }
                />
              </SettingsGroup>
            </SettingsSection>

            <SettingsSection
              title="Session history"
              description="Daintree records resumable agent sessions so you can pick up where you left off."
            >
              <SettingsGroup>
                <SettingsPresetGroup
                  label="Keep session history for"
                  description="Applies to every project. Shortening the window prunes older records immediately."
                  options={RETENTION_OPTIONS}
                  value={sessionRetentionDays}
                  onChange={(days) => void handleSessionRetentionChange(days)}
                  isModified={sessionRetentionDays !== DEFAULT_RETENTION_DAYS}
                  onReset={() => void handleSessionRetentionChange(DEFAULT_RETENTION_DAYS)}
                />
                <SettingsRow
                  label="Clear session history"
                  description="Deletes every recorded session now. Bookmarked sessions are kept."
                  control={
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      onClick={() => setShowClearHistoryConfirm(true)}
                    >
                      {historyCleared ? "History cleared" : "Clear history…"}
                    </Button>
                  }
                />
              </SettingsGroup>
            </SettingsSection>

            <SettingsSection id="privacy-reset-data" title="Factory reset">
              <SettingsGroup>
                <SettingsRow
                  label="Reset all app data"
                  description="Permanently deletes all settings, session data, and logs. The app restarts with factory defaults."
                  control={
                    resetState === "idle" ? (
                      <Button
                        variant="ghost-danger"
                        size="sm"
                        onClick={() => setResetState("confirming")}
                      >
                        Reset all data…
                      </Button>
                    ) : undefined
                  }
                />
                {resetState === "confirming" && (
                  <div className="px-4 py-3 space-y-3" role="alert">
                    <div>
                      <p className="text-sm text-text-primary font-medium">Reset all app data?</p>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        This permanently deletes all settings, API keys, session data, and logs. The
                        app restarts with factory defaults, and this can't be undone.
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setResetState("idle")}>
                        Cancel
                      </Button>
                      <Button variant="destructive" size="sm" onClick={handleResetAllData}>
                        Reset everything &amp; restart
                      </Button>
                    </div>
                  </div>
                )}
              </SettingsGroup>
            </SettingsSection>
          </>
        )}
      </div>

      <ConfirmDialog
        isOpen={showClearHistoryConfirm}
        variant="destructive"
        onConfirm={() => void handleClearSessionHistory()}
        onClose={() => setShowClearHistoryConfirm(false)}
        title="Clear all session history?"
        description="This permanently deletes recorded resumable-session history across every project on this machine, and those records can't be recovered. Open sessions aren't affected, and bookmarked sessions are kept — deleting a bookmark is the only way to remove one."
        confirmLabel="Clear history"
      />
    </div>
  );
}
