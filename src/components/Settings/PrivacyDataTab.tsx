import { useState, useEffect } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { SettingsSection } from "./SettingsSection";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ErrorRetryRow } from "./auditLogParts";
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
type LoadState = "loading" | "ready" | "error";

/** A write that failed, and the call that repeats it. */
type FailedWrite = { message: string; retry: () => void } | null;

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
    description: "Nothing is sent. Crash reports aren't submitted.",
  },
  {
    level: "errors",
    title: "Errors only",
    description: "Crash reports and error details are sent. No usage analytics.",
  },
  {
    level: "full",
    title: "Full usage",
    description:
      "Crash reports plus anonymous usage analytics. Analytics recorded before you chose a level may be sent too.",
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
    title: "Off",
    summary: "No data is collected or transmitted.",
    fields: [],
  },
  {
    level: "errors",
    title: "Errors only",
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
    title: "Full usage",
    summary:
      "Crash reports and error details, plus anonymous usage analytics events, including those listed below. Each event carries its name, a timestamp, and event-specific properties — never file contents, prompts, or credentials. Analytics events recorded before you chose a level may be sent when you choose Full usage.",
    fields: [],
    events: ANALYTICS_EVENTS,
  },
];

/** How long the "History cleared" confirmation label stays visible. */
const CLEARED_FLASH_MS = 3000;

const DEFAULT_RETENTION_DAYS: LogRetention = 30;

/** 0 is "Keep forever", so any finite window is shorter than it. */
function isShorterRetention(next: LogRetention, current: LogRetention): boolean {
  if (next === 0) return false;
  return current === 0 || next < current;
}

