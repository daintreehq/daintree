import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, CircleCheck, CircleDashed } from "lucide-react";
import type { AgentConfig, AgentIconProps } from "@/config/agents";
import type { AgentInstallBlock } from "@shared/config/agentRegistry";
import { getInstallBlocksForCurrentOS } from "@/lib/agentInstall";
import { systemClient } from "@/clients";
import type { ComponentType } from "react";

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

function InstallBlock({ block }: { block: AgentInstallBlock }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-canopy-border bg-canopy-bg/50 p-3">
      {block.label && (
        <div className="text-xs font-medium text-canopy-text/60 mb-2">{block.label}</div>
      )}
      {block.steps && block.steps.length > 0 && (
        <ol className="list-decimal list-inside text-xs text-canopy-text/60 space-y-1 mb-2">
          {block.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {block.commands && block.commands.length > 0 && (
        <div className="space-y-1.5">
          {block.commands.map((cmd, i) => (
            <CopyableCommand key={i} command={cmd} />
          ))}
        </div>
      )}
      {block.notes && block.notes.length > 0 && (
        <div className="mt-2 text-[11px] text-canopy-text/40 space-y-0.5">
          {block.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(command).then(() => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      setCopied(true);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [command]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-canopy-bg border border-canopy-border">
      <code className="flex-1 text-xs text-canopy-text font-mono select-all">{command}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 p-1 text-canopy-text/40 hover:text-canopy-text transition-colors rounded"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-status-success" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}
