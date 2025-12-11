import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight, TreePine, Moon, CheckCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { hibernationClient, cliAvailabilityClient, agentSettingsClient } from "@/clients";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { DEFAULT_AGENT_SETTINGS, getAgentSettingsEntry } from "@shared/types";
import type { HibernationConfig, CliAvailability, AgentSettings } from "@shared/types";

interface GeneralTabProps {
  appVersion: string;
  onNavigateToAgents?: () => void;
}

const KEYBOARD_SHORTCUTS = [
  {
    category: "Agents",
    shortcuts: [
      { key: "Cmd+N", description: "New terminal (select type)" },
      { key: "Cmd+Alt+C", description: "Start Claude agent" },
      { key: "Cmd+Alt+G", description: "Start Gemini agent" },
      { key: "Cmd+Alt+X", description: "Start Codex agent" },
      { key: "Cmd+Alt+N", description: "Start shell agent" },
      { key: "Cmd+Shift+I", description: "Inject context to agent" },
      { key: "Cmd+P", description: "Open terminal palette" },
      { key: "Cmd+T", description: "New terminal" },
    ],
  },
  {
    category: "Navigation",
    shortcuts: [
      { key: "Ctrl+Tab", description: "Focus next agent or terminal" },
      { key: "Ctrl+Shift+Tab", description: "Focus previous agent or terminal" },
      { key: "Ctrl+Shift+F", description: "Toggle maximize focused tile" },
    ],
  },
  {
    category: "Panels",
    shortcuts: [
      { key: "Ctrl+Shift+L", description: "Toggle logs panel" },
      { key: "Ctrl+Shift+E", description: "Toggle event inspector" },
    ],
  },
  {
    category: "Other",
    shortcuts: [
      { key: "Cmd+K Z", description: "Toggle focus mode (chord: press Cmd+K, release, then Z)" },
    ],
  },
];

const formatKey = (key: string): string => {
  const isMac = window.navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  if (isMac) {
    return key
      .replace(/Cmd\+/g, "⌘")
      .replace(/Ctrl\+/g, "⌃")
      .replace(/Shift\+/g, "⇧")
      .replace(/Alt\+/g, "⌥");
  }

  return key.replace(/Cmd\+/g, "Ctrl+");
};

const THRESHOLD_PRESETS = [
  { value: 12, label: "12h" },
  { value: 24, label: "24h" },
  { value: 48, label: "48h" },
  { value: 72, label: "72h" },
] as const;

export function GeneralTab({ appVersion, onNavigateToAgents }: GeneralTabProps) {
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);
  const [hibernationConfig, setHibernationConfig] = useState<HibernationConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [cliAvailability, setCliAvailability] = useState<CliAvailability | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings | null>(null);

  useEffect(() => {
    hibernationClient
      .getConfig()
      .then((config) => {
        setHibernationConfig(config);
        setConfigError(null);
      })
      .catch((error) => {
        console.error("Failed to load hibernation config:", error);
        setConfigError(error instanceof Error ? error.message : "Failed to load settings");
      });
  }, []);

  useEffect(() => {
    Promise.all([cliAvailabilityClient.get(), agentSettingsClient.get()])
      .then(([availability, settings]) => {
        setCliAvailability(availability);
        setAgentSettings(settings ?? DEFAULT_AGENT_SETTINGS);
      })
      .catch((error) => {
        console.error("Failed to load agent availability:", error);
      });
  }, []);
  const handleHibernationToggle = async () => {
    if (!hibernationConfig || isSaving) return;
    setIsSaving(true);
    try {
      const updated = await hibernationClient.updateConfig({
        enabled: !hibernationConfig.enabled,
      });
      setHibernationConfig(updated);
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
      const updated = await hibernationClient.updateConfig({
        inactiveThresholdHours: value,
      });
      setHibernationConfig(updated);
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
        <div className="bg-canopy-bg border border-canopy-border rounded-md p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-12 w-12 bg-canopy-accent/20 rounded-lg flex items-center justify-center">
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
        <div className="bg-canopy-bg border border-canopy-border rounded-md p-4 space-y-3">
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
        <div className="p-4 rounded-lg border border-red-500/50 bg-red-500/10">
          <p className="text-sm text-red-500">Failed to load hibernation settings: {configError}</p>
        </div>
      ) : hibernationConfig ? (
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
              <Moon className="w-4 h-4 text-purple-500" />
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
            className={cn(
              "w-full flex items-center justify-between p-4 rounded-lg border transition-all",
              hibernationConfig.enabled
                ? "bg-purple-500/10 border-purple-500 text-purple-500"
                : "border-canopy-border hover:bg-white/5 text-canopy-text/70"
            )}
          >
            <div className="flex items-center gap-3">
              <Moon
                className={cn(
                  "w-5 h-5",
                  hibernationConfig.enabled ? "text-purple-500" : "text-canopy-text/50"
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
                hibernationConfig.enabled ? "bg-purple-500" : "bg-canopy-border"
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
                      "px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                      hibernationConfig.inactiveThresholdHours === value
                        ? "bg-purple-500/10 border border-purple-500 text-purple-500"
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

      <div className="border border-canopy-border rounded-md">
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
            {KEYBOARD_SHORTCUTS.map((category) => (
              <div key={category.category} className="space-y-2">
                <h5 className="text-xs font-medium text-canopy-text/60 uppercase tracking-wide">
                  {category.category}
                </h5>
                <dl className="space-y-1">
                  {category.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.key}
                      className="flex items-center justify-between text-sm py-1"
                    >
                      <dt className="text-canopy-text">{shortcut.description}</dt>
                      <dd>
                        <kbd className="px-2 py-1 bg-canopy-bg border border-canopy-border rounded text-xs font-mono text-canopy-text">
                          {formatKey(shortcut.key)}
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
