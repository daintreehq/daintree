import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollText } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { PluginActionAuditLogViewer } from "@/components/Settings/PluginActionAuditLogViewer";
import { appClient } from "@/clients/appClient";
import { logError } from "@/utils/logger";
import { type PluginActionAuditRecord, PLUGIN_AUDIT_DEFAULT_MAX_RECORDS } from "@shared/types";

const COPY_FEEDBACK_MS = 2000;

export function PluginActionsSettingsTab() {
  const [records, setRecords] = useState<PluginActionAuditRecord[]>([]);
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [maxRecords, setMaxRecords] = useState(PLUGIN_AUDIT_DEFAULT_MAX_RECORDS);
  const [developerMode, setDeveloperMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [exportedFlash, setExportedFlash] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshRecords = useCallback(async (): Promise<void> => {
    try {
      const next = await window.electron.plugin.getAuditRecords();
      setRecords(next);
    } catch (err) {
      logError("Failed to load plugin audit log", err);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      window.electron.plugin.getAuditConfig(),
      window.electron.plugin.getAuditRecords(),
      appClient.getState(),
    ])
      .then(([cfgResult, recordsResult, stateResult]) => {
        if (cancelled) return;
        if (cfgResult.status === "fulfilled") {
          setAuditEnabled(cfgResult.value.enabled);
          setMaxRecords(cfgResult.value.maxRecords);
        } else {
          logError("Failed to load plugin audit config", cfgResult.reason);
        }
        if (recordsResult.status === "fulfilled") {
          setRecords(recordsResult.value);
        } else {
          logError("Failed to load plugin audit log", recordsResult.reason);
        }
        if (stateResult.status === "fulfilled" && stateResult.value?.developerMode) {
          setDeveloperMode(stateResult.value.developerMode.enabled === true);
        }
        setLoading(false);
      })
      .catch((err) => {
        logError("Failed to load plugin audit settings", err);
        if (!cancelled) setLoading(false);
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
      const next = !auditEnabled;
      const cfg = await window.electron.plugin.setAuditEnabled(next);
      setAuditEnabled(cfg.enabled);
      setMaxRecords(cfg.maxRecords);
    } catch (err) {
      logError("Failed to toggle plugin audit log", err);
    }
  }, [auditEnabled]);

  const handleCopy = useCallback(async (toCopy: PluginActionAuditRecord[]) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(toCopy, null, 2));
      setCopiedFlash(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedFlash(false), COPY_FEEDBACK_MS);
    } catch (err) {
      logError("Failed to copy plugin audit log", err);
    }
  }, []);

  const handleExport = useCallback(async (toExport: PluginActionAuditRecord[]) => {
    try {
      const saved = await window.electron.plugin.exportAuditLog(toExport);
      if (saved) {
        setExportedFlash(true);
        if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
        exportTimeoutRef.current = setTimeout(() => setExportedFlash(false), COPY_FEEDBACK_MS);
      }
    } catch (err) {
      logError("Failed to export plugin audit log", err);
    }
  }, []);

  const handleClear = useCallback(async () => {
    try {
      await window.electron.plugin.clearAuditLog();
      setRecords([]);
    } catch (err) {
      logError("Failed to clear plugin audit log", err);
    } finally {
      setShowClearConfirm(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        icon={ScrollText}
        title="Plugin action audit log"
        description="Records every action dispatched by an installed plugin. Arguments are stored as a SHA-256 hash by default; turn on plaintext args in Developer mode to keep a readable copy."
      >
        <div className="flex flex-col gap-4">
          <SettingsSwitchCard
            id="plugin-audit-enable"
            title="Record plugin actions"
            subtitle="Append a record each time a plugin action is dispatched"
            isEnabled={auditEnabled}
            onChange={() => void handleEnabledToggle()}
            ariaLabel="Toggle plugin action audit log"
          />
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
            developerMode={developerMode}
          />
        </div>
      </SettingsSection>

      <ConfirmDialog
        isOpen={showClearConfirm}
        variant="destructive"
        onConfirm={() => void handleClear()}
        onClose={() => setShowClearConfirm(false)}
        title="Clear plugin audit log?"
        description="This permanently deletes all recorded plugin action dispatches on this machine. New dispatches will still be recorded."
        confirmLabel="Clear log"
      />
    </div>
  );
}
