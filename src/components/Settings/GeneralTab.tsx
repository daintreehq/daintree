import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Moon,
  CheckCircle,
  Wrench,
  LayoutGrid,
  PanelBottom,
  Keyboard,
  Info,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DaintreeIcon, ProjectPulseIcon } from "@/components/icons";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { SettingsSubtabBar } from "./SettingsSubtabBar";
import type { SettingsSubtabItem } from "./SettingsSubtabBar";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { DEFAULT_AGENT_SETTINGS, getAgentSettingsEntry } from "@shared/types";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import type {
  HibernationConfig,
  IdleTerminalNotifyConfig,
  CliAvailability,
  AgentSettings,
} from "@shared/types";
import { isAgentInstalled, isAgentReady } from "../../../shared/utils/agentAvailability";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { usePreferencesStore } from "@/store";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";

const GENERAL_SUBTABS: SettingsSubtabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "hibernation", label: "Hibernation" },
  { id: "display", label: "Display" },
];

interface GeneralTabProps {
  appVersion: string;
  onNavigateToAgents?: (agentId?: string) => void;
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
}

const CURATED_SHORTCUTS = [
  {
    category: "Agents",
    actionIds: [
      "panel.palette",
      ...BUILT_IN_AGENT_IDS.map((id) => `agent.${id}`),
      "agent.terminal",
      "terminal.inject",
    ],
  },
  {
    category: "Terminal",
    actionIds: [
      "nav.quickSwitcher",
      "terminal.new",
      "terminal.focusNext",
      "terminal.focusPrevious",
    ],
  },
  {
    category: "Panels",
    actionIds: ["panel.diagnosticsLogs", "panel.diagnosticsEvents"],
  },
];

const THRESHOLD_PRESETS = [
  { value: 12, label: "12h" },
  { value: 24, label: "24h" },
  { value: 48, label: "48h" },
  { value: 72, label: "72h" },
] as const;

const IDLE_TERMINAL_THRESHOLD_PRESETS = [
  { value: 30, label: "30m" },
  { value: 60, label: "1h" },
  { value: 120, label: "2h" },
  { value: 240, label: "4h" },
] as const;

interface ShortcutDisplay {
  actionId: string;
  key: string;
  description: string;
}

interface ShortcutCategory {
  category: string;
  shortcuts: ShortcutDisplay[];
}

