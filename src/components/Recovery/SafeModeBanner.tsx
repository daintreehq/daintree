import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useSafeModeStore } from "@/store/safeModeStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
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
  const quarantinedPanels = useSafeModeStore((s) => s.quarantinedPanels);
  const removeQuarantinedPanel = useSafeModeStore((s) => s.removeQuarantinedPanel);
  const dismiss = useSafeModeStore((s) => s.dismiss);
  const [isRestarting, setIsRestarting] = useState(false);
  const [pendingRestoreIds, setPendingRestoreIds] = useState<Set<string>>(new Set());

  const hasQuarantine = (quarantinedPanels?.length ?? 0) > 0;

  if ((!safeMode && !hasQuarantine) || dismissed) return null;

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

  const handleRestorePanel = async (panelId: string) => {
    if (pendingRestoreIds.has(panelId)) return;
    setPendingRestoreIds((prev) => {
      const next = new Set(prev);
      next.add(panelId);
      return next;
    });
    try {
      await window.electron.crashRecovery.restorePanel(panelId);
      removeQuarantinedPanel(panelId);
      // Trigger a relaunch so the panel comes back before any in-session
      // save can overwrite per-project state with the renderer's filtered
      // terminal list. Mirrors the "Restart normally" pattern — the ledger
      // entry is already cleared, so the next boot will restore the panel.
      await window.electron.app.resetAndRelaunch();
    } catch (error) {
      logError("Failed to restore quarantined panel", error);
      setPendingRestoreIds((prev) => {
        const next = new Set(prev);
        next.delete(panelId);
        return next;
      });
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
  const hasDetails = skipped > 0 || crashes > 0 || crashTimestamp !== null || hasQuarantine;

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
        className="p-3 text-xs max-w-sm space-y-2 text-daintree-text"
      >
        {crashMetaText && <p className="font-medium">{crashMetaText}</p>}
        {skipped > 0 && !hasQuarantine && (
          <p className="text-daintree-text/70">
            {skipped} {skipped === 1 ? "panel was" : "panels were"} skipped so you can recover the
            app. Restart normally to reload them.
          </p>
        )}
        {hasQuarantine && quarantinedPanels && (
          <div className="space-y-2">
            <p className="text-daintree-text/70">
              {quarantinedPanels.length}{" "}
              {quarantinedPanels.length === 1
                ? "panel was held back because it"
                : "panels were held back because they"}{" "}
              crashed shortly after launching. Restore individually to try again.
            </p>
            <ul className="space-y-1.5">
              {quarantinedPanels.map((panel) => {
                const isPending = pendingRestoreIds.has(panel.id);
                return (
                  <li
                    key={panel.id}
                    className="flex items-start justify-between gap-2 rounded border border-daintree-border/40 p-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-daintree-text truncate">
                        {panel.title || panel.kind || panel.id}
                      </p>
                      {panel.cwd && (
                        <p className="text-daintree-text/60 truncate font-mono text-[10px]">
                          {panel.cwd}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void handleRestorePanel(panel.id);
                      }}
                      disabled={isPending}
                      className="text-xs px-2 py-1 rounded border border-daintree-border hover:bg-overlay-subtle transition-colors shrink-0 disabled:opacity-50"
                    >
                      {isPending ? "Restoring…" : "Restore panel"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  ) : undefined;

  const title = safeMode
    ? "Safe mode — panels weren't restored"
    : hasQuarantine
      ? "Some panels were quarantined"
      : "Safe mode — panels weren't restored";

  const actions = safeMode
    ? [
        {
          id: "restart",
          label: isRestarting ? "Restarting…" : "Restart normally",
          variant: "primary" as const,
          onClick: handleRestart,
          disabled: isRestarting,
        },
      ]
    : [];

  return (
    <InlineStatusBanner
      icon={AlertTriangle}
      title={title}
      severity="warning"
      role="status"
      trailingSlot={detailsPopover}
      actions={actions}
      onClose={dismiss}
      closeAriaLabel="Dismiss safe mode banner"
    />
  );
}
