import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import {
  useAgentSettingsStore,
  useCliAvailabilityStore,
  migrateAgentSelection,
  useAgentPreferencesStore,
} from "@/store";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
} from "@shared/types";
import { RotateCcw, ExternalLink, RefreshCw, Copy, Check } from "lucide-react";
import { CanopyAgentIcon } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";
import type { DefaultAgentId } from "@/store/agentPreferencesStore";

const GENERAL_SUBTAB_ID = "general";

interface AgentSettingsProps {
  activeSubtab: string | null;
  onSubtabChange: (id: string) => void;
  onSettingsChange?: () => void;
}

export function AgentSettings({
  activeSubtab,
  onSubtabChange,
  onSettingsChange,
}: AgentSettingsProps) {
  const {
    settings,
    isLoading,
    error: loadError,
    initialize,
    updateAgent,
    setAgentSelected,
    reset,
  } = useAgentSettingsStore();

  const cliAvailability = useCliAvailabilityStore((state) => state.availability);
  const isCliLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isCliInitialized = useCliAvailabilityStore((state) => state.isInitialized);
  const isRefreshingCli = useCliAvailabilityStore((state) => state.isRefreshing);
  const cliError = useCliAvailabilityStore((state) => state.error);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);

  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    initialize();
    const timer = setTimeout(() => setLoadTimedOut(true), 10_000);
    return () => clearTimeout(timer);
  }, [initialize]);

  useEffect(() => {
    void initializeCliAvailability();
  }, [initializeCliAvailability]);

  // Migrate selection state for agents that don't have `selected` set yet.
  // Gate on CLI availability being fully initialized (not just not-loading) to avoid
  // persisting incorrect `false` defaults when the CLI check errored or is still pending.
  useEffect(() => {
    if (!settings || !isCliInitialized || isCliLoading) return;
    void migrateAgentSelection(cliAvailability);
  }, [settings, isCliInitialized, isCliLoading, cliAvailability]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleRefreshCliAvailability = useCallback(async () => {
    if (isRefreshingCli) return;
    try {
      await refreshCliAvailability();
    } catch (error) {
      console.error("[AgentSettings] Failed to refresh CLI availability:", error);
    }
  }, [isRefreshingCli, refreshCliAvailability]);

  const handleCopyCommand = useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      if (!isMountedRef.current) return;

      setCopiedCommand(command);

      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }

      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setCopiedCommand(null);
        }
        copyTimeoutRef.current = null;
      }, 2000);
    } catch (error) {
      console.error("Failed to copy command:", error);
    }
  }, []);

  const defaultAgent = useAgentPreferencesStore((state) => state.defaultAgent);
  const setDefaultAgent = useAgentPreferencesStore((state) => state.setDefaultAgent);

  const agentIds = useMemo(() => getAgentIds(), []);
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  // Derive active subtab: "general" or one of the agent ids.
  // Unknown subtab ids (not "general", not an agent) fall back to General to avoid blank screens.
  const isGeneralActive =
    activeSubtab === GENERAL_SUBTAB_ID || activeSubtab === null || !agentIds.includes(activeSubtab);
  const activeAgentId = isGeneralActive ? null : activeSubtab;

  const agentOptions = useMemo(
    () =>
      agentIds
        .map((id) => {
          const config = getAgentConfig(id);
          if (!config) return null;
          const entry = getAgentSettingsEntry(effectiveSettings, id);
          return {
            id,
            name: config.name,
            color: config.color,
            Icon: config.icon,
            usageUrl: config.usageUrl,
            selected: entry.selected !== false,
            dangerousEnabled: entry.dangerousEnabled ?? false,
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    [agentIds, effectiveSettings]
  );

  const activeAgent = activeAgentId ? agentOptions.find((a) => a.id === activeAgentId) : null;
  const activeEntry = activeAgent
    ? getAgentSettingsEntry(effectiveSettings, activeAgent.id)
    : { customFlags: "", dangerousArgs: "", dangerousEnabled: false };

  const defaultDangerousArg = activeAgent ? (DEFAULT_DANGEROUS_ARGS[activeAgent.id] ?? "") : "";

  if (agentOptions.length === 0) {
    return (
      <div className="text-sm text-canopy-text/60">
        No agents registered. Add agents to the registry to configure them here.
      </div>
    );
  }

  if (isLoading && !settings) {
    if (loadTimedOut) {
      return (
        <div className="flex flex-col items-center justify-center h-32 gap-3">
          <div className="text-status-error text-sm">Settings load timed out</div>
          <button
            onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
            className="text-xs px-3 py-1.5 bg-canopy-accent/10 hover:bg-canopy-accent/20 text-canopy-accent rounded transition-colors"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-canopy-text/60 text-sm">Loading settings...</div>
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-status-error text-sm">{loadError || "Failed to load settings"}</div>
        <button
          onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
          className="text-xs px-3 py-1.5 bg-canopy-accent/10 hover:bg-canopy-accent/20 text-canopy-accent rounded transition-colors"
        >
          Reload Application
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium mb-1">CLI Agents</h4>
            <p className="text-xs text-canopy-text/50 select-text">
              Configure global agent preferences and per-agent settings
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("canopy:open-agent-setup-wizard"));
            }}
            className="text-canopy-text/60 hover:text-canopy-text shrink-0"
          >
            <CanopyAgentIcon className="w-3.5 h-3.5" />
            Run Setup Wizard
          </Button>
        </div>

        <AgentSelectorDropdown
          agentOptions={agentOptions}
          activeSubtab={isGeneralActive ? GENERAL_SUBTAB_ID : (activeAgentId ?? GENERAL_SUBTAB_ID)}
          onSubtabChange={onSubtabChange}
        />

        {/* General subtab content */}
        {isGeneralActive && (
          <div
            id="agents-general"
            className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4"
          >
            <div className="pb-3 border-b border-canopy-border">
              <h4 className="text-sm font-medium text-canopy-text">Global Agent Settings</h4>
              <p className="text-xs text-canopy-text/50 mt-0.5 select-text">
                Settings that apply across all agents
              </p>
            </div>

            <div id="agents-default-agent" className="space-y-2">
              <label className="text-sm font-medium text-canopy-text block">Default agent</label>
              <select
                value={defaultAgent ?? ""}
                onChange={(e) =>
                  setDefaultAgent(e.target.value ? (e.target.value as DefaultAgentId) : undefined)
                }
                className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg text-canopy-text focus:border-canopy-accent focus:outline-none transition-colors"
              >
                <option value="">None (first available)</option>
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-canopy-text/40 select-text">
                Agent used for automated workflows ("What's Next?", onboarding, project
                explanations). Distinct from the Portal "Default New Tab Agent" which controls the
                browser panel opened by the + button.
              </p>
            </div>
          </div>
        )}

        {/* Agent Configuration Card */}
        {!isGeneralActive && activeAgent && agentOptions.some((a) => a.id === activeAgent.id) && (
          <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4">
            {/* Header with agent info */}
            <div className="flex items-center justify-between pb-3 border-b border-canopy-border">
              <div className="flex items-center gap-3">
                {activeAgent.Icon && <activeAgent.Icon size={24} brandColor={activeAgent.color} />}
                <div>
                  <h4 className="text-sm font-medium text-canopy-text">
                    {activeAgent.name} Settings
                  </h4>
                  <p className="text-xs text-canopy-text/50 select-text">
                    Configure how {activeAgent.name.toLowerCase()} runs in terminals
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeAgent.usageUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-canopy-text/50 hover:text-canopy-text"
                    onClick={async () => {
                      const url = activeAgent.usageUrl?.trim();
                      if (!url) return;
                      try {
                        const result = await actionService.dispatch(
                          "system.openExternal",
                          { url },
                          { source: "user" }
                        );
                        if (!result.ok) {
                          throw new Error(result.error.message);
                        }
                      } catch (error) {
                        console.error("Failed to open usage URL:", error);
                      }
                    }}
                  >
                    <ExternalLink size={14} />
                    View Usage
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-canopy-text/50 hover:text-canopy-text"
                  onClick={async () => {
                    await reset(activeAgent.id);
                    onSettingsChange?.();
                  }}
                >
                  <RotateCcw size={14} />
                  Reset
                </Button>
              </div>
            </div>

            {/* Enable Agent Toggle */}
            <div id="agents-enable">
              <SettingsSwitchCard
                variant="compact"
                title="Enable agent"
                subtitle="When disabled, this agent is hidden everywhere and treated as if it is not installed"
                isEnabled={activeEntry.selected !== false}
                onChange={() => {
                  const current = activeEntry.selected !== false;
                  void (async () => {
                    await setAgentSelected(activeAgent.id, !current);
                    onSettingsChange?.();
                  })();
                }}
                ariaLabel={`Enable ${activeAgent.name}`}
              />
            </div>

            {/* Dangerous Mode Toggle */}
            <div id="agents-skip-permissions" className="space-y-2">
              <SettingsSwitchCard
                variant="compact"
                title="Skip Permissions"
                subtitle="Auto-approve all actions"
                isEnabled={activeEntry.dangerousEnabled ?? false}
                onChange={() => {
                  const current = activeEntry.dangerousEnabled ?? false;
                  void (async () => {
                    await updateAgent(activeAgent.id, { dangerousEnabled: !current });
                    onSettingsChange?.();
                  })();
                }}
                ariaLabel={`Skip permissions for ${activeAgent.name}`}
                colorScheme="danger"
              />

              {activeEntry.dangerousEnabled && defaultDangerousArg && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                  <code className="text-xs text-status-error font-mono">{defaultDangerousArg}</code>
                  <span className="text-xs text-canopy-text/40">added to command</span>
                </div>
              )}
            </div>

            {/* Inline Mode Toggle - only for agents that support it */}
            {(() => {
              const agentCfg = getAgentConfig(activeAgent.id);
              const inlineModeFlag = agentCfg?.capabilities?.inlineModeFlag;
              if (!inlineModeFlag) return null;
              const inlineMode = activeEntry.inlineMode ?? true;
              return (
                <div id="agents-inline-mode">
                  <SettingsSwitchCard
                    variant="compact"
                    title="Inline Mode"
                    subtitle="Disable fullscreen TUI for better resize handling and scrollback"
                    isEnabled={inlineMode}
                    onChange={() => {
                      void (async () => {
                        await updateAgent(activeAgent.id, { inlineMode: !inlineMode });
                        onSettingsChange?.();
                      })();
                    }}
                    ariaLabel={`Inline mode for ${activeAgent.name}`}
                  />
                </div>
              );
            })()}

            {/* Share Clipboard Directory Toggle - Gemini only */}
            {activeAgent.id === "gemini" && (
              <div id="agents-clipboard">
                <SettingsSwitchCard
                  variant="compact"
                  title="Share Clipboard Directory"
                  subtitle="Allow Gemini to read pasted clipboard images via --include-directories"
                  isEnabled={activeEntry.shareClipboardDirectory !== false}
                  onChange={() => {
                    const current = activeEntry.shareClipboardDirectory !== false;
                    void (async () => {
                      await updateAgent(activeAgent.id, { shareClipboardDirectory: !current });
                      onSettingsChange?.();
                    })();
                  }}
                  ariaLabel="Share clipboard directory with Gemini"
                />
              </div>
            )}

            {/* Custom Arguments */}
            <div id="agents-custom-args" className="space-y-2 pt-2 border-t border-canopy-border">
              <label className="text-sm font-medium text-canopy-text">Custom Arguments</label>
              <input
                className="w-full rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 placeholder:text-text-muted"
                value={activeEntry.customFlags ?? ""}
                onChange={(e) => updateAgent(activeAgent.id, { customFlags: e.target.value })}
                placeholder="--verbose --max-tokens=4096"
              />
              <p className="text-xs text-canopy-text/40 select-text">
                Extra CLI flags appended when launching
              </p>
            </div>

            {/* Help Output */}
            <AgentHelpOutput
              agentId={activeAgent.id}
              agentName={activeAgent.name}
              usageUrl={activeAgent.usageUrl}
            />

            {/* Installation Section */}
            {(() => {
              const agentConfig = getAgentConfig(activeAgent.id);
              const isCliAvailable = cliAvailability[activeAgent.id];
              const isLoading = isCliLoading;
              const installBlocks = agentConfig ? getInstallBlocksForCurrentOS(agentConfig) : null;
              const hasInstallConfig = agentConfig?.install;

              if (isCliAvailable === true) {
                return null;
              }

              if (isLoading) {
                return (
                  <div className="pt-4 border-t border-canopy-border">
                    <div className="text-xs text-canopy-text/40">Checking CLI availability...</div>
                  </div>
                );
              }

              return (
                <div
                  id="agents-installation"
                  className="space-y-3 pt-4 border-t border-canopy-border"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <h5 className="text-sm font-medium text-canopy-text">Installation</h5>
                      <p className="text-xs text-canopy-text/50 select-text">
                        {activeAgent.name} CLI not found
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleRefreshCliAvailability()}
                      disabled={isRefreshingCli}
                      className="text-canopy-text/50 hover:text-canopy-text"
                    >
                      <RefreshCw
                        size={14}
                        className={cn("mr-1.5", isRefreshingCli && "animate-spin")}
                      />
                      Re-check
                    </Button>
                  </div>

                  {cliError && (
                    <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-error/10 border border-status-error/20">
                      <p className="text-xs text-status-error">
                        Re-check failed. Try again or restart the app.
                      </p>
                    </div>
                  )}

                  {installBlocks && installBlocks.length > 0 ? (
                    <div className="space-y-3">
                      {installBlocks.map((block, blockIndex) => (
                        <div
                          key={blockIndex}
                          className="rounded-[var(--radius-md)] border border-canopy-border bg-surface p-3 space-y-2"
                        >
                          {block.label && (
                            <div className="text-xs font-medium text-canopy-text/70">
                              {block.label}
                            </div>
                          )}

                          {block.steps && block.steps.length > 0 && (
                            <ul className="space-y-1 text-xs text-canopy-text/60">
                              {block.steps.map((step, stepIndex) => (
                                <li key={stepIndex} className="flex gap-2">
                                  <span className="text-canopy-text/40">{stepIndex + 1}.</span>
                                  <span>{step}</span>
                                </li>
                              ))}
                            </ul>
                          )}

                          {block.commands && block.commands.length > 0 && (
                            <div className="space-y-1.5">
                              {block.commands.map((command, cmdIndex) => (
                                <div
                                  key={cmdIndex}
                                  className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-canopy-bg border border-canopy-border"
                                >
                                  <code className="flex-1 text-xs font-mono text-canopy-text">
                                    {command}
                                  </code>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <button
                                          onClick={() => void handleCopyCommand(command)}
                                          className="shrink-0 p-1 hover:bg-tint/5 rounded transition-colors"
                                          aria-label="Copy command"
                                        >
                                          {copiedCommand === command ? (
                                            <Check size={14} className="text-canopy-accent" />
                                          ) : (
                                            <Copy size={14} className="text-canopy-text/40" />
                                          )}
                                        </button>
                                      </TooltipTrigger>
                                      <TooltipContent side="bottom">Copy command</TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                              ))}
                            </div>
                          )}

                          {block.notes && block.notes.length > 0 && (
                            <div className="space-y-1 text-xs text-canopy-text/40">
                              {block.notes.map((note, noteIndex) => (
                                <p key={noteIndex}>{note}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}

                      {agentConfig?.install?.troubleshooting &&
                        agentConfig.install.troubleshooting.length > 0 && (
                          <div className="px-3 py-2 rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20">
                            <div className="text-xs font-medium text-status-warning mb-1">
                              Troubleshooting
                            </div>
                            <ul className="space-y-0.5 text-xs text-canopy-text/60">
                              {agentConfig.install.troubleshooting.map((tip, tipIndex) => (
                                <li key={tipIndex}>• {tip}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                      <div className="px-3 py-2 rounded-[var(--radius-md)] bg-canopy-bg/50 border border-canopy-border/50">
                        <p className="text-xs text-canopy-text/40 select-text">
                          ⚠️ Review commands before running them in your terminal
                        </p>
                      </div>
                    </div>
                  ) : hasInstallConfig?.docsUrl ? (
                    <div className="px-4 py-6 rounded-[var(--radius-md)] border border-canopy-border bg-surface text-center">
                      <p className="text-xs text-canopy-text/60 mb-3">
                        No OS-specific install instructions available
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          const url = agentConfig?.install?.docsUrl;
                          if (url) {
                            void window.electron.system.openExternal(url);
                          }
                        }}
                        className="text-canopy-accent hover:text-canopy-accent/80"
                      >
                        <ExternalLink size={14} />
                        Open Install Docs
                      </Button>
                    </div>
                  ) : (
                    <div className="px-4 py-6 rounded-[var(--radius-md)] border border-canopy-border bg-surface text-center">
                      <p className="text-xs text-canopy-text/60">
                        No installation instructions configured for this agent
                      </p>
                    </div>
                  )}

                  {hasInstallConfig?.docsUrl && installBlocks && installBlocks.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const url = agentConfig?.install?.docsUrl;
                        if (url) {
                          void window.electron.system.openExternal(url);
                        }
                      }}
                      className="w-full text-canopy-text/50 hover:text-canopy-text"
                    >
                      <ExternalLink size={14} />
                      View Official Documentation
                    </Button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
