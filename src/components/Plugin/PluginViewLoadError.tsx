import { useEffect } from "react";
import { XCircle } from "lucide-react";
import { PaneState } from "@/components/ui/PaneState";
import { Button } from "@/components/ui/button";
import { actionService } from "@/services/ActionService";
import { logWarn } from "@/utils/logger";

interface PluginViewLoadErrorProps {
  pluginId: string;
  displayName: string;
  message: string;
}

export function PluginViewLoadError({ pluginId, displayName, message }: PluginViewLoadErrorProps) {
  useEffect(() => {
    logWarn("[PluginViewHost] view configuration error", { pluginId, displayName, message });
  }, [pluginId, displayName, message]);

  return (
    <div role="region" aria-label="Plugin view unavailable" className="flex flex-1 flex-col">
      <PaneState
        inFlow
        className="flex-1"
        live="alert"
        icon={<XCircle className="text-status-error" />}
        title={`${displayName} unavailable`}
        description={message}
      >
        <Button
          variant="subtle"
          size="sm"
          onClick={() =>
            void actionService.dispatch("app.pluginManager", undefined, { source: "user" })
          }
        >
          Open plugin manager
        </Button>
      </PaneState>
    </div>
  );
}
