import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Copy,
  Check,
  AlertCircle,
  Key,
  Hash,
  Shield,
  Eye,
  EyeOff,
  RefreshCw,
  ScrollText,
} from "lucide-react";
import { McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import {
  type McpAuditRecord,
  type McpAuditResult,
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "@shared/types";

interface McpServerStatus {
  enabled: boolean;
  port: number | null;
  configuredPort: number | null;
  apiKey: string;
}

type AuditResultFilter = "all" | McpAuditResult;

const RESULT_LABEL: Record<McpAuditResult, string> = {
  success: "Success",
  error: "Error",
  "confirmation-pending": "Awaiting confirmation",
  unauthorized: "Unauthorized",
};

const RESULT_DOT_CLASS: Record<McpAuditResult, string> = {
  success: "bg-status-success",
  error: "bg-status-danger",
  "confirmation-pending": "bg-status-warning",
  unauthorized: "bg-status-danger",
};

function formatRelativeTimestamp(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function McpServerSettingsTab() {
  const [status, setStatus] = useState<McpServerStatus>({
    enabled: false,
    port: null,
    configuredPort: null,
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portInput, setPortInput] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [auditRecords, setAuditRecords] = useState<McpAuditRecord[]>([]);
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [auditMaxRecords, setAuditMaxRecords] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS);
  const [maxRecordsInput, setMaxRecordsInput] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS.toString());
  const [auditLoading, setAuditLoading] = useState(true);
  const [toolFilter, setToolFilter] = useState("");
  const [resultFilter, setResultFilter] = useState<AuditResultFilter>("all");

  const refreshAuditRecords = useCallback(async (): Promise<void> => {
    try {
      const records = await window.electron.mcpServer.getAuditRecords();
      setAuditRecords(records);
    } catch (err) {
      logError("Failed to load MCP audit log", err);
    }
  }, []);

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setError("Settings load timed out");
      setLoading(false);
      notify({
        type: "error",
        title: "MCP status failed",
        message: "Loading MCP server status timed out. The settings panel may be out of date.",
        priority: "low",
      });
      logError("MCP status load timed out");
    }, 10_000);

    Promise.all([
      window.electron.mcpServer.getStatus(),
      window.electron.mcpServer.getAuditConfig(),
      window.electron.mcpServer.getAuditRecords(),
    ])
      .then(([s, auditCfg, records]) => {
        if (settled) return;
        setStatus(s);
        setPortInput(s.configuredPort?.toString() ?? "");
        setAuditEnabled(auditCfg.enabled);
        setAuditMaxRecords(auditCfg.maxRecords);
        setMaxRecordsInput(auditCfg.maxRecords.toString());
        setAuditRecords(records);
        setError(null);
      })
      .catch((err) => {
        if (settled) return;
        setError(formatErrorMessage(err, "Failed to load MCP status"));
        notify({
          type: "error",
          title: "MCP status failed",
          message: "Couldn't load MCP server status. The settings panel may be out of date.",
          priority: "low",
        });
        logError("Failed to load MCP status", err);
      })
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        setLoading(false);
        setAuditLoading(false);
      });

    return () => {
      clearTimeout(timer);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const handleToggle = useCallback(async () => {
    try {
      setError(null);
      const newStatus = await window.electron.mcpServer.setEnabled(!status.enabled);
      setStatus(newStatus);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update MCP server"));
      notify({
        type: "error",
        title: "MCP server update failed",
        message: "Couldn't update the MCP server state. Try again.",
        priority: "low",
      });
      logError("Failed to update MCP server", err);
    }
  }, [status.enabled]);

  const handleCopyConfig = useCallback(async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to copy config"));
      notify({
        type: "error",
        title: "Config copy failed",
        message: "Couldn't copy the MCP config. The server may not be running.",
        priority: "low",
      });
      logError("Failed to copy MCP config", err);
    }
  }, []);

  const handlePortSave = useCallback(async () => {
    try {
      setError(null);
      const portValue = portInput.trim();
      const port = portValue === "" ? null : parseInt(portValue, 10);
      if (port !== null && (isNaN(port) || port < 1024 || port > 65535)) {
        setError("Port must be between 1024 and 65535");
        return;
      }
      const newStatus = await window.electron.mcpServer.setPort(port);
      setStatus(newStatus);
      setPortInput(newStatus.configuredPort?.toString() ?? "");
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update port"));
      notify({
        type: "error",
        title: "Port update failed",
        message: "Couldn't save the port setting. Check the value and try again.",
        priority: "low",
      });
      logError("Failed to update MCP port", err);
    }
  }, [portInput]);

  const handleRotateApiKey = useCallback(async () => {
    try {
      setError(null);
      const key = await window.electron.mcpServer.rotateApiKey();
      setStatus((prev) => ({ ...prev, apiKey: key }));
      setShowApiKey(true);
      setCopiedKey(false);
      notify({
        type: "success",
        title: "API key rotated",
        message: "Update any external MCP clients with the new key.",
        priority: "low",
      });
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to rotate API key"));
      notify({
        type: "error",
        title: "API key rotation failed",
        message: "Couldn't rotate the API key. Try again.",
        priority: "low",
      });
      logError("Failed to rotate MCP API key", err);
    }
  }, []);

  const handleCopyApiKey = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(status.apiKey);
      setCopiedKey(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopiedKey(false), 2000);
    } catch {
      // clipboard write failed — silently ignore
    }
  }, [status.apiKey]);

  const handleAuditEnabledToggle = useCallback(async () => {
    try {
      const next = !auditEnabled;
      const cfg = await window.electron.mcpServer.setAuditEnabled(next);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
    } catch (err) {
      logError("Failed to toggle MCP audit log", err);
      notify({
        type: "error",
        title: "Audit log update failed",
        message: "Couldn't update audit logging. Try again.",
        priority: "low",
      });
    }
  }, [auditEnabled]);

  const handleMaxRecordsSave = useCallback(async () => {
    const trimmed = maxRecordsInput.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (
      !Number.isFinite(parsed) ||
      parsed < MCP_AUDIT_MIN_RECORDS ||
      parsed > MCP_AUDIT_MAX_RECORDS
    ) {
      notify({
        type: "error",
        title: "Audit cap invalid",
        message: `Enter a number between ${MCP_AUDIT_MIN_RECORDS} and ${MCP_AUDIT_MAX_RECORDS}.`,
        priority: "low",
      });
      return;
    }
    try {
      const cfg = await window.electron.mcpServer.setAuditMaxRecords(parsed);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
      setMaxRecordsInput(cfg.maxRecords.toString());
      await refreshAuditRecords();
    } catch (err) {
      logError("Failed to update audit cap", err);
      notify({
        type: "error",
        title: "Audit cap update failed",
        message: "Couldn't save the audit cap. Try again.",
        priority: "low",
      });
    }
  }, [maxRecordsInput, refreshAuditRecords]);

  const handleClearAuditLog = useCallback(async () => {
    try {
      await window.electron.mcpServer.clearAuditLog();
      setAuditRecords([]);
      notify({
        type: "info",
        title: "Audit log cleared",
        message: "All recorded MCP tool dispatches were removed.",
        priority: "low",
      });
    } catch (err) {
      logError("Failed to clear MCP audit log", err);
      notify({
        type: "error",
        title: "Couldn't clear audit log",
        message: "The audit log wasn't cleared. Try again.",
        priority: "low",
      });
    }
  }, []);

  const handleCopyAuditAsJson = useCallback(async (records: McpAuditRecord[]) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
      notify({
        type: "info",
        title: "Audit log copied",
        message: `${records.length} record${records.length === 1 ? "" : "s"} copied as JSON.`,
        priority: "low",
      });
    } catch (err) {
      logError("Failed to copy MCP audit log", err);
      notify({
        type: "error",
        title: "Couldn't copy audit log",
        message: "Clipboard access failed. Try again.",
        priority: "low",
      });
    }
  }, []);

  const filteredAuditRecords = useMemo(() => {
    const needle = toolFilter.trim().toLowerCase();
    return auditRecords.filter((record) => {
      if (resultFilter !== "all" && record.result !== resultFilter) return false;
      if (needle.length > 0 && !record.toolId.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [auditRecords, resultFilter, toolFilter]);

  const sseUrl = status.port ? `http://127.0.0.1:${status.port}/sse` : null;

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        icon={McpServerIcon}
        title="MCP Server"
        subtitle="Start a local Model Context Protocol server so AI agents can discover and invoke Daintree actions directly."
        isEnabled={status.enabled}
        onChange={handleToggle}
        ariaLabel="Enable MCP server"
        disabled={loading}
      />

      {!status.enabled && !loading && !error && (
        <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
          <EmptyState
            variant="zero-data"
            icon={<McpServerIcon />}
            title="MCP server is off"
            description="Turn it on to expose Daintree's actions as MCP tools agents can call."
            action={
              <Button variant="outline" size="sm" onClick={() => void handleToggle()}>
                Turn on MCP server
              </Button>
            }
          />
        </div>
      )}

      {status.enabled && (
        <>
          {/* Connection Status */}
          <SettingsSection
            icon={McpServerIcon}
            title="Connection"
            description="The server binds to 127.0.0.1 (loopback only) — it is never accessible from outside this machine."
          >
            {loading ? (
              <p className="text-xs text-daintree-text/50">Loading…</p>
            ) : status.port ? (
              <div className="contents">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                  <span className="text-xs text-daintree-text/60">
                    Running on port {status.port}
                  </span>
                </div>

                <div className="flex items-center gap-2 p-2.5 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border font-mono text-xs text-daintree-text/80 select-all">
                  {sseUrl}
                </div>

                <button
                  onClick={handleCopyConfig}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                    "border border-daintree-border hover:bg-overlay-soft",
                    copied
                      ? "text-status-success border-status-success/30"
                      : "text-daintree-text/70 hover:text-daintree-text"
                  )}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? "Copied!" : "Copy MCP config"}
                </button>

                <p className="text-xs text-daintree-text/50 leading-relaxed select-text">
                  Paste the copied config into your MCP client (e.g. Claude Code, Cursor).
                  {status.apiKey && " The config includes the authorization header."}
                </p>
              </div>
            ) : (
              <p className="text-xs text-daintree-text/50">Server is starting…</p>
            )}
          </SettingsSection>

          {/* Port Configuration */}
          <SettingsSection
            icon={Hash}
            title="Port"
            description="The server defaults to port 45454. If the port is taken, it will automatically try the next port (45455, 45456, …). You can set a custom port if needed."
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={portInput}
                onChange={(e) => setPortInput(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handlePortSave();
                }}
                placeholder="45454"
                className="w-40 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-2 text-sm text-daintree-text placeholder:text-daintree-text/40 font-mono focus:outline-hidden focus:ring-1 focus:ring-daintree-accent"
              />
              <button
                onClick={handlePortSave}
                disabled={portInput === (status.configuredPort?.toString() ?? "")}
                className={cn(
                  "px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                  "border border-daintree-border",
                  portInput === (status.configuredPort?.toString() ?? "")
                    ? "text-daintree-text/30 cursor-not-allowed"
                    : "text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
                )}
              >
                Apply
              </button>
            </div>
            {status.port && status.configuredPort && status.port !== status.configuredPort && (
              <p className="text-xs text-status-warning/80 mt-2 select-text">
                Configured port {status.configuredPort} was in use — bound to {status.port} instead.
              </p>
            )}
          </SettingsSection>

          {/* API Key / Authentication */}
          <SettingsSection
            icon={Shield}
            title="Authentication"
            description="Every MCP connection must present this bearer token. The key persists across restarts. Rotate it if you suspect it has leaked — external clients holding the old key in their config will need to re-paste."
          >
            {status.apiKey ? (
              <div className="contents">
                <div className="flex items-center gap-1.5 text-xs text-status-success">
                  <Key className="w-3 h-3" />
                  API key active — clients must send an Authorization header
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-2 rounded-[var(--radius-md)] bg-surface-disabled border border-daintree-border px-3 py-2 font-mono text-xs text-daintree-text/80 select-all">
                    <span className="flex-1 truncate">
                      {showApiKey ? status.apiKey : "•".repeat(status.apiKey.length)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      className="shrink-0 text-daintree-text/40 hover:text-daintree-text/70"
                      aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    >
                      {showApiKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyApiKey}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                      "border border-daintree-border hover:bg-overlay-soft",
                      copiedKey
                        ? "text-status-success border-status-success/30"
                        : "text-daintree-text/70 hover:text-daintree-text"
                    )}
                    aria-label="Copy API key"
                  >
                    {copiedKey ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedKey ? "Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={handleRotateApiKey}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                    title="Rotate API key"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Rotate API key
                  </button>
                </div>
              </div>
            ) : (
              <div className="contents">
                <div className="flex items-center gap-2 p-3 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border">
                  <div className="w-2 h-2 rounded-full bg-daintree-text/30" />
                  <span className="text-xs text-daintree-text/60">
                    Key will be generated when the server starts.
                  </span>
                </div>
              </div>
            )}
          </SettingsSection>

          {/* Audit Log */}
          <SettingsSection
            icon={ScrollText}
            title="Audit log"
            description="Every tool dispatched over MCP is recorded with a redacted argument summary. Use this to investigate what an agent did during a session — argument values are never stored verbatim."
          >
            <div className="contents">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAuditEnabledToggle}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
                    auditEnabled
                      ? "border-status-success/30 text-status-success hover:bg-status-success/10"
                      : "border-daintree-border text-daintree-text/60 hover:text-daintree-text"
                  )}
                  aria-pressed={auditEnabled}
                >
                  {auditEnabled ? "Capture on" : "Capture off"}
                </button>
                <span className="text-xs text-daintree-text/50">
                  {auditEnabled
                    ? "Recording every dispatch."
                    : "New dispatches will not be recorded."}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="mcp-audit-max-records" className="text-xs text-daintree-text/60">
                  Max records
                </label>
                <input
                  id="mcp-audit-max-records"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={maxRecordsInput}
                  onChange={(e) => setMaxRecordsInput(e.target.value.replace(/\D/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleMaxRecordsSave();
                  }}
                  placeholder={MCP_AUDIT_DEFAULT_MAX_RECORDS.toString()}
                  className="w-24 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text placeholder:text-daintree-text/40 font-mono focus:outline-hidden focus:ring-1 focus:ring-daintree-accent"
                />
                <button
                  type="button"
                  onClick={() => void handleMaxRecordsSave()}
                  disabled={maxRecordsInput === auditMaxRecords.toString()}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                    "border border-daintree-border",
                    maxRecordsInput === auditMaxRecords.toString()
                      ? "text-daintree-text/30 cursor-not-allowed"
                      : "text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
                  )}
                >
                  Apply
                </button>
                <span className="text-xs text-daintree-text/40">
                  Range {MCP_AUDIT_MIN_RECORDS}–{MCP_AUDIT_MAX_RECORDS}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={toolFilter}
                  onChange={(e) => setToolFilter(e.target.value)}
                  placeholder="Filter by tool ID"
                  className="flex-1 min-w-[160px] bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text placeholder:text-daintree-text/40 font-mono focus:outline-hidden focus:ring-1 focus:ring-daintree-accent"
                />
                <select
                  value={resultFilter}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (
                      value === "all" ||
                      value === "success" ||
                      value === "error" ||
                      value === "confirmation-pending"
                    ) {
                      setResultFilter(value);
                    }
                  }}
                  className="bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text focus:outline-hidden focus:ring-1 focus:ring-daintree-accent"
                >
                  <option value="all">All results</option>
                  <option value="success">Success</option>
                  <option value="error">Error</option>
                  <option value="confirmation-pending">Awaiting confirmation</option>
                </select>
              </div>

              <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-daintree-border bg-daintree-bg">
                {auditLoading ? (
                  <p className="p-3 text-xs text-daintree-text/50">Loading…</p>
                ) : filteredAuditRecords.length === 0 ? (
                  <p className="p-3 text-xs text-daintree-text/50">
                    {auditRecords.length === 0
                      ? "No tool dispatches recorded yet."
                      : "No records match the current filters."}
                  </p>
                ) : (
                  <ul className="divide-y divide-daintree-border">
                    {filteredAuditRecords.map((record) => (
                      <li
                        key={record.id}
                        className="grid grid-cols-[auto_1fr_auto] gap-2 p-2 text-xs"
                      >
                        <span
                          className={cn(
                            "mt-1 h-2 w-2 rounded-full shrink-0",
                            RESULT_DOT_CLASS[record.result]
                          )}
                          aria-label={RESULT_LABEL[record.result]}
                          title={RESULT_LABEL[record.result]}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-daintree-text/90 truncate">
                              {record.toolId}
                            </span>
                            {record.errorCode && (
                              <span className="text-[10px] uppercase tracking-wide text-status-danger/80">
                                {record.errorCode}
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 font-mono text-daintree-text/50 truncate">
                            {record.argsSummary || "{}"}
                          </div>
                        </div>
                        <div className="text-right text-daintree-text/40 whitespace-nowrap">
                          <div>{formatRelativeTimestamp(record.timestamp)}</div>
                          <div>{record.durationMs}ms</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void refreshAuditRecords()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                  aria-label="Refresh audit log"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyAuditAsJson(filteredAuditRecords)}
                  disabled={filteredAuditRecords.length === 0}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
                    filteredAuditRecords.length === 0
                      ? "border-daintree-border text-daintree-text/30 cursor-not-allowed"
                      : "border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft"
                  )}
                >
                  <Copy className="w-3.5 h-3.5" />
                  Copy {filteredAuditRecords.length === auditRecords.length ? "all" : "filtered"} as
                  JSON
                </button>
                <button
                  type="button"
                  onClick={() => void handleClearAuditLog()}
                  disabled={auditRecords.length === 0}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)] border transition-colors",
                    auditRecords.length === 0
                      ? "border-daintree-border text-daintree-text/30 cursor-not-allowed"
                      : "border-daintree-border text-status-danger hover:text-status-danger hover:bg-status-danger/10 hover:border-status-danger/20"
                  )}
                >
                  Clear log
                </button>
                <span className="ml-auto text-xs text-daintree-text/40">
                  {auditRecords.length} of {auditMaxRecords}
                </span>
              </div>
            </div>
          </SettingsSection>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}
    </div>
  );
}
