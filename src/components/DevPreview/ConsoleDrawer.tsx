import { useState, useCallback, useEffect } from "react";
import { ChevronDown, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface ConsoleDrawerProps {
  terminalId: string;
  status?: DevPreviewStatus;
  defaultOpen?: boolean;
  isRestarting?: boolean;
  onHardRestart?: () => void;
}

const STATUS_LABEL: Record<DevPreviewStatus, { label: string; className: string }> = {
  stopped: { label: "Stopped", className: "text-canopy-text/40" },
  starting: { label: "Starting", className: "text-blue-400" },
  installing: { label: "Installing", className: "text-yellow-400" },
  running: { label: "Running", className: "text-green-400" },
  error: { label: "Error", className: "text-red-400" },
};

export function ConsoleDrawer({
  terminalId,
  status = "stopped",
  defaultOpen = false,
  isRestarting = false,
  onHardRestart,
}: ConsoleDrawerProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const toggleDrawer = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    terminalInstanceService.setVisible(terminalId, isOpen);
  }, [terminalId, isOpen]);

  const getRefreshTier = useCallback(() => {
    return isOpen ? TerminalRefreshTier.VISIBLE : TerminalRefreshTier.BACKGROUND;
  }, [isOpen]);

  const statusLabel = isRestarting
    ? { label: "Restarting", className: "text-blue-400" }
    : (STATUS_LABEL[status] ?? STATUS_LABEL.stopped);
  const hardRestartDisabled =
    !onHardRestart || isRestarting || status === "starting" || status === "installing";

  return (
    <div className="flex flex-col border-t border-overlay">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          onClick={toggleDrawer}
          className="flex min-w-0 flex-1 items-center justify-between rounded px-1 py-0.5 text-xs font-medium text-canopy-text/70 hover:bg-white/10 transition-colors"
          aria-expanded={isOpen}
          aria-controls={`console-drawer-${terminalId}`}
        >
          <span>{isOpen ? "Hide Logs" : "Show Logs"}</span>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-medium uppercase tracking-wide",
                statusLabel.className
              )}
            >
              {statusLabel.label}
            </span>
            <ChevronDown
              className={cn("w-3.5 h-3.5 transition-transform", isOpen && "rotate-180")}
            />
          </span>
        </button>

        {onHardRestart && (
          <button
            type="button"
            onClick={onHardRestart}
            disabled={hardRestartDisabled}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] font-medium uppercase tracking-wide transition-colors",
              "text-canopy-text/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40",
              isRestarting && "text-blue-400"
            )}
            title="Hard restart dev preview"
            aria-label="Hard restart dev preview"
            aria-busy={isRestarting}
          >
            <RotateCw className={cn("w-3.5 h-3.5", isRestarting && "animate-spin")} />
            <span>Restart</span>
          </button>
        )}
      </div>

      <div
        id={`console-drawer-${terminalId}`}
        className={cn("overflow-hidden transition-[height]", isOpen ? "h-[300px]" : "h-0")}
        aria-hidden={!isOpen}
      >
        <div className="h-[300px] bg-black">
          <XtermAdapter
            terminalId={terminalId}
            getRefreshTier={getRefreshTier}
            restoreOnAttach={true}
          />
        </div>
      </div>
    </div>
  );
}
