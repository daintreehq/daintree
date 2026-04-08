import { useMemo, useCallback } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AGENT_REGISTRY } from "@/config/agents";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useCliAvailabilityStore } from "@/store/cliAvailabilityStore";
import { actionService } from "@/services/ActionService";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";

interface HelpAgentPickerProps {
  onSelectAgent: (agentId: string) => void;
}

export function HelpAgentPicker({ onSelectAgent }: HelpAgentPickerProps) {
  const settings = useAgentSettingsStore((s) => s.settings);
  const availability = useCliAvailabilityStore((s) => s.availability);

  const enabledAgents = useMemo(() => {
    return BUILT_IN_AGENT_IDS.filter((id) => {
      if (settings?.agents && settings.agents[id]?.selected === false) return false;
      if (availability[id] === false) return false;
      return true;
    });
  }, [settings, availability]);

  const handleOpenSettings = useCallback(() => {
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  }, []);

  if (enabledAgents.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-canopy-text/50">No agents are currently available.</p>
        <p className="text-xs text-canopy-text/40">
          Enable an agent in settings to use as your Canopy assistant.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleOpenSettings}
          className="gap-1.5"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>Agent Settings</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-6 gap-6 overflow-y-auto">
      <div className="text-center">
        <h3 className="text-sm font-medium text-canopy-text/80">
          Which agent would you like to use as your Canopy assistant?
        </h3>
      </div>

      <div className="flex flex-col gap-2">
        {enabledAgents.map((id) => {
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
                "border border-canopy-border/50 bg-canopy-bg",
                "transition-colors hover:bg-tint/8 hover:border-canopy-border",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                "group text-left"
              )}
            >
              <div className="shrink-0 w-8 h-8 flex items-center justify-center">
                <Icon
                  className="w-6 h-6 opacity-70 group-hover:opacity-100 transition-opacity"
                  brandColor={config.color}
                />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-canopy-text/80 group-hover:text-canopy-text transition-colors">
                  {config.name}
                </span>
                {config.tooltip && (
                  <span className="text-xs text-canopy-text/40 group-hover:text-canopy-text/60 transition-colors truncate">
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
