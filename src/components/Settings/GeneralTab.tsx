import { useState, useEffect, useRef } from "react";
import {
  ChevronDown,
  ChevronRight,
  TreePine,
  Moon,
  CheckCircle,
  AlertCircle,
  Activity,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">About</h4>
        <div className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-12 w-12 bg-canopy-accent/20 rounded-[var(--radius-lg)] flex items-center justify-center">
              <TreePine className="w-6 h-6 text-canopy-accent" />
            </div>
            <div>
              <div className="font-semibold text-canopy-text text-lg flex items-center gap-2">
                Canopy
                <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-canopy-accent/20 text-canopy-accent">
                  Beta
                </span>
              </div>
              <div className="text-sm text-canopy-text/60">Command Center</div>
            </div>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between text-canopy-text/60">
              <span>Version</span>
              <span className="font-mono text-canopy-text">{appVersion}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">Description</h4>
        <p className="text-sm text-canopy-text/60">
          An orchestration board for AI coding agents. Start agents on worktrees, monitor their
          progress, and inject context to help them understand your codebase.
        </p>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-canopy-text">System Status</h4>
        <div className="bg-canopy-bg border border-canopy-border rounded-[var(--radius-md)] p-4 space-y-3">
          {cliCheckFailed ? (
            <div className="text-sm text-[var(--color-status-error)]/80">
              Failed to check agent status
            </div>
          ) : !cliAvailability || !agentSettings ? (
            <div className="text-sm text-canopy-text/40">Loading agent status...</div>
          ) : (
            getAgentIds().map((id) => {
              const config = getAgentConfig(id);
              const agentEntry = getAgentSettingsEntry(agentSettings, id);
              const isEnabled = agentEntry.enabled ?? true;
              const isAvailable = cliAvailability[id] ?? false;
              const name = config?.name ?? id;

              return (
                <div key={id} className="flex items-center justify-between text-sm">
                  <span className="text-canopy-text/70">{name}</span>
                  <div className="flex items-center gap-2">
                    {!isEnabled ? (
                      <span className="text-canopy-text/40 text-xs">Disabled</span>
                    ) : isAvailable ? (
                      <>
                        <CheckCircle className="w-4 h-4 text-green-400" />
                        <span className="text-green-400 text-xs">Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-4 h-4 text-amber-400" />
                        <span className="text-amber-400 text-xs">CLI not found</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {onNavigateToAgents && (
            <button
              onClick={onNavigateToAgents}
              className="text-xs text-canopy-accent hover:underline mt-2"
            >
              Configure agents →
            </button>
          )}
        </div>
      </div>

      {configError ? (
        <div className="p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklab,var(--color-status-error)_50%,transparent)] bg-[color-mix(in_oklab,var(--color-status-error)_10%,transparent)]">
          <p className="text-sm text-[var(--color-status-error)]">
            Failed to load hibernation settings: {configError}
          </p>
        </div>
      ) : hibernationConfig ? (
        <SettingsSection
          icon={Moon}
          title="Auto-Hibernation"
          description="Automatically stop terminals and servers for projects that have been inactive for a period of time. Reduces system resource usage."
          iconColor="text-canopy-accent"
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

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-canopy-text flex items-center gap-2">
          <Activity className="w-4 h-4 text-canopy-accent" />
          Display
        </h4>
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
        />
      </div>

      <div className="border border-canopy-border rounded-[var(--radius-md)]">
        <button
          type="button"
          onClick={() => setIsShortcutsOpen(!isShortcutsOpen)}
          aria-expanded={isShortcutsOpen}
          aria-controls="keyboard-shortcuts-content"
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-canopy-text/60 hover:text-canopy-text transition-colors"
        >
          {isShortcutsOpen ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          <span>Keyboard Shortcuts</span>
        </button>

        {isShortcutsOpen && (
          <div
            id="keyboard-shortcuts-content"
            className="px-3 pb-3 space-y-4 border-t border-canopy-border pt-3"
          >
            {shortcuts.map((category) => (
              <div key={category.category} className="space-y-2">
                <h5 className="text-xs font-medium text-canopy-text/60 uppercase tracking-wide">
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
      </div>
    </div>
  );
}
