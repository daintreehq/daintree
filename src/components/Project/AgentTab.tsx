import { cn } from "@/lib/utils";

interface AgentTabProps {
  agentInstructions: string;
  onAgentInstructionsChange: (value: string) => void;
}

export function AgentTab({ agentInstructions, onAgentInstructionsChange }: AgentTabProps) {
  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-medium text-canopy-text mb-1">Agent Instructions</h4>
        <p className="text-xs text-canopy-text/60 mb-3">
          These instructions are automatically prepended to the initial prompt of every new agent
          session in this project. Stored in{" "}
          <code className="text-[11px] bg-canopy-bg/80 px-1 py-0.5 rounded">
            .canopy/settings.json
          </code>{" "}
          — do not include secrets.
        </p>
        <textarea
          value={agentInstructions}
          onChange={(e) => onAgentInstructionsChange(e.target.value)}
          placeholder="e.g., Always use TypeScript strict mode. Follow our naming conventions..."
          rows={8}
          className="w-full rounded-md border border-canopy-border bg-canopy-sidebar px-3 py-2 text-sm text-canopy-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-canopy-accent resize-y font-mono"
        />
        <div className="flex items-center justify-between mt-1.5">
          <p className="text-xs text-canopy-text/40">
            Newlines are collapsed to spaces when passed to the agent CLI.
          </p>
          <span
            className={cn(
              "text-xs tabular-nums",
              agentInstructions.length >= 5000
                ? "text-status-danger"
                : agentInstructions.length >= 4000
                  ? "text-status-warning"
                  : "text-canopy-text/40"
            )}
          >
            {agentInstructions.length.toLocaleString()} / 5,000
          </span>
        </div>
      </div>
    </div>
  );
}
