import { ExternalLink, CircleCheck, CircleDashed } from "lucide-react";
import type { AgentConfig, AgentIconProps } from "@/config/agents";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import type { ComponentType } from "react";
import { InstallBlock } from "./InstallBlock";

interface AgentSetupStepProps {
  agent: AgentConfig;
  isAvailable: boolean;
  icon: ComponentType<AgentIconProps>;
}

export function AgentSetupStep({ agent, isAvailable, icon: Icon }: AgentSetupStepProps) {
  const installBlocks = getInstallBlocksForCurrentOS(agent);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div
          className="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center"
          style={{ backgroundColor: `${agent.color}15` }}
        >
          <Icon size={22} brandColor={agent.color} />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-canopy-text">{agent.name}</h3>
          {agent.tooltip && <p className="text-xs text-canopy-text/50">{agent.tooltip}</p>}
        </div>
        <StatusBadge isAvailable={isAvailable} />
      </div>

      {!isAvailable && installBlocks && (
        <div className="space-y-2">
          {installBlocks.map((block, i) => (
            <InstallBlock key={i} block={block} />
          ))}
        </div>
      )}

      {!isAvailable && agent.install?.docsUrl && (
        <a
          href={agent.install.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-canopy-accent hover:underline"
          onClick={(e) => {
            e.preventDefault();
            systemClient.openExternal(agent.install!.docsUrl!);
          }}
        >
          <ExternalLink className="w-3 h-3" />
          View documentation
        </a>
      )}

      {isAvailable && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] bg-surface border border-canopy-border">
          <CircleCheck className="w-4 h-4 text-status-success" />
          <span className="text-sm text-canopy-text/70">{agent.name} is installed and ready</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ isAvailable }: { isAvailable: boolean }) {
  if (isAvailable) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-status-success">
        <CircleCheck className="w-3 h-3" />
        Installed
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-canopy-text/5 text-canopy-text/50">
      <CircleDashed className="w-3 h-3" />
      Not installed
    </span>
  );
}
