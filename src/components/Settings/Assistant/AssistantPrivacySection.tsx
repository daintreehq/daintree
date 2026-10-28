import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { pluralNoun } from "@/lib/pluralize";
import type {
  AssistantTurnRecord,
  HelpAssistantSettings,
  McpAuditStats,
  McpLogRecord,
} from "@shared/types";
import { isAuditRecord } from "@shared/types";
import { SettingsSection } from "../SettingsSection";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsSwitchCard } from "../SettingsSwitchCard";
import { SettingsPresetGroup } from "../SettingsPresetGroup";
import { McpAuditLogViewer } from "../McpAuditLogViewer";
import { McpAuditLatencyTable } from "../McpAuditLatencyTable";
import { TurnOutcomeDiagnostics } from "../TurnOutcomeDiagnostics";
import { TabError } from "./AssistantStatus";
import { DEFAULT_SETTINGS } from "./assistantSettingsModel";

const EXPORT_FEEDBACK_MS = 2000;

const RETENTION_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "0", label: "Off" },
];

interface AssistantPrivacySectionProps {
  auditRetention: HelpAssistantSettings["auditRetention"];
  persist: (patch: Partial<HelpAssistantSettings>) => Promise<void>;
  saveError: ReactNode;
  settingsUnavailable: boolean;
  loading: boolean;
}

