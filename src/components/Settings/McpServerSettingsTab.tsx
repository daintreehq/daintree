import { useState, useEffect, useRef } from "react";
import { Eye, EyeOff, ChevronRight } from "lucide-react";
import { SeverityMark } from "@/lib/statusSeverity";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import {
  SETTINGS_CONTROL_WIDTH,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { useSettingsTabValidation } from "@/components/Settings/SettingsValidationRegistry";
import { McpAuditLogViewer } from "@/components/Settings/McpAuditLogViewer";
import { AuditLoadErrorRow } from "@/components/Settings/auditLogParts";
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
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";

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
  // One state, not two booleans: the plain and scoped copies share a single
  // reset timer, so independent flags let the second copy cancel the first's
  // reset and strand its "Copied!" indefinitely.
  const [copiedTarget, setCopiedTarget] = useState<"plain" | "scoped" | null>(null);
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
  const [paneWakeEnabled, setPaneWakeEnabled] = useState(false);
  // Until main has answered, "off" would be a guess rather than the setting.
  const [paneWakeLoaded, setPaneWakeLoaded] = useState(false);
  const [paneWakeLoadFailed, setPaneWakeLoadFailed] = useState(false);
  const [auditMaxRecords, setAuditMaxRecords] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS);
  const [maxRecordsInput, setMaxRecordsInput] = useState(MCP_AUDIT_DEFAULT_MAX_RECORDS.toString());
  const [auditLoading, setAuditLoading] = useState(true);
  const [turnsLoadFailed, setTurnsLoadFailed] = useState(false);
  const [auditLoadFailed, setAuditLoadFailed] = useState(false);
  const [auditConfigLoaded, setAuditConfigLoaded] = useState(false);
  const [auditConfigFailed, setAuditConfigFailed] = useState(false);
  // Set by a deliberate clear, so the empty log says so instead of reading as
  // "nothing has ever been recorded" beside turn outcomes that were kept.
  const [auditCleared, setAuditCleared] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [maxRecordsError, setMaxRecordsError] = useState<string | null>(null);

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
  // The workspace this settings view itself belongs to — immutable for the life
  // of the WebContents, and the only view-local identity that is safe to hand
  // out here (#11789). `useProjectStore`-style current-project reads describe
  // what the user is looking at globally, which is exactly the focus-following
  // ambiguity a scoped config exists to remove.
  const viewWorkspaceId = getViewWorkspaceId();
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
    setCopiedTarget(null);
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
        setAuditLoadFailed(false);
      } else {
        setAuditLoadFailed(true);
        logError("Failed to load MCP audit log", recordsResult.reason);
      }
      if (turnsResult.status === "fulfilled") {
        setTurnRecords(turnsResult.value);
        setTurnsLoadFailed(false);
      } else {
        setTurnsLoadFailed(true);
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

  // Until this answers, the capture switch and the cap would be showing guesses.
  const loadAuditConfig = async (): Promise<void> => {
    try {
      const auditCfg = await window.electron.mcpServer.getAuditConfig();
      setAuditEnabled(auditCfg.enabled);
      setAuditMaxRecords(auditCfg.maxRecords);
      setMaxRecordsInput(auditCfg.maxRecords.toString());
      setAuditConfigLoaded(true);
      setAuditConfigFailed(false);
    } catch (err) {
      setAuditConfigFailed(true);
      logError("Failed to load MCP audit config", err);
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

    // Server status and the audit reads settle independently: a failed audit
    // read must not hide a healthy server, or the reverse.
    Promise.all([
      window.electron.mcpServer.getStatus(),
      window.electron.mcpServer.getRuntimeState(),
    ])
      .then(([s, runtime]) => {
        if (settled) return;
        setStatus(s);
        setRuntimeSnapshot(runtime);
        setPortInput(s.configuredPort?.toString() ?? "");
        portDirtyRef.current = false;
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
      });

    void loadAuditConfig();
    void refreshAuditRecords().finally(() => setAuditLoading(false));
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
      // Abandon an in-flight copy so it can't schedule a timer past cleanup.
      copyGenerationRef.current += 1;
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

  /**
   * Copy the client config, optionally scoped to this view's workspace (#11789).
   *
   * A scoped config adds the workspace header, so the client it configures binds
   * to this project and keeps routing there no matter which Daintree window the
   * user later focuses. The unscoped copy is left exactly as it was: it produces
   * the same bytes it always did, and the session it configures follows focus,
   * which is the documented behaviour for clients that don't ask for a binding.
   */
  const copyClientConfig = async (workspaceId: string | null) => {
    const generation = ++copyGenerationRef.current;
    try {
      setError(null);
      // Rotating the key elsewhere (the assistant tab has its own control)
      // doesn't broadcast, so the cached status can be stale by the time the
      // user copies. Re-read it rather than hand out a dead key.
      const fresh = await window.electron.mcpServer.getStatus();
      if (generation !== copyGenerationRef.current) return;
      setStatus(fresh);
      const { snippet } = buildMcpClientConfig(clientConfigId, {
        port: runtimeSnapshot.port ?? fresh.port,
        apiKey: fresh.apiKey,
        workspaceId,
      });
      await navigator.clipboard.writeText(snippet);
      if (generation !== copyGenerationRef.current) return;
      setCopiedTarget(workspaceId === null ? "plain" : "scoped");
      if (configCopyTimeoutRef.current) clearTimeout(configCopyTimeoutRef.current);
      configCopyTimeoutRef.current = setTimeout(() => setCopiedTarget(null), COPY_FEEDBACK_MS);
    } catch (err) {
      if (generation !== copyGenerationRef.current) return;
      clearConfigCopyFeedback();
      setError(formatErrorMessage(err, "Failed to copy config"));
      logError("Failed to copy MCP config", err);
    }
  };

  const handleCopyConfig = () => copyClientConfig(null);
  const handleCopyScopedConfig = () => copyClientConfig(viewWorkspaceId);

  // Stale "Copied!" would otherwise describe a payload the user no longer has.
  const handleSelectClientConfig = (id: McpClientConfigId) => {
    setClientConfigId(id);
    clearConfigCopyFeedback();
  };

  const handlePortSave = async () => {
    try {
      setPortError(null);
      const portValue = portInput.trim();
      const port = portValue === "" ? null : parseInt(portValue, 10);
      if (port !== null && (isNaN(port) || port < 1024 || port > 65535)) {
        setPortError("Enter a port between 1024 and 65535");
        return;
      }
      const newStatus = await window.electron.mcpServer.setPort(port);
      setStatus(newStatus);
      // A new port invalidates whatever config was last copied.
      clearConfigCopyFeedback();
      setPortInput(newStatus.configuredPort?.toString() ?? "");
      portDirtyRef.current = false;
    } catch (err) {
      setPortError(formatErrorMessage(err, "Failed to update port"));
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

  // Loaded apart from the status batch so a failure here costs only this
  // toggle, which stays at its safe default of off.
  useEffect(() => {
    let cancelled = false;
    window.electron.mcpServer
      .getPaneWakeEnabled()
      .then((enabled) => {
        if (cancelled) return;
        setPaneWakeEnabled(enabled);
        setPaneWakeLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setPaneWakeLoadFailed(true);
        logError("Failed to load MCP pane wake setting", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePaneWakeToggle = async () => {
    try {
      setError(null);
      setPaneWakeEnabled(await window.electron.mcpServer.setPaneWakeEnabled(!paneWakeEnabled));
    } catch (err) {
      setError(formatErrorMessage(err, "Failed to update pane wakes"));
      logError("Failed to toggle MCP pane wakes", err);
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
      setMaxRecordsError(
        `Enter a number between ${MCP_AUDIT_MIN_RECORDS} and ${MCP_AUDIT_MAX_RECORDS}`
      );
      return;
    }
    try {
      setMaxRecordsError(null);
      const cfg = await window.electron.mcpServer.setAuditMaxRecords(parsed);
      setAuditEnabled(cfg.enabled);
      setAuditMaxRecords(cfg.maxRecords);
      setMaxRecordsInput(cfg.maxRecords.toString());
      await refreshAuditRecords();
    } catch (err) {
      setMaxRecordsError(formatErrorMessage(err, "Failed to update audit cap"));
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
      setAuditCleared(true);
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

  const portUnchanged = portInput.trim() === (status.configuredPort?.toString() ?? "");
  const maxRecordsUnchanged = maxRecordsInput === auditMaxRecords.toString();

  const statusRow = !status.enabled ? null : loading ? (
    showInlineLoading ? (
      <SettingsRow label={<span className="text-text-secondary">Loading…</span>} />
    ) : null
  ) : runtimeSnapshot.state === "starting" ? (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <span className="status-mark w-2 h-2 rounded-full bg-text-secondary shrink-0" />
          Server is starting…
        </span>
      }
    />
  ) : runtimeSnapshot.state === "failed" ? (
    <SettingsRow
      label={
        <span role="alert" className="flex items-center gap-2">
          <SeverityMark severity="error" label="Error" className="h-3.5 w-3.5" decorative />
          MCP server failed to start
        </span>
      }
      description={runtimeSnapshot.lastError ?? "Check the logs for details."}
    />
  ) : (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <span className="status-mark w-2 h-2 rounded-full bg-activity-working shrink-0" />
          Running on port {boundPort}
        </span>
      }
      description={
        <span className="font-mono text-text-primary select-all">{clientConfig.url}</span>
      }
    />
  );

  return (
    <div className="space-y-8">
      {/* No section heading: the page is already titled "MCP server", so the enable
          switch carries the concept on its own. What is running, and who is
          connected, sit directly under it; setup comes after. */}
      <SettingsGroup>
        <SettingsSwitchCard
          id="mcp-server-enable"
          title="Enable MCP server"
          subtitle="Starts a local Model Context Protocol server so AI agents can discover and invoke Daintree actions directly"
          isEnabled={status.enabled}
          onChange={handleToggle}
          // Matches the title; kept explicit because e2e selectors match the attribute.
          ariaLabel="Enable MCP server"
          disabled={loading}
          lifecycleBadge={
            status.enabled && keptAliveByAssistant ? "Kept alive by Daintree Assistant" : undefined
          }
        />

        {statusRow}

        {status.enabled && runtimeSnapshot.state === "ready" && activeBearers.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setBearersExpanded((v) => !v)}
              aria-expanded={bearersExpanded}
              className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            >
              <ChevronRight
                data-animated-chevron
                aria-hidden="true"
                className={cn(
                  "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150",
                  bearersExpanded && "rotate-90"
                )}
              />
              External clients ({activeBearers.length})
            </button>

            {bearersExpanded && (
              <ul className="border-t border-border-subtle divide-y divide-border-subtle">
                {activeBearers.map((bearer) => (
                  <li key={bearer.tokenHash} className="flex items-center gap-3 py-2 pl-9 pr-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-text-primary">{bearer.userAgent}</div>
                      <div className="text-2xs text-text-secondary">
                        <span className="font-mono">…{bearer.token4LastChars}</span>
                        {" · "}
                        {bearer.requestsSinceLaunch}{" "}
                        {bearer.requestsSinceLaunch === 1 ? "request" : "requests"}
                        {" · active "}
                        {formatRelativeTime(bearer.lastActiveAt)}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleDisconnectBearer(bearer.tokenHash)}
                      disabled={disconnectingHash !== null}
                    >
                      {disconnectingHash === bearer.tokenHash ? "Disconnecting…" : "Disconnect"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {status.enabled && runtimeSnapshot.state === "ready" && helpSessionBearers.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setHelpBearersExpanded((v) => !v)}
              aria-expanded={helpBearersExpanded}
              className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
            >
              <ChevronRight
                data-animated-chevron
                aria-hidden="true"
                className={cn(
                  "w-3.5 h-3.5 shrink-0 text-text-secondary transition-transform duration-150",
                  helpBearersExpanded && "rotate-90"
                )}
              />
              Internal connections ({helpSessionBearers.length})
            </button>

            {helpBearersExpanded && (
              <ul className="border-t border-border-subtle divide-y divide-border-subtle">
                {helpSessionBearers.map((bearer, i) => (
                  <li
                    key={`${bearer.userAgent}-${i}`}
                    className="flex items-center gap-3 py-2 pl-9 pr-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs text-text-primary">{bearer.userAgent}</div>
                      <div className="text-2xs text-text-secondary">
                        {bearer.sessionCount} {bearer.sessionCount === 1 ? "session" : "sessions"}
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

        {status.enabled && (
          <SettingsSwitchCard
            id="mcp-server-pane-wakes"
            title="Wake agents from terminal watches"
            subtitle={
              paneWakeLoadFailed
                ? "Couldn't read this setting. Reopen settings to try again."
                : "An agent supervising other terminals can ask to hear when they change instead of polling. Daintree types one line into that agent's prompt once it's idle — never into an approval, a question, or an error, and never over your typing. A pane that may be woken shows a radar chip; use it to stop the watches."
            }
            isEnabled={paneWakeEnabled}
            onChange={handlePaneWakeToggle}
            ariaLabel="Wake agents from terminal watches"
            disabled={!paneWakeLoaded}
          />
        )}
      </SettingsGroup>

      <p className="sr-only" role="status">
        {copiedTarget ? "Config copied" : copiedKey ? "API key copied" : ""}
      </p>

      {error && (
        <div role="alert" className="flex items-start gap-2 text-xs text-text-primary select-text">
          <SeverityMark severity="error" label="Error" className="mt-px h-3.5 w-3.5" decorative />
          <p>{error}</p>
        </div>
      )}

      {status.enabled && (
        <>
          <SettingsSection
            id="mcp-server-config"
            title="Connection"
            description="The server binds to 127.0.0.1 (loopback only), so it's never reachable from outside this machine."
          >
            <SettingsGroup>
              {!loading && runtimeSnapshot.state === "ready" && (
                <>
                  <RadioChoiceGroup
                    legend="Client"
                    legendHidden
                    className="space-y-0 divide-y divide-border-subtle"
                  >
                    <div className="px-4 pt-3 pb-1 border-b-0">
                      <div className="text-sm font-medium text-text-primary" aria-hidden="true">
                        Client
                      </div>
                      <p className="mt-0.5 text-xs text-text-secondary select-text">
                        Pick the client you&apos;re connecting, then copy its config.
                      </p>
                    </div>
                    {MCP_CLIENT_CONFIGS.map((entry) => (
                      <RadioChoiceRow
                        key={entry.id}
                        bare
                        name="mcpClientConfig"
                        value={entry.id}
                        checked={clientConfigId === entry.id}
                        onChange={() => handleSelectClientConfig(entry.id)}
                        label={entry.label}
                        description={entry.destination}
                        className={cn(
                          "px-4 py-3 transition-colors",
                          "has-[input:focus-visible]:outline has-[input:focus-visible]:outline-2 has-[input:focus-visible]:-outline-offset-2 has-[input:focus-visible]:outline-accent-primary",
                          clientConfigId === entry.id
                            ? "bg-overlay-selected"
                            : "hover:bg-overlay-soft"
                        )}
                      />
                    ))}
                  </RadioChoiceGroup>

                  <SettingsRow
                    label="Client config"
                    description={
                      <>
                        {viewWorkspaceId
                          ? "A project-scoped config pins the client to this project, so its calls keep landing here whichever window you're looking at. The plain config follows whichever Daintree window you focused last."
                          : null}
                        {viewWorkspaceId && status.apiKey ? " " : null}
                        {status.apiKey
                          ? "The config carries your API key, so treat it like a password — rotating the key cuts off any client still holding an older copy."
                          : null}
                      </>
                    }
                    layout="stacked"
                    control={
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="sm" onClick={handleCopyConfig}>
                          {copiedTarget === "plain" ? "Copied!" : "Copy MCP config"}
                        </Button>
                        {viewWorkspaceId ? (
                          <Button variant="outline" size="sm" onClick={handleCopyScopedConfig}>
                            {copiedTarget === "scoped" ? "Copied!" : "Copy config for this project"}
                          </Button>
                        ) : null}
                      </div>
                    }
                  />
                </>
              )}

              <SettingsRow
                id="mcp-server-port"
                label="Port"
                error={portError}
                description={
                  <>
                    Defaults to 45454. If it&apos;s taken, the next free port is used.
                    {status.port &&
                      status.configuredPort &&
                      status.port !== status.configuredPort && (
                        <span className="mt-1 flex items-start gap-1.5 text-text-primary">
                          <SeverityMark
                            severity="warning"
                            label="Warning"
                            className="w-3.5 h-3.5 mt-px"
                            decorative
                          />
                          <span>
                            Port {status.configuredPort} was in use, so the server is on{" "}
                            {status.port}.
                          </span>
                        </span>
                      )}
                  </>
                }
                control={({ disabled, descriptionId }) => (
                  <>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={portInput}
                      disabled={disabled}
                      onChange={(e) => {
                        setPortInput(e.target.value.replace(/\D/g, ""));
                        portDirtyRef.current = true;
                        setPortError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handlePortSave();
                      }}
                      placeholder="45454"
                      aria-label="MCP server port"
                      aria-describedby={descriptionId}
                      aria-invalid={portError ? true : undefined}
                      className={cn(
                        SETTINGS_CONTROL_WIDTH.number,
                        "h-7 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 text-sm text-text-primary placeholder:text-text-placeholder font-mono tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                      )}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handlePortSave}
                      disabled={portUnchanged}
                      aria-label="Apply port"
                    >
                      Apply
                    </Button>
                  </>
                )}
              />

              <SettingsRow
                id="mcp-server-auth"
                label="API key"
                layout={status.apiKey ? "stacked" : "inline"}
                description={
                  status.apiKey
                    ? "Every connection must present this bearer token. It persists across restarts."
                    : "Generated when the server starts"
                }
                control={
                  status.apiKey ? (
                    <div className="flex items-center gap-2">
                      <div
                        data-api-key-display=""
                        className="flex-1 min-w-0 flex items-center gap-2 h-7 rounded-[var(--radius-md)] bg-surface-canvas border border-border-strong px-2 font-mono text-xs text-text-primary select-all"
                      >
                        <span className="flex-1 truncate">
                          {showApiKey ? status.apiKey : MASKED_KEY}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          className="shrink-0 text-text-secondary hover:text-text-primary transition-colors"
                          aria-label={showApiKey ? "Hide API key" : "Show API key"}
                        >
                          {showApiKey ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCopyApiKey}
                        aria-label="Copy API key"
                      >
                        {copiedKey ? "Copied!" : "Copy"}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            </SettingsGroup>
            {status.apiKey && (
              <SettingsGroup>
                <SettingsRow
                  label="Rotate API key"
                  description="Issues a new key and invalidates the current one. Every client holding it is cut off until it has the new config."
                  control={
                    <Button
                      variant="ghost-danger"
                      size="sm"
                      onClick={() => setShowRotateConfirm(true)}
                      disabled={!apiKeySuffix}
                    >
                      Rotate key…
                    </Button>
                  }
                />
              </SettingsGroup>
            )}
          </SettingsSection>
        </>
      )}

      {/* The log outlives the server: turning MCP off after something suspicious
          must not hide the record of what happened. */}
      <>
        <SettingsSection
          title="Audit log"
          description="Every tool call over MCP, with its arguments summarised and anything that looks like a secret masked."
        >
          <SettingsGroup>
            <SettingsSwitchCard
              title="Capture audit log"
              subtitle="New tool calls are recorded while this is on"
              isEnabled={auditEnabled}
              onChange={handleAuditEnabledToggle}
              disabled={!auditConfigLoaded}
              disabledReason={
                auditConfigFailed
                  ? "Couldn't read this setting. Reopen settings to try again."
                  : undefined
              }
            />
            <SettingsRow
              label="Records kept"
              description={`The oldest are dropped past this limit. ${MCP_AUDIT_MIN_RECORDS}–${MCP_AUDIT_MAX_RECORDS}, default ${MCP_AUDIT_DEFAULT_MAX_RECORDS}.`}
              error={maxRecordsError}
              control={({ labelId, descriptionId }) => (
                <>
                  <input
                    id="mcp-audit-max-records"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={maxRecordsInput}
                    onChange={(e) => {
                      setMaxRecordsInput(e.target.value.replace(/\D/g, ""));
                      setMaxRecordsError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleMaxRecordsSave();
                    }}
                    placeholder={MCP_AUDIT_DEFAULT_MAX_RECORDS.toString()}
                    aria-labelledby={labelId}
                    aria-describedby={descriptionId}
                    aria-invalid={maxRecordsError ? true : undefined}
                    className={cn(
                      SETTINGS_CONTROL_WIDTH.number,
                      "h-7 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 text-sm text-text-primary placeholder:text-text-placeholder font-mono tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
                    )}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleMaxRecordsSave()}
                    disabled={maxRecordsUnchanged}
                    aria-label="Apply max records"
                  >
                    Apply
                  </Button>
                </>
              )}
            />
          </SettingsGroup>

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
            emptyLabel={
              auditCleared
                ? auditEnabled
                  ? "Audit log cleared. New tool calls are recorded as they happen"
                  : "Audit log cleared. Capture is off, so nothing new is recorded"
                : undefined
            }
            loadError={
              auditLoadFailed ? (
                <AuditLoadErrorRow
                  message="The audit log couldn't be read"
                  onRetry={() => void refreshAuditRecords()}
                />
              ) : undefined
            }
          />
        </SettingsSection>

        <SettingsSection
          title="Turn outcomes"
          description="How each assistant turn ended, and which tools the sessions behind those outcomes used. A tool listed against an outcome was used in that session; it didn't necessarily cause it."
        >
          <TurnOutcomeDiagnostics
            auditRecords={auditRecords}
            records={turnRecords}
            onRefresh={refreshAuditRecords}
            loadFailed={turnsLoadFailed}
          />
        </SettingsSection>
      </>

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
              className="flex items-center justify-between gap-3 p-2 rounded-[var(--radius-md)] bg-surface-canvas border border-border-default"
            >
              <span className="text-xs text-text-primary truncate">
                {client.userAgent ?? "Unknown client"}
              </span>
              <span className="text-2xs text-text-secondary shrink-0">
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
        description={`This permanently deletes ${auditRecords.length === 1 ? "1 audit record" : `${auditRecords.length} audit records`} on this machine. Turn outcomes aren't affected.${auditEnabled ? " New tool calls will still be recorded." : ""}`}
        confirmLabel="Clear audit log"
        cancelLabel="Cancel"
        onConfirm={confirmClearAuditLog}
        isConfirmLoading={isClearing}
        variant="destructive"
        zIndex="nested"
      />
    </div>
  );
}
