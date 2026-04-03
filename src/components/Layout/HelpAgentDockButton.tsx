import { useState, useMemo, useCallback } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons/CanopyIcon";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";
import { useAgentPreferencesStore } from "@/store/agentPreferencesStore";
import { actionService } from "@/services/ActionService";
import { AGENT_REGISTRY } from "@/config/agents";
import { Settings } from "lucide-react";

const HELP_AGENT_IDS = ["claude", "gemini", "codex"] as const;

interface HelpAgentDockButtonProps {
  compact?: boolean;
}

export function HelpAgentDockButton({ compact = false }: HelpAgentDockButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const settings = useAgentSettingsStore((s) => s.settings);
  const defaultAgent = useAgentPreferencesStore((s) => s.defaultAgent);

  const enabledHelpAgents = useMemo(() => {
    return HELP_AGENT_IDS.filter((id) => {
      if (!settings?.agents) return true;
      return settings.agents[id]?.selected !== false;
    });
  }, [settings]);

  const directLaunchAgentId = useMemo(() => {
    if (enabledHelpAgents.length === 1) return enabledHelpAgents[0];
    if (
      defaultAgent &&
      enabledHelpAgents.includes(defaultAgent as (typeof HELP_AGENT_IDS)[number])
    ) {
      return defaultAgent;
    }
    return undefined;
  }, [enabledHelpAgents, defaultAgent]);

  const handleLaunchAgent = useCallback((agentId: string) => {
    setIsOpen(false);
    void actionService.dispatch("help.launchAgent", { agentId }, { source: "user" });
  }, []);

  const handleButtonClick = useCallback(() => {
    if (directLaunchAgentId) {
      handleLaunchAgent(directLaunchAgentId);
    } else {
      setIsOpen(true);
    }
  }, [directLaunchAgentId, handleLaunchAgent]);

  const handleOpenSettings = useCallback(() => {
    setIsOpen(false);
    void actionService.dispatch("app.settings.openTab", { tab: "agents" }, { source: "user" });
  }, []);

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="pill"
                size="sm"
                className={cn(
                  compact ? "px-1.5 min-w-0" : "px-2.5",
                  isOpen && "bg-canopy-border border-canopy-accent/40 ring-1 ring-canopy-accent/30"
                )}
                onClick={(e) => {
                  if (directLaunchAgentId) {
                    e.preventDefault();
                    handleButtonClick();
                  }
                }}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-label="Help Agent"
              >
                <CanopyIcon className="w-3.5 h-3.5 text-canopy-text/50" />
                {!compact && <span className="font-medium">Help</span>}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {directLaunchAgentId
              ? `Launch ${AGENT_REGISTRY[directLaunchAgentId]?.name ?? directLaunchAgentId} in help workspace`
              : "Open help agent picker"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <PopoverContent
        className="w-64 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-canopy-bg/50">
            <span className="text-xs font-medium text-canopy-text/70">Help Agent</span>
          </div>

          {enabledHelpAgents.length === 0 ? (
            <div className="p-4 flex flex-col items-center gap-2 text-center">
              <span className="text-xs text-canopy-text/50">No help agents enabled</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleOpenSettings}
                className="gap-1.5"
              >
                <Settings className="w-3 h-3" />
                <span>Enable Agents</span>
              </Button>
            </div>
          ) : (
            <div className="p-2">
              <div className="grid grid-cols-3 gap-1.5">
                {enabledHelpAgents.map((id) => {
                  const config = AGENT_REGISTRY[id];
                  if (!config) return null;
                  const Icon = config.icon;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleLaunchAgent(id)}
                      className={cn(
                        "flex flex-col items-center gap-1.5 p-2.5 rounded-[var(--radius-md)]",
                        "transition-colors hover:bg-tint/8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent",
                        "group"
                      )}
                    >
                      <Icon
                        className="w-6 h-6 opacity-70 group-hover:opacity-100 transition-opacity"
                        brandColor={config.color}
                      />
                      <span className="text-[11px] font-medium text-canopy-text/60 group-hover:text-canopy-text transition-colors">
                        {config.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