function retentionLabel(days: LogRetention): string {
  return days === 0 ? "forever" : `${days} days`;
}

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
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [pendingSessionRetention, setPendingSessionRetention] = useState<LogRetention | null>(null);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const [telemetryFailure, setTelemetryFailure] = useState<FailedWrite>(null);
  const [logRetentionFailure, setLogRetentionFailure] = useState<FailedWrite>(null);
  const [sessionRetentionFailure, setSessionRetentionFailure] = useState<FailedWrite>(null);
  const [cacheFailure, setCacheFailure] = useState<FailedWrite>(null);
  const [shortenPending, setShortenPending] = useState(false);
  const [shortenError, setShortenError] = useState<string | null>(null);
  const [clearHistoryPending, setClearHistoryPending] = useState(false);
  const [clearHistoryError, setClearHistoryError] = useState<string | null>(null);
  const [sessionRetentionDays, setSessionRetentionDays] =
    useState<LogRetention>(DEFAULT_RETENTION_DAYS);
  const [showClearHistoryConfirm, setShowClearHistoryConfirm] = useState(false);
  const [historyCleared, setHistoryCleared] = useState(false);
  // Until a load succeeds the telemetry level and both retention pickers show
  // fallbacks, not the user's values — so they stay disabled rather than letting an
  // edit save over a value nobody saw.
  const [privacyLoad, setPrivacyLoad] = useState<LoadState>("loading");
  const [privacyLoadNonce, setPrivacyLoadNonce] = useState(0);
  const [sessionRetentionLoad, setSessionRetentionLoad] = useState<LoadState>("loading");
  const [sessionRetentionNonce, setSessionRetentionNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPrivacyLoad("loading");
    window.electron.privacy
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        setTelemetryLevel(settings.telemetryLevel);
        setLogRetentionDays(settings.logRetentionDays);
        setDataFolderPath(settings.dataFolderPath);
        setPrivacyLoad("ready");
      })
      .catch((err) => {
        if (!cancelled) setPrivacyLoad("error");
        logError("Failed to load privacy settings", err);
      });
    return () => {
      cancelled = true;
    };
  }, [privacyLoadNonce]);

  // A failed write reverts the control and says so right beside it, with a
  // Retry that repeats the same change — not a toast the user has to go and find.
  const handleTelemetryChange = async (level: TelemetryLevel) => {
    const prev = telemetryLevel;
    setTelemetryFailure(null);
    setTelemetryLevel(level);
    try {
      await window.electron.privacy.setTelemetryLevel(level);
    } catch (err) {
      setTelemetryLevel(prev);
      setTelemetryFailure({
        message: "Telemetry level couldn't be saved",
        retry: () => void handleTelemetryChange(level),
      });
      logError("Failed to set telemetry level", err);
    }
  };

  const handleRetentionChange = async (days: LogRetention) => {
    const prev = logRetentionDays;
    setLogRetentionFailure(null);
    setLogRetentionDays(days);
    try {
      await window.electron.privacy.setLogRetention(days);
    } catch (err) {
      setLogRetentionDays(prev);
      setLogRetentionFailure({
        message: "Log retention couldn't be saved",
        retry: () => void handleRetentionChange(days),
      });
      logError("Failed to set log retention", err);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setSessionRetentionLoad("loading");
    window.electron.agentSessionHistory
      .getRetentionDays()
      .then((days) => {
        if (cancelled) return;
        setSessionRetentionDays(days);
        setSessionRetentionLoad("ready");
      })
      .catch((err) => {
        if (!cancelled) setSessionRetentionLoad("error");
        logError("Failed to load agent session retention", err);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionRetentionNonce]);

  /** Resolves false when the write failed; the caller decides where to say so. */
  const handleSessionRetentionChange = async (
    days: LogRetention,
    { reportInline = true }: { reportInline?: boolean } = {}
  ): Promise<boolean> => {
    const prev = sessionRetentionDays;
    setSessionRetentionFailure(null);
    setSessionRetentionDays(days);
    try {
      await window.electron.agentSessionHistory.setRetentionDays(days);
      return true;
    } catch (err) {
      setSessionRetentionDays(prev);
      if (reportInline) {
        setSessionRetentionFailure({
          message: "Session history retention couldn't be saved",
          retry: () => void handleSessionRetentionChange(days),
        });
      }
      logError("Failed to set session history retention", err);
      return false;
    }
  };

  // The confirm stays up, busy, until the shorter window has actually been
  // saved, and says so inside itself if it wasn't.
  const confirmShortenRetention = async () => {
    if (pendingSessionRetention === null || shortenPending) return;
    setShortenPending(true);
    setShortenError(null);
    const ok = await handleSessionRetentionChange(pendingSessionRetention, {
      reportInline: false,
    });
    setShortenPending(false);
    if (ok) setPendingSessionRetention(null);
    else setShortenError("Session history retention couldn't be saved. Try again.");
  };

  // A shorter window prunes records the moment it's saved, so it asks first;
  // a longer one only keeps more and applies straight away.
  const requestSessionRetentionChange = (days: LogRetention) => {
    if (isShorterRetention(days, sessionRetentionDays)) {
      setPendingSessionRetention(days);
    } else {
      void handleSessionRetentionChange(days);
    }
  };

  const handleClearSessionHistory = async () => {
    if (clearHistoryPending) return;
    setClearHistoryPending(true);
    setClearHistoryError(null);
    try {
      await window.electron.agentSessionHistory.clear();
      setShowClearHistoryConfirm(false);
      setHistoryCleared(true);
      setTimeout(() => setHistoryCleared(false), CLEARED_FLASH_MS);
    } catch (err) {
      setClearHistoryError("Session history couldn't be cleared. Try again.");
      logError("Failed to clear agent session history", err);
    } finally {
      setClearHistoryPending(false);
    }
  };

  const handleOpenDataFolder = () => {
    window.electron.privacy.openDataFolder();
  };

  const handleClearCache = async () => {
    setCacheClearing(true);
    setCacheCleared(false);
    setCacheFailure(null);
    try {
      const { failed } = await window.electron.privacy.clearCache();
      if (failed === 0) {
        setCacheCleared(true);
        setTimeout(() => setCacheCleared(false), CLEARED_FLASH_MS);
      } else {
        setCacheFailure({
          message: "Some caches couldn't be cleared, so cached data may remain",
          retry: () => void handleClearCache(),
        });
      }
    } catch (err) {
      setCacheFailure({
        message: "The cache couldn't be cleared, so cached data may remain",
        retry: () => void handleClearCache(),
      });
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

  const privacyUnknown = privacyLoad !== "ready";
  const sessionRetentionUnknown = sessionRetentionLoad !== "ready";
  const privacyLoadError =
    privacyLoad === "error" ? (
      <SettingsLoadErrorBanner
        title="Privacy settings didn't load"
        message="Telemetry level and log retention are unavailable until they do."
        onRetry={() => setPrivacyLoadNonce((n) => n + 1)}
      />
    ) : null;

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
              description="What Daintree sends off this machine. File contents, prompts and credentials are never sent. Logs and histories kept on this machine are managed under Data & storage."
            >
              {privacyLoadError}
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
                      checked={!privacyUnknown && telemetryLevel === option.level}
                      disabled={privacyUnknown}
                      onChange={() => void handleTelemetryChange(option.level)}
                      label={option.title}
                      description={option.description}
                      className={cn(
                        "px-4 py-3 transition-colors",
                        "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                        !privacyUnknown && telemetryLevel === option.level
                          ? "bg-overlay-selected"
                          : !privacyUnknown && "hover:bg-overlay-soft"
                      )}
                    />
                  ))}
                </RadioChoiceGroup>
                {telemetryFailure && (
                  <ErrorRetryRow
                    message={telemetryFailure.message}
                    onRetry={telemetryFailure.retry}
                  />
                )}
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
              description="Exactly what each level sends."
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
                          <>
                            <button
                              type="button"
                              onClick={() => setShowAllEvents((v) => !v)}
                              aria-expanded={showAllEvents}
                              aria-controls="privacy-analytics-events"
                              className="inline-flex items-center gap-1 text-xs font-medium text-text-primary rounded-[var(--radius-sm)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary"
                            >
                              <ChevronRight
                                aria-hidden="true"
                                data-animated-chevron
                                className={cn(
                                  "w-3.5 h-3.5 text-text-secondary transition-transform duration-150",
                                  showAllEvents && "rotate-90"
                                )}
                              />
                              {showAllEvents ? "Hide" : "Show"} the {entry.events.length} analytics
                              events
                            </button>
                            {showAllEvents && (
                              <ul id="privacy-analytics-events" className="flex flex-wrap gap-1.5">
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
                          </>
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
              {privacyLoadError}
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
                  value={privacyUnknown ? null : logRetentionDays}
                  onChange={(days) => void handleRetentionChange(days)}
                  isModified={!privacyUnknown && logRetentionDays !== DEFAULT_RETENTION_DAYS}
                  onReset={() => void handleRetentionChange(DEFAULT_RETENTION_DAYS)}
                  disabled={privacyUnknown}
                />
                {logRetentionFailure && (
                  <ErrorRetryRow
                    message={logRetentionFailure.message}
                    onRetry={logRetentionFailure.retry}
                  />
                )}
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
                {cacheFailure && (
                  <ErrorRetryRow message={cacheFailure.message} onRetry={cacheFailure.retry} />
                )}
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
              {sessionRetentionLoad === "error" && (
                <SettingsLoadErrorBanner
                  title="Session history retention didn't load"
                  message="The retention window is unavailable until it does."
                  onRetry={() => setSessionRetentionNonce((n) => n + 1)}
                />
              )}
              <SettingsGroup>
                <SettingsPresetGroup
                  label="Keep session history for"
                  description="Applies to every project. Shortening it deletes older records straight away, so it asks first."
                  options={RETENTION_OPTIONS}
                  value={sessionRetentionUnknown ? null : sessionRetentionDays}
                  onChange={requestSessionRetentionChange}
                  isModified={
                    !sessionRetentionUnknown && sessionRetentionDays !== DEFAULT_RETENTION_DAYS
                  }
                  onReset={() => requestSessionRetentionChange(DEFAULT_RETENTION_DAYS)}
                  disabled={sessionRetentionUnknown}
                />
                {sessionRetentionFailure && (
                  <ErrorRetryRow
                    message={sessionRetentionFailure.message}
                    onRetry={sessionRetentionFailure.retry}
                  />
                )}
              </SettingsGroup>
              <SettingsGroup>
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
                  description="Deletes every setting, API key, recorded session and log on this machine, then restarts Daintree with factory defaults."
                  control={
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      onClick={() => setShowResetConfirm(true)}
                    >
                      Reset all data…
                    </Button>
                  }
                />
              </SettingsGroup>
            </SettingsSection>
          </>
        )}
      </div>

      <p className="sr-only" role="status">
        {cacheCleared
          ? "Every cache was cleared"
          : historyCleared
            ? "Session history was cleared"
            : ""}
      </p>

      <ConfirmDialog
        isOpen={showResetConfirm}
        variant="destructive"
        onConfirm={handleResetAllData}
        onClose={() => setShowResetConfirm(false)}
        title="Reset all app data?"
        description="This permanently deletes every setting, API key, recorded session and log on this machine. Daintree then restarts with factory defaults. It can't be undone."
        confirmLabel="Reset and restart"
      />

      <ConfirmDialog
        isOpen={pendingSessionRetention !== null}
        variant="destructive"
        onConfirm={() => void confirmShortenRetention()}
        onClose={
          shortenPending
            ? undefined
            : () => {
                setPendingSessionRetention(null);
                setShortenError(null);
              }
        }
        isConfirmLoading={shortenPending}
        hint={shortenError ?? undefined}
        title="Shorten session history?"
        description={
          pendingSessionRetention === null
            ? ""
            : `Keeping session history for ${retentionLabel(pendingSessionRetention)} instead of ${retentionLabel(sessionRetentionDays)} deletes older recorded sessions across every project now. Bookmarked sessions are kept.`
        }
        confirmLabel="Shorten and delete"
      />

      <ConfirmDialog
        isOpen={showClearHistoryConfirm}
        variant="destructive"
        onConfirm={() => void handleClearSessionHistory()}
        onClose={
          clearHistoryPending
            ? undefined
            : () => {
                setShowClearHistoryConfirm(false);
                setClearHistoryError(null);
              }
        }
        isConfirmLoading={clearHistoryPending}
        hint={clearHistoryError ?? undefined}
        title="Clear all session history?"
        description="This permanently deletes recorded resumable-session history across every project on this machine, and those records can't be recovered. Open sessions aren't affected, and bookmarked sessions are kept — deleting a bookmark is the only way to remove one."
        confirmLabel="Clear history"
      />
    </div>
  );
}
