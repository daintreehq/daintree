import { useCallback } from "react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";
import { useAppAgentStore } from "@/store/appAgentStore";
import { CanopyIcon } from "@/components/icons/CanopyIcon";

interface EmptyStateProps {
  className?: string;
  onSubmit?: (prompt: string) => void;
}

export function EmptyState({ className, onSubmit: _onSubmit }: EmptyStateProps) {
  const hasApiKey = useAppAgentStore((s) => s.hasApiKey);

  const handleOpenSettings = useCallback(async () => {
    try {
      await actionService.dispatch("app.settings.openTab", { tab: "assistant" });
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  }, []);

  return (
    <div className={cn("flex h-full flex-col items-center justify-center p-8", className)}>
      <div className="flex flex-col items-center text-center">
        <CanopyIcon className="h-12 w-12 text-canopy-accent/30 mb-4" />
        <div className="text-center space-y-2">
          <p className="text-[14px] text-canopy-text/40 max-w-[280px] leading-relaxed">
            Orchestrate your panels, agents, and workflows.
          </p>
          <p className="text-xs text-amber-800 dark:text-amber-400 font-medium">
            Experimental feature • Capabilities are evolving
          </p>
        </div>

        {!hasApiKey && (
          <button
            type="button"
            onClick={handleOpenSettings}
            className={cn(
              "mt-6 flex items-center gap-2 px-3 py-2",
              "bg-white/[0.02] border border-white/10 rounded-md text-[13px]",
              "text-canopy-text/60 hover:text-canopy-text hover:border-white/20 hover:bg-white/[0.05]",
              "transition-all duration-200"
            )}
          >
            <Settings className="w-3 h-3" />
            Configure API Key
          </button>
        )}
      </div>
    </div>
  );
}
