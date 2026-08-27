import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useSafeModeStore } from "@/store/safeModeStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { InlineStatusBanner } from "@/components/Terminal/InlineStatusBanner";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { SAFE_MODE_BANNER_COPY } from "./recoveryCopy";
import type { QuarantinedPanelSummary } from "@shared/types/ipc/crashRecovery";

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

interface QuarantinedPanelRowProps {
  panel: QuarantinedPanelSummary;
}

function QuarantinedPanelRow({ panel }: QuarantinedPanelRowProps) {
  const clearQuarantinedPanel = useSafeModeStore((s) => s.clearQuarantinedPanel);
  const [state, setState] = useState<"idle" | "clearing" | "cleared" | "failed">("idle");

  const handleRestore = async () => {
    // Block only the in-flight case — a failed clear must remain retryable
    // (the row's Retry button calls this same handler).
    if (state === "clearing" || state === "cleared") return;
    setState("clearing");
    try {
      const result = await clearQuarantinedPanel(panel.id);
      setState(result.cleared ? "cleared" : "failed");
    } catch (error) {
      logError("Failed to clear quarantined panel", error);
      setState("failed");
    }
  };

  const displayTitle = panel.title.trim().length > 0 ? panel.title : "Untitled panel";
  // Prefer worktree context when present; cwd is verbose and often a long
  // absolute path that wraps the popover badly. Either way it's a single
  // secondary line so the panel is identifiable across collisions.
  const subtitle = panel.worktreeId ?? panel.cwd ?? null;

  return (
    <li className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-daintree-text" title={displayTitle}>
          {displayTitle}
        </p>
        {subtitle && (
          <p className="truncate text-3xs text-daintree-text/50" title={subtitle}>
            {subtitle}
          </p>
        )}
      </div>
      {state === "idle" && (
        <button
          type="button"
          onClick={handleRestore}
          className="shrink-0 rounded border border-[var(--color-status-warning)]/30 px-2 py-0.5 text-3xs transition-colors hover:bg-[var(--color-status-warning)]/10"
        >
          Restore panel
        </button>
      )}
      {state === "clearing" && (
        <span className="shrink-0 text-3xs text-daintree-text/60">Clearing…</span>
      )}
      {state === "cleared" && (
        <span className="shrink-0 text-3xs text-daintree-text/60">Restoring on next launch</span>
      )}
      {state === "failed" && (
        <button
          type="button"
          onClick={handleRestore}
          className="shrink-0 rounded border border-[var(--color-status-warning)]/30 px-2 py-0.5 text-3xs transition-colors hover:bg-[var(--color-status-warning)]/10"
        >
          Retry
        </button>
      )}
    </li>
  );
}

export function SafeModeBanner() {
  const safeMode = useSafeModeStore((s) => s.safeMode);
  const dismissed = useSafeModeStore((s) => s.dismissed);
  const crashCount = useSafeModeStore((s) => s.crashCount);
  const skippedPanelCount = useSafeModeStore((s) => s.skippedPanelCount);
  const lastCrashAt = useSafeModeStore((s) => s.lastCrashAt);
  const quarantinedPanels = useSafeModeStore((s) => s.quarantinedPanels);
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
  const quarantined = Array.isArray(quarantinedPanels) ? quarantinedPanels : [];
  const hasQuarantineList = quarantined.length > 0;
  const hasDetails = skipped > 0 || crashes > 0 || crashTimestamp !== null || hasQuarantineList;

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
        {hasQuarantineList ? (
          <>
            <p className="text-daintree-text/70">
              {quarantined.length === 1
                ? "1 panel was quarantined because it appeared to trigger repeated crashes."
                : `${quarantined.length} panels were quarantined because they appeared to trigger repeated crashes.`}
            </p>
            <ul
              role="list"
              className="-mx-1 max-h-64 overflow-y-auto divide-y divide-daintree-text/10 text-2xs"
            >
              {quarantined.map((panel) => (
                <QuarantinedPanelRow key={panel.id} panel={panel} />
              ))}
            </ul>
          </>
        ) : (
          skipped > 0 && (
            <p className="text-daintree-text/70">
              {skipped} {skipped === 1 ? "panel was" : "panels were"} skipped so you can recover the
              app. Restart normally to reload them.
            </p>
          )
        )}
      </PopoverContent>
    </Popover>
  ) : undefined;

  return (
    <>
      <InlineStatusBanner
        icon={AlertTriangle}
        title={SAFE_MODE_BANNER_COPY.title}
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
