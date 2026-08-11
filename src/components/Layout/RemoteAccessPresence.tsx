import { useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import type { RemoteAccessSnapshot } from "@shared/types/remote";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { actionService } from "@/services/ActionService";
import { cn } from "@/lib/utils";
import { safeFireAndForget } from "@/utils/safeFireAndForget";

const REMOTE_PRESENCE_REFRESH_INTERVAL_MS = 3_000;

export function RemoteAccessPresence() {
  const [snapshot, setSnapshot] = useState<RemoteAccessSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      safeFireAndForget(
        window.electron.remoteAccess.getState().then((next) => {
          if (active) setSnapshot(next);
        }),
        { context: "refresh remote access presence" }
      );
    };
    refresh();
    const timer = window.setInterval(refresh, REMOTE_PRESENCE_REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!snapshot?.config.enabled && !snapshot?.activeSessions) return null;

  const activeNames = snapshot.devices
    .filter((device) => device.activeSessions > 0)
    .map((device) => device.displayName);
  const presence =
    snapshot.status.state === "error"
      ? "Remote access needs attention — open settings to retry"
      : snapshot.activeSubscriptions > 0
        ? `${activeNames[0] ?? "Portal device"} observing an agent`
        : snapshot.activeSessions > 0
          ? `${activeNames.join(", ") || "Portal device"} connected`
          : "Remote access enabled";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="toolbar-icon-button app-no-drag relative text-daintree-text"
          aria-label={`${presence}. Manage remote access`}
          onClick={() =>
            void actionService.dispatch("app.remoteAccess.manage", undefined, { source: "user" })
          }
        >
          <RadioTower aria-hidden="true" />
          {(snapshot.activeSessions > 0 || snapshot.status.state === "error") && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ring-1 ring-daintree-bg",
                snapshot.status.state === "error" ? "bg-status-error" : "bg-text-secondary"
              )}
            />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{presence}</TooltipContent>
    </Tooltip>
  );
}
