import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getAgentIds, getAgentConfig } from "@/config/agents";
import { useAgentSettingsStore } from "@/store";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_AGENT_SETTINGS,
  getAgentSettingsEntry,
  DEFAULT_DANGEROUS_ARGS,
} from "@shared/types";
import { FixedDropdown } from "@/components/ui/fixed-dropdown";
import { ChevronDown, RotateCcw } from "lucide-react";

interface AgentSettingsProps {
  onSettingsChange?: () => void;
}

export function AgentSettings({ onSettingsChange }: AgentSettingsProps) {
  const { settings, isLoading, error: loadError, initialize, updateAgent, reset } =
    useAgentSettingsStore();
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    initialize();
  }, [initialize]);

  const agentIds = getAgentIds();
  const effectiveSettings = settings ?? DEFAULT_AGENT_SETTINGS;

  useEffect(() => {
    if (!activeAgentId && agentIds.length > 0) {
      setActiveAgentId(agentIds[0]);
    }
  }, [activeAgentId, agentIds]);

  const agentOptions = useMemo(
    () =>
      agentIds
        .map((id) => {
          const config = getAgentConfig(id);
          if (!config) return null;
          const entry = getAgentSettingsEntry(effectiveSettings, id);
          const Icon = config.icon ? config.icon : null;
          return {
            id,
            name: config.name,
            color: config.color,
            Icon,
            enabled: entry.enabled ?? true,
            dangerousEnabled: entry.dangerousEnabled ?? false,
            hasCustomFlags: Boolean(entry.customFlags?.trim()),
          };
        })
        .filter(Boolean),
    [agentIds, effectiveSettings]
  );

  const activeAgent = activeAgentId
    ? agentOptions.find((a) => a?.id === activeAgentId)
    : agentOptions[0];
  const activeEntry = activeAgent
    ? getAgentSettingsEntry(effectiveSettings, activeAgent.id)
    : { customFlags: "", dangerousArgs: "", dangerousEnabled: false };

  const defaultDangerousArg = activeAgent
    ? DEFAULT_DANGEROUS_ARGS[activeAgent.id] ?? ""
    : "";

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
          onClick={() => window.location.reload()}
          className="text-xs px-3 py-1.5 bg-canopy-accent/10 hover:bg-canopy-accent/20 text-canopy-accent rounded transition-colors"
        >
          Reload Application
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Agent Selector Dropdown */}
      <div className="relative">
        <button
          ref={selectorRef as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => setSelectorOpen((o) => !o)}
          className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-canopy-border bg-canopy-bg-secondary hover:border-canopy-text/20 transition-colors"
        >
          {activeAgent ? (
            <div className="flex items-center gap-3 min-w-0">
              {activeAgent.Icon && (
                <activeAgent.Icon size={22} brandColor={activeAgent.color} />
              )}
              <span className="text-sm font-medium text-canopy-text">
                {activeAgent.name}
              </span>
              {!activeAgent.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-canopy-border text-canopy-text/60">
                  Disabled
                </span>
              )}
              {activeAgent.dangerousEnabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-status-error)]/20 text-[var(--color-status-error)]">
                  Dangerous
                </span>
              )}
            </div>
          ) : (
            <span className="text-sm text-canopy-text/60">Select an agent</span>
          )}
          <ChevronDown
            size={16}
            className={cn(
              "text-canopy-text/50 transition-transform",
              selectorOpen && "rotate-180"
            )}
          />
        </button>

        <FixedDropdown
          open={selectorOpen}
          onOpenChange={setSelectorOpen}
          anchorRef={selectorRef}
          className="min-w-[280px]"
        >
          <div className="py-1">
            {agentOptions.map((agent) => {
              if (!agent) return null;
              const Icon = agent.Icon;
              return (
                <button
                  key={agent.id}
                  onClick={() => {
                    setActiveAgentId(agent.id);
                    setSelectorOpen(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/5 transition-colors",
                    activeAgent?.id === agent.id && "bg-canopy-accent/10"
                  )}
                >
                  {Icon && <Icon size={20} brandColor={agent.color} />}
                  <span className="text-sm font-medium text-canopy-text flex-1">
                    {agent.name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {!agent.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-canopy-border text-canopy-text/60">
                        Off
                      </span>
                    )}
                    {agent.dangerousEnabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-status-error)]/20 text-[var(--color-status-error)]">
                        ⚠
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </FixedDropdown>
      </div>

      {/* Agent Configuration Panel */}
      {activeAgent && (
        <div className="space-y-4">
          {/* Enabled Toggle */}
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium text-canopy-text">
                Enable {activeAgent.name}
              </div>
              <div className="text-xs text-canopy-text/60">
                Show this agent in the launcher
              </div>
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

          <div className="border-t border-canopy-border" />

          {/* Dangerous Mode Toggle */}
          <div className="space-y-3">
            <div className="flex items-center justify-between py-1">
              <div>
                <div className="text-sm font-medium text-canopy-text">
                  Skip Permissions
                </div>
                <div className="text-xs text-canopy-text/60">
                  Run without confirmation prompts
                </div>
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
              <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-[var(--color-status-error)]/10 border border-[var(--color-status-error)]/20">
                <code className="text-xs text-[var(--color-status-error)] font-mono">
                  {defaultDangerousArg}
                </code>
                <span className="text-xs text-canopy-text/50">
                  will be added automatically
                </span>
              </div>
            )}
          </div>

          <div className="border-t border-canopy-border" />

          {/* Custom Arguments */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-canopy-text">
              Custom Arguments
            </label>
            <input
              className="w-full rounded-md border border-canopy-border bg-canopy-bg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 placeholder:text-canopy-text/40"
              value={activeEntry.customFlags ?? ""}
              onChange={(e) => updateAgent(activeAgent.id, { customFlags: e.target.value })}
              placeholder="--verbose --max-tokens=4096"
            />
            <p className="text-xs text-canopy-text/50">
              Additional CLI flags passed to {activeAgent.name.toLowerCase()}
            </p>
          </div>

          {/* Reset Button */}
          <div className="pt-2">
            <Button
              size="sm"
              variant="ghost"
              className="text-canopy-text/60 hover:text-canopy-text"
              onClick={async () => {
                await reset(activeAgent.id);
                onSettingsChange?.();
              }}
            >
              <RotateCcw size={14} className="mr-1.5" />
              Reset to defaults
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
