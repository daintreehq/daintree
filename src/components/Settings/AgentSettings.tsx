import { useEffect, useMemo, useState, useCallback } from "react";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { useAgentSettingsStore, useCliAvailabilityStore, useAgentPreferencesStore } from "@/store";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
} from "@shared/types";
import { isAgentPinned } from "../../../shared/utils/agentPinned";
import { RotateCcw, ExternalLink } from "lucide-react";
import { DaintreeAgentIcon } from "@/components/icons";
import { AgentSelectorDropdown } from "./AgentSelectorDropdown";
import { SettingsSwitchCard } from "./SettingsSwitchCard";
import { SettingsSelect } from "./SettingsSelect";
import { actionService } from "@/services/ActionService";
import { AgentHelpOutput } from "./AgentHelpOutput";
import { AgentCard, AgentInstallSection } from "@/components/agents/AgentCard";
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
    setAgentPinned,
    reset,
  } = useAgentSettingsStore();

  const cliAvailability = useCliAvailabilityStore((state) => state.availability);
  const isCliLoading = useCliAvailabilityStore((state) => state.isLoading);
  const isRefreshingCli = useCliAvailabilityStore((state) => state.isRefreshing);
  const cliError = useCliAvailabilityStore((state) => state.error);
  const initializeCliAvailability = useCliAvailabilityStore((state) => state.initialize);
  const refreshCliAvailability = useCliAvailabilityStore((state) => state.refresh);

  const [loadTimedOut, setLoadTimedOut] = useState(false);

  useEffect(() => {
    initialize();
    const timer = setTimeout(() => setLoadTimedOut(true), 10_000);
    return () => clearTimeout(timer);
  }, [initialize]);

  useEffect(() => {
    void initializeCliAvailability();
  }, [initializeCliAvailability]);

  const handleRefreshCliAvailability = useCallback(async () => {
    if (isRefreshingCli) return;
    try {
      // Explicit user gesture — bypass the 30s throttle that exists for
      // passive triggers (tray-open, window focus, visibility change).
      await refreshCliAvailability(true);
    } catch (error) {
      console.error("[AgentSettings] Failed to refresh CLI availability:", error);
    }
  }, [isRefreshingCli, refreshCliAvailability]);

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
            selected: isAgentPinned(entry),
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
      <div className="text-sm text-daintree-text/60">
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
            className="text-xs px-3 py-1.5 bg-daintree-accent/10 hover:bg-daintree-accent/20 text-daintree-accent rounded transition-colors"
          >
            Reload Application
          </button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center h-32">
        <div className="text-daintree-text/60 text-sm">Loading settings...</div>
      </div>
    );
  }

  if (loadError || !settings) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-3">
        <div className="text-status-error text-sm">{loadError || "Failed to load settings"}</div>
        <button
          onClick={() => void actionService.dispatch("ui.refresh", undefined, { source: "user" })}
          className="text-xs px-3 py-1.5 bg-daintree-accent/10 hover:bg-daintree-accent/20 text-daintree-accent rounded transition-colors"
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
            <p className="text-xs text-daintree-text/50 select-text">
              Configure global agent preferences and per-agent settings
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
            }}
            className="text-daintree-text/60 hover:text-daintree-text shrink-0"
          >
            <DaintreeAgentIcon className="w-3.5 h-3.5" />
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
            className="rounded-[var(--radius-lg)] border border-daintree-border bg-surface p-4 space-y-4"
          >
            <div className="pb-3 border-b border-daintree-border">
              <h4 className="text-sm font-medium text-daintree-text">Global Agent Settings</h4>
              <p className="text-xs text-daintree-text/50 mt-0.5 select-text">
                Settings that apply across all agents
              </p>
            </div>

            <div id="agents-default-agent" className="space-y-2">
              <label className="text-sm font-medium text-daintree-text block">Default agent</label>
              <select
                value={defaultAgent ?? ""}
                onChange={(e) =>
                  setDefaultAgent(e.target.value ? (e.target.value as DefaultAgentId) : undefined)
                }
                className="w-full px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg text-daintree-text focus:border-daintree-accent focus:outline-none transition-colors"
              >
                <option value="">None (first available)</option>
                {agentOptions.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-daintree-text/40 select-text">
                Agent used for the help dock button (⌘⇧H) and automated workflows ("What's Next?",
                onboarding, project explanations). Distinct from the Portal "Default New Tab Agent"
                which controls the browser panel opened by the + button.
              </p>
            </div>
          </div>
        )}

        {/* Agent Configuration Card */}
        {!isGeneralActive && activeAgent && agentOptions.some((a) => a.id === activeAgent.id) && (
          <AgentCard
            mode="management"
            agentId={activeAgent.id}
            actions={
              <>
                {activeAgent.usageUrl && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-daintree-text/50 hover:text-daintree-text"
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
                  className="text-daintree-text/50 hover:text-daintree-text"
                  onClick={async () => {
                    await reset(activeAgent.id);
                    onSettingsChange?.();
                  }}
                >
                  <RotateCcw size={14} />
                  Reset
                </Button>
              </>
            }
          >
            {/* Pin to Toolbar Toggle */}
            <div id="agents-enable">
              <SettingsSwitchCard
                variant="compact"
                title="Pin to toolbar"
                subtitle="When pinned, this agent appears in the toolbar for quick access"
                isEnabled={isAgentPinned(activeEntry)}
                onChange={() => {
                  const current = isAgentPinned(activeEntry);
                  void (async () => {
                    await setAgentPinned(activeAgent.id, !current);
                    onSettingsChange?.();
                  })();
                }}
                ariaLabel={`Pin ${activeAgent.name} to toolbar`}
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
                  <span className="text-xs text-daintree-text/40">added to command</span>
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

            {/* Assistant Model Picker - only for agents with multiple models */}
            {(() => {
              const agentCfg = getAgentConfig(activeAgent.id);
              if (!agentCfg?.models || agentCfg.models.length <= 1) return null;
              return (
                <div id="agents-assistant-model">
                  <SettingsSelect
                    label="Assistant Model"
                    description="Model used when this agent is launched from the help panel or assistant shortcut"
                    value={(activeEntry.assistantModelId as string) ?? ""}
                    onChange={(e) => {
                      void (async () => {
                        await updateAgent(activeAgent.id, {
                          assistantModelId: e.target.value || undefined,
                        });
                        onSettingsChange?.();
                      })();
                    }}
                    isModified={!!activeEntry.assistantModelId}
                    onReset={() => {
                      void (async () => {
                        await updateAgent(activeAgent.id, { assistantModelId: undefined });
                        onSettingsChange?.();
                      })();
                    }}
                    resetAriaLabel={`Reset ${activeAgent.name} assistant model to default`}
                  >
                    <option value="">Default (fast model)</option>
                    {agentCfg.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </SettingsSelect>
                </div>
              );
            })()}

            {/* Custom Arguments */}
            <div id="agents-custom-args" className="space-y-2 pt-2 border-t border-daintree-border">
              <label className="text-sm font-medium text-daintree-text">Custom Arguments</label>
              <input
                className="w-full rounded-[var(--radius-md)] border border-border-strong bg-daintree-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-daintree-accent/50 placeholder:text-text-muted"
                value={activeEntry.customFlags ?? ""}
                onChange={(e) => updateAgent(activeAgent.id, { customFlags: e.target.value })}
                placeholder="--verbose --max-tokens=4096"
              />
              <p className="text-xs text-daintree-text/40 select-text">
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
            <AgentInstallSection
              agentId={activeAgent.id}
              agentName={activeAgent.name}
              availability={cliAvailability[activeAgent.id]}
              isCliLoading={isCliLoading}
              isRefreshingCli={isRefreshingCli}
              cliError={cliError}
              onRefresh={() => void handleRefreshCliAvailability()}
            />
          </AgentCard>
        )}
      </div>
    </div>
  );
}
