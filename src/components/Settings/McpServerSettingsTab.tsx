import { useState, useEffect, useRef } from "react";
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
  Plug,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsChoicebox } from "@/components/Settings/SettingsChoicebox";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { McpAuditLogViewer } from "@/components/Settings/McpAuditLogViewer";
import { TurnOutcomeDiagnostics } from "@/components/Settings/TurnOutcomeDiagnostics";
import { useDeferredLoading } from "@/hooks";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logError } from "@/utils/logger";
import {
  type McpActiveClientInfo,
  type McpLogRecord,
  type AssistantTurnRecord,
  type McpAuditStats,
  type ActiveBearerRecord,
  type HelpSessionBearerRecord,
  type McpRuntimeSnapshot,
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "@shared/types";
import {
  buildMcpClientConfig,
  MCP_CLIENT_CONFIGS,
  type McpClientConfigId,
} from "@shared/config/mcpClientConfigs";

interface McpServerStatus {
  enabled: boolean;
  port: number | null;
  configuredPort: number | null;
  apiKey: string;
}

const COPY_FEEDBACK_MS = 2000;
const STATUS_LOAD_TIMEOUT_MS = 10_000;

const MASKED_KEY = "•".repeat(24);

const INITIAL_RUNTIME_SNAPSHOT: McpRuntimeSnapshot = {
  enabled: false,
  state: "disabled",
  port: null,
  lastError: null,
};

export function McpServerSettingsTab() {
  const [status, setStatus] = useState<McpServerStatus>({
    enabled: false,
    port: null,
    configuredPort: null,
    apiKey: "",
  });
  // Runtime readiness (state + lastError + bound port) is carried by a
  // separate snapshot from the persisted config above; the section is gated
  // on `status.enabled` so the `disabled` branch is unreachable here.
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<McpRuntimeSnapshot>(INITIAL_RUNTIME_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  // Gate the "Loading…" copy past the Doherty threshold so fast IPC resolutions
  // don't flash a loading state for sub-400ms work.
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);
  const [copied, setCopied] = useState(false);
  const [clientConfigId, setClientConfigId] = useState<McpClientConfigId>("claude-code");
  const [error, setError] = useState<string | null>(null);
  const [portInput, setPortInput] = useState("");
  const portDirtyRef = useRef(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedAudit, setCopiedAudit] = useState(false);
  const [exportedAudit, setExportedAudit] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const configCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyGenerationRef = useRef(0);
  const apiKeyCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [auditRecords, setAuditRecords] = useState<McpLogRecord[]>([]);
  const [turnRecords, setTurnRecords] = useState<AssistantTurnRecord[]>([]);
  const [auditStats, setAuditStats] = useState<McpAuditStats | null>(null);
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [auditMaxRecords, setAuditMaxRecords] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS);
  const [maxRecordsInput, setMaxRecordsInput] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS.toString());
  const [auditLoading, setAuditLoading] = useState(true);

  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  // Tier-D2 disable confirmation (#8779): populated only when the user turns
  // the server off while external clients are connected, so the dialog can
  // name who's about to be severed before the stop fires.
  const [disableClients, setDisableClients] = useState<McpActiveClientInfo[]>([]);
  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const [activeBearers, setActiveBearers] = useState<ActiveBearerRecord[]>([]);
  const [bearersExpanded, setBearersExpanded] = useState(false);
  const [disconnectingHash, setDisconnectingHash] = useState<string | null>(null);
  // Read-only inventory of Daintree's own internal MCP connections — the
  // help-chat assistant and in-panel agents (#10036) — surfaced so the External
  // clients row no longer hides them, but with no disconnect control (these are
  // Daintree's own consumers, severed via their owning surface, not here).
  const [helpSessionBearers, setHelpSessionBearers] = useState<HelpSessionBearerRecord[]>([]);
  const [helpBearersExpanded, setHelpBearersExpanded] = useState(false);
  // Drives the neutral attribution pill on the top card: when the Daintree
  // Assistant holds the server open, the toggle reflects assistant intent
  // rather than a manual choice.
  const [keptAliveByAssistant, setKeptAliveByAssistant] = useState(false);

  useSettingsTabValidation("mcp", Boolean(error));

  // Prefer the runtime-snapshot port for the ready branch so a push that
  // transitions starting→ready renders the URL without waiting for the
  // follow-up `getStatus()` refetch. Fall back to `status.port` when the
  // snapshot hasn't caught up yet (matches the assistant tab precedent at
  // DaintreeAssistantSettingsTab.tsx:740).
  const boundPort = runtimeSnapshot.port ?? status.port;
  // Displayed URL and copied snippet come from one build, so they can't drift
  // the way the old `/sse` box did beside a `/mcp` snippet (#11535).
  const clientConfig = buildMcpClientConfig(clientConfigId, {
    port: boundPort,
    apiKey: status.apiKey,
  });

  // Bumping the generation abandons any copy still in flight, so a write that
  // resolves after the payload changed can't resurrect "Copied!" for it.
  const clearConfigCopyFeedback = () => {
    copyGenerationRef.current += 1;
    setCopied(false);
    if (configCopyTimeoutRef.current) {
      clearTimeout(configCopyTimeoutRef.current);
      configCopyTimeoutRef.current = null;
    }
  };

  // Bearer list + assistant-control flag are non-critical: a failure must not
  // block the rest of the tab, so they're fetched outside the main mount
  // Promise.all and swallow errors to a quiet log.
  const refreshActiveBearers = async (): Promise<void> => {
    try {
      const bearers = await window.electron.mcpServer.listActiveBearers();
      setActiveBearers(bearers);
    } catch (err) {
      logError("Failed to load MCP active bearers", err);
    }
  };

  const refreshHelpSessionBearers = async (): Promise<void> => {
    try {
      const bearers = await window.electron.mcpServer.listHelpSessionBearers();
      setHelpSessionBearers(bearers);
    } catch (err) {
      logError("Failed to load MCP help-session bearers", err);
    }
  };

  const refreshAssistantControl = async (): Promise<void> => {
    try {
      const settings = await window.electron.helpAssistant?.getSettings();
      setKeptAliveByAssistant(settings?.daintreeControl === true);
    } catch (err) {
      logError("Failed to load Daintree Assistant settings", err);
    }
  };

  const refreshAuditRecords = async (): Promise<void> => {
    try {
      const [recordsResult, turnsResult, statsResult] = await Promise.allSettled([
        window.electron.mcpServer.getLogRecords(),
        window.electron.mcpServer.getTurnOutcomeRecords(),
        window.electron.mcpServer.getAuditStats(),
      ]);
      if (recordsResult.status === "fulfilled") {
        setAuditRecords(recordsResult.value);
      } else {
        logError("Failed to load MCP audit log", recordsResult.reason);
      }
      if (turnsResult.status === "fulfilled") {
        setTurnRecords(turnsResult.value);
      } else {
        logError("Failed to load MCP turn outcome records", turnsResult.reason);
      }
      if (statsResult.status === "fulfilled") {
        setAuditStats(statsResult.value);
      } else {
        logError("Failed to load MCP audit stats", statsResult.reason);
      }
    } catch (err) {
      logError("Failed to load MCP audit log", err);
    }
  };

  useEffect(() => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      setError("Couldn't load MCP server settings. Restart Daintree and try again.");
      setLoading(false);
      logError("MCP status load timed out");
    }, STATUS_LOAD_TIMEOUT_MS);

    Promise.all([
      window.electron.mcpServer.getStatus(),
      window.electron.mcpServer.getRuntimeState(),
      window.electron.mcpServer.getAuditConfig(),
      window.electron.mcpServer.getLogRecords(),
      window.electron.mcpServer.getTurnOutcomeRecords(),
      window.electron.mcpServer.getAuditStats(),
    ])
      .then(([s, runtime, auditCfg, records, turns, stats]) => {
        if (settled) return;
        setStatus(s);
        setRuntimeSnapshot(runtime);
        setPortInput(s.configuredPort?.toString() ?? "");
        portDirtyRef.current = false;
        setAuditEnabled(auditCfg.enabled);
        setAuditMaxRecords(auditCfg.maxRecords);
        setMaxRecordsInput(auditCfg.maxRecords.toString());
        setAuditRecords(records);
        setTurnRecords(turns);
        setAuditStats(stats);
        setError(null);
      })
      .catch((err) => {
        if (settled) return;
        setError(formatErrorMessage(err, "Failed to load MCP status"));
        logError("Failed to load MCP status", err);
      })
      .finally(() => {
        settled = true;
        clearTimeout(timer);
        setLoading(false);
        setAuditLoading(false);
      });

    void refreshActiveBearers();
    void refreshHelpSessionBearers();
    void refreshAssistantControl();

    const unsub = window.electron.mcpServer.onRuntimeStateChanged((next) => {
      if (!settled) return;
      // Apply the runtime push directly so the Connection section reflects
      // the new state without waiting for a config refetch.
      setRuntimeSnapshot(next);
      window.electron.mcpServer
        .getStatus()
        .then((s) => {
          setStatus(s);
          if (!portDirtyRef.current) {
            setPortInput(s.configuredPort?.toString() ?? "");
          }
          setError(null);
        })
        .catch((err) => {
          logError("Failed to refresh MCP status on runtime change", err);
        });
      // A runtime-state push fires on connect/disconnect, server restart, and
      // the assistant toggling `daintreeControl` — refresh all derived views.
      void refreshActiveBearers();
      void refreshHelpSessionBearers();
      void refreshAssistantControl();
    });

    return () => {
      clearTimeout(timer);
      unsub();
      if (configCopyTimeoutRef.current) clearTimeout(configCopyTimeoutRef.current);
      if (apiKeyCopyTimeoutRef.current) clearTimeout(apiKeyCopyTimeoutRef.current);
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
      if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
    };
  }, []);

  const applyEnabled = async (enabled: boolean) => {
    const newStatus = await window.electron.mcpServer.setEnabled(enabled);
    setStatus(newStatus);
  };

  const handleToggle = async () => {
    try {
      setError(null);
      // Enabling is always D0 — flip immediately. Disabling severs whatever
      // external clients are connected, so gate it on a D2 confirm that names
      // them. Zero external clients → reversible-local, no ceremony (#8779).
      if (!status.enabled) {
        await applyEnabled(true);
        return;
      }
      const clients = await window.electron.mcpServer.listActiveClients();
      if (clients.length === 0) {
        await applyEnabled(false);
        return;
      }
      setDisableClients(clients);
      setShowDisableConfirm(true);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update MCP server"));
      logError("Failed to update MCP server", err);
    }
  };

  const confirmDisable = async () => {
    if (isDisabling) return;
    setIsDisabling(true);
    try {
      setError(null);
      await applyEnabled(false);
      setShowDisableConfirm(false);
      setDisableClients([]);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update MCP server"));
      logError("Failed to update MCP server", err);
    } finally {
      setIsDisabling(false);
    }
  };

  const handleCancelDisable = () => {
    if (isDisabling) return;
    setShowDisableConfirm(false);
    setDisableClients([]);
  };

  const handleCopyConfig = async () => {
    const generation = ++copyGenerationRef.current;
    try {
      // Rotating the key elsewhere (the assistant tab has its own control)
      // doesn't broadcast, so the cached status can be stale by the time the
      // user copies. Re-read it rather than hand out a dead key.
      const fresh = await window.electron.mcpServer.getStatus();
      setStatus(fresh);
      const { snippet } = buildMcpClientConfig(clientConfigId, {
        port: runtimeSnapshot.port ?? fresh.port,
        apiKey: fresh.apiKey,
      });
      await navigator.clipboard.writeText(snippet);
      if (generation !== copyGenerationRef.current) return;
      setCopied(true);
      if (configCopyTimeoutRef.current) clearTimeout(configCopyTimeoutRef.current);
      configCopyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch (err) {
      if (generation !== copyGenerationRef.current) return;
      clearConfigCopyFeedback();
      setError(formatErrorMessage(err, "Failed to copy config"));
      logError("Failed to copy MCP config", err);
    }
  };

  // Stale "Copied!" would otherwise describe a payload the user no longer has.
  const handleSelectClientConfig = (id: McpClientConfigId) => {
    setClientConfigId(id);
    clearConfigCopyFeedback();
  };

  const handlePortSave = async () => {
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
      // A new port invalidates whatever config was last copied.
      clearConfigCopyFeedback();
      setPortInput(newStatus.configuredPort?.toString() ?? "");
      portDirtyRef.current = false;
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update port"));
      logError("Failed to update MCP port", err);
    }
  };

  const confirmRotateApiKey = async () => {
    if (isRotating) return;
    setIsRotating(true);
    try {
      setError(null);
      const key = await window.electron.mcpServer.rotateApiKey();
      setStatus((prev) => ({ ...prev, apiKey: key }));
      // The rotated key invalidates whatever config was last copied.
      clearConfigCopyFeedback();
      setCopiedKey(false);
      setShowApiKey(false);
      setShowRotateConfirm(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to rotate API key"));
      logError("Failed to rotate MCP API key", err);
    } finally {
      setIsRotating(false);
    }
  };

  const handleCancelRotate = () => {
    if (isRotating) return;
    setShowRotateConfirm(false);
    setShowApiKey(false);
  };

  const handleCopyApiKey = async () => {
    try {
      await navigator.clipboard.writeText(status.apiKey);
      setCopiedKey(true);
      if (apiKeyCopyTimeoutRef.current) clearTimeout(apiKeyCopyTimeoutRef.current);
      apiKeyCopyTimeoutRef.current = setTimeout(() => setCopiedKey(false), COPY_FEEDBACK_MS);
    } catch (err) {
      setCopiedKey(false);
      if (apiKeyCopyTimeoutRef.current) {
        clearTimeout(apiKeyCopyTimeoutRef.current);
        apiKeyCopyTimeoutRef.current = null;
      }
      setError(formatErrorMessage(err, "Failed to copy API key"));
      logError("Failed to copy MCP API key", err);
    }
  };

  const handleAuditEnabledToggle = async () => {
    try {
      setError(null);
      const next = !auditEnabled;
      const cfg = await window.electron.mcpServer.setAuditEnabled(next);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
      setMaxRecordsInput(cfg.maxRecords.toString());
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update audit logging"));
      logError("Failed to toggle MCP audit log", err);
    }
  };

  const handleMaxRecordsSave = async () => {
    const trimmed = maxRecordsInput.trim();
    const parsed = Number.parseInt(trimmed, 10);
    if (
      !Number.isFinite(parsed) ||
      parsed < MCP_AUDIT_MIN_RECORDS ||
      parsed > MCP_AUDIT_MAX_RECORDS
    ) {
      setError(`Enter a number between ${MCP_AUDIT_MIN_RECORDS} and ${MCP_AUDIT_MAX_RECORDS}.`);
      return;
    }
    try {
      setError(null);
      const cfg = await window.electron.mcpServer.setAuditMaxRecords(parsed);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
      setMaxRecordsInput(cfg.maxRecords.toString());
      await refreshAuditRecords();
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update audit cap"));
      logError("Failed to update audit cap", err);
    }
  };

  const confirmClearAuditLog = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      setError(null);
      await window.electron.mcpServer.clearAuditLog();
      setAuditRecords([]);
      setAuditStats(null);
      setShowClearConfirm(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to clear audit log"));
      logError("Failed to clear MCP audit log", err);
    } finally {
      setIsClearing(false);
    }
  };

  const handleCancelClear = () => {
    if (isClearing) return;
    setShowClearConfirm(false);
  };

  const handleCopyAuditAsJson = async (records: McpLogRecord[]) => {
    try {
      setError(null);
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
      setCopiedAudit(true);
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
      auditCopyTimeoutRef.current = setTimeout(() => setCopiedAudit(false), COPY_FEEDBACK_MS);
    } catch (err) {
      setCopiedAudit(false);
      if (auditCopyTimeoutRef.current) {
        clearTimeout(auditCopyTimeoutRef.current);
        auditCopyTimeoutRef.current = null;
      }
      setError(formatErrorMessage(err, "Failed to copy audit log"));
      logError("Failed to copy MCP audit log", err);
    }
  };

  const handleExportAuditLog = async (records: McpLogRecord[]) => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      setError(null);
      const written = await window.electron.mcpServer.exportAuditLog(records);
      if (written) {
        setExportedAudit(true);
        if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = setTimeout(() => setExportedAudit(false), COPY_FEEDBACK_MS);
      }
    } catch (err) {
      setExportedAudit(false);
      if (auditExportTimeoutRef.current) {
        clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = null;
      }
      setError(formatErrorMessage(err, "Failed to export audit log"));
      logError("Failed to export MCP audit log", err);
    } finally {
      setIsExporting(false);
    }
  };

  const handleDisconnectBearer = async (tokenHash: string) => {
    if (disconnectingHash) return;
    setDisconnectingHash(tokenHash);
    try {
      setError(null);
      await window.electron.mcpServer.disconnectBearer(tokenHash);
      await refreshActiveBearers();
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to disconnect client"));
      logError("Failed to disconnect MCP client", err);
    } finally {
      setDisconnectingHash(null);
    }
  };

  // Rotation is the revoke-all primitive — it invalidates every external
  // client holding the current key in one shot (Tier D3). Gate it behind
  // typing the last 4 characters, matching DaintreeAssistantSettingsTab.
  const apiKeySuffix = status.apiKey && status.apiKey.length >= 8 ? status.apiKey.slice(-4) : "";

  return (
    <div className="space-y-6">
      <SettingsSwitchCard
        icon={McpServerIcon}
        title="MCP server"
        subtitle="Start a local Model Context Protocol server so AI agents can discover and invoke Daintree actions directly"
        isEnabled={status.enabled}
        onChange={handleToggle}
        ariaLabel="Enable MCP server"
        disabled={loading}
        lifecycleBadge={
          status.enabled && keptAliveByAssistant ? "Kept alive by Daintree Assistant" : undefined
        }
      />

      {!status.enabled && !loading && !error && (
        <div className="border border-dashed border-daintree-border rounded-[var(--radius-md)]">
          <EmptyState
            variant="zero-data"
            scale="canvas"
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
              showInlineLoading ? (
                <p className="text-xs text-daintree-text/50">Loading…</p>
              ) : null
            ) : runtimeSnapshot.state === "starting" ? (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-daintree-text/30 shrink-0" />
                <span className="text-xs text-daintree-text/60">Server is starting…</span>
              </div>
            ) : runtimeSnapshot.state === "failed" ? (
              <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
                <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
                <p className="text-xs text-status-danger leading-relaxed select-text">
                  MCP server failed to start.{" "}
                  {runtimeSnapshot.lastError ?? "Check the logs for details."}
                </p>
              </div>
            ) : (
              <div className="contents">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
                  <span className="text-xs text-daintree-text/60">Running on port {boundPort}</span>
                </div>

                <div className="flex items-center gap-2 p-2.5 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border font-mono text-xs text-daintree-text/80 select-all">
                  {clientConfig.url}
                </div>

                <SettingsChoicebox<McpClientConfigId>
                  label="Client"
                  description="Pick the client you're connecting, then copy its config."
                  value={clientConfigId}
                  onChange={handleSelectClientConfig}
                  options={MCP_CLIENT_CONFIGS.map((entry) => ({
                    value: entry.id,
                    label: entry.label,
                    description: entry.destination,
                  }))}
                  columns={3}
                />

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
                  {clientConfig.destination}.
                  {status.apiKey &&
                    " It carries your API key, so treat it like a password — rotating the key below cuts off any client still holding an older copy."}
                </p>

                {activeBearers.length > 0 && (
                  <div className="rounded-[var(--radius-md)] border border-daintree-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setBearersExpanded((v) => !v)}
                      aria-expanded={bearersExpanded}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                    >
                      <ChevronRight
                        data-animated-chevron
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                          bearersExpanded && "rotate-90"
                        )}
                      />
                      <Plug className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" />
                      External clients ({activeBearers.length})
                    </button>

                    {bearersExpanded && (
                      <ul className="border-t border-daintree-border divide-y divide-daintree-border">
                        {activeBearers.map((bearer) => (
                          <li key={bearer.tokenHash} className="flex items-center gap-3 px-3 py-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs text-daintree-text/80">
                                {bearer.userAgent}
                              </div>
                              <div className="text-[11px] text-daintree-text/50">
                                <span className="font-mono">…{bearer.token4LastChars}</span>
                                {" · "}
                                {bearer.requestsSinceLaunch}{" "}
                                {bearer.requestsSinceLaunch === 1 ? "request" : "requests"}
                                {" · active "}
                                {formatRelativeTime(bearer.lastActiveAt)}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleDisconnectBearer(bearer.tokenHash)}
                              disabled={disconnectingHash !== null}
                              className="shrink-0 px-2.5 py-1 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                            >
                              {disconnectingHash === bearer.tokenHash
                                ? "Disconnecting…"
                                : "Disconnect"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {helpSessionBearers.length > 0 && (
                  <div className="rounded-[var(--radius-md)] border border-daintree-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setHelpBearersExpanded((v) => !v)}
                      aria-expanded={helpBearersExpanded}
                      className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
                    >
                      <ChevronRight
                        data-animated-chevron
                        className={cn(
                          "w-3.5 h-3.5 shrink-0 transition-transform duration-150",
                          helpBearersExpanded && "rotate-90"
                        )}
                      />
                      <Sparkles className="w-3.5 h-3.5 shrink-0 text-daintree-text/50" />
                      Internal connections ({helpSessionBearers.length})
                    </button>

                    {helpBearersExpanded && (
                      <ul className="border-t border-daintree-border divide-y divide-daintree-border">
                        {helpSessionBearers.map((bearer, i) => (
                          <li
                            key={`${bearer.userAgent}-${i}`}
                            className="flex items-center gap-3 px-3 py-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs text-daintree-text/80">
                                {bearer.userAgent}
                              </div>
                              <div className="text-[11px] text-daintree-text/50">
                                {bearer.sessionCount}{" "}
                                {bearer.sessionCount === 1 ? "session" : "sessions"}
                                {" · "}
                                {bearer.requestsSinceLaunch}{" "}
                                {bearer.requestsSinceLaunch === 1 ? "request" : "requests"}
                                {" · active "}
                                {formatRelativeTime(bearer.lastActiveAt)}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
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
                onChange={(e) => {
                  setPortInput(e.target.value.replace(/\D/g, ""));
                  portDirtyRef.current = true;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handlePortSave();
                }}
                placeholder="45454"
                aria-label="MCP server port"
                className="w-40 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-3 py-2 text-sm text-daintree-text placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
              />
              <button
                onClick={handlePortSave}
                disabled={portInput.trim() === (status.configuredPort?.toString() ?? "")}
                aria-label="Apply port"
                className={cn(
                  "px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] transition-colors",
                  "border border-daintree-border",
                  portInput.trim() === (status.configuredPort?.toString() ?? "")
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
                      {showApiKey ? status.apiKey : MASKED_KEY}
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
                    onClick={() => setShowRotateConfirm(true)}
                    disabled={!apiKeySuffix}
                    className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-[var(--radius-md)] border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-daintree-text/70"
                    title={apiKeySuffix ? "Rotate API key" : "Waiting for the MCP key to load…"}
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
              <SettingsSwitchCard
                variant="compact"
                title="Capture audit log"
                subtitle={
                  auditEnabled ? "Recording every dispatch" : "New dispatches will not be recorded"
                }
                isEnabled={auditEnabled}
                onChange={handleAuditEnabledToggle}
                ariaLabel="Capture audit log"
              />

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
                  className="w-24 bg-daintree-bg border border-border-strong rounded-[var(--radius-md)] px-2 py-1 text-xs text-daintree-text placeholder:text-text-placeholder font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                />
                <button
                  type="button"
                  onClick={() => void handleMaxRecordsSave()}
                  disabled={maxRecordsInput === auditMaxRecords.toString()}
                  aria-label="Apply max records"
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

              <McpAuditLogViewer
                records={auditRecords}
                turnRecords={turnRecords}
                loading={auditLoading}
                onRefresh={refreshAuditRecords}
                onCopy={handleCopyAuditAsJson}
                onClear={() => setShowClearConfirm(true)}
                copyFlashActive={copiedAudit}
                maxRecords={auditMaxRecords}
                onExport={handleExportAuditLog}
                exportFlashActive={exportedAudit}
                anomalySignals={auditStats?.anomalySignals ?? []}
                anomalySuppressed={auditStats?.anomalySuppressed ?? true}
              />
            </div>
          </SettingsSection>

          {/* Turn Outcome Diagnostics */}
          <SettingsSection
            icon={ScrollText}
            title="Turn outcome diagnostics"
            description="Per-turn outcome classification for MCP help sessions. Use the per-tool rollups to identify which tools are producing the most errors, tier rejections, or stuck agents."
          >
            <TurnOutcomeDiagnostics auditRecords={auditRecords} />
          </SettingsSection>
        </>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}

      <ConfirmDialog
        isOpen={showDisableConfirm}
        onClose={isDisabling ? undefined : handleCancelDisable}
        title="Stop MCP server?"
        description={
          disableClients.length === 1
            ? "Turning the server off disconnects the client below and stops accepting new tool calls."
            : `Turning the server off disconnects the ${disableClients.length} clients below and stops accepting new tool calls.`
        }
        confirmLabel="Stop sharing"
        cancelLabel="Keep running"
        onConfirm={confirmDisable}
        isConfirmLoading={isDisabling}
        variant="default"
        zIndex="nested"
      >
        <ul className="space-y-1.5">
          {disableClients.map((client) => (
            <li
              key={client.sessionId}
              className="flex items-center justify-between gap-3 p-2 rounded-[var(--radius-md)] bg-daintree-bg border border-daintree-border"
            >
              <span className="text-xs text-daintree-text/80 truncate">
                {client.userAgent ?? "Unknown client"}
              </span>
              <span className="text-[11px] text-daintree-text/50 shrink-0">
                connected {formatRelativeTime(client.connectedAtMs)}
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <ConfirmDialog
        isOpen={showRotateConfirm}
        onClose={isRotating ? undefined : handleCancelRotate}
        title="Rotate API key?"
        description="The current key will be invalidated immediately. External clients using this key will need to update their configuration."
        confirmLabel="Rotate key"
        cancelLabel="Cancel"
        onConfirm={confirmRotateApiKey}
        isConfirmLoading={isRotating}
        variant="destructive"
        zIndex="nested"
      />

      <ConfirmDialog
        isOpen={showClearConfirm}
        onClose={isClearing ? undefined : handleCancelClear}
        title="Clear audit log?"
        description="All recorded tool dispatches will be permanently deleted."
        confirmLabel="Clear log"
        cancelLabel="Cancel"
        onConfirm={confirmClearAuditLog}
        isConfirmLoading={isClearing}
        variant="destructive"
        zIndex="nested"
      />
    </div>
  );
}
