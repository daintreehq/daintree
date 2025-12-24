import { useState, useEffect } from "react";
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
      "terminal.spawnPalette",
      "agent.claude",
      "agent.gemini",
      "agent.codex",
      "agent.terminal",
      "terminal.inject",
    ],
  },
  {
    category: "Terminal",
    actionIds: ["terminal.palette", "terminal.new", "terminal.focusNext", "terminal.focusPrevious"],
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
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutCategory[]>([]);

  const showProjectPulse = usePreferencesStore((s) => s.showProjectPulse);
  const showDeveloperTools = usePreferencesStore((s) => s.showDeveloperTools);

  useEffect(() => {
    actionService
      .dispatch("hibernation.getConfig", undefined, { source: "user" })
      .then((result) => {
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        setHibernationConfig(result.result as HibernationConfig);
        setConfigError(null);
      })
      .catch((error) => {
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
        if (!availabilityResult.ok) {
          throw new Error(availabilityResult.error.message);
        }
        if (!settingsResult.ok) {
          throw new Error(settingsResult.error.message);
        }
        setCliAvailability(availabilityResult.result as CliAvailability);
        setAgentSettings((settingsResult.result as AgentSettings) ?? DEFAULT_AGENT_SETTINGS);
      })
      .catch((error) => {
        console.error("Failed to load agent availability:", error);
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
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      console.error("Failed to update hibernation config:", error);
    } finally {
      setIsSaving(false);
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
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      setHibernationConfig(result.result as HibernationConfig);
    } catch (error) {
      console.error("Failed to update hibernation threshold:", error);
    } finally {
      setIsSaving(false);
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
          {!cliAvailability || !agentSettings ? (
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
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
              <Moon className="w-4 h-4 text-canopy-accent" />
              Auto-Hibernation
            </h4>
            <p className="text-xs text-canopy-text/50 mb-4">
              Automatically stop terminals and servers for projects that have been inactive for a
              period of time. Reduces system resource usage.
            </p>
          </div>

          <button
            onClick={handleHibernationToggle}
            disabled={isSaving}
            role="switch"
            aria-checked={hibernationConfig.enabled}
            aria-label="Auto-Hibernation Toggle"
            className={cn(
              "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
              hibernationConfig.enabled
                ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
                : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
            )}
          >
            <div className="flex items-center gap-3">
              <Moon
                className={cn(
                  "w-5 h-5",
                  hibernationConfig.enabled ? "text-canopy-accent" : "text-canopy-text/50"
                )}
              />
              <div className="text-left">
                <div className="text-sm font-medium">
                  {hibernationConfig.enabled
                    ? "Auto-Hibernation Enabled"
                    : "Enable Auto-Hibernation"}
                </div>
                <div className="text-xs opacity-70">
                  {hibernationConfig.enabled
                    ? `After ${hibernationConfig.inactiveThresholdHours}h of inactivity`
                    : "Save resources by hibernating idle projects"}
                </div>
              </div>
            </div>
            <div
              className={cn(
                "w-11 h-6 rounded-full relative transition-colors",
                hibernationConfig.enabled ? "bg-canopy-accent" : "bg-canopy-border"
              )}
            >
              <div
                className={cn(
                  "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                  hibernationConfig.enabled ? "translate-x-6" : "translate-x-1"
                )}
              />
            </div>
          </button>

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
        </div>
      ) : null}

      <div className="space-y-3">
        <h4 className="text-sm font-medium text-canopy-text flex items-center gap-2">
          <Activity className="w-4 h-4 text-canopy-accent" />
          Display
        </h4>
        <button
          onClick={() =>
            void actionService.dispatch(
              "preferences.showProjectPulse.set",
              { show: !showProjectPulse },
              { source: "user" }
            )
          }
          role="switch"
          aria-checked={showProjectPulse}
          aria-label="Project Pulse Toggle"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            showProjectPulse
              ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
              : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
          )}
        >
          <div className="flex items-center gap-3">
            <Activity
              className={cn(
                "w-5 h-5",
                showProjectPulse ? "text-canopy-accent" : "text-canopy-text/50"
              )}
            />
            <div className="text-left">
              <div className="text-sm font-medium">Project Pulse</div>
              <div className="text-xs opacity-70">
                Show activity heatmap on the empty terminal grid
              </div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              showProjectPulse ? "bg-canopy-accent" : "bg-canopy-border"
            )}
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                showProjectPulse ? "translate-x-6" : "translate-x-1"
              )}
            />
          </div>
        </button>

        <button
          onClick={() =>
            void actionService.dispatch(
              "preferences.showDeveloperTools.set",
              { show: !showDeveloperTools },
              { source: "user" }
            )
          }
          role="switch"
          aria-checked={showDeveloperTools}
          aria-label="Developer Tools Toggle"
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
            showDeveloperTools
              ? "bg-canopy-accent/10 border-canopy-accent text-canopy-accent"
              : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
          )}
        >
          <div className="flex items-center gap-3">
            <Wrench
              className={cn(
                "w-5 h-5",
                showDeveloperTools ? "text-canopy-accent" : "text-canopy-text/50"
              )}
            />
            <div className="text-left">
              <div className="text-sm font-medium">Developer Tools</div>
              <div className="text-xs opacity-70">Show problems panel button in the toolbar</div>
            </div>
          </div>
          <div
            className={cn(
              "w-11 h-6 rounded-full relative transition-colors",
              showDeveloperTools ? "bg-canopy-accent" : "bg-canopy-border"
            )}
          >
            <div
              className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
                showDeveloperTools ? "translate-x-6" : "translate-x-1"
              )}
            />
          </div>
        </button>
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
