import { useState, type CSSProperties } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePanelStore } from "@/store/panelStore";
import { actionService } from "@/services/ActionService";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { logError } from "@/utils/logger";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { HOST_CRASH_RECOVERING_COPY, getHostCrashBannerCopy } from "./recoveryCopy";

function SpinnerIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <Loader2
      className={cn("animate-spin motion-reduce:animate-none", className)}
      style={style}
      aria-hidden="true"
    />
  );
}

export function HostCrashBanner() {
  const backendStatus = usePanelStore((s) => s.backendStatus);
  const lastCrashType = usePanelStore((s) => s.lastCrashType);
  const [isRestarting, setIsRestarting] = useState(false);
  const recoveringShown = useDohertyGate(backendStatus === "recovering");

  if (backendStatus === "connected") return null;

  if (backendStatus === "recovering") {
    if (!recoveringShown) return null;

    return (
      <InlineStatusBanner
        icon={SpinnerIcon}
        title={HOST_CRASH_RECOVERING_COPY.title}
        description={HOST_CRASH_RECOVERING_COPY.description}
        severity="warning"
        role="alert"
        animated={false}
        actions={[]}
      />
    );
  }

  const { title, description } = getHostCrashBannerCopy(lastCrashType);

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    const result = await actionService.dispatch("terminal.restartService", undefined, {
      source: "user",
    });
    if (!result.ok) {
      logError("Failed to restart terminal service from host crash banner", result.error);
      setIsRestarting(false);
    }
  };

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={title}
      description={description}
      severity="error"
      role="alert"
      animated={false}
      actions={[
        {
          id: "restart",
          label: isRestarting ? "Restarting…" : "Restart service",
          variant: "dangerFilled",
          onClick: handleRestart,
          disabled: isRestarting,
        },
      ]}
    />
  );
}
