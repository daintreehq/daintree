import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { useAgentSettingsStore } from "@/store";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
} from "@shared/types";
import { RotateCcw, ExternalLink, RefreshCw, Copy, Check } from "lucide-react";
import { actionService } from "@/services/ActionService";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { cliAvailabilityClient } from "@/clients";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";

interface AgentSettingsProps {
  onSettingsChange?: () => void;
}

export function AgentSettings({ onSettingsChange }: AgentSettingsProps) {
  const {
    settings,
    isLoading,
    error: loadError,
    initialize,
    updateAgent,
    reset,
  } = useAgentSettingsStore();
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [cliAvailability, setCliAvailability] = useState<Record<string, boolean> | null>(null);
  const [isRefreshingCli, setIsRefreshingCli] = useState(false);
  const [cliCheckError, setCliCheckError] = useState<string | null>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copyTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isMountedRef = useRef(true);
  const refreshRequestIdRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const activePillRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  useEffect(() => {
    const loadCliAvailability = async () => {
      try {
        const availability = await cliAvailabilityClient.get();
        if (isMountedRef.current) {
          setCliAvailability(availability);
          setCliCheckError(null);
        }
      } catch (error) {
        console.error("[AgentSettings] Failed to load CLI availability:", error);
        if (isMountedRef.current) {
          setCliAvailability({});
          setCliCheckError("Failed to check CLI availability");
        }
      }
    };
    void loadCliAvailability();
  }, []);

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

    const requestId = ++refreshRequestIdRef.current;
    setIsRefreshingCli(true);
    setCliCheckError(null);
    try {
      const availability = await cliAvailabilityClient.refresh();
      if (isMountedRef.current && refreshRequestIdRef.current === requestId) {
        setCliAvailability(availability);
      }
    } catch (error) {
      console.error("[AgentSettings] Failed to refresh CLI availability:", error);
      if (isMountedRef.current && refreshRequestIdRef.current === requestId) {
        setCliCheckError("Re-check failed. Try again or restart the app.");
      }
    } finally {
      if (isMountedRef.current && refreshRequestIdRef.current === requestId) {
        setIsRefreshingCli(false);
      }
    }
  }, [isRefreshingCli]);

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

  const agentIds = useMemo(() => getAgentIds(), []);
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  useEffect(() => {
    if ((!activeAgentId || !agentIds.includes(activeAgentId)) && agentIds.length > 0) {
      setActiveAgentId(agentIds[0]);
    }
  }, [activeAgentId, agentIds]);

  useEffect(() => {
    if (activePillRef.current && scrollContainerRef.current) {
      activePillRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "center",
      });
    }
  }, [activeAgentId]);

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
            enabled: entry.enabled ?? true,
            dangerousEnabled: entry.dangerousEnabled ?? false,
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    [agentIds, effectiveSettings]
  );

  const activeAgent = activeAgentId
    ? agentOptions.find((a) => a.id === activeAgentId)
    : agentOptions[0];
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
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-canopy-text/60 text-sm">Loading settings...</div>
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-[var(--color-status-error)] text-sm">
          {loadError || "Failed to load settings"}
        </div>
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
        <div>
          <h3 className="text-sm font-medium mb-1">Agent Runtime Settings</h3>
          <p className="text-xs text-canopy-text/50">
            Configure CLI flags and options for each agent
          </p>
        </div>

        {/* Agent Selector - Horizontal scrolling pills */}
        <div
          ref={scrollContainerRef}
          tabIndex={0}
          className="flex gap-1.5 p-1.5 bg-canopy-bg rounded-[var(--radius-lg)] border border-canopy-border overflow-x-auto scrollbar-thin focus:outline-none focus:ring-2 focus:ring-canopy-accent/50"
        >
          {agentOptions.map((agent) => {
            if (!agent) return null;
            const Icon = agent.Icon;
            const isActive = activeAgent?.id === agent.id;
            return (
              <button
                key={agent.id}
                ref={isActive ? activePillRef : null}
                onClick={() => setActiveAgentId(agent.id)}
                className={cn(
                  "flex items-center justify-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-sm font-medium transition-all flex-shrink-0",
                  isActive
                    ? "bg-canopy-sidebar text-canopy-text shadow-sm"
                    : "text-canopy-text/60 hover:text-canopy-text hover:bg-white/5"
                )}
              >
                {Icon && (
                  <Icon
                    size={18}
                    brandColor={isActive ? agent.color : undefined}
                    className={cn(!isActive && "opacity-60")}
                  />
                )}
                <span className={cn("truncate", !agent.enabled && "opacity-50")}>{agent.name}</span>
                <div className="flex items-center gap-1 shrink-0">
                  {!agent.enabled && (
                    <span className="w-1.5 h-1.5 rounded-full bg-canopy-text/30" />
                  )}
                  {agent.dangerousEnabled && (
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-status-error)]" />
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Agent Configuration Card */}
        {activeAgent && (
          <div className="rounded-[var(--radius-lg)] border border-canopy-border bg-surface p-4 space-y-4">
            {/* Header with agent info */}
            <div className="flex items-center justify-between pb-3 border-b border-canopy-border">
              <div className="flex items-center gap-3">
                {activeAgent.Icon && <activeAgent.Icon size={24} brandColor={activeAgent.color} />}
                <div>
                  <h4 className="text-sm font-medium text-canopy-text">
                    {activeAgent.name} Settings
                  </h4>
                  <p className="text-xs text-canopy-text/50">
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

            {/* Enabled Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-canopy-text">Enabled</div>
                <div className="text-xs text-canopy-text/50">Show in agent launcher</div>
              </div>
              <button
                onClick={async () => {
                  const current = activeEntry.enabled ?? true;
                  await updateAgent(activeAgent.id, { enabled: !current });
                  onSettingsChange?.();
                }}
                className={cn(
                  "relative w-11 h-6 rounded-full transition-colors",
                  (activeEntry.enabled ?? true) ? "bg-canopy-accent" : "bg-canopy-border"
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                    (activeEntry.enabled ?? true) && "translate-x-5"
                  )}
                />
              </button>
            </div>

            {/* Dangerous Mode Toggle */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-canopy-text">Skip Permissions</div>
                  <div className="text-xs text-canopy-text/50">Auto-approve all actions</div>
                </div>
                <button
                  onClick={async () => {
                    const current = activeEntry.dangerousEnabled ?? false;
                    await updateAgent(activeAgent.id, { dangerousEnabled: !current });
                    onSettingsChange?.();
                  }}
                  className={cn(
                    "relative w-11 h-6 rounded-full transition-colors",
                    activeEntry.dangerousEnabled
                      ? "bg-[var(--color-status-error)]"
                      : "bg-canopy-border"
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                      activeEntry.dangerousEnabled && "translate-x-5"
                    )}
                  />
                </button>
              </div>

              {activeEntry.dangerousEnabled && defaultDangerousArg && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-status-error)]/10 border border-[var(--color-status-error)]/20">
                  <code className="text-xs text-[var(--color-status-error)] font-mono">
                    {defaultDangerousArg}
                  </code>
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
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-canopy-text">Inline Mode</div>
                    <div className="text-xs text-canopy-text/50">
                      Disable fullscreen TUI for better resize handling and scrollback
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      await updateAgent(activeAgent.id, { inlineMode: !inlineMode });
                      onSettingsChange?.();
                    }}
                    className={cn(
                      "relative w-11 h-6 rounded-full transition-colors",
                      inlineMode ? "bg-canopy-accent" : "bg-canopy-border"
                    )}
                  >
                    <span
                      className={cn(
                        "absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform",
                        inlineMode && "translate-x-5"
                      )}
                    />
                  </button>
                </div>
              );
            })()}

            {/* Custom Arguments */}
            <div className="space-y-2 pt-2 border-t border-canopy-border">
              <label className="text-sm font-medium text-canopy-text">Custom Arguments</label>
              <input
                className="w-full rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 placeholder:text-canopy-text/30"
                value={activeEntry.customFlags ?? ""}
                onChange={(e) => updateAgent(activeAgent.id, { customFlags: e.target.value })}
                placeholder="--verbose --max-tokens=4096"
              />
              <p className="text-xs text-canopy-text/40">Extra CLI flags appended when launching</p>
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
              const isCliAvailable = cliAvailability?.[activeAgent.id];
              const isLoading = cliAvailability === null;
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
                <div className="space-y-3 pt-4 border-t border-canopy-border">
                  <div className="flex items-center justify-between">
                    <div>
                      <h5 className="text-sm font-medium text-canopy-text">Installation</h5>
                      <p className="text-xs text-canopy-text/50">
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

                  {cliCheckError && (
                    <div className="px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-status-error)]/10 border border-[var(--color-status-error)]/20">
                      <p className="text-xs text-[var(--color-status-error)]">{cliCheckError}</p>
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
                                          className="shrink-0 p-1 hover:bg-white/5 rounded transition-colors"
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
                          <div className="px-3 py-2 rounded-[var(--radius-md)] bg-[var(--color-status-warning)]/10 border border-[var(--color-status-warning)]/20">
                            <div className="text-xs font-medium text-[var(--color-status-warning)] mb-1">
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
                        <p className="text-xs text-canopy-text/40">
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
