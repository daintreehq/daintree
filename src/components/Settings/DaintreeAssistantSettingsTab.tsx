import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
  Check,
  ChevronRight,
  Copy,
  KeyRound,
  Moon,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Wrench,
} from "lucide-react";
import { DaintreeIcon, McpServerIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { useDeferredLoading, useHelpSessionLiveStatus } from "@/hooks";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useMcpReadiness } from "@/hooks/useMcpReadiness";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { actionService } from "@/services/ActionService";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsInput } from "./SettingsInput";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { McpAuditLogViewer } from "./McpAuditLogViewer";
import { McpAuditLatencyTable } from "./McpAuditLatencyTable";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useDebounce } from "@/hooks/useDebounce";

import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import type {
  HelpAssistantSettings,
  HelpAssistantTier,
  HelpSessionActiveGrant,
  McpAuditStats,
  McpLogRecord,
  AssistantTurnRecord,
} from "@shared/types";
import { isAuditRecord } from "@shared/types";
import {
  HELP_TIER_CUMULATIVE,
  HELP_TIER_INCREMENTAL,
  SYSTEM_TIER_HIGH_BLAST_RADIUS,
} from "@shared/config/helpAssistantTierAllowlists";

const COPY_RESET_DELAY_MS = 2000;
const CUSTOM_ARGS_DEBOUNCE_MS = 500;

const DEFAULT_SETTINGS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  tier: "action",
  bypassPermissions: false,
  auditRetention: 7,
  customArgs: "",
  idleHibernateMinutes: 30,
};

const TIER_OPTIONS = [
  { value: "workbench", label: "Workbench — read-only" },
  { value: "action", label: "Action — read + write (default)" },
  { value: "system", label: "System — destructive and external writes" },
];

const TIER_DESCRIPTIONS: Record<HelpAssistantTier, string> = {
  workbench:
    "The assistant can read project state but can't change it. Best when you're handing off observation tasks.",
  action:
    "The assistant can spawn agents, send prompts, read terminal state, and close terminals — full in-app orchestration. Most assistance tasks need this.",
  system:
    "Adds operations that touch disk or external services: delete worktrees, commit/push git, write the system clipboard, open GitHub issues/PRs. Reserve for trusted automation.",
};

const TIER_SHORT_LABEL: Record<HelpAssistantTier, string> = {
  workbench: "Workbench",
  action: "Action",
  system: "System",
};

const TIER_RANK: Record<HelpAssistantTier, number> = {
  workbench: 0,
  action: 1,
  system: 2,
};

// Format a whole-seconds grant countdown as "Xm Ys" / "Xm" / "Ys". Exported
// for unit coverage of the boundary cases (sub-minute, exact minute, mixed).
export function formatGrantRemaining(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe >= 60) {
    const minutes = Math.floor(safe / 60);
    const seconds = safe % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  return `${safe}s`;
}

