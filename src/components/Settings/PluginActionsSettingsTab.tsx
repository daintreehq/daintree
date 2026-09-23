import { useCallback, useEffect, useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { PluginActionAuditLogViewer } from "@/components/Settings/PluginActionAuditLogViewer";
import { InlineErrorRow, AuditLoadErrorRow } from "@/components/Settings/auditLogParts";
import { logError } from "@/utils/logger";
import { type PluginActionAuditRecord, PLUGIN_AUDIT_DEFAULT_MAX_RECORDS } from "@shared/types";

const COPY_FEEDBACK_MS = 2000;

export function PluginActionsSettingsTab() {
  const [records, setRecords] = useState<PluginActionAuditRecord[]>([]);
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configFailed, setConfigFailed] = useState(false);
  const [maxRecords, setMaxRecords] = useState(PLUGIN_AUDIT_DEFAULT_MAX_RECORDS);
  const [loading, setLoading] = useState(true);
  const [recordsFailed, setRecordsFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [exportedFlash, setExportedFlash] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshRecords = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electron.plugin.getAuditRecords();
      setRecords(next);
      setRecordsFailed(false);
    } catch (err) {
      setRecordsFailed(true);
      logError("Failed to load plugin audit log", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      window.electron.plugin.getAuditConfig(),
      window.electron.plugin.getAuditRecords(),
    ]).then(([cfgResult, recordsResult]) => {
      if (cancelled) return;
      if (cfgResult.status === "fulfilled") {
        setAuditEnabled(cfgResult.value.enabled);
        setMaxRecords(cfgResult.value.maxRecords);
        setConfigLoaded(true);
      } else {
        setConfigFailed(true);
        logError("Failed to load plugin audit config", cfgResult.reason);
      }
      if (recordsResult.status === "fulfilled") {
        setRecords(recordsResult.value);
      } else {
        setRecordsFailed(true);
        logError("Failed to load plugin audit log", recordsResult.reason);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
    };
  }, []);

  const handleEnabledToggle = useCallback(async () => {
    try {
      setToggleError(null);
      const cfg = await window.electron.plugin.setAuditEnabled(!auditEnabled);
      setAuditEnabled(cfg.enabled);
      setMaxRecords(cfg.maxRecords);
    } catch (err) {
      setToggleError("Recording couldn't be changed. Try again.");
      logError("Failed to toggle plugin audit log", err);
    }
  }, [auditEnabled]);

  const handleCopy = useCallback(async (toCopy: PluginActionAuditRecord[]) => {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(JSON.stringify(toCopy, null, 2));
      setCopiedFlash(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedFlash(false), COPY_FEEDBACK_MS);
    } catch (err) {
      setActionError("The audit log couldn't be copied. Try again.");
      logError("Failed to copy plugin audit log", err);
    }
  }, []);

  const handleExport = useCallback(async (toExport: PluginActionAuditRecord[]) => {
    setActionError(null);
    try {
      const saved = await window.electron.plugin.exportAuditLog(toExport);
      if (saved) {
        setExportedFlash(true);
        if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
        exportTimeoutRef.current = setTimeout(() => setExportedFlash(false), COPY_FEEDBACK_MS);
      }
    } catch (err) {
      setActionError("The audit log couldn't be exported. Try again.");
      logError("Failed to export plugin audit log", err);
    }
  }, []);

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    try {
      setActionError(null);
      await window.electron.plugin.clearAuditLog();
      setRecords([]);
    } catch (err) {
      setActionError("The audit log couldn't be cleared. Try again.");
      logError("Failed to clear plugin audit log", err);
    } finally {
      setIsClearing(false);
      setShowClearConfirm(false);
    }
  }, []);

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Audit log"
        description="Every action an installed plugin dispatches. Arguments are kept as a SHA-256 hash unless plaintext arguments are turned on in developer mode."
      >
        <SettingsGroup>
          <SettingsSwitchCard
            id="plugin-audit-enable"
            title="Record plugin actions"
            subtitle="Appends a record each time a plugin action is dispatched"
            isEnabled={auditEnabled}
            onChange={() => void handleEnabledToggle()}
            disabled={!configLoaded}
            disabledReason={
              configFailed ? "Couldn't read this setting. Reopen settings to try again." : undefined
            }
          />
          {toggleError && <InlineErrorRow>{toggleError}</InlineErrorRow>}
        </SettingsGroup>
        <PluginActionAuditLogViewer
          records={records}
          loading={loading}
          maxRecords={maxRecords}
          onRefresh={refreshRecords}
          onCopy={handleCopy}
          onExport={handleExport}
          onClear={() => setShowClearConfirm(true)}
          copyFlashActive={copiedFlash}
          exportFlashActive={exportedFlash}
          actionError={actionError}
          loadError={
            recordsFailed ? (
              <AuditLoadErrorRow
                message="Plugin actions couldn't be read"
                onRetry={() => void refreshRecords()}
              />
            ) : undefined
          }
        />
      </SettingsSection>

      <ConfirmDialog
        isOpen={showClearConfirm}
        variant="destructive"
        onConfirm={() => void handleClear()}
        onClose={isClearing ? undefined : () => setShowClearConfirm(false)}
        isConfirmLoading={isClearing}
        title="Clear plugin audit log?"
        description={`This permanently deletes ${records.length === 1 ? "1 recorded plugin action" : `${records.length} recorded plugin actions`} on this machine.${auditEnabled ? " New dispatches will still be recorded." : ""}`}
        confirmLabel="Clear audit log"
      />
    </div>
  );
}
