import { useCallback } from "react";
import { Settings, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { actionService } from "@/services/ActionService";

interface EmptyStateProps {
  className?: string;
}

export function EmptyState({ className }: EmptyStateProps) {
  const handleOpenSettings = useCallback(async () => {
    await actionService.dispatch("app.settings.openTab", { tab: "assistant" });
  }, []);

  return (
    <div className={cn("flex-1 flex items-center justify-center p-8", className)}>
      <div className="text-center max-w-sm">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-canopy-accent/10 mb-4">
          <Bot className="w-8 h-8 text-canopy-accent/70" />
        </div>

        <h3 className="text-lg font-medium text-canopy-text mb-2">Configure Canopy Assistant</h3>

        <p className="text-sm text-canopy-text/60 mb-6">
          Set up your Fireworks API key to start chatting with Canopy Assistant. The assistant can
          help you with coding questions, project navigation, and more.
        </p>

        <button
          type="button"
          onClick={handleOpenSettings}
          className={cn(
            "inline-flex items-center gap-2 px-4 py-2",
            "bg-canopy-accent text-white text-sm font-medium",
            "rounded-md",
            "hover:bg-canopy-accent/90 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-canopy-accent/50 focus:ring-offset-2 focus:ring-offset-canopy-bg"
          )}
        >
          <Settings className="w-4 h-4" />
          Open Settings
        </button>

        <p className="text-xs text-canopy-text/40 mt-4">
          Press <kbd className="px-1.5 py-0.5 rounded bg-canopy-sidebar font-mono">Cmd+Shift+K</kbd>{" "}
          to focus this panel
        </p>
      </div>
    </div>
  );
}