function groupToolsByNamespace(tools: readonly string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const dot = tool.indexOf(".");
    const ns = dot >= 0 ? tool.slice(0, dot) : tool;
    const list = groups.get(ns);
    if (list) {
      list.push(tool);
    } else {
      groups.set(ns, [tool]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

interface McpStatusSnapshot {
  enabled: boolean;
  port: number | null;
  apiKey: string;
}

const RETENTION_OPTIONS = [
  { value: "7", label: "7 days (default)" },
  { value: "30", label: "30 days" },
  { value: "0", label: "Off" },
];

const HIBERNATE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes (default)" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
];

export function DaintreeAssistantSettingsTab() {
  const [settings, setSettings] = useState<HelpAssistantSettings>(DEFAULT_SETTINGS);
  const [mcpStatus, setMcpStatus] = useState<McpStatusSnapshot | null>(null);
  // useMcpReadiness drives the 4-state Connection display reactively; the
  // separate mcpStatus state still supplies apiKey for copy/rotate (not in
  // the runtime snapshot). Keep both — they update independently (lesson #4958).
  const runtimeSnapshot = useMcpReadiness();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRotateConfirm, setShowRotateConfirm] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [showBlastRadius, setShowBlastRadius] = useState(false);
  const [auditRecords, setAuditRecords] = useState<McpLogRecord[]>([]);
  const [auditStats, setAuditStats] = useState<McpAuditStats | null>(null);
  const [turnRecords, setTurnRecords] = useState<AssistantTurnRecord[]>([]);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditCopied, setAuditCopied] = useState(false);
  const [auditExported, setAuditExported] = useState(false);
  const [isExportingAudit, setIsExportingAudit] = useState(false);
  const [showClearAuditConfirm, setShowClearAuditConfirm] = useState(false);
  const [isClearingAudit, setIsClearingAudit] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditCopyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const auditExportTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // customArgs is a free-form text input; persisting on every keystroke would
  // spam IPC. We track a pending edit alongside the persisted value: when the
  // pending value is null the input mirrors `settings.customArgs` directly
  // (no extra render round-trip on initial load), and when non-null it holds
  // the user's in-flight edit until the debounced persist catches up. A flush
  // hook captures the pending value before dialog dismissal (#7260).
  const [pendingCustomArgs, setPendingCustomArgs] = useState<string | null>(null);
  const debouncedPendingCustomArgs = useDebounce(pendingCustomArgs, CUSTOM_ARGS_DEBOUNCE_MS);
  const displayedCustomArgs = pendingCustomArgs ?? settings.customArgs;
  const isCustomArgsDirty = pendingCustomArgs !== null && pendingCustomArgs !== settings.customArgs;
  const pendingCustomArgsRef = useRef(pendingCustomArgs);
  useEffect(() => {
    pendingCustomArgsRef.current = pendingCustomArgs;
  }, [pendingCustomArgs]);

  useSettingsTabValidation("assistant", Boolean(error));

  const preferredAgentId = useHelpPanelStore((s) => s.preferredAgentId);
  const setPreferredAgent = useHelpPanelStore((s) => s.setPreferredAgent);

  const agentOptions = useMemo(() => {
    return getAssistantSupportedAgentIds().map((id) => ({
      value: id,
      label: getAgentConfig(id)?.name ?? id,
    }));
  }, []);
  // Track the persisted choice exactly — falling back to a default would visually
  // suggest a value is set when it isn't, leaving onChange unfired and the help
  // panel still in its empty state. The placeholder makes "no selection" explicit.
  const agentSelectValue = preferredAgentId ?? "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const refreshStatus = (): Promise<void> =>
      window.electron.mcpServer
        .getStatus()
        .then((status) => {
          if (cancelled) return;
          setMcpStatus({
            enabled: status.enabled,
            port: status.port,
            apiKey: status.apiKey,
          });
        })
        .catch((err) => {
          if (cancelled) return;
          setMcpStatus(null);
          logError("Failed to load MCP status for assistant tab", err);
        });

    const settingsLoad = window.electron.helpAssistant
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        setSettings(s);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatErrorMessage(err, "Couldn't load assistant settings"));
        logError("Failed to load Daintree Assistant settings", err);
      });

    const mcpLoad = refreshStatus().catch((err) => {
      if (cancelled) return;
      logError("Failed initial MCP status load for assistant tab", err);
    });

    // Refetch the connection panel whenever the runtime state transitions.
    // Without this, toggling Daintree control on triggers main-process
    // auto-coupling (`helpAssistant.setSettings` calls `mcpServer.setEnabled`),
    // but this tab still shows "MCP server is off" until the user reopens it.
    const unsubscribe = window.electron.mcpServer.onRuntimeStateChanged(() => {
      void refreshStatus();
    });

    void Promise.all([settingsLoad, mcpLoad]).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      unsubscribe();
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
    };
  }, []);

  // Separate audit fetch effect — keeps the settings init effect's cancellation
  // semantics simple (per past lesson #4958) while still letting the audit
  // viewer hydrate independently of the settings + MCP status round-trips.
  // `allSettled` so a stats failure doesn't silently blank the record list.
  const refreshAuditRecords = async (): Promise<void> => {
    const [recordsResult, statsResult, turnsResult] = await Promise.allSettled([
      window.electron.mcpServer.getLogRecords(),
      window.electron.mcpServer.getAuditStats(),
      window.electron.mcpServer.getTurnOutcomeRecords(),
    ]);
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
      ])
        .then(([recordsResult, statsResult, turnsResult]) => {
          if (cancelled) return;
          if (recordsResult.status === "fulfilled") {
            setAuditRecords(recordsResult.value);
          } else {
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
            logError("Failed initial turn outcomes load for assistant tab", turnsResult.reason);
          }
        })
        .finally(() => {
          if (!cancelled) setAuditLoading(false);
        }),
      { context: "initial audit load for assistant tab" }
    );
    return () => {
      cancelled = true;
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
    };
  }, []);

  const handleCopyAuditAsJson = async (records: McpLogRecord[]) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
      setAuditCopied(true);
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
      auditCopyTimeoutRef.current = setTimeout(() => setAuditCopied(false), COPY_RESET_DELAY_MS);
    } catch (err) {
      setAuditCopied(false);
      if (auditCopyTimeoutRef.current) {
        clearTimeout(auditCopyTimeoutRef.current);
        auditCopyTimeoutRef.current = null;
      }
      setError(formatErrorMessage(err, "Couldn't copy audit log"));
      logError("Failed to copy MCP audit log from assistant tab", err);
    }
  };

  const handleExportAuditAsNdjson = async (records: McpLogRecord[]) => {
    if (isExportingAudit) return;
    setIsExportingAudit(true);
    try {
      setError(null);
      const written = await window.electron.mcpServer.exportAuditLog(records);
      if (written) {
        setAuditExported(true);
        if (auditExportTimeoutRef.current) clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = setTimeout(
          () => setAuditExported(false),
          COPY_RESET_DELAY_MS
        );
      }
    } catch (err) {
      setAuditExported(false);
      if (auditExportTimeoutRef.current) {
        clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = null;
      }
      setError(formatErrorMessage(err, "Couldn't export audit log"));
      logError("Failed to export MCP audit log from assistant tab", err);
    } finally {
      setIsExportingAudit(false);
    }
  };

  const confirmClearAuditLog = async () => {
    if (isClearingAudit) return;
    setIsClearingAudit(true);
    try {
      setError(null);
      await window.electron.mcpServer.clearAuditLog();
      setAuditRecords([]);
      setShowClearAuditConfirm(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't clear audit log"));
      logError("Failed to clear MCP audit log from assistant tab", err);
    } finally {
      setIsClearingAudit(false);
    }
  };

  const handleCancelClearAudit = () => {
    if (isClearingAudit) return;
    setShowClearAuditConfirm(false);
  };

  const persist = useCallback(
    async (patch: Partial<HelpAssistantSettings>) => {
      const next = { ...settings, ...patch } as HelpAssistantSettings;
      setSettings(next);
      try {
        await window.electron.helpAssistant.setSettings(patch);
      } catch (err) {
        setError(formatErrorMessage(err, "Couldn't save assistant settings"));
        logError("Failed to save Daintree Assistant settings", err);
      }
      // settings is intentionally read at call time via the closure; no stale risk
      // because we set it synchronously above.
    },
    [settings]
  );

  const toggleDocSearch = () => {
    void persist({ docSearch: !settings.docSearch });
  };

  const toggleDaintreeControl = () => {
    void persist({ daintreeControl: !settings.daintreeControl });
  };

  const setTier = (value: string) => {
    if (value !== "workbench" && value !== "action" && value !== "system") return;
    void persist({ tier: value });
  };

  const toggleBypassPermissions = () => {
    void persist({ bypassPermissions: !settings.bypassPermissions });
  };

  const setRetention = (value: string) => {
    const parsed = Number(value);
    if (parsed !== 0 && parsed !== 7 && parsed !== 30) return;
    void persist({ auditRetention: parsed as 0 | 7 | 30 });
  };

  const setHibernateMinutes = (value: string) => {
    const parsed = Number(value);
    if (parsed !== 0 && parsed !== 15 && parsed !== 30 && parsed !== 60 && parsed !== 120) {
      return;
    }
    void persist({ idleHibernateMinutes: parsed as 0 | 15 | 30 | 60 | 120 });
  };

  const handleAgentChange = (value: string) => {
    setPreferredAgent(value || null);
  };

  const handleCustomArgsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPendingCustomArgs(event.target.value);
  };

  // Persist the pending value once the debounce settles. Skipped when pending
  // matches what's already persisted (e.g., user typed and undid, or the
  // value just landed via the optimistic update inside `persist`).
  useEffect(() => {
    if (debouncedPendingCustomArgs === null) return;
    if (debouncedPendingCustomArgs !== settings.customArgs) {
      void persist({ customArgs: debouncedPendingCustomArgs });
    }
  }, [debouncedPendingCustomArgs, settings.customArgs, persist]);

  // Once the persisted value catches up, clear the pending flag so the input
  // resumes mirroring `settings.customArgs` directly.
  useEffect(() => {
    if (pendingCustomArgs !== null && pendingCustomArgs === settings.customArgs) {
      setPendingCustomArgs(null);
    }
  }, [pendingCustomArgs, settings.customArgs]);

  // Pre-close flush bypasses the debounce so closing the dialog mid-edit
  // still captures the in-flight value.
  useSettingsTabFlush(
    "assistant",
    () => {
      const pending = pendingCustomArgsRef.current;
      if (pending === null) return;
      return persist({ customArgs: pending });
    },
    isCustomArgsDirty
  );

  const confirmRotateKey = async () => {
    if (isRotating) return;
    setIsRotating(true);
    try {
      setError(null);
      const key = await window.electron.mcpServer.rotateApiKey();
      setMcpStatus((prev) => (prev ? { ...prev, apiKey: key } : prev));
      setShowRotateConfirm(false);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't rotate key"));
      logError("Failed to rotate MCP API key", err);
    } finally {
      setIsRotating(false);
    }
  };

  const handleCancelRotate = () => {
    if (isRotating) return;
    setShowRotateConfirm(false);
  };

  const apiKeySuffix =
    mcpStatus?.apiKey && mcpStatus.apiKey.length >= 8 ? mcpStatus.apiKey.slice(-4) : "";

  // Doherty gate for the initial status round-trip: render section chrome
  // immediately and only show the inline "Loading…" text if it outlasts the
  // threshold, avoiding a sub-400ms flicker.
  const showInlineLoading = useDeferredLoading(loading, UI_DOHERTY_THRESHOLD);

  const handleGoToMcpSettings = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "mcp" }, { source: "user" });
  };

  const handleCopyConfig = async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_RESET_DELAY_MS);
    } catch (err) {
      setError(formatErrorMessage(err, "Couldn't copy config"));
      logError("Failed to copy MCP config", err);
    }
  };

  return (
    <div className="space-y-6" id="settings-panel-assistant-content">
      <header className="flex items-start gap-3 pb-4 border-b border-daintree-border">
        <DaintreeIcon className="w-6 h-6 text-daintree-text shrink-0 mt-0.5" size={24} />
        <div>
          <h3 className="text-sm font-medium text-daintree-text">Daintree Assistant</h3>
          <p className="text-xs text-daintree-text/50 mt-1 select-text">
            Controls the help assistant launched from the dock — the tools it can call and how its
            activity is recorded. Changes apply to new help sessions.
          </p>
        </div>
      </header>

      {/* Agent */}
      <SettingsSection
        icon={Sliders}
        title="Agent"
        description="Pick which CLI runs the assistant and pass extra flags at launch."
      >
        <SettingsSelect
          label="Agent"
          description="The CLI launched when you open the Daintree Assistant."
          value={agentSelectValue}
          onValueChange={handleAgentChange}
          options={agentOptions}
          placeholder="Choose an agent"
          disabled={loading || agentOptions.length === 0}
        />
        <SettingsInput
          label="Custom CLI args"
          description={
            <>
              Whitespace-separated flags appended to the launch command — e.g.{" "}
              <code className="font-mono text-[11px]">--model sonnet</code>. Applies to new
              assistant sessions.
            </>
          }
          type="text"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="--model sonnet"
          value={displayedCustomArgs}
          onChange={handleCustomArgsChange}
          disabled={loading}
        />
      </SettingsSection>

      {/* Behavior */}
      <SettingsSection
        icon={Wrench}
        title="Behavior"
        description="Choose which tools the assistant can use during help sessions."
      >
        <SettingsSwitchCard
          variant="compact"
          icon={BookOpen}
          title="Search documentation"
          subtitle="Let the assistant search Daintree docs and changelog while answering"
          isEnabled={settings.docSearch}
          onChange={toggleDocSearch}
          ariaLabel="Allow the assistant to search Daintree documentation"
          disabled={loading}
        />
        <SettingsSwitchCard
          variant="compact"
          icon={DaintreeIcon}
          title="Daintree control"
          subtitle="Let the assistant call Daintree actions through the local MCP server"
          isEnabled={settings.daintreeControl}
          onChange={toggleDaintreeControl}
          ariaLabel="Allow the assistant to call Daintree control tools"
          disabled={loading}
        />
        {!loading && settings.daintreeControl && (
          <div
            className={cn(
              "flex items-start gap-2 p-3 rounded-[var(--radius-md)]",
              "bg-overlay-subtle border border-daintree-border"
            )}
          >
            <div className="text-xs text-daintree-text/70 leading-relaxed select-text">
              Enabling this starts a local HTTP server on 127.0.0.1 so the assistant can call
              Daintree actions. The MCP server tab has the connection details and API key.
            </div>
          </div>
        )}
      </SettingsSection>

      {/* Hibernation */}
      <SettingsSection
        icon={Moon}
        title="Hibernation"
        description="Idle assistants release memory and capture a resume token, so reopening reconnects to the same Claude conversation."
      >
        <SettingsSelect
          label="Hibernate after"
          description="How long the panel stays hidden before the assistant gracefully shuts down. Off keeps it resident until you close it."
          value={String(settings.idleHibernateMinutes)}
          onValueChange={setHibernateMinutes}
          options={HIBERNATE_OPTIONS}
          disabled={loading}
        />
      </SettingsSection>

      {/* Security */}
      <SettingsSection
        icon={ShieldAlert}
        title="Security"
        description="Pick how much the assistant can do without prompting, and whether to bypass Claude Code's per-tool confirmation gate."
      >
        <SettingsSelect
          label="Capability tier"
          description={TIER_DESCRIPTIONS[settings.tier]}
          value={settings.tier}
          onValueChange={setTier}
          options={TIER_OPTIONS}
          disabled={loading}
        />

        <BlastRadiusPreview
          tier={settings.tier}
          isOpen={showBlastRadius}
          onToggle={() => setShowBlastRadius((v) => !v)}
        />

        <SessionLiveStatusCard configuredTier={settings.tier} />

        <SettingsSwitchCard
          variant="compact"
          icon={ShieldAlert}
          title="Bypass Claude permission prompts"
          subtitle="Skip Claude Code's per-tool confirmation gate (passes --dangerously-skip-permissions)"
          isEnabled={settings.bypassPermissions}
          onChange={toggleBypassPermissions}
          ariaLabel="Bypass Claude Code permission prompts during help sessions"
          colorScheme="amber"
          disabled={loading}
        />
        {settings.bypassPermissions && (
          <div
            className={cn(
              "flex items-start gap-2 p-3 rounded-[var(--radius-md)]",
              "bg-overlay-subtle border border-daintree-border"
            )}
          >
            <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" />
            <div className="text-xs text-daintree-text/70 leading-relaxed select-text">
              With this on, Claude Code's permission gate is bypassed for all tools — built-in
              (Bash, Write) and MCP. The capability tier above is the only remaining safeguard for
              Daintree actions.
            </div>
          </div>
        )}
      </SettingsSection>

      {/* Privacy */}
      <SettingsSection
        icon={KeyRound}
        title="Privacy"
        description="Help-session activity is logged locally so you can review what the assistant did."
      >
        <SettingsSelect
          label="Audit log retention"
          description="How long help-session logs are kept on this machine. Set to off to skip logging entirely."
          value={String(settings.auditRetention)}
          onValueChange={setRetention}
          options={RETENTION_OPTIONS}
          disabled={loading}
        />
        <McpAuditLogViewer
          records={auditRecords}
          turnRecords={turnRecords}
          loading={auditLoading}
          onRefresh={refreshAuditRecords}
          onCopy={handleCopyAuditAsJson}
          onClear={() => setShowClearAuditConfirm(true)}
          copyFlashActive={auditCopied}
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
        {auditStats && auditStats.auth401Count > 0 && (
          <p className="text-xs text-daintree-text/60 select-text">
            <span className="font-mono text-daintree-text/80">{auditStats.auth401Count}</span>{" "}
            bearer rejection{auditStats.auth401Count === 1 ? "" : "s"} since last launch — an
            external client is connecting with a stale or missing API key.
          </p>
        )}
      </SettingsSection>

      {/* Connection */}
      <SettingsSection
        icon={McpServerIcon}
        title="Connection"
        description="The assistant talks to Daintree through the local MCP server. Use these controls to share access with external clients."
      >
        {loading ? (
          showInlineLoading ? (
            <p className="text-xs text-daintree-text/50">Loading…</p>
          ) : null
        ) : runtimeSnapshot.state === "disabled" ? (
          <div className="space-y-2">
            <p className="text-xs text-daintree-text/60 select-text">
              MCP server is off. Turn it on to share the connection with external clients.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleGoToMcpSettings}
                className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
              >
                Open MCP server settings
              </button>
            </div>
          </div>
        ) : runtimeSnapshot.state === "starting" ? (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-daintree-text/30 shrink-0" />
            <span className="text-xs text-daintree-text/60">Server is starting…</span>
          </div>
        ) : runtimeSnapshot.state === "failed" ? (
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
              <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
              <p className="text-xs text-status-danger leading-relaxed select-text">
                MCP server failed to start.{" "}
                {runtimeSnapshot.lastError ?? "Check the MCP server tab for details."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleGoToMcpSettings}
                className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors"
              >
                Open MCP server settings
              </button>
            </div>
          </div>
        ) : !mcpStatus ? (
          <p className="text-xs text-daintree-text/50">Couldn't load MCP status.</p>
        ) : (
          <div className="contents">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-status-success shrink-0" />
              <span className="text-xs text-daintree-text/60">
                {runtimeSnapshot.port ? `Running on port ${runtimeSnapshot.port}` : "Running"}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
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
                {copied ? "Copied" : "Copy MCP config"}
              </button>
              <button
                type="button"
                onClick={() => setShowRotateConfirm(true)}
                disabled={!apiKeySuffix}
                title={apiKeySuffix ? undefined : "Waiting for the MCP key to load…"}
                className="flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium border border-daintree-border text-daintree-text/70 hover:text-daintree-text hover:bg-overlay-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-daintree-text/70"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Rotate MCP key
              </button>
            </div>

            <p className="text-xs text-daintree-text/50 leading-relaxed select-text">
              Paste the copied config into an external MCP client (e.g. Claude Code, Cursor).
              Regenerating the key invalidates existing client connections.
            </p>
          </div>
        )}
      </SettingsSection>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-[var(--radius-md)] bg-status-danger/10 border border-status-danger/20">
          <AlertCircle className="w-4 h-4 text-status-danger shrink-0 mt-0.5" />
          <p className="text-xs text-status-danger">{error}</p>
        </div>
      )}

      <ConfirmDialog
        isOpen={showClearAuditConfirm}
        onClose={isClearingAudit ? undefined : handleCancelClearAudit}
        title="Clear audit log?"
        description="All recorded tool dispatches will be permanently deleted — including those from external MCP clients."
        confirmLabel="Clear log"
        cancelLabel="Cancel"
        onConfirm={confirmClearAuditLog}
        isConfirmLoading={isClearingAudit}
        variant="destructive"
        zIndex="nested"
      />

      <ConfirmDialog
        isOpen={showRotateConfirm}
        onClose={isRotating ? undefined : handleCancelRotate}
        title="Rotate API key?"
        description="The current key will be invalidated immediately. External clients using this key will need to update their configuration."
        confirmLabel="Rotate key"
        cancelLabel="Cancel"
        onConfirm={confirmRotateKey}
        isConfirmLoading={isRotating}
        variant="destructive"
        zIndex="nested"
      />
    </div>
  );
}

