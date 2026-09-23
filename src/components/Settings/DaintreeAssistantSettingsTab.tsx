import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import * as semver from "semver";
import { cn } from "@/lib/utils";
import { useDeferredLoading, useHelpSessionLiveStatus } from "@/hooks";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { useMcpReadiness } from "@/hooks/useMcpReadiness";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { actionService } from "@/services/ActionService";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsDependents, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsChoicebox } from "./SettingsChoicebox";
import { SettingsPresetGroup } from "./SettingsPresetGroup";
import { SettingsInput } from "./SettingsInput";
import { SettingsSelect } from "./SettingsSelect";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsLoadErrorBanner } from "./SettingsLoadErrorBanner";
import { McpAuditLogViewer } from "./McpAuditLogViewer";
import { McpAuditLatencyTable } from "./McpAuditLatencyTable";
import { TurnOutcomeDiagnostics } from "./TurnOutcomeDiagnostics";
import { useSettingsTabValidation } from "./SettingsValidationRegistry";
import { useSettingsTabFlush } from "./SettingsFlushRegistry";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { useDebounce } from "@/hooks/useDebounce";

import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { getAgentConfig, getAssistantSupportedAgentIds } from "@/config/agents";
import { DEFAULT_DANGEROUS_ARGS } from "@shared/types/agentSettings";
import { agentCapabilitiesClient } from "@/clients/agentCapabilitiesClient";
import type { AgentModelConfig } from "@shared/config/agentRegistry";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import type {
  HelpAssistantIdleHibernateMinutes,
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
  HIGH_BLAST_RADIUS_TOOLS,
} from "@shared/config/helpAssistantTierAllowlists";

const COPY_RESET_DELAY_MS = 2000;
const CUSTOM_ARGS_DEBOUNCE_MS = 500;

type SaveGroup = "agent" | "launch" | "behavior" | "security" | "privacy";

const SAVE_GROUP_BY_KEY: Record<keyof HelpAssistantSettings, SaveGroup> = {
  modelId: "agent",
  customArgs: "launch",
  debugLogging: "launch",
  docSearch: "behavior",
  daintreeControl: "behavior",
  idleHibernateMinutes: "launch",
  tier: "security",
  bypassPermissions: "security",
  auditRetention: "privacy",
};

const SETTING_KEYS: readonly (keyof HelpAssistantSettings)[] = [
  "modelId",
  "customArgs",
  "debugLogging",
  "docSearch",
  "daintreeControl",
  "idleHibernateMinutes",
  "tier",
  "bypassPermissions",
  "auditRetention",
];

function patchedKeys(patch: Partial<HelpAssistantSettings>): (keyof HelpAssistantSettings)[] {
  return SETTING_KEYS.filter((key) => key in patch);
}

function saveGroupOf(patch: Partial<HelpAssistantSettings>): SaveGroup {
  const [first] = patchedKeys(patch);
  return first ? SAVE_GROUP_BY_KEY[first] : "agent";
}

function copySetting<K extends keyof HelpAssistantSettings>(
  target: HelpAssistantSettings,
  source: HelpAssistantSettings,
  key: K
): void {
  target[key] = source[key];
}

interface SaveFailure {
  group: SaveGroup;
  patch: Partial<HelpAssistantSettings>;
}

const DEFAULT_SETTINGS: HelpAssistantSettings = {
  docSearch: true,
  daintreeControl: true,
  tier: "action",
  bypassPermissions: false,
  auditRetention: 7,
  modelId: "",
  customArgs: "",
  idleHibernateMinutes: 5,
  debugLogging: false,
};

// Radix Select rejects an empty-string item value, so the "use the CLI default"
// choice carries a sentinel in the dropdown and maps back to "" on persist.
const MODEL_DEFAULT_SENTINEL = "__default__";

// One sentence of consequence beside the select; the rest lives in the tier's
// disclosure with the action inventory, where it can be read in full.
const TIER_SUMMARIES: Record<HelpAssistantTier, string> = {
  workbench: "Reads project state but can't change it",
  action: "Full in-app orchestration, including closing terminals and deleting worktrees",
  system: "Adds git, forge and on-disk writes outside the app. Reserve for trusted automation.",
};

// Descriptive exclusive choice: each tier's consequence stays readable in full, so the
// one that grants destructive and external writes can't hide behind a truncated label.
const TIER_CHOICES: { value: HelpAssistantTier; label: string; description: string }[] = [
  { value: "workbench", label: "Workbench", description: TIER_SUMMARIES.workbench },
  { value: "action", label: "Action (default)", description: TIER_SUMMARIES.action },
  { value: "system", label: "System", description: TIER_SUMMARIES.system },
];

const TIER_DETAILS: Record<HelpAssistantTier, string> = {
  workbench:
    "The assistant can read project state but can't change it. Best when you're handing off observation tasks.",
  action:
    "The assistant can spawn agents, send prompts, read terminal state, close terminals, and delete worktrees in this project or tear down their resources. Deletions normally ask you to confirm each time, unless you have granted the assistant automation for them, and they run whatever teardown commands the project configures. Most assistance tasks need this.",
  system:
    "Adds git staging, commits, fetches and pushes; forge issue/PR reads and writes; worktree creation at any path on disk; clipboard and CopyTree-to-disk writes; and arming terminals for automation.",
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
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "0", label: "Off" },
];

