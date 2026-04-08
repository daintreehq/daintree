import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDashed, Loader2, ExternalLink } from "lucide-react";
import { AGENT_REGISTRY, getAgentConfig } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { getInstallBlocksForCurrentOS, getInstallCommand } from "@/lib/agentInstall";
import { terminalClient } from "@/clients";
import { systemClient } from "@/clients";
import { EmbeddedTerminal } from "./EmbeddedTerminal";
import type { CliAvailability } from "@shared/types";

const AGENT_ORDER = BUILT_IN_AGENT_IDS;

const AGENT_DESCRIPTIONS: Record<string, string> = {
  claude: "Deep refactoring, architecture, and complex reasoning",
  gemini: "Quick exploration and broad knowledge lookup",
  codex: "Careful, methodical runs with sandboxed execution",
  opencode: "Provider-agnostic, open-source flexibility",
};

interface AgentCliStepProps {
  availability: CliAvailability;
  selections: Record<string, boolean>;
}

export function AgentCliStep({ availability, selections }: AgentCliStepProps) {
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [installingAgentId, setInstallingAgentId] = useState<string | null>(null);
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<Record<string, number>>({});

  const prevAvailabilityRef = useRef(availability);
  useEffect(() => {
    if (
      installingAgentId &&
      availability[installingAgentId] === true &&
      prevAvailabilityRef.current[installingAgentId] !== true
    ) {
      setInstallingAgentId(null);
    }
    prevAvailabilityRef.current = availability;
  }, [availability, installingAgentId]);

  const handleTerminalReady = useCallback((id: string) => {
    setTerminalId(id);
  }, []);

  const handleAgentSelect = useCallback(
    (agentId: string) => {
      if (!terminalId || installingAgentId) return;

      const agent = getAgentConfig(agentId);
      if (!agent) return;

      const blocks = getInstallBlocksForCurrentOS(agent);
      if (!blocks || blocks.length === 0) return;

      const methodIdx = selectedMethodIndex[agentId] ?? 0;
      const block = blocks[methodIdx] ?? blocks[0];
      const command = getInstallCommand(block);
      if (!command) return;

      setInstallingAgentId(agentId);
      terminalClient.submit(terminalId, command);
    },
    [terminalId, installingAgentId, selectedMethodIndex]
  );

  const handleMethodChange = useCallback((agentId: string, index: number) => {
    setSelectedMethodIndex((prev) => ({ ...prev, [agentId]: index }));
  }, []);

  const selectedAgentIds = AGENT_ORDER.filter((id) => selections[id]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-canopy-text mb-1">Install agents</h3>
        <p className="text-sm text-canopy-text/60">
          Click an agent to run its install command in the terminal below.
        </p>
      </div>

      <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
        {selectedAgentIds.map((agentId) => {
          const config = AGENT_REGISTRY[agentId];
          if (!config) return null;

          const isInstalled = availability[agentId] === true;
          const isInstalling = installingAgentId === agentId;
          const isDisabled = isInstalled || !!installingAgentId || !terminalId;
          const blocks = getInstallBlocksForCurrentOS(config);
          const hasMultipleMethods = blocks && blocks.length > 1;
          const currentMethodIdx = selectedMethodIndex[agentId] ?? 0;
          const Icon = config.icon;
          const description = AGENT_DESCRIPTIONS[agentId] ?? config.tooltip ?? "";

          return (
            <div key={agentId} className="space-y-0">
              <button
                type="button"
                disabled={isDisabled}
                onClick={() => handleAgentSelect(agentId)}
                data-selected={isInstalling || undefined}
                className="flex items-center gap-3 w-full px-3 py-2 rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/30 text-left transition-colors hover:bg-canopy-bg/60 disabled:opacity-50 disabled:cursor-default data-[selected]:bg-canopy-accent/10 data-[selected]:border-canopy-accent/40"
              >
                <div
                  className="w-8 h-8 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0"
                  style={{ backgroundColor: `${config.color}15` }}
                >
                  <Icon size={18} brandColor={config.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-canopy-text">{config.name}</div>
                  {description && (
                    <div className="text-[11px] text-canopy-text/40 truncate">{description}</div>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {config.install?.docsUrl && (
                    <button
                      type="button"
                      className="text-canopy-text/30 hover:text-canopy-accent transition-colors p-0.5"
                      onClick={(e) => {
                        e.stopPropagation();
                        systemClient.openExternal(config.install!.docsUrl!);
                      }}
                      title="View documentation"
                    >
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  )}
                  {isInstalled ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-status-success font-medium">
                      <CircleCheck className="w-3 h-3" />
                      Installed
                    </span>
                  ) : isInstalling ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-accent font-medium">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Installing
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-canopy-text/30">
                      <CircleDashed className="w-3 h-3" />
                      Not installed
                    </span>
                  )}
                </div>
              </button>

              {hasMultipleMethods && !isInstalled && (
                <div className="flex items-center gap-1 pl-14 pt-1 pb-0.5">
                  <span className="text-[10px] text-canopy-text/30 mr-1">via</span>
                  {blocks.map((block, idx) => (
                    <button
                      key={idx}
                      type="button"
                      disabled={!!installingAgentId}
                      onClick={() => handleMethodChange(agentId, idx)}
                      data-selected={idx === currentMethodIdx || undefined}
                      className="px-1.5 py-0.5 rounded text-[10px] text-canopy-text/50 transition-colors hover:text-canopy-text/80 data-[selected]:bg-canopy-accent/15 data-[selected]:text-canopy-accent disabled:opacity-50"
                    >
                      {block.label ?? `Method ${idx + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <div className="text-xs font-medium text-canopy-text/60">Terminal</div>
          <div className="text-[11px] text-canopy-text/30">
            {installingAgentId
              ? `Installing ${getAgentConfig(installingAgentId)?.name ?? installingAgentId}...`
              : "Click an agent above to install"}
          </div>
        </div>
        <EmbeddedTerminal onTerminalReady={handleTerminalReady} />
      </div>
    </div>
  );
}
