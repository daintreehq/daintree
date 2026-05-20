import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useSafeModeStore } from "@/store/safeModeStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SafeModeBanner() {
  const safeMode = useSafeModeStore((s) => s.safeMode);
  const dismissed = useSafeModeStore((s) => s.dismissed);
  const crashCount = useSafeModeStore((s) => s.crashCount);
  const skippedPanelCount = useSafeModeStore((s) => s.skippedPanelCount);
  const lastCrashAt = useSafeModeStore((s) => s.lastCrashAt);
  const dismiss = useSafeModeStore((s) => s.dismiss);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  if (!safeMode || dismissed) return null;

  const handleRestart = async () => {
    if (isRestarting) return;
    setIsRestarting(true);
    try {
      await window.electron.app.resetAndRelaunch();
    } catch (error) {
      logError("Failed to restart from safe mode", error);
      setIsRestarting(false);
    }
  };

  const skipped =
    typeof skippedPanelCount === "number" &&
    Number.isFinite(skippedPanelCount) &&
    skippedPanelCount > 0
      ? skippedPanelCount
      : 0;
  const crashes =
    typeof crashCount === "number" && Number.isFinite(crashCount) && crashCount > 0
      ? crashCount
      : 0;
  const crashTimestamp =
    typeof lastCrashAt === "number" && Number.isFinite(lastCrashAt) ? lastCrashAt : null;
  const hasDetails = skipped > 0 || crashes > 0 || crashTimestamp !== null;

  let crashMetaText: string | null = null;
  if (crashes > 0 && crashTimestamp !== null) {
    crashMetaText = `${crashes} ${crashes === 1 ? "crash" : "crashes"} detected, last ${formatRelativeTime(crashTimestamp)}`;
  } else if (crashes > 0) {
    crashMetaText = `${crashes} ${crashes === 1 ? "crash" : "crashes"} detected`;
  } else if (crashTimestamp !== null) {
    crashMetaText = `Last crash ${formatRelativeTime(crashTimestamp)}`;
  }

  const detailsPopover = hasDetails ? (
    <Popover>
      <PopoverTrigger
        type="button"
        className="text-xs px-2 py-1 rounded border border-[var(--color-status-warning)]/30 hover:bg-[var(--color-status-warning)]/10 transition-colors shrink-0"
      >
        Show details
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="p-3 text-xs max-w-xs space-y-2 text-daintree-text"
      >
        {crashMetaText && <p className="font-medium">{crashMetaText}</p>}
        {skipped > 0 && (
          <p className="text-daintree-text/70">
            {skipped} {skipped === 1 ? "panel was" : "panels were"} skipped so you can recover the
            app. Restart normally to reload them.
          </p>
        )}
      </PopoverContent>
    </Popover>
  ) : undefined;

  return (
    <>
      <InlineStatusBanner
        icon={AlertTriangle}
        title="Safe mode — panels weren't restored"
        severity="warning"
        role="status"
        trailingSlot={detailsPopover}
        actions={[
          {
            id: "restart",
            label: isRestarting ? "Restarting…" : "Restart normally",
            variant: "primary",
            onClick: () => setIsConfirmOpen(true),
            disabled: isRestarting,
          },
        ]}
        onClose={dismiss}
        closeAriaLabel="Dismiss safe mode banner"
      />
      <ConfirmDialog
        isOpen={isConfirmOpen}
        onClose={isRestarting ? undefined : () => setIsConfirmOpen(false)}
        title="Restart Daintree normally?"
        description="All running terminals and agent sessions will be killed. Scrollback and in-flight agent work will be lost."
        confirmLabel="Restart normally"
        variant="destructive"
        onConfirm={handleRestart}
        isConfirmLoading={isRestarting}
      >
        <button
          type="button"
          onClick={() => {
            void actionService.dispatch("logs.openFile", undefined, { source: "user" });
          }}
          className="text-xs text-daintree-text/60 hover:text-daintree-text transition-colors underline decoration-daintree-text/30 underline-offset-2"
        >
          View logs
        </button>
      </ConfirmDialog>
    </>
  );
}
