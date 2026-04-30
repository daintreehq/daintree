import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useSafeModeStore } from "@/store/safeModeStore";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
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

  const summaryParts: string[] = [];
  if (typeof crashCount === "number" && crashCount > 0) {
    summaryParts.push(`${crashCount} ${crashCount === 1 ? "crash" : "crashes"}`);
  }
  if (lastCrashAt) {
    summaryParts.push(`last ${formatRelativeTime(lastCrashAt)}`);
  }
  const summary = summaryParts.length > 0 ? ` — ${summaryParts.join(", ")}` : "";

  const skipped =
    typeof skippedPanelCount === "number" && skippedPanelCount > 0 ? skippedPanelCount : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 px-4 py-2 bg-[var(--color-status-warning)]/15 border-b border-[var(--color-status-warning)]/30 text-[var(--color-status-warning)] text-sm shrink-0"
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">
        Safe mode{summary}. Panels weren't restored to break the crash loop.
      </span>
      {skipped > 0 && (
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
            <p className="font-medium">
              {skipped} {skipped === 1 ? "panel was" : "panels were"} skipped
            </p>
            <p className="text-daintree-text/70">
              Daintree booted in safe mode after repeated crashes. Saved panels weren't restored so
              you can recover the app.
            </p>
            <p className="text-daintree-text/70">
              Restart normally to reload them. If crashes return, check Settings &gt;
              Troubleshooting.
            </p>
          </PopoverContent>
        </Popover>
      )}
      <button
        type="button"
        onClick={handleRestart}
        disabled={isRestarting}
        className="text-xs px-2 py-1 rounded border border-[var(--color-status-warning)]/30 hover:bg-[var(--color-status-warning)]/10 transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isRestarting ? "Restarting…" : "Restart normally"}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss safe mode banner"
        className="p-1 rounded hover:bg-[var(--color-status-warning)]/10 transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
