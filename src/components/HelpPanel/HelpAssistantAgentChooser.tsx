import { ChevronRight, SquareTerminal } from "lucide-react";
import { BrandMark } from "@/components/icons/BrandMark";
import { BrandSurface } from "@/components/icons/BrandSurface";
import { getAgentConfig } from "@/config/agents";

interface HelpAssistantAgentChooserProps {
  agentIds: readonly string[];
  onChoose: (agentId: string) => void;
}

/**
 * First-run choice of the agent that runs the assistant, shown while no
 * preference is stored and more than one installed agent could. Choosing one
 * makes it the default and starts the assistant; Settings changes it later.
 * The rows are a set, so none of them takes the accent.
 */
export function HelpAssistantAgentChooser({ agentIds, onChoose }: HelpAssistantAgentChooserProps) {
  return (
    <BrandSurface surface="surface-canvas">
      <div
        role="group"
        aria-labelledby="help-agent-chooser-label"
        className="flex flex-col gap-1.5 w-full"
        data-testid="help-agent-chooser"
      >
        <p id="help-agent-chooser-label" className="text-xs text-text-secondary">
          Choose the agent that runs your assistant
        </p>
        {agentIds.map((agentId) => {
          const config = getAgentConfig(agentId);
          if (!config) return null;
          const Icon = config.icon ?? SquareTerminal;
          const description = config.tooltip;
          return (
            <button
              key={agentId}
              type="button"
              onClick={() => onChoose(agentId)}
              data-testid={`help-choose-agent-${agentId}`}
              className="group flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-[var(--radius-md)] border border-border-default text-text-primary hover:bg-overlay-soft transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2"
            >
              <BrandMark brandColor={config.color}>
                <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
              </BrandMark>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-sm font-medium">{config.name}</span>
                {description && <span className="text-2xs text-text-secondary">{description}</span>}
              </span>
              <ChevronRight
                className="w-3.5 h-3.5 shrink-0 text-text-secondary group-hover:text-text-primary transition-colors"
                aria-hidden="true"
              />
            </button>
          );
        })}
        <p className="text-2xs text-text-secondary">Saved as your default</p>
      </div>
    </BrandSurface>
  );
}
