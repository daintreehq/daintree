import { useState, type CSSProperties } from "react";
import { AlertTriangle, Download, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  // (see InlineStatusBanner.tsx). Keeping "Restart service" as the primary
  // `action` preserves the dangerFilled emphasis.
  const sendDiagnosticsButton = (
    <button
      type="button"
      onClick={handleSendDiagnostics}
      disabled={isCollectingDiagnostics}
      aria-label="Send diagnostics"
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors",
        "text-daintree-text/70 hover:text-daintree-text hover:bg-daintree-border/50",
        "outline-hidden focus-visible:outline-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent",
        isCollectingDiagnostics && "cursor-not-allowed opacity-60 hover:bg-transparent"
      )}
    >
      <Download className="w-3 h-3" aria-hidden="true" />
      {isCollectingDiagnostics ? "Collecting…" : "Send diagnostics"}
    </button>
  );

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={title}
      description={description}
      severity="error"
      role="alert"
      animated={false}
      trailingSlot={sendDiagnosticsButton}
      descriptionExtras={
        diagnosticsError ? (
          <p
            className="text-xs mt-1.5 break-words"
            style={{ color: "color-mix(in oklab, var(--color-status-error) 80%, transparent)" }}
            data-testid="host-crash-banner-diagnostics-error"
          >
            Diagnostics collection failed: {diagnosticsError}
          </p>
        ) : null
      }
      action={{
        id: "restart",
        label: isRestarting ? "Restarting…" : "Restart service",
        variant: "dangerFilled",
        onClick: handleRestart,
        disabled: isRestarting,
      }}
    />
  );
}
