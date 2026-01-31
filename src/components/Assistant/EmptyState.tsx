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
        <p className="text-[13px] text-canopy-text/40 max-w-[260px] leading-relaxed">
          Orchestrate your panels, agents, and workflows.
        </p>

        {!hasApiKey && (
          <button
            type="button"
            onClick={handleOpenSettings}
            className={cn(
              "mt-6 flex items-center gap-2 px-3 py-2",
              "bg-canopy-sidebar/30 border border-canopy-border rounded text-[13px]",
              "text-canopy-text/60 hover:text-canopy-text hover:border-canopy-text/20",
              "transition-colors"
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