export function GeneralTab({
  appVersion,
  onNavigateToAgents,
  activeSubtab,
  onSubtabChange,
}: GeneralTabProps) {
  const effectiveSubtab =
    activeSubtab && GENERAL_SUBTABS.some((t) => t.id === activeSubtab) ? activeSubtab : "overview";

  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [hibernationConfig, setHibernationConfig] = useState<HibernationConfig | null>(null);
  const [idleNotifyConfig, setIdleNotifyConfig] = useState<IdleTerminalNotifyConfig | null>(null);
  const [isIdleNotifySaving, setIsIdleNotifySaving] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [cliAvailability, setCliAvailability] = useState<CliAvailability | null>(null);
  const [cliCheckFailed, setCliCheckFailed] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutCategory[]>([]);
  const [updateChannel, setUpdateChannel] = useState<"stable" | "nightly" | null>(null);
  const [channelSaving, setChannelSaving] = useState(false);
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const showProjectPulse = usePreferencesStore((s) => s.showProjectPulse);
  const showDeveloperTools = usePreferencesStore((s) => s.showDeveloperTools);
  const showGridAgentHighlights = usePreferencesStore((s) => s.showGridAgentHighlights);
  const showDockAgentHighlights = usePreferencesStore((s) => s.showDockAgentHighlights);

  useEffect(() => {
    let cancelled = false;
    window.electron.update
      .getChannel()
      .then((ch) => {
        if (!cancelled) setUpdateChannel(ch);
      })
      .catch(() => {
        if (!cancelled) setUpdateChannel("stable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChannelChange = async (channel: "stable" | "nightly") => {
    if (channelSaving || channel === updateChannel) return;
    setChannelSaving(true);
    try {
      const result = await window.electron.update.setChannel(channel);
      if (isMountedRef.current) setUpdateChannel(result);
    } catch (error) {
      console.error("Failed to set update channel:", error);
    } finally {
      if (isMountedRef.current) setChannelSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setConfigError("Settings load timed out");
      }
    }, 10_000);

    actionService
      .dispatch("hibernation.getConfig", undefined, { source: "user" })
      .then((result) => {
        clearTimeout(timer);
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setHibernationConfig(result.result as HibernationConfig);
        setConfigError(null);
      })
      .catch((error) => {
        clearTimeout(timer);
        if (cancelled) return;
        console.error("Failed to load hibernation config:", error);
        setConfigError(error instanceof Error ? error.message : "Failed to load settings");
      });

    actionService
      .dispatch("idleTerminalNotify.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load idle terminal notify config:", error);
      });

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const STATUS_TIMEOUT_MS = 15_000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Agent status check timed out")),
        STATUS_TIMEOUT_MS
      );
    });

    Promise.race([
      Promise.all([
        actionService.dispatch("cliAvailability.get", undefined, { source: "user" }),
        actionService.dispatch("agentSettings.get", undefined, { source: "user" }),
      ]),
      timeout,
    ])
      .then(([availabilityResult, settingsResult]) => {
        if (cancelled) return;
        if (!availabilityResult.ok) {
          throw new Error(availabilityResult.error.message);
        }
        if (!settingsResult.ok) {
          throw new Error(settingsResult.error.message);
        }
        setCliAvailability(availabilityResult.result as CliAvailability);
        setCliCheckFailed(false);
        setAgentSettings((settingsResult.result as AgentSettings) ?? DEFAULT_AGENT_SETTINGS);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[GeneralTab] Failed to load agent availability:", error);
        setCliCheckFailed(true);
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const loadShortcuts = () => {
      const categories: ShortcutCategory[] = CURATED_SHORTCUTS.map((category) => {
        const shortcuts: ShortcutDisplay[] = category.actionIds
          .map((actionId) => {
            const binding = keybindingService.getBinding(actionId);
            const effectiveCombo = keybindingService.getEffectiveCombo(actionId);

            if (!binding || !effectiveCombo) {
              return null;
            }

            return {
              actionId,
              key: keybindingService.formatComboForDisplay(effectiveCombo),
              description: binding.description || actionId,
            };
          })
          .filter((s): s is ShortcutDisplay => s !== null);

        return {
          category: category.category,
          shortcuts,
        };
      }).filter((c) => c.shortcuts.length > 0);

      if (isMounted) {
        setShortcuts(categories);
      }
    };

    const unsubscribe = keybindingService.subscribe(loadShortcuts);

    keybindingService.loadOverrides().then(() => {
      if (isMounted) {
        loadShortcuts();
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);
  const handleHibernationToggle = async () => {
    if (!hibernationConfig || isSaving) return;
    setIsSaving(true);
    try {
      const result = await actionService.dispatch(
        "hibernation.updateConfig",
        { enabled: !hibernationConfig.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error("Failed to update hibernation config:", error);
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  const handleIdleNotifyToggle = async () => {
    if (!idleNotifyConfig || isIdleNotifySaving) return;
    setIsIdleNotifySaving(true);
    try {
      const result = await actionService.dispatch(
        "idleTerminalNotify.updateConfig",
        { enabled: !idleNotifyConfig.enabled },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error("Failed to update idle terminal notify config:", error);
    } finally {
      if (isMountedRef.current) {
        setIsIdleNotifySaving(false);
      }
    }
  };

  const handleIdleNotifyThresholdChange = async (value: number) => {
    if (!idleNotifyConfig || isIdleNotifySaving) return;
    setIsIdleNotifySaving(true);
    try {
      const result = await actionService.dispatch(
        "idleTerminalNotify.updateConfig",
        { thresholdMinutes: value },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setIdleNotifyConfig(result.result as IdleTerminalNotifyConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error("Failed to update idle terminal notify threshold:", error);
    } finally {
      if (isMountedRef.current) {
        setIsIdleNotifySaving(false);
      }
    }
  };

  const handleThresholdChange = async (value: number) => {
    if (!hibernationConfig || isSaving) return;
    setIsSaving(true);
    try {
      const result = await actionService.dispatch(
        "hibernation.updateConfig",
        { inactiveThresholdHours: value },
        { source: "user" }
      );
      if (!isMountedRef.current) return;
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error("Failed to update hibernation threshold:", error);
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSubtabBar
        subtabs={GENERAL_SUBTABS}
        activeId={effectiveSubtab}
        onChange={onSubtabChange}
      />

      {effectiveSubtab === "overview" && (
        <>
          <div
            id="general-about"
            className="settings-card flex items-start gap-4 p-4 rounded-[var(--radius-md)] border border-daintree-border"
          >
            <div
              className="h-12 w-12 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: "#151616" }}
            >
              <DaintreeIcon size={28} className="shrink-0" style={{ color: "#36CE94" }} />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-daintree-text">Daintree</span>
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-daintree-accent/15 text-daintree-accent leading-none">
                  Beta
                </span>
                <span className="text-xs text-text-muted font-mono ml-auto">v{appVersion}</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                An orchestration board for AI coding agents. Start agents on worktrees, monitor
                progress, and inject context.
              </p>
              <button
                onClick={() =>
                  void actionService.dispatch(
                    "system.openExternal",
                    { url: "https://daintree.org" },
                    { source: "user" }
                  )
                }
                className="flex items-center gap-1.5 text-xs text-text-muted hover:text-daintree-accent transition-colors pt-1"
              >
                <ExternalLink className="w-3 h-3" />
                daintree.org
              </button>
            </div>
          </div>

          <SettingsSection
            icon={Info}
            title="System Status"
            description="Agents ready to use on your system."
            id="general-system-status"
          >
            {cliCheckFailed ? (
              <div className="text-sm text-status-error/80">Failed to check agent status</div>
            ) : !cliAvailability || !agentSettings ? (
              <div className="text-sm text-text-muted">Loading agent status...</div>
            ) : (
              (() => {
                const allAgentIds = getAgentIds();
                const installedAgentIds = allAgentIds.filter(
                  (id) =>
                    isAgentInstalled(cliAvailability[id]) &&
                    isAgentPinned(getAgentSettingsEntry(agentSettings, id))
                );
                const hiddenCount = allAgentIds.length - installedAgentIds.length;

                if (installedAgentIds.length === 0) {
                  return (
                    <div className="space-y-2">
                      <p className="text-sm text-text-muted">No agents installed yet.</p>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          className="text-xs text-daintree-accent hover:underline"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent("daintree:open-agent-setup-wizard")
                            )
                          }
                        >
                          Run setup wizard
                        </button>
                        {onNavigateToAgents && (
                          <button
                            type="button"
                            className="text-xs text-daintree-accent hover:underline"
                            onClick={() => onNavigateToAgents?.()}
                          >
                            Browse available agents
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="space-y-2">
                    {installedAgentIds.map((id) => {
                      const config = getAgentConfig(id);
                      const name = config?.name ?? id;
                      const ready = isAgentReady(cliAvailability[id]);

                      return (
                        <button
                          type="button"
                          key={id}
                          className="settings-list-item border-daintree-border hover:bg-[var(--settings-nav-hover-bg,var(--theme-overlay-hover))] flex items-center justify-between text-sm px-3 py-2 rounded-[var(--radius-md)] border w-full text-left cursor-pointer transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2"
                          aria-label={`Go to ${name} agent settings`}
                          onClick={() => onNavigateToAgents?.(id)}
                        >
                          <span className="text-text-secondary">{name}</span>
                          <span className="flex items-center gap-2">
                            <CheckCircle
                              className={cn(
                                "w-3.5 h-3.5",
                                ready ? "text-status-success" : "text-status-warning"
                              )}
                            />
                            <span
                              className={cn(
                                "text-xs",
                                ready ? "text-status-success" : "text-status-warning"
                              )}
                            >
                              {ready ? "Ready" : "Needs setup"}
                            </span>
                          </span>
                        </button>
                      );
                    })}

                    {hiddenCount > 0 && onNavigateToAgents && (
                      <button
                        type="button"
                        onClick={() => onNavigateToAgents?.()}
                        className="text-xs text-daintree-accent hover:underline"
                      >
                        {`Daintree supports ${hiddenCount} more ${hiddenCount === 1 ? "agent" : "agents"} →`}
                      </button>
                    )}
                  </div>
                );
              })()
            )}
          </SettingsSection>

          <SettingsSection
            icon={RefreshCw}
            title="Update Channel"
            description="Choose between stable releases and nightly builds."
            id="general-update-channel"
          >
            <div className="flex gap-2">
              {(["stable", "nightly"] as const).map((ch) => (
                <button
                  key={ch}
                  disabled={channelSaving || updateChannel === null}
                  onClick={() => void handleChannelChange(ch)}
                  className={cn(
                    "px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors capitalize",
                    updateChannel === ch
                      ? "bg-daintree-accent/10 border border-daintree-accent text-daintree-accent"
                      : "border border-daintree-border hover:bg-tint/5 text-daintree-text/70"
                  )}
                >
                  {ch}
                </button>
              ))}
            </div>
            {updateChannel === "nightly" && (
              <p className="text-xs text-status-warning/80">
                Nightly builds may contain unstable features. You can switch back to stable at any
                time.
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            icon={Keyboard}
            title="Quick Reference"
            description="Common keyboard shortcuts. Edit all shortcuts in the Keyboard settings tab."
          >
            <button
              type="button"
              onClick={() => setIsShortcutsOpen(!isShortcutsOpen)}
              aria-expanded={isShortcutsOpen}
              aria-controls="keyboard-shortcuts-content"
              className="flex items-center gap-2 text-sm text-daintree-text/60 hover:text-daintree-text transition-colors"
            >
              {isShortcutsOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>{isShortcutsOpen ? "Hide shortcuts" : "Show shortcuts"}</span>
            </button>

            {isShortcutsOpen && (
              <div id="keyboard-shortcuts-content" className="space-y-4">
                {shortcuts.map((category) => (
                  <div key={category.category} className="space-y-2">
                    <h5 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                      {category.category}
                    </h5>
                    <dl className="space-y-1">
                      {category.shortcuts.map((shortcut) => (
                        <div
                          key={shortcut.actionId}
                          className="flex items-center justify-between text-sm py-1"
                        >
                          <dt className="text-daintree-text">{shortcut.description}</dt>
                          <dd>
                            <kbd className="settings-kbd px-2 py-1 rounded border text-xs font-mono text-daintree-text">
                              {shortcut.key}
                            </kbd>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}

      {effectiveSubtab === "hibernation" && (
        <>
          {idleNotifyConfig && (
            <SettingsSection
              icon={Moon}
              title="Idle Terminal Notifications"
              description="Get a friendly reminder when terminals in background projects have been idle for a while. Doesn't kill anything — just lets you decide."
              id="general-idle-terminal-notify"
            >
              <SettingsSwitchCard
                icon={Moon}
                title={
                  idleNotifyConfig.enabled
                    ? "Idle Notifications Enabled"
                    : "Enable Idle Notifications"
                }
                subtitle={
                  idleNotifyConfig.enabled
                    ? `After ${idleNotifyConfig.thresholdMinutes} min of terminal inactivity`
                    : "Notify me about idle terminals in background projects"
                }
                isEnabled={idleNotifyConfig.enabled}
                onChange={handleIdleNotifyToggle}
                ariaLabel="Idle Terminal Notifications Toggle"
                disabled={isIdleNotifySaving}
              />

              {idleNotifyConfig.enabled && (
                <div id="general-idle-terminal-threshold" className="space-y-2">
                  <label className="text-sm text-daintree-text/70">Idle Threshold</label>
                  <div className="flex gap-2">
                    {IDLE_TERMINAL_THRESHOLD_PRESETS.map(({ value, label }) => (
                      <button
                        key={value}
                        disabled={isIdleNotifySaving}
                        onClick={() => handleIdleNotifyThresholdChange(value)}
                        className={cn(
                          "px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                          idleNotifyConfig.thresholdMinutes === value
                            ? "bg-daintree-accent/10 border border-daintree-accent text-daintree-accent"
                            : "border border-daintree-border hover:bg-tint/5 text-daintree-text/70"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-daintree-text/40">
                    A toast appears when background project terminals have been quiet this long,
                    with options to close them or dismiss the reminder.
                  </p>
                </div>
              )}
            </SettingsSection>
          )}
          {configError ? (
            <div className="p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklab,var(--color-status-error)_50%,transparent)] bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)]">
              <p className="text-sm text-status-error">
                Failed to load hibernation settings: {configError}
              </p>
            </div>
          ) : hibernationConfig ? (
            <SettingsSection
              icon={Moon}
              title="Auto-Hibernation"
              description="Automatically stop terminals and servers for projects that have been inactive for a period of time. Reduces system resource usage."
              id="general-hibernation"
            >
              <SettingsSwitchCard
                icon={Moon}
                title={
                  hibernationConfig.enabled ? "Auto-Hibernation Enabled" : "Enable Auto-Hibernation"
                }
                subtitle={
                  hibernationConfig.enabled
                    ? `After ${hibernationConfig.inactiveThresholdHours}h of inactivity`
                    : "Save resources by hibernating idle projects"
                }
                isEnabled={hibernationConfig.enabled}
                onChange={handleHibernationToggle}
                ariaLabel="Auto-Hibernation Toggle"
                disabled={isSaving}
              />

              {hibernationConfig.enabled && (
                <div id="general-hibernation-threshold" className="space-y-2">
                  <label className="text-sm text-daintree-text/70">Inactivity Threshold</label>
                  <div className="flex gap-2">
                    {THRESHOLD_PRESETS.map(({ value, label }) => (
                      <button
                        key={value}
                        disabled={isSaving}
                        onClick={() => handleThresholdChange(value)}
                        className={cn(
                          "px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-colors",
                          hibernationConfig.inactiveThresholdHours === value
                            ? "bg-daintree-accent/10 border border-daintree-accent text-daintree-accent"
                            : "border border-daintree-border hover:bg-tint/5 text-daintree-text/70"
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-daintree-text/40">
                    Projects idle longer than this will have their processes stopped automatically.
                  </p>
                </div>
              )}
            </SettingsSection>
          ) : (
            <div className="text-sm text-daintree-text/40">Loading hibernation settings...</div>
          )}
        </>
      )}

      {effectiveSubtab === "display" && (
        <SettingsSection
          icon={ProjectPulseIcon}
          title="Display"
          description="Control which interface elements are visible."
          id="general-project-pulse"
        >
          <SettingsSwitchCard
            icon={ProjectPulseIcon}
            title="Project Pulse"
            subtitle="Show activity heatmap on the empty panel grid"
            isEnabled={showProjectPulse}
            onChange={() =>
              void actionService.dispatch(
                "preferences.showProjectPulse.set",
                { show: !showProjectPulse },
                { source: "user" }
              )
            }
            ariaLabel="Project Pulse Toggle"
            isModified={!showProjectPulse}
            onReset={() =>
              void actionService.dispatch(
                "preferences.showProjectPulse.set",
                { show: true },
                { source: "user" }
              )
            }
          />

          <div id="general-developer-tools">
            <SettingsSwitchCard
              icon={Wrench}
              title="Developer Tools"
              subtitle="Show problems panel button in the toolbar"
              isEnabled={showDeveloperTools}
              onChange={() =>
                void actionService.dispatch(
                  "preferences.showDeveloperTools.set",
                  { show: !showDeveloperTools },
                  { source: "user" }
                )
              }
              ariaLabel="Developer Tools Toggle"
              isModified={showDeveloperTools}
              onReset={() =>
                void actionService.dispatch(
                  "preferences.showDeveloperTools.set",
                  { show: false },
                  { source: "user" }
                )
              }
            />
          </div>

          <div id="general-grid-agent-highlights">
            <SettingsSwitchCard
              icon={LayoutGrid}
              title="Grid Panel Agent Highlights"
              subtitle="Show waiting and working state borders on grid panels. Failed state borders are always visible."
              isEnabled={showGridAgentHighlights}
              onChange={() =>
                void actionService.dispatch(
                  "preferences.showGridAgentHighlights.set",
                  { show: !showGridAgentHighlights },
                  { source: "user" }
                )
              }
              ariaLabel="Grid Panel Agent Highlights Toggle"
              isModified={showGridAgentHighlights}
              onReset={() =>
                void actionService.dispatch(
                  "preferences.showGridAgentHighlights.set",
                  { show: false },
                  { source: "user" }
                )
              }
            />
          </div>

          <div id="general-dock-agent-highlights">
            <SettingsSwitchCard
              icon={PanelBottom}
              title="Dock Item Agent Highlights"
              subtitle="Show waiting state borders on dock items. Failed state borders are always visible."
              isEnabled={showDockAgentHighlights}
              onChange={() =>
                void actionService.dispatch(
                  "preferences.showDockAgentHighlights.set",
                  { show: !showDockAgentHighlights },
                  { source: "user" }
                )
              }
              ariaLabel="Dock Item Agent Highlights Toggle"
              isModified={showDockAgentHighlights}
              onReset={() =>
                void actionService.dispatch(
                  "preferences.showDockAgentHighlights.set",
                  { show: false },
                  { source: "user" }
                )
              }
            />
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
