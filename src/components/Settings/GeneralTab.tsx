import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  Moon,
  CheckCircle,
  AlertCircle,
  Activity,
  Wrench,
  Keyboard,
  Info,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsSwitchCard } from "@/components/Settings/SettingsSwitchCard";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { DEFAULT_AGENT_SETTINGS, getAgentSettingsEntry } from "@shared/types";
import type { HibernationConfig, CliAvailability, AgentSettings } from "@shared/types";
import { usePreferencesStore } from "@/store";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";

interface GeneralTabProps {
  appVersion: string;
  onNavigateToAgents?: () => void;
}

const CURATED_SHORTCUTS = [
  {
    category: "Agents",
    actionIds: [
      "panel.palette",
      "agent.claude",
      "agent.gemini",
      "agent.codex",
      "agent.opencode",
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

interface ShortcutDisplay {
  actionId: string;
  key: string;
  description: string;
}

interface ShortcutCategory {
  category: string;
  shortcuts: ShortcutDisplay[];
}

export function GeneralTab({ appVersion, onNavigateToAgents }: GeneralTabProps) {
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [hibernationConfig, setHibernationConfig] = useState<HibernationConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [cliAvailability, setCliAvailability] = useState<CliAvailability | null>(null);
  const [cliCheckFailed, setCliCheckFailed] = useState(false);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutCategory[]>([]);
  const isMountedRef = useRef(true);

  const showProjectPulse = usePreferencesStore((s) => s.showProjectPulse);
  const showDeveloperTools = usePreferencesStore((s) => s.showDeveloperTools);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    actionService
      .dispatch("hibernation.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (!isMountedRef.current) return;
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setHibernationConfig(result.result as HibernationConfig);
        setConfigError(null);
      })
      .catch((error) => {
        if (!isMountedRef.current) return;
        console.error("Failed to load hibernation config:", error);
        setConfigError(error instanceof Error ? error.message : "Failed to load settings");
      });
  }, []);

  useEffect(() => {
    Promise.all([
      actionService.dispatch("cliAvailability.get", undefined, { source: "user" }),
      actionService.dispatch("agentSettings.get", undefined, { source: "user" }),
    ])
      .then(([availabilityResult, settingsResult]) => {
        if (!isMountedRef.current) return;
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
        if (!isMountedRef.current) return;
        console.error("[GeneralTab] Failed to load agent availability:", error);
        setCliCheckFailed(true);
      });
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
      <div
        id="general-about"
        className="flex items-start gap-4 p-4 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/50"
      >
        <div className="h-12 w-12 bg-canopy-accent/10 rounded-xl flex items-center justify-center shrink-0">
          <CanopyIcon size={28} className="text-canopy-accent" />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-canopy-text">Canopy</span>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/15 text-canopy-accent leading-none">
              Beta
            </span>
            <span className="text-xs text-canopy-text/40 font-mono ml-auto">v{appVersion}</span>
          </div>
          <p className="text-xs text-canopy-text/50 leading-relaxed">
            An orchestration board for AI coding agents. Start agents on worktrees, monitor
            progress, and inject context.
          </p>
          <button
            onClick={() =>
              void actionService.dispatch(
                "system.openExternal",
                { url: "https://github.com/canopyide/canopy" },
                { source: "user" }
              )
            }
            className="flex items-center gap-1.5 text-xs text-canopy-text/40 hover:text-canopy-accent transition-colors pt-1"
          >
            <ExternalLink className="w-3 h-3" />
            github.com/canopyide/canopy
          </button>
        </div>
      </div>

      <SettingsSection
        icon={Info}
        title="System Status"
        description="Agent CLI availability. Agents must be installed and accessible in your PATH."
        id="general-system-status"
      >
        {cliCheckFailed ? (
          <div className="text-sm text-status-error/80">Failed to check agent status</div>
        ) : !cliAvailability || !agentSettings ? (
          <div className="text-sm text-canopy-text/40">Loading agent status...</div>
        ) : (
          <div className="space-y-2">
            {getAgentIds().map((id) => {
              const config = getAgentConfig(id);
              const agentEntry = getAgentSettingsEntry(agentSettings, id);
              const isSelected = agentEntry.selected !== false;
              const isAvailable = cliAvailability[id] ?? false;
              const name = config?.name ?? id;

              return (
                <div
                  key={id}
                  className="flex items-center justify-between text-sm px-3 py-2 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30"
                >
                  <span className="text-canopy-text/70">{name}</span>
                  <div className="flex items-center gap-2">
                    {!isSelected ? (
                      <span className="text-canopy-text/40 text-xs">Disabled</span>
                    ) : isAvailable ? (
                      <>
                        <CheckCircle className="w-3.5 h-3.5 text-status-success" />
                        <span className="text-status-success text-xs">Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-3.5 h-3.5 text-status-warning" />
                        <span className="text-status-warning text-xs">CLI not found</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {onNavigateToAgents && (
              <button
                onClick={onNavigateToAgents}
                className="text-xs text-canopy-accent hover:underline"
              >
                Configure agents →
              </button>
            )}
          </div>
        )}
      </SettingsSection>

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
            <div className="space-y-2">
              <label className="text-sm text-canopy-text/70">Inactivity Threshold</label>
              <div className="flex gap-2">
                {THRESHOLD_PRESETS.map(({ value, label }) => (
                  <button
                    key={value}
                    disabled={isSaving}
                    onClick={() => handleThresholdChange(value)}
                    className={cn(
                      "px-3 py-1.5 rounded-[var(--radius-md)] text-xs font-medium transition-all",
                      hibernationConfig.inactiveThresholdHours === value
                        ? "bg-canopy-accent/10 border border-canopy-accent text-canopy-accent"
                        : "border border-canopy-border hover:bg-white/5 text-canopy-text/70"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-canopy-text/40">
                Projects idle longer than this will have their processes stopped automatically.
              </p>
            </div>
          )}
        </SettingsSection>
      ) : null}

      <SettingsSection
        icon={Activity}
        title="Display"
        description="Control which interface elements are visible."
        id="general-project-pulse"
      >
        <SettingsSwitchCard
          icon={Activity}
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
          className="flex items-center gap-2 text-sm text-canopy-text/60 hover:text-canopy-text transition-colors"
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
                <h5 className="text-xs font-medium text-canopy-text/50 uppercase tracking-wide">
                  {category.category}
                </h5>
                <dl className="space-y-1">
                  {category.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.actionId}
                      className="flex items-center justify-between text-sm py-1"
                    >
                      <dt className="text-canopy-text">{shortcut.description}</dt>
                      <dd>
                        <kbd className="px-2 py-1 bg-canopy-bg border border-canopy-border rounded text-xs font-mono text-canopy-text">
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
    </div>
  );
}