// Owns the audit trail end to end: its reads, recording switch, export and
// clear, and the errors they raise. Retention is a setting, so it still saves
// through the tab's grouped persistence.
export function AssistantPrivacySection({
  auditRetention,
  persist,
  saveError,
  settingsUnavailable,
  loading,
}: AssistantPrivacySectionProps) {
  // Failures of one-off actions stay on the section they belong to, not at the page foot.
  const [privacyError, setPrivacyError] = useState<{ message: string; retry?: () => void } | null>(
    null
  );
  const [clearAuditError, setClearAuditError] = useState<string | null>(null);
  // A failed read must not pass for an empty history.
  const [auditReadFailed, setAuditReadFailed] = useState(false);
  // Unread, the recording switch would show its optimistic default as if it were fact.
  const [auditConfigFailed, setAuditConfigFailed] = useState(false);
  const [auditRecords, setAuditRecords] = useState<McpLogRecord[]>([]);
  const [auditStats, setAuditStats] = useState<McpAuditStats | null>(null);
  const [turnRecords, setTurnRecords] = useState<AssistantTurnRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditExported, setAuditExported] = useState(false);
  const [isExportingAudit, setIsExportingAudit] = useState(false);
  const [showClearAuditConfirm, setShowClearAuditConfirm] = useState(false);
  const [isClearingAudit, setIsClearingAudit] = useState(false);
  // Recording stays on by default — the audit trail is a privacy/safety feature.
  // The authoritative value loads from getAuditConfig in the audit fetch effect.
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [isTogglingAudit, setIsTogglingAudit] = useState(false);
  // Diagnostics (audit viewer, latency table, turn outcomes) collapse by default
  // so the Privacy section doesn't surface telemetry on load. Local-only state —
  // no persistence precedent for section collapse in Settings.
  const [advancedDiagnosticsOpen, setAdvancedDiagnosticsOpen] = useState(false);
  const auditExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const exportTimeout = auditExportTimeoutRef;
    return () => {
      if (exportTimeout.current) clearTimeout(exportTimeout.current);
    };
  }, []);

  // Separate audit fetch effect — keeps the settings init effect's cancellation
  // semantics simple (per past lesson #4958) while still letting the audit
  // viewer hydrate independently of the settings + MCP status round-trips.
  // `allSettled` so a stats failure doesn't silently blank the record list.
  const refreshAuditRecords = async (): Promise<void> => {
    const [recordsResult, statsResult, turnsResult, configResult] = await Promise.allSettled([
      window.electron.mcpServer.getLogRecords(),
      window.electron.mcpServer.getAuditStats(),
      window.electron.mcpServer.getTurnOutcomeRecords(),
      window.electron.mcpServer.getAuditConfig(),
    ]);
    setAuditReadFailed(recordsResult.status === "rejected" || turnsResult.status === "rejected");
    if (configResult.status === "fulfilled") {
      setAuditEnabled(configResult.value.enabled);
      setAuditConfigFailed(false);
    } else {
      setAuditConfigFailed(true);
      logError("Failed to load MCP audit config for assistant tab", configResult.reason);
    }
    if (recordsResult.status === "fulfilled") {
      setAuditRecords(recordsResult.value);
    } else {
      logError("Failed to load MCP audit records for assistant tab", recordsResult.reason);
    }
    if (statsResult.status === "fulfilled") {
      setAuditStats(statsResult.value);
    } else {
      logError("Failed to load MCP audit stats for assistant tab", statsResult.reason);
    }
    if (turnsResult.status === "fulfilled") {
      setTurnRecords(turnsResult.value);
    } else {
      logError("Failed to load MCP turn outcomes for assistant tab", turnsResult.reason);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setAuditLoading(true);
    safeFireAndForget(
      Promise.allSettled([
        window.electron.mcpServer.getLogRecords(),
        window.electron.mcpServer.getAuditStats(),
        window.electron.mcpServer.getTurnOutcomeRecords(),
        window.electron.mcpServer.getAuditConfig(),
      ])
        .then(([recordsResult, statsResult, turnsResult, configResult]) => {
          if (cancelled) return;
          if (recordsResult.status === "fulfilled") {
            setAuditRecords(recordsResult.value);
          } else {
            setAuditReadFailed(true);
            logError("Failed initial audit load for assistant tab", recordsResult.reason);
          }
          if (statsResult.status === "fulfilled") {
            setAuditStats(statsResult.value);
          } else {
            logError("Failed initial audit stats load for assistant tab", statsResult.reason);
          }
          if (turnsResult.status === "fulfilled") {
            setTurnRecords(turnsResult.value);
          } else {
            setAuditReadFailed(true);
            logError("Failed initial turn outcomes load for assistant tab", turnsResult.reason);
          }
          if (configResult.status === "fulfilled") {
            setAuditEnabled(configResult.value.enabled);
          } else {
            setAuditConfigFailed(true);
            logError("Failed initial audit config load for assistant tab", configResult.reason);
          }
        })
        .finally(() => {
          if (!cancelled) setAuditLoading(false);
        }),
      { context: "initial audit load for assistant tab" }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Proxies the same mcpServer.setAuditEnabled endpoint as the MCP Server tab's
  // "Capture audit log" toggle. Server response is authoritative — no optimistic
  // flip. The in-flight guard prevents a double-click from computing `next` twice
  // off the same pre-await state. On failure, surface the error and leave the
  // last known-good value (matches McpServerSettingsTab's toggle).
  const handleAuditEnabledToggle = async () => {
    if (isTogglingAudit) return;
    setIsTogglingAudit(true);
    try {
      setPrivacyError(null);
      const next = !auditEnabled;
      const cfg = await window.electron.mcpServer.setAuditEnabled(next);
      setAuditEnabled(cfg.enabled);
    } catch (err) {
      setPrivacyError({
        message: formatErrorMessage(err, "Couldn't update audit recording"),
        retry: () => void handleAuditEnabledToggle(),
      });
      logError("Failed to toggle MCP audit log from assistant tab", err);
    } finally {
      setIsTogglingAudit(false);
    }
  };

  const handleExportAuditAsNdjson = async (records: McpLogRecord[]) => {
    if (isExportingAudit) return;
    setIsExportingAudit(true);
    try {
      setPrivacyError(null);
      const written = await window.electron.mcpServer.exportAuditLog(records);
      if (written) {
        setAuditExported(true);
        if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = setTimeout(
          () => setAuditExported(false),
          EXPORT_FEEDBACK_MS
        );
      }
    } catch (err) {
      setAuditExported(false);
      if (auditExportTimeoutRef.current) {
        clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = null;
      }
      setPrivacyError({
        message: formatErrorMessage(err, "Couldn't export audit log"),
        retry: () => void handleExportAuditAsNdjson(records),
      });
      logError("Failed to export MCP audit log from assistant tab", err);
    } finally {
      setIsExportingAudit(false);
    }
  };

  const confirmClearAuditLog = async () => {
    if (isClearingAudit) return;
    setIsClearingAudit(true);
    try {
      setClearAuditError(null);
      await window.electron.mcpServer.clearAuditLog();
      setAuditRecords([]);
      setShowClearAuditConfirm(false);
    } catch (err) {
      setClearAuditError(formatErrorMessage(err, "Couldn't clear audit log"));
      logError("Failed to clear MCP audit log from assistant tab", err);
    } finally {
      setIsClearingAudit(false);
    }
  };

  const handleCancelClearAudit = () => {
    if (isClearingAudit) return;
    setClearAuditError(null);
    setShowClearAuditConfirm(false);
  };

  const setRetention = (value: string) => {
    const parsed = Number(value);
    if (parsed !== 0 && parsed !== 7 && parsed !== 30) return;
    void persist({ auditRetention: parsed as 0 | 7 | 30 });
  };

  return (
    <>
      <SettingsSection
        title="Privacy"
        description="Help-session activity is logged locally so you can review what the assistant did"
      >
        {saveError}
        {privacyError && <TabError onRetry={privacyError.retry}>{privacyError.message}</TabError>}
        {(auditReadFailed || auditConfigFailed) && (
          <TabError onRetry={() => void refreshAuditRecords()}>
            {auditConfigFailed
              ? "Couldn't read the audit settings, so recording is shown as unknown."
              : "Couldn't read the audit log, so the diagnostics below may be incomplete."}
          </TabError>
        )}
        <SettingsGroup>
          <SettingsSwitchCard
            title="Capture audit log"
            subtitle={
              auditConfigFailed
                ? "Recording status unavailable"
                : auditLoading
                  ? "Checking…"
                  : auditEnabled
                    ? "Recording every dispatch"
                    : "New dispatches will not be recorded"
            }
            isEnabled={auditEnabled}
            onChange={handleAuditEnabledToggle}
            ariaLabel="Capture audit log"
            // Gate on auditLoading too: until getAuditConfig resolves, auditEnabled
            // is still the optimistic default and a late fulfillment would clobber
            // a user toggle made in that window.
            disabled={loading || auditLoading || isTogglingAudit || auditConfigFailed}
            disabledReason={
              auditConfigFailed ? "Couldn't read whether recording is on. Retry above." : undefined
            }
          />
          <SettingsPresetGroup
            id="assistant-audit-retention"
            label="Audit log retention"
            description="How long audit records stay on this machine. Turn-outcome diagnostics are kept separately."
            options={RETENTION_OPTIONS}
            value={String(auditRetention)}
            onChange={setRetention}
            disabled={settingsUnavailable}
            isModified={auditRetention !== DEFAULT_SETTINGS.auditRetention}
            onReset={() => setRetention(String(DEFAULT_SETTINGS.auditRetention))}
          />
          <div>
            <button
              type="button"
              onClick={() => setAdvancedDiagnosticsOpen((v) => !v)}
              aria-expanded={advancedDiagnosticsOpen}
              className={cn(
                "w-full flex cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium",
                "text-text-primary hover:bg-overlay-subtle transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
              )}
            >
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "w-3.5 h-3.5 text-text-secondary transition-transform duration-150 ease-out",
                  advancedDiagnosticsOpen ? "rotate-90" : "rotate-0"
                )}
                aria-hidden="true"
              />
              Advanced diagnostics
            </button>
          </div>
        </SettingsGroup>
        {/* Each diagnostics view is its own settings group, so they follow the
            disclosure as siblings rather than nesting cards inside its card. */}
        {advancedDiagnosticsOpen && (
          <>
            <McpAuditLogViewer
              records={auditRecords}
              turnRecords={turnRecords}
              loading={auditLoading}
              onRefresh={refreshAuditRecords}
              onClear={() => setShowClearAuditConfirm(true)}
              // Privacy section hides external MCP traffic. Grant-lifecycle
              // events stay visible — they're tied to this Daintree's own
              // help-session bearers, not external API-key clients.
              includeRecord={(record) => !isAuditRecord(record) || record.tier !== "external"}
              onExport={handleExportAuditAsNdjson}
              exportFlashActive={auditExported}
            />
            <McpAuditLatencyTable
              records={auditRecords}
              includeRecord={(record) => !isAuditRecord(record) || record.tier !== "external"}
            />
            <TurnOutcomeDiagnostics
              auditRecords={auditRecords}
              records={turnRecords}
              onRefresh={refreshAuditRecords}
            />
            {auditStats && auditStats.auth401Count > 0 && (
              <p className="text-xs text-text-secondary select-text">
                <span className="font-mono text-text-primary">{auditStats.auth401Count}</span>{" "}
                bearer {pluralNoun(auditStats.auth401Count, "rejection")} since last launch — an
                external client is connecting with a stale or missing API key.
              </p>
            )}
          </>
        )}
      </SettingsSection>

      <ConfirmDialog
        isOpen={showClearAuditConfirm}
        onClose={handleCancelClearAudit}
        title="Clear audit log?"
        description="All recorded tool dispatches will be permanently deleted — including those from external MCP clients."
        confirmLabel={clearAuditError ? "Try again" : "Clear audit log"}
        cancelLabel="Cancel"
        onConfirm={confirmClearAuditLog}
        isConfirmLoading={isClearingAudit}
        variant="destructive"
        zIndex="nested"
      >
        {clearAuditError && <TabError>{clearAuditError}</TabError>}
      </ConfirmDialog>
    </>
  );
}
