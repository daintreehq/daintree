import { useState, type CSSProperties } from "react";
import { Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePanelStore } from "@/store/panelStore";
import { useDiagnosticsReviewStore } from "@/store/diagnosticsReviewStore";
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
  const isCollectingDiagnostics = useDiagnosticsReviewStore((s) => s.isCollecting);
  const diagnosticsError = useDiagnosticsReviewStore((s) => s.downloadError);
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
        role="status"
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

  const handleSendDiagnostics = () => {
    void actionService.dispatch(
      "diagnostics.openReview",
      {
        scope: {
          source: "recovery.hostCrashBanner",
          // 5-minute window scope hint — surfaced for downstream filtering once
          // the collection IPC supports it; today it's metadata only.
          timeWindowMs: 5 * 60 * 1000,
        },
      },
      { source: "user" }
    );
  };

  // `trailingSlot` is the documented escape hatch for surfacing a secondary
  // affordance on an error banner without breaking the single-action rule
  // (see InlineStatusBanner.tsx). "Restart service" stays the one `action`.
  const sendDiagnosticsButton = (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleSendDiagnostics}
      disabled={isCollectingDiagnostics}
      aria-label="Send diagnostics"
    >
      <Download aria-hidden="true" />
      {isCollectingDiagnostics ? "Collecting…" : "Send diagnostics"}
    </Button>
  );

  return (
    <InlineStatusBanner
      title={title}
      description={description}
      severity="error"
      role="alert"
      animated={false}
      trailingSlot={sendDiagnosticsButton}
      descriptionExtras={
        diagnosticsError ? (
          <p
            className="text-xs mt-1 break-words text-text-primary"
            data-testid="host-crash-banner-diagnostics-error"
          >
            Diagnostics collection failed: {diagnosticsError}
          </p>
        ) : null
      }
      action={{
        id: "restart",
        label: isRestarting ? "Restarting…" : "Restart service",
        variant: "primary",
        onClick: handleRestart,
        disabled: isRestarting,
      }}
    />
  );
}
