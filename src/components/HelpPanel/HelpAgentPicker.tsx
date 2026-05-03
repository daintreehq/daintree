import { useCallback } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AGENT_REGISTRY } from "@/config/agents";
import { BrandMark } from "@/components/icons";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";

interface HelpAgentPickerProps {
  onSelectAgent: (agentId: string) => void;
  /**
   * IDs of agents that are both wired for the assistant overlay AND installed
   * locally. Computed by `HelpPanel` so the picker and the single-supported
   * agent auto-skip effect agree on the visible set. The picker just renders
   * this list; it still reads `hasRealData` to distinguish "loading" from
   * "no installed agents".
   */
  supportedAgentIds: string[];
}

export function HelpAgentPicker({ onSelectAgent, supportedAgentIds }: HelpAgentPickerProps) {
  // Gate on `hasRealData` (not `isInitialized`): `isInitialized` flips true even on probe
  // failure, but `hasRealData` waits for a real result — from localStorage cache or a
  // successful IPC — so users with previously-installed agents don't see the
  // "No agents are installed" empty state flash on cold open.
  const hasRealData = useCliAvailabilityStore((s) => s.hasRealData);

  const handleOpenSetupWizard = useCallback(() => {
    window.dispatchEvent(new CustomEvent("daintree:open-agent-setup-wizard"));
  }, []);

  if (!hasRealData) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-daintree-text/50">Checking for installed agents…</p>
      </div>
    );
  }

  if (supportedAgentIds.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-daintree-text/50">No agents are installed.</p>
        <p className="text-xs text-daintree-text/40">
          Install an agent using the setup wizard to use as your Daintree assistant.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleOpenSetupWizard}
          className="gap-1.5"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>Run setup wizard</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 gap-6 overflow-y-auto">
      <div className="text-center">
        <h3 className="text-sm font-medium text-daintree-text/80">
          Which agent would you like to use as your Daintree assistant?
        </h3>
      </div>

      <div className="flex flex-col gap-2">
        {supportedAgentIds.map((id) => {
          const config = AGENT_REGISTRY[id];
          if (!config) return null;
          const Icon = config.icon;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelectAgent(id)}
              className={cn(
                "flex items-center gap-3 p-3 rounded-[var(--radius-md)]",
                "border border-daintree-border/50 bg-daintree-bg",
                "transition-colors hover:bg-tint/8 hover:border-daintree-border",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
                "group text-left"
              )}
            >
              <div className="shrink-0 w-8 h-8 flex items-center justify-center">
                <BrandMark
                  brandColor={config.color}
                  size={24}
                  className="opacity-70 group-hover:opacity-100 transition-opacity"
                >
                  <Icon className="w-6 h-6" brandColor={config.color} />
                </BrandMark>
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-daintree-text/80 group-hover:text-daintree-text transition-colors">
                  {config.name}
                </span>
                {config.tooltip && (
                  <span className="text-xs text-daintree-text/40 group-hover:text-daintree-text/60 transition-colors truncate">
                    {config.tooltip}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