interface BlastRadiusPreviewProps {
  tier: HelpAssistantTier;
  isOpen: boolean;
  onToggle: () => void;
}

function BlastRadiusPreview({ tier, isOpen, onToggle }: BlastRadiusPreviewProps) {
  const totalCount = HELP_TIER_CUMULATIVE[tier].length;
  const newAtTier = HELP_TIER_INCREMENTAL[tier].length;
  const groups = useMemo(() => {
    const cumulative = HELP_TIER_CUMULATIVE[tier];
    if (tier !== "system") return groupToolsByNamespace(cumulative);
    // Pin the load-bearing dangerous actions at the top of the system tier
    // so users don't miss them when scanning a long alphabetical list.
    const pinned = new Set(SYSTEM_TIER_HIGH_BLAST_RADIUS);
    const rest = cumulative.filter((tool) => !pinned.has(tool));
    const pinnedList = SYSTEM_TIER_HIGH_BLAST_RADIUS.filter((tool) => cumulative.includes(tool));
    return [
      ["⚠ high blast radius", pinnedList] as [string, string[]],
      ...groupToolsByNamespace(rest),
    ];
  }, [tier]);

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-3 py-2 text-xs",
          "text-daintree-text/80 hover:text-daintree-text transition-colors"
        )}
      >
        <span className="flex items-center gap-2">
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 transition-transform duration-150",
              isOpen ? "rotate-90" : "rotate-0"
            )}
          />
          <span>
            {totalCount} actions allowed without prompting
            {tier !== "workbench" && (
              <span className="text-daintree-text/50"> ({newAtTier} new at this tier)</span>
            )}
          </span>
        </span>
      </button>
      {isOpen && (
        <div className="px-3 pb-3 pt-1 space-y-2">
          {groups.map(([ns, tools]) => (
            <div key={ns} className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-daintree-text/50 font-mono">
                {ns}
                <span className="ml-1 text-daintree-text/30">({tools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <span
                    key={tool}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-mono",
                      "bg-daintree-bg border border-daintree-border text-daintree-text/70"
                    )}
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-tool grant expiry countdown. Re-renders once a second — a semantic
// countdown (the decay IS the signal), so it sits outside the motion tiers.
// The push event (`grant.expired`) is authoritative for removal; this is only
// the display, so reaching zero shows "expiring" until the row is pulled out.
function GrantCountdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  // Per-second tick that pauses while the window is hidden (the canonical
  // compliant timer wrapper — direct setInterval is lint-restricted).
  useVisibilityAwareInterval(() => setNow(Date.now()), 1000);
  const remainingMs = expiresAt - now;
  return (
    <span className="font-mono text-daintree-text/50 tabular-nums shrink-0">
      {remainingMs <= 0 ? "expiring" : `expires in ${formatGrantRemaining(remainingMs / 1000)}`}
    </span>
  );
}

// Native session-scoped automation grants (#10648): approve a bounded set of
// tools for a limited number of uses, then inspect and revoke them. Distinct
// from the per-tool "Approve once" grants above — these authorize follow-up
// automation across the session without a per-call modal. The grant lifecycle
// (issue/use/exhaust/expire/revoke) is mirrored in the audit log below.
function NativeGrantsSection({
  helpSessionId,
  grants,
}: {
  helpSessionId: string;
  grants: HelpSessionActiveGrant[];
}) {
  const [toolsInput, setToolsInput] = useState("");
  const [usesInput, setUsesInput] = useState("5");
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const approve = useCallback(() => {
    const allowedTools = toolsInput
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (allowedTools.length === 0) {
      setIssueError("Enter at least one tool id");
      return;
    }
    const maxUses = Number.parseInt(usesInput, 10);
    setIssuing(true);
    setIssueError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .issueNativeGrant({
          helpSessionId,
          allowedTools,
          maxUses: Number.isFinite(maxUses) ? maxUses : undefined,
        })
        .then(() => {
          setToolsInput("");
        })
        .catch((err: unknown) => {
          setIssueError(formatErrorMessage(err, "Couldn't approve grant"));
        })
        .finally(() => {
          setIssuing(false);
        }),
      { context: "DaintreeAssistant:issueNativeGrant" }
    );
  }, [helpSessionId, toolsInput, usesInput]);

  const revoke = useCallback((grantId: string) => {
    safeFireAndForget(
      window.electron.mcpServer
        .revokeNativeGrant({ grantId })
        .then(() => undefined)
        .catch((err: unknown) => {
          logError("DaintreeAssistant: revokeNativeGrant failed", err);
        }),
      { context: "DaintreeAssistant:revokeNativeGrant" }
    );
  }, []);

  return (
    <div className="space-y-2 pt-1">
      <div className="text-[10px] uppercase tracking-wide text-daintree-text/50 font-mono">
        Automation grants{grants.length > 0 ? ` (${grants.length})` : ""}
      </div>
      {grants.length > 0 ? (
        <div className="space-y-1.5">
          {grants.map((grant) => (
            <div
              key={grant.grantId}
              className="rounded-[var(--radius-sm)] border border-daintree-border bg-daintree-bg/40 px-2 py-1.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono text-daintree-text/70 truncate">
                  {(grant.allowedTools ?? []).join(", ") || "no tools"}
                </span>
                <button
                  type="button"
                  onClick={() => grant.grantId && revoke(grant.grantId)}
                  className="shrink-0 text-[10px] text-daintree-text/60 hover:text-status-danger transition-colors"
                >
                  Revoke
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 text-[10px] text-daintree-text/50">
                <span className="tabular-nums">
                  {grant.remainingUses ?? 0} of {grant.maxUses ?? 0} uses left
                </span>
                <GrantCountdown expiresAt={grant.expiresAt} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-daintree-text/50">No automation grants active</div>
      )}

      <div className="flex items-end gap-1.5 pt-0.5">
        <input
          type="text"
          value={toolsInput}
          onChange={(e) => setToolsInput(e.target.value)}
          placeholder="git.commit terminal.new"
          className="flex-1 min-w-0 rounded-[var(--radius-sm)] border border-daintree-border bg-daintree-bg px-2 py-1 text-[11px] font-mono text-daintree-text placeholder:text-daintree-text/30 focus-visible:outline-2 focus-visible:outline-daintree-accent"
        />
        <input
          type="number"
          min={1}
          max={100}
          value={usesInput}
          onChange={(e) => setUsesInput(e.target.value)}
          aria-label="Maximum uses"
          className="w-12 rounded-[var(--radius-sm)] border border-daintree-border bg-daintree-bg px-1.5 py-1 text-[11px] tabular-nums text-daintree-text focus-visible:outline-2 focus-visible:outline-daintree-accent"
        />
        <button
          type="button"
          onClick={approve}
          disabled={issuing}
          className="shrink-0 rounded-[var(--radius-sm)] border border-daintree-border bg-overlay-subtle px-2 py-1 text-[11px] text-daintree-text/80 hover:text-daintree-text disabled:opacity-50 transition-colors"
        >
          Approve grant
        </button>
      </div>
      {issueError && <div className="text-[10px] text-status-danger">{issueError}</div>}
    </div>
  );
}

interface SessionLiveStatusCardProps {
  configuredTier: HelpAssistantTier;
}

// Live status of the *currently pinned* help session — distinct from the
// configured-default tier select above. Renders from safe `connected: false`
// defaults immediately (no spinner, per the settings-tab loading rule) and
// populates when the live-status bridge call resolves. Live-tier *change*
// events while this is open aren't pushed (the grant-lifecycle push carries no
// tier field — covered by #10027); the snapshot refreshes on mount and on any
// grant-lifecycle event for this session.
function SessionLiveStatusCard({ configuredTier }: SessionLiveStatusCardProps) {
  const sessionId = useHelpPanelStore((s) => s.sessionId);
  const { connected, tier, activeGrants } = useHelpSessionLiveStatus(sessionId);
  const perToolGrants = activeGrants.filter((g) => g.kind !== "native");
  const nativeGrants = activeGrants.filter((g) => g.kind === "native");
  // Three-way relation to the configured default: a renderer-approved elevation
  // raises the live tier above it, but a session can also sit *below* it (e.g.
  // a per-session choice or a decayed elevation) — both must read truthfully,
  // not collapse to "matches".
  const tierDelta = TIER_RANK[tier] - TIER_RANK[configuredTier];
  const tierComparisonCopy =
    tierDelta > 0
      ? ` — elevated above the configured ${TIER_SHORT_LABEL[configuredTier].toLowerCase()} default`
      : tierDelta < 0
        ? ` — below the configured ${TIER_SHORT_LABEL[configuredTier].toLowerCase()} default`
        : " — matches the configured default";

  return (
    <div className="rounded-[var(--radius-md)] border border-daintree-border bg-overlay-subtle/40 px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              connected ? "bg-status-success" : "bg-daintree-text/30"
            )}
            aria-hidden="true"
          />
          <span className="text-xs text-daintree-text/80">
            {connected ? "Live session" : "No live session"}
          </span>
        </span>
        {connected && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-daintree-bg border border-daintree-border text-daintree-text/70">
            {TIER_SHORT_LABEL[tier]}
          </span>
        )}
      </div>

      {connected ? (
        <>
          <div className="text-xs text-daintree-text/70 leading-relaxed">
            Running at{" "}
            <span className="text-daintree-text">{TIER_SHORT_LABEL[tier].toLowerCase()}</span>
            {tierComparisonCopy}
          </div>
          {perToolGrants.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-daintree-text/50 font-mono">
                Active grants ({perToolGrants.length})
              </div>
              <div className="space-y-1">
                {perToolGrants.map((grant) => (
                  <div
                    key={grant.toolId}
                    className="flex items-center justify-between gap-2 text-[11px]"
                  >
                    <span className="font-mono text-daintree-text/70 truncate">{grant.toolId}</span>
                    <GrantCountdown expiresAt={grant.expiresAt} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-daintree-text/50">No per-tool grants active</div>
          )}
          {sessionId && <NativeGrantsSection helpSessionId={sessionId} grants={nativeGrants} />}
        </>
      ) : (
        <div className="text-xs text-daintree-text/60 leading-relaxed">
          Open the assistant to start a session — its live tier and any active per-tool grants show
          here
        </div>
      )}
    </div>
  );
}