const HIBERNATE_OPTIONS = [
  { value: "0", label: "Off" },
  { value: "5", label: "5 minutes (default)" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
];

interface BypassCopy {
  title: string;
  subtitle: string;
  /** Only when the spoken name must add to the visible title; it has to contain it. */
  ariaLabel?: string;
  warning: string;
}

// Names the tier rather than pointing at "the selector above" (#11907): with
// the gate off, the tier carries most of the remaining boundary, so the
// warning has to say which one. It isn't the *entire* boundary though, and
// claiming so was the #12119 overclaim: a `danger: "confirm"` action still
// opens the host confirmation dialog no matter the tier or the bypass flag
// (`tierAuth.ts` — `requiresConfirmation: danger === "confirm" &&
// !nativeGranted`), and only a native automation grant pre-authorizes it. So
// the second sentence names that exception instead of dropping the warning.
// Scoped to new sessions because both the tier and the bypass preference are
// provision-time snapshots — a session already running keeps the tier it was
// minted with, which the live-status card reports.
const tierBoundsNewSessions = (tier: HelpAssistantTier): string =>
  `New sessions are limited to the Daintree actions the ${TIER_SHORT_LABEL[tier]} capability tier allows. Actions that need confirmation still open Daintree's own prompt unless an automation grant covers them.`;

/**
 * Per-agent wording for the one stored `bypassPermissions` preference. The
 * generic template below is accurate for a plain confirmation gate, but
 * understates any agent whose flag gives up more than that — Codex drops its
 * sandbox alongside its approvals — and understating the blast radius is the
 * same failure as labelling every agent with Claude's flag.
 */
// `warning` carries the agent-specific half only; `getBypassCopy` appends the
// tier-naming safeguard sentences so every branch names the same effective tier.
const BYPASS_COPY: Record<string, Omit<BypassCopy, "subtitle"> & { effect: string }> = {
  claude: {
    title: "Bypass Claude permission prompts",
    effect: "Skip Claude's per-tool confirmation gate",
    ariaLabel: "Bypass Claude permission prompts during help sessions",
    warning:
      "With this on, Claude's permission gate is bypassed for all tools — built-in (Bash, Write) and MCP.",
  },
  codex: {
    title: "Bypass Codex approvals and sandbox",
    effect: "Skip Codex's approval prompts and run tools unsandboxed",
    ariaLabel: "Bypass Codex approvals and sandbox during help sessions",
    warning:
      "With this on, Codex runs every tool without its own approval prompts and outside its sandbox, so it reaches anywhere the process can.",
  },
};

/**
 * What "bypass permissions" means for the selected agent, or `null` when the
 * agent has no bypass mechanism and the control should stay hidden.
 *
 * The flag always comes from `DEFAULT_DANGEROUS_ARGS` — the same map the launch
 * path appends from (`electron/ipc/handlers/terminal/lifecycle.ts`) — so the
 * subtitle can't drift from what actually reaches the command line.
 */
function getBypassCopy(agentId: string | null, tier: HelpAssistantTier): BypassCopy | null {
  if (!agentId) return null;

  const safeguard = tierBoundsNewSessions(tier);

  // The assistant has no CLI flag: bypass skips its own confirm sheet via
  // DAINTREE_ASSISTANT_AUTO_APPROVE, which is why it carries no
  // DEFAULT_DANGEROUS_ARGS entry and declares `permissionBypass: false`.
  if (agentId === "daintree-assistant") {
    return {
      title: "Auto-approve assistant actions",
      subtitle: "Skip the assistant's own per-action confirmation sheet",
      warning: `With this on, the assistant acts without asking — it skips its own confirmation sheet for everything it does. ${safeguard}`,
    };
  }

  const flag = DEFAULT_DANGEROUS_ARGS[agentId];
  const config = getAgentConfig(agentId);
  if (!flag || config?.supports === false || config?.supports?.permissionBypass !== true) {
    return null;
  }

  const agentName = config?.name ?? agentId;
  const known = BYPASS_COPY[agentId];
  if (known) {
    const { effect, warning, ...rest } = known;
    return { ...rest, subtitle: `${effect} (passes ${flag})`, warning: `${warning} ${safeguard}` };
  }
  return {
    title: `Bypass ${agentName} permission prompts`,
    subtitle: `Skip ${agentName}'s confirmation gate (passes ${flag})`,
    ariaLabel: `Bypass ${agentName} permission prompts during help sessions`,
    warning: `With this on, ${agentName} skips its own confirmation gate for every tool. ${safeguard}`,
  };
}

export function DaintreeAssistantSettingsTab() {
  const [settings, setSettings] = useState<HelpAssistantSettings>(DEFAULT_SETTINGS);
  const [mcpStatus, setMcpStatus] = useState<McpStatusSnapshot | null>(null);
  // useMcpReadiness drives the 4-state Connection display reactively; the
  // separate mcpStatus state still supplies apiKey for copy/rotate (not in
  // the runtime snapshot). Keep both — they update independently (lesson #4958).
  const runtimeSnapshot = useMcpReadiness();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Failures of one-off actions stay on the section they belong to, not at the page foot.
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  // A failed read must not pass for an empty history.
  const [auditReadFailed, setAuditReadFailed] = useState(false);
  const [saveFailure, setSaveFailure] = useState<SaveFailure | null>(null);
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
  // Recording stays on by default — the audit trail is a privacy/safety feature.
  // The authoritative value loads from getAuditConfig in the audit fetch effect.
  const [auditEnabled, setAuditEnabled] = useState(true);
  const [isTogglingAudit, setIsTogglingAudit] = useState(false);
  // Diagnostics (audit viewer, latency table, turn outcomes) collapse by default
  // so the Privacy section doesn't surface telemetry on load. Local-only state —
  // no persistence precedent for section collapse in Settings.
  const [advancedDiagnosticsOpen, setAdvancedDiagnosticsOpen] = useState(false);
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

  useSettingsTabValidation("assistant", Boolean(loadError || saveFailure));

  const preferredAgentId = useHelpPanelStore((s) => s.preferredAgentId);
  const setPreferredAgent = useHelpPanelStore((s) => s.setPreferredAgent);
  const droppedPreferredAgentId = useHelpPanelStore((s) => s.droppedPreferredAgentId);
  const clearDroppedPreferredAgent = useHelpPanelStore((s) => s.clearDroppedPreferredAgent);

  // Version gate at the configuration point: the launch path already blocks an
  // outdated CLI (HelpPanelVersionGate), but the user can pick a too-old agent
  // here with no warning. Probe the selected agent's version (12h cached in
  // AgentVersionService, so cheap) and surface a non-blocking hint inline.
  const [versionWarning, setVersionWarning] = useState<{
    agentName: string;
    installed: string;
    required: string;
  } | null>(null);

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

  const bypassCopy = useMemo(
    () => getBypassCopy(preferredAgentId, settings.tier),
    [preferredAgentId, settings.tier]
  );

  // Resolved model catalog for the currently-preferred agent. `null` means "not
  // loaded / unavailable" (we render nothing); an empty array means "agent has
  // no models" (also nothing). The model picker only appears once a non-empty
  // catalog resolves for the selected agent.
  const [resolvedModels, setResolvedModels] = useState<AgentModelConfig[] | null>(null);

  useEffect(() => {
    if (!preferredAgentId) {
      setResolvedModels(null);
      return;
    }
    let cancelled = false;
    setResolvedModels(null);
    agentCapabilitiesClient
      .getResolvedModelList(preferredAgentId)
      .then((catalog) => {
        if (cancelled) return;
        setResolvedModels(catalog?.models ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setResolvedModels([]);
        logError("Failed to load model catalog for assistant tab", err);
      });
    return () => {
      cancelled = true;
    };
  }, [preferredAgentId]);

  const modelOptions = useMemo(() => {
    const models = resolvedModels ?? [];
    const options = [
      { value: MODEL_DEFAULT_SENTINEL, label: "Default (CLI default)" },
      ...models.map((m) => ({ value: m.id, label: m.name })),
    ];
    // A persisted model that's no longer in the catalog (custom CLI, renamed
    // model) still needs a matching option or Radix shows a blank trigger.
    if (settings.modelId && !models.some((m) => m.id === settings.modelId)) {
      options.push({ value: settings.modelId, label: settings.modelId });
    }
    return options;
  }, [resolvedModels, settings.modelId]);

  const modelSelectValue = settings.modelId || MODEL_DEFAULT_SENTINEL;
  const showModelPicker = Boolean(resolvedModels && resolvedModels.length > 0);

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
        setLoadError(formatErrorMessage(err, "Couldn't load assistant settings"));
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
      setAuditReadFailed(false);
    } else {
      setAuditReadFailed(true);
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
            logError("Failed initial turn outcomes load for assistant tab", turnsResult.reason);
          }
          if (configResult.status === "fulfilled") {
            setAuditEnabled(configResult.value.enabled);
          } else {
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
      if (auditCopyTimeoutRef.current) clearTimeout(auditCopyTimeoutRef.current);
    };
  }, []);

  // Isolated version-probe effect (kept separate from the settings-init effect
  // per past lesson #4958). Mirrors HelpSessionController.probeAssistantVersion:
  // any non-definitive result (no minimum configured, no installed version, or
  // a comparison error) clears the warning so we never block on a transient
  // failure or show a stale hint after switching agents.
  useEffect(() => {
    let cancelled = false;
    if (!preferredAgentId) {
      setVersionWarning(null);
      return;
    }
    const config = getAgentConfig(preferredAgentId);
    const required = config?.assistantMinVersion;
    if (!required) {
      setVersionWarning(null);
      return;
    }
    const agentName = config?.name ?? preferredAgentId;
    // Drop any prior agent's warning up front so the banner never shows a stale
    // name/version while this probe is in flight.
    setVersionWarning(null);
    window.electron.system
      .getAgentVersion(preferredAgentId)
      .then((info) => {
        if (cancelled) return;
        const installed = info?.installedVersion;
        if (!installed) {
          setVersionWarning(null);
          return;
        }
        try {
          setVersionWarning(
            semver.lt(installed, required) ? { agentName, installed, required } : null
          );
        } catch (err) {
          setVersionWarning(null);
          logError("Failed to compare assistant CLI version in settings", err);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setVersionWarning(null);
        logError("Failed to probe assistant CLI version in settings", err);
      });
    return () => {
      cancelled = true;
    };
  }, [preferredAgentId]);

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
      setPrivacyError(formatErrorMessage(err, "Couldn't update audit recording"));
      logError("Failed to toggle MCP audit log from assistant tab", err);
    } finally {
      setIsTogglingAudit(false);
    }
  };

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
      setPrivacyError(formatErrorMessage(err, "Couldn't copy audit log"));
      logError("Failed to copy MCP audit log from assistant tab", err);
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
          COPY_RESET_DELAY_MS
        );
      }
    } catch (err) {
      setAuditExported(false);
      if (auditExportTimeoutRef.current) {
        clearTimeout(auditExportTimeoutRef.current);
        auditExportTimeoutRef.current = null;
      }
      setPrivacyError(formatErrorMessage(err, "Couldn't export audit log"));
      logError("Failed to export MCP audit log from assistant tab", err);
    } finally {
      setIsExportingAudit(false);
    }
  };

  const confirmClearAuditLog = async () => {
    if (isClearingAudit) return;
    setIsClearingAudit(true);
    try {
      setPrivacyError(null);
      await window.electron.mcpServer.clearAuditLog();
      setAuditRecords([]);
      setShowClearAuditConfirm(false);
    } catch (err) {
      setPrivacyError(formatErrorMessage(err, "Couldn't clear audit log"));
      logError("Failed to clear MCP audit log from assistant tab", err);
    } finally {
      setIsClearingAudit(false);
    }
  };

  const handleCancelClearAudit = () => {
    if (isClearingAudit) return;
    setShowClearAuditConfirm(false);
  };

  // Optimistic apply; a rejected save puts the attempted keys back (unless a later
  // change has already moved them) and parks the failure on the group it belongs to.
  const persist = useCallback(
    async (patch: Partial<HelpAssistantSettings>) => {
      const previous = settings;
      const group = saveGroupOf(patch);
      setSettings((current) => ({ ...current, ...patch }));
      try {
        await window.electron.helpAssistant.setSettings(patch);
        setSaveFailure((current) => (current?.group === group ? null : current));
      } catch (err) {
        setSettings((current) => {
          const reverted: HelpAssistantSettings = { ...current };
          for (const key of patchedKeys(patch)) {
            if (current[key] === patch[key]) copySetting(reverted, previous, key);
          }
          return reverted;
        });
        setSaveFailure({ group, patch });
        logError("Failed to save Daintree Assistant settings", err);
      }
    },
    [settings]
  );

  const saveError = (group: SaveGroup) =>
    saveFailure?.group === group ? (
      <SettingsLoadErrorBanner
        title="Couldn't save that change"
        message="The setting is back to its previous value."
        onRetry={() => void persist(saveFailure.patch)}
      />
    ) : null;

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

  const toggleDebugLogging = () => {
    void persist({ debugLogging: !settings.debugLogging });
  };

  const setRetention = (value: string) => {
    const parsed = Number(value);
    if (parsed !== 0 && parsed !== 7 && parsed !== 30) return;
    void persist({ auditRetention: parsed as 0 | 7 | 30 });
  };

  const setHibernateMinutes = (value: string) => {
    const parsed = Number(value);
    if (
      parsed !== 0 &&
      parsed !== 5 &&
      parsed !== 15 &&
      parsed !== 30 &&
      parsed !== 60 &&
      parsed !== 120
    ) {
      return;
    }
    void persist({ idleHibernateMinutes: parsed as HelpAssistantIdleHibernateMinutes });
  };

  const handleAgentChange = (value: string) => {
    setPreferredAgent(value || null);
    // Model IDs are agent-specific — a Claude model passed to Gemini's --model
    // would break the launch — so clear any stale selection on agent change.
    if (settings.modelId) void persist({ modelId: "" });
  };

  const handleModelChange = (value: string) => {
    void persist({ modelId: value === MODEL_DEFAULT_SENTINEL ? "" : value });
  };

  const handleCustomArgsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPendingCustomArgs(event.target.value);
  };

  // Persist the pending value once the debounce settles. Skipped when pending
  // matches what's already persisted (e.g., user typed and undid, or the
  // value just landed via the optimistic update inside `persist`).
  // Each settled value is attempted once: a rejected save rolls settings.customArgs
  // back, which would otherwise re-fire this effect and retry in a loop. Retry
  // lives on the group's error banner instead.
  const lastAttemptedCustomArgsRef = useRef<string | null>(null);
  useEffect(() => {
    if (debouncedPendingCustomArgs === null) {
      lastAttemptedCustomArgsRef.current = null;
      return;
    }
    if (debouncedPendingCustomArgs === lastAttemptedCustomArgsRef.current) return;
    if (debouncedPendingCustomArgs !== settings.customArgs) {
      lastAttemptedCustomArgsRef.current = debouncedPendingCustomArgs;
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
      setConnectionError(null);
      const key = await window.electron.mcpServer.rotateApiKey();
      setMcpStatus((prev) => (prev ? { ...prev, apiKey: key } : prev));
      setShowRotateConfirm(false);
    } catch (err) {
      setConnectionError(formatErrorMessage(err, "Couldn't rotate key"));
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

  const handleGoToAgentSettings = () => {
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  };

  const handleOpenCommandsFolder = () => {
    void actionService.dispatch("help.openCommandsFolder", undefined, { source: "user" });
  };

  const handleCopyConfig = async () => {
    try {
      const snippet = await window.electron.mcpServer.getConfigSnippet();
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = setTimeout(() => setCopied(false), COPY_RESET_DELAY_MS);
    } catch (err) {
      setConnectionError(formatErrorMessage(err, "Couldn't copy config"));
      logError("Failed to copy MCP config", err);
    }
  };

  // Controls stay inert for the whole retry and only unlock once real values land.
  const retryLoadSettings = () => {
    setLoading(true);
    window.electron.helpAssistant
      .getSettings()
      .then((s) => {
        setSettings(s);
        setLoadError(null);
      })
      .catch((err) => {
        setLoadError(formatErrorMessage(err, "Couldn't load assistant settings"));
        logError("Failed to reload Daintree Assistant settings", err);
      })
      .finally(() => setLoading(false));
  };

  // Until the saved values arrive, the controls show defaults. They stay inert so a
  // click can't overwrite a real setting with a value the user never saw.
  const settingsUnavailable = loading || Boolean(loadError);
  const unavailableReason = loadError
    ? "Your saved settings couldn't be read. Retry above."
    : undefined;

  const mcpState = runtimeSnapshot.state;
  const mcpStatusRow = (
    <SettingsRow
      label="MCP server"
      description={
        mcpState === "ready" ? (
          <StatusLine tone="ok">
            {runtimeSnapshot.port ? `Running on port ${runtimeSnapshot.port}` : "Running"}
          </StatusLine>
        ) : mcpState === "starting" ? (
          <StatusLine tone="idle">Server is starting…</StatusLine>
        ) : mcpState === "failed" ? (
          <StatusLine tone="error">
            MCP server failed to start.{" "}
            {runtimeSnapshot.lastError ?? "Check the MCP server tab for details."}
          </StatusLine>
        ) : (
          <StatusLine tone="idle">
            MCP server is off, so the assistant can&apos;t reach Daintree actions
          </StatusLine>
        )
      }
      control={
        mcpState === "failed" || mcpState === "disabled" ? (
          <Button variant="outline" size="sm" onClick={handleGoToMcpSettings}>
            Open MCP server settings
          </Button>
        ) : undefined
      }
    />
  );

  return (
    <div className="space-y-8" id="settings-panel-assistant-content">
      {loadError && (
        <SettingsLoadErrorBanner
          title="Couldn't load assistant settings"
          message={loadError}
          onRetry={retryLoadSettings}
        />
      )}

      <SettingsSection title="Agent" description="Changes apply to new assistant sessions.">
        {saveError("agent")}
        <SettingsGroup>
          <SettingsSelect
            label="Agent"
            description={
              preferredAgentId
                ? "The CLI that runs the help assistant in the dock"
                : "The help assistant can't start until you choose one"
            }
            value={agentSelectValue}
            onValueChange={handleAgentChange}
            options={agentOptions}
            placeholder="Choose an agent"
            disabled={settingsUnavailable || agentOptions.length === 0}
            disabledReason={unavailableReason}
          />
          {showModelPicker && (
            <SettingsSelect
              label="Model"
              description="A --model flag in Custom CLI args overrides this"
              value={modelSelectValue}
              onValueChange={handleModelChange}
              options={modelOptions}
              controlWidth="wide"
              disabled={settingsUnavailable}
            />
          )}
        </SettingsGroup>
        {droppedPreferredAgentId && (
          <AgentNotice
            testId="assistant-dropped-agent-banner"
            title={`${getAgentConfig(droppedPreferredAgentId)?.name ?? droppedPreferredAgentId} is no longer available`}
            body="The agent was removed or is no longer supported as an assistant backend. Choose another agent above."
            action={
              <Button variant="ghost" size="sm" onClick={clearDroppedPreferredAgent}>
                Dismiss
              </Button>
            }
          />
        )}
        {versionWarning && (
          <AgentNotice
            testId="assistant-version-warning-banner"
            title={`${versionWarning.agentName} needs an update`}
            body={`Version ${versionWarning.required} or later is required, but ${versionWarning.installed} is installed. Update the CLI to avoid a blocked or degraded session.`}
            action={
              <Button variant="outline" size="sm" onClick={handleGoToAgentSettings}>
                Open agent settings
              </Button>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Behavior"
        description="Which tools the assistant can use during help sessions"
      >
        {saveError("behavior")}
        <SettingsGroup>
          <SettingsSwitchCard
            id="assistant-doc-search"
            title="Search documentation"
            subtitle="Let the assistant search Daintree docs and changelog while answering"
            isEnabled={settings.docSearch}
            onChange={toggleDocSearch}
            disabled={settingsUnavailable}
            isModified={settings.docSearch !== DEFAULT_SETTINGS.docSearch}
            onReset={() => void persist({ docSearch: DEFAULT_SETTINGS.docSearch })}
          />
          <SettingsSwitchCard
            id="assistant-daintree-control"
            title="Daintree control"
            subtitle={
              !loading && settings.daintreeControl
                ? "Let the assistant call Daintree actions. This starts a local HTTP server on 127.0.0.1."
                : "Let the assistant call Daintree actions through the local MCP server"
            }
            isEnabled={settings.daintreeControl}
            onChange={toggleDaintreeControl}
            ariaLabel="Allow the assistant to call Daintree control tools"
            disabled={settingsUnavailable}
            isModified={settings.daintreeControl !== DEFAULT_SETTINGS.daintreeControl}
            onReset={() => void persist({ daintreeControl: DEFAULT_SETTINGS.daintreeControl })}
          />
          {settings.daintreeControl && !loading && (
            <SettingsDependents>{mcpStatusRow}</SettingsDependents>
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Security"
        description="How much of Daintree the assistant can reach, and whether to bypass the agent's own confirmation gate"
      >
        {saveError("security")}
        <SettingsGroup>
          <SettingsChoicebox
            label="Capability tier"
            description="The default for new sessions"
            value={settings.tier}
            onChange={setTier}
            options={TIER_CHOICES}
            disabled={settingsUnavailable}
            isModified={settings.tier !== DEFAULT_SETTINGS.tier}
            onReset={() => setTier(DEFAULT_SETTINGS.tier)}
          />

          {/* The stored preference is agent-agnostic but its effect is not, so the
              row only renders once an agent with a real bypass mechanism is
              selected — mirroring the agent-gated Debug logging switch above. */}
          {bypassCopy && (
            <SettingsSwitchCard
              id="assistant-skip-permissions"
              title={bypassCopy.title}
              subtitle={bypassCopy.subtitle}
              isEnabled={settings.bypassPermissions}
              onChange={toggleBypassPermissions}
              ariaLabel={bypassCopy.ariaLabel}
              colorScheme="amber"
              disabled={settingsUnavailable}
              isModified={settings.bypassPermissions !== DEFAULT_SETTINGS.bypassPermissions}
              onReset={() =>
                void persist({ bypassPermissions: DEFAULT_SETTINGS.bypassPermissions })
              }
            />
          )}
          {bypassCopy && settings.bypassPermissions && (
            <div className="flex items-start gap-2 py-2.5 pl-4 pr-4">
              <AlertTriangle
                className="w-4 h-4 text-status-warning shrink-0 mt-px"
                aria-hidden="true"
              />
              <div className="text-xs text-text-secondary select-text">{bypassCopy.warning}</div>
            </div>
          )}

          {/* The inventory comes last so opening it never pushes the bypass switch away
              from the tier it works with. */}
          <BlastRadiusPreview
            tier={settings.tier}
            isOpen={showBlastRadius}
            onToggle={() => setShowBlastRadius((v) => !v)}
          />
        </SettingsGroup>

        <SessionLiveStatusCard configuredTier={settings.tier} />
      </SettingsSection>

      <SettingsSection
        title="Privacy"
        description="Help-session activity is logged locally so you can review what the assistant did"
      >
        {saveError("privacy")}
        {privacyError && <InlineError>{privacyError}</InlineError>}
        {auditReadFailed && (
          <InlineError onRetry={() => void refreshAuditRecords()}>
            Couldn&apos;t read the audit log, so the diagnostics below may be incomplete.
          </InlineError>
        )}
        <SettingsGroup>
          <SettingsSwitchCard
            title="Capture audit log"
            subtitle={
              auditEnabled ? "Recording every dispatch" : "New dispatches will not be recorded"
            }
            isEnabled={auditEnabled}
            onChange={handleAuditEnabledToggle}
            ariaLabel="Capture audit log"
            // Gate on auditLoading too: until getAuditConfig resolves, auditEnabled
            // is still the optimistic default and a late fulfillment would clobber
            // a user toggle made in that window.
            disabled={loading || auditLoading || isTogglingAudit}
          />
          <SettingsPresetGroup
            id="assistant-audit-retention"
            label="Audit log retention"
            description="How long audit records stay on this machine. Turn-outcome diagnostics are kept separately."
            options={RETENTION_OPTIONS}
            value={String(settings.auditRetention)}
            onChange={setRetention}
            disabled={settingsUnavailable}
            isModified={settings.auditRetention !== DEFAULT_SETTINGS.auditRetention}
            onReset={() => setRetention(String(DEFAULT_SETTINGS.auditRetention))}
          />
          <div>
            <button
              type="button"
              onClick={() => setAdvancedDiagnosticsOpen((v) => !v)}
              aria-expanded={advancedDiagnosticsOpen}
              className={cn(
                "w-full flex items-center gap-2 px-4 py-3 text-sm font-medium",
                "text-text-primary transition-colors"
              )}
            >
              <ChevronRight
                data-animated-chevron
                className={cn(
                  "w-3.5 h-3.5 text-text-secondary transition-transform duration-150",
                  advancedDiagnosticsOpen ? "rotate-90" : "rotate-0"
                )}
                aria-hidden="true"
              />
              Advanced diagnostics
            </button>
            {advancedDiagnosticsOpen && (
              <div className="flex flex-col gap-4 px-4 pb-4">
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
                <TurnOutcomeDiagnostics
                  auditRecords={auditRecords}
                  records={turnRecords}
                  onRefresh={refreshAuditRecords}
                />
                {auditStats && auditStats.auth401Count > 0 && (
                  <p className="text-xs text-text-secondary select-text">
                    <span className="font-mono text-text-primary">{auditStats.auth401Count}</span>{" "}
                    bearer rejection{auditStats.auth401Count === 1 ? "" : "s"} since last launch —
                    an external client is connecting with a stale or missing API key.
                  </p>
                )}
              </div>
            )}
          </div>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Launch options"
        description="Changes apply to new assistant sessions."
      >
        {saveError("launch")}
        <SettingsGroup>
          <SettingsInput
            label="Custom CLI args"
            description="Whitespace-separated flags appended to the launch command"
            type="text"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="e.g. --verbose"
            className="font-mono"
            value={displayedCustomArgs}
            onChange={handleCustomArgsChange}
            disabled={settingsUnavailable}
          />
          <SettingsSelect
            label="Hibernate after"
            description="How long the panel stays hidden before the assistant shuts down. Reopening resumes the same conversation."
            value={String(settings.idleHibernateMinutes)}
            onValueChange={setHibernateMinutes}
            options={HIBERNATE_OPTIONS}
            disabled={settingsUnavailable}
            isModified={settings.idleHibernateMinutes !== DEFAULT_SETTINGS.idleHibernateMinutes}
            onReset={() => setHibernateMinutes(String(DEFAULT_SETTINGS.idleHibernateMinutes))}
          />
          {preferredAgentId === "daintree-assistant" && (
            <SettingsSwitchCard
              title="Debug logging"
              subtitle="Write a full-fidelity per-session trace to ~/.daintree/logs"
              isEnabled={settings.debugLogging}
              onChange={toggleDebugLogging}
              ariaLabel="Enable Daintree Assistant debug logging"
              disabled={settingsUnavailable}
              isModified={settings.debugLogging !== DEFAULT_SETTINGS.debugLogging}
              onReset={() => void persist({ debugLogging: DEFAULT_SETTINGS.debugLogging })}
            />
          )}
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Custom commands and skills">
        <SettingsGroup>
          <SettingsRow
            label="Assistant folder"
            description={
              <>
                Files in <code className="font-mono">~/.daintree/assistant</code> are copied into
                each new session, where Claude Code, Codex and Copilot pick up their commands and
                skills. A project&apos;s own <code className="font-mono">.daintree/assistant</code>{" "}
                takes precedence and can be committed.
              </>
            }
            control={
              <Button variant="outline" size="sm" onClick={handleOpenCommandsFolder}>
                <FolderOpen />
                Open folder
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="assistant-mcp-status"
        title="External clients"
        description="Share the assistant's local MCP server with other clients, such as Claude Code or Cursor"
      >
        {connectionError && <InlineError>{connectionError}</InlineError>}
        {loading ? (
          showInlineLoading ? (
            <p className="text-xs text-text-secondary">Loading…</p>
          ) : null
        ) : mcpState !== "ready" ? (
          <SettingsGroup>
            {settings.daintreeControl ? (
              <SettingsRow
                label="MCP server"
                description="Available once the MCP server is running. Its status is under Behavior."
              />
            ) : (
              mcpStatusRow
            )}
          </SettingsGroup>
        ) : !mcpStatus ? (
          <SettingsGroup>
            <SettingsRow label="MCP server" description="Couldn't load MCP status." />
          </SettingsGroup>
        ) : (
          <SettingsGroup>
            <SettingsRow
              label="Client config"
              description={`Paste into an external MCP client to connect it to port ${runtimeSnapshot.port ?? mcpStatus.port ?? "—"}`}
              control={
                <Button variant="outline" size="sm" onClick={handleCopyConfig}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy MCP config"}
                </Button>
              }
            />
            <SettingsRow
              label="API key"
              description={
                apiKeySuffix
                  ? `Ends in ${apiKeySuffix}. Rotating it disconnects every client using the old key.`
                  : "Rotating the key disconnects every client using the old one."
              }
              control={
                <Button
                  variant="ghost-danger"
                  size="sm"
                  onClick={() => setShowRotateConfirm(true)}
                  disabled={!apiKeySuffix}
                  title={apiKeySuffix ? undefined : "Waiting for the MCP key to load…"}
                >
                  <RefreshCw />
                  Rotate MCP key
                </Button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsSection>

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

/** A status sentence with its mark: the colour sits on the dot, never on the words. */
function StatusLine({ tone, children }: { tone: "ok" | "idle" | "error"; children: ReactNode }) {
  return (
    <span className="flex items-start gap-2">
      {tone === "error" ? (
        <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0 text-status-error" aria-hidden="true" />
      ) : (
        <span
          className={cn(
            "status-mark mt-1 w-2 h-2 rounded-full shrink-0",
            tone === "ok" ? "bg-activity-working" : "bg-text-secondary"
          )}
          aria-hidden="true"
        />
      )}
      <span>{children}</span>
    </span>
  );
}

function InlineError({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-1.5 text-xs text-text-primary select-text">
      <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0 text-status-error" aria-hidden="true" />
      <span className="min-w-0 flex-1">{children}</span>
      {onRetry && (
        <Button variant="ghost" size="xs" onClick={onRetry} className="-my-1 shrink-0">
          Retry
        </Button>
      )}
    </div>
  );
}

/** A notice about the chosen agent, directly under the group that chooses it. */
function AgentNotice({
  testId,
  title,
  body,
  action,
}: {
  testId: string;
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-3 rounded-[var(--radius-md)] border border-border-default bg-overlay-subtle px-3 py-2.5"
    >
      <AlertTriangle className="w-4 h-4 text-status-warning shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-xs select-text">
        <p className="font-medium text-text-primary">{title}</p>
        <p className="mt-0.5 text-text-secondary">{body}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

interface BlastRadiusPreviewProps {
  tier: HelpAssistantTier;
  isOpen: boolean;
  onToggle: () => void;
}

const HIGH_BLAST_RADIUS_GROUP = "high blast radius";

function BlastRadiusPreview({ tier, isOpen, onToggle }: BlastRadiusPreviewProps) {
  const totalCount = HELP_TIER_CUMULATIVE[tier].length;
  const newAtTier = HELP_TIER_INCREMENTAL[tier].length;
  const groups = useMemo(() => {
    const cumulative = HELP_TIER_CUMULATIVE[tier];
    // Pin the load-bearing dangerous actions at the top of whichever tier is
    // being previewed, so they can't be missed in a long alphabetical list.
    // Intersected with this tier rather than pinned only on `system` (#12116):
    // the preview's job is to show what selecting THIS tier grants, so a tool
    // has to be called out at the tier that first reaches it.
    const pinnedList = HIGH_BLAST_RADIUS_TOOLS.filter((tool) => cumulative.includes(tool));
    if (pinnedList.length === 0) return groupToolsByNamespace(cumulative);
    const pinned = new Set(pinnedList);
    const rest = cumulative.filter((tool) => !pinned.has(tool));
    return [
      [HIGH_BLAST_RADIUS_GROUP, pinnedList] as [string, string[]],
      ...groupToolsByNamespace(rest),
    ];
  }, [tier]);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cn(
          "w-full flex items-center justify-between gap-3 px-4 py-2.5 text-xs",
          "text-text-secondary hover:text-text-primary transition-colors"
        )}
      >
        <span className="flex items-center gap-2">
          <ChevronRight
            data-animated-chevron
            className={cn(
              "w-3.5 h-3.5 transition-transform duration-150",
              isOpen ? "rotate-90" : "rotate-0"
            )}
            aria-hidden="true"
          />
          <span>
            What this tier allows · {totalCount} actions
            {tier !== "workbench" && <span> ({newAtTier} new at this tier)</span>}
          </span>
        </span>
      </button>
      {isOpen && (
        <div className="px-4 pb-3 pt-1 space-y-2">
          <p className="text-xs text-text-secondary select-text">{TIER_DETAILS[tier]}</p>
          {groups.map(([ns, tools]) => (
            <div key={ns} className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-secondary font-mono">
                {ns === HIGH_BLAST_RADIUS_GROUP && (
                  <AlertTriangle className="w-3 h-3 text-status-warning" aria-hidden="true" />
                )}
                {ns}
                <span className="ml-1 text-text-placeholder">({tools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {tools.map((tool) => (
                  <span
                    key={tool}
                    className={cn(
                      "px-1.5 py-0.5 rounded-[var(--radius-sm)] text-3xs font-mono",
                      "bg-surface-canvas border border-border-default text-text-secondary"
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
    <span role="timer" className="font-mono text-text-secondary tabular-nums shrink-0">
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
    setIssueError(null);
    safeFireAndForget(
      window.electron.mcpServer
        .revokeNativeGrant({ grantId })
        .then(() => undefined)
        .catch((err: unknown) => {
          setIssueError(formatErrorMessage(err, "Couldn't revoke grant"));
          logError("DaintreeAssistant: revokeNativeGrant failed", err);
        }),
      { context: "DaintreeAssistant:revokeNativeGrant" }
    );
  }, []);

  return (
    <div className="space-y-2 pt-1">
      <div className="text-xs text-text-secondary font-mono">
        Automation grants{grants.length > 0 ? ` (${grants.length})` : ""}
      </div>
      {grants.length > 0 ? (
        <div className="space-y-1.5">
          {grants.map((grant) => (
            <div
              key={grant.grantId}
              className="rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-2 py-1.5 space-y-1"
            >
              <div className="flex items-center justify-between gap-2 text-2xs">
                <span className="font-mono text-text-secondary truncate">
                  {(grant.allowedTools ?? []).join(", ") || "no tools"}
                </span>
                <button
                  type="button"
                  onClick={() => grant.grantId && revoke(grant.grantId)}
                  className="shrink-0 text-3xs text-text-secondary hover:text-status-danger transition-colors"
                >
                  Revoke
                </button>
              </div>
              <div className="flex items-center justify-between gap-2 text-3xs text-text-secondary">
                <span className="tabular-nums">
                  {grant.remainingUses ?? 0} of {grant.maxUses ?? 0} uses left
                </span>
                <GrantCountdown expiresAt={grant.expiresAt} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-2xs text-text-secondary">No automation grants active</div>
      )}

      <div className="flex items-end gap-1.5 pt-0.5">
        <input
          type="text"
          value={toolsInput}
          onChange={(e) => setToolsInput(e.target.value)}
          placeholder="git.commit terminal.new"
          aria-label="Tools to approve"
          className="flex-1 min-w-0 rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-2 py-1 text-2xs font-mono text-text-primary placeholder:text-text-placeholder focus-visible:outline-2 focus-visible:outline-accent-primary"
        />
        <input
          type="number"
          min={1}
          max={100}
          value={usesInput}
          onChange={(e) => setUsesInput(e.target.value)}
          aria-label="Maximum uses"
          className="w-12 rounded-[var(--radius-sm)] border border-border-default bg-surface-canvas px-1.5 py-1 text-2xs tabular-nums text-text-primary focus-visible:outline-2 focus-visible:outline-accent-primary"
        />
        <button
          type="button"
          onClick={approve}
          disabled={issuing}
          className="shrink-0 rounded-[var(--radius-sm)] border border-border-default bg-overlay-subtle px-2 py-1 text-2xs text-text-secondary hover:text-text-primary disabled:opacity-50 transition-colors"
        >
          Approve grant
        </button>
      </div>
      {issueError && <InlineError>{issueError}</InlineError>}
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
  const sessionId = useHelpPanelStore((s) => selectActiveSlot(s).sessionId);
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
    <SettingsGroup>
      <SettingsRow
        label="Live session"
        accessory={
          connected ? (
            <span className="px-1.5 py-0.5 rounded-[var(--radius-sm)] text-3xs font-mono bg-surface-canvas border border-border-default text-text-secondary">
              {TIER_SHORT_LABEL[tier]}
            </span>
          ) : undefined
        }
        description={
          connected ? (
            <StatusLine tone="ok">
              Running at{" "}
              <span className="text-text-primary">{TIER_SHORT_LABEL[tier].toLowerCase()}</span>
              {tierComparisonCopy}
            </StatusLine>
          ) : (
            <StatusLine tone="idle">
              None. Open the assistant to start one; its live tier and grants show here.
            </StatusLine>
          )
        }
        layout={connected ? "stacked" : "inline"}
        control={
          connected ? (
            <div className="space-y-2">
              {perToolGrants.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs text-text-secondary font-mono">
                    Active grants ({perToolGrants.length})
                  </div>
                  <div className="space-y-1">
                    {perToolGrants.map((grant) => (
                      <div
                        key={grant.toolId}
                        className="flex items-center justify-between gap-2 text-2xs"
                      >
                        <span className="font-mono text-text-secondary truncate">
                          {grant.toolId}
                        </span>
                        <GrantCountdown expiresAt={grant.expiresAt} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="text-2xs text-text-secondary">No per-tool grants active</div>
              )}
              {sessionId && <NativeGrantsSection helpSessionId={sessionId} grants={nativeGrants} />}
            </div>
          ) : undefined
        }
      />
    </SettingsGroup>
  );
}
