import { useState, useCallback, useEffect } from "react";
import { ChevronUp, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";
import type { DevPreviewStatus } from "@/hooks/useDevServer";

interface ConsoleDrawerProps {
  terminalId: string;
  status?: DevPreviewStatus;
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  defaultOpen?: boolean;
  isRestarting?: boolean;
  onHardRestart?: () => void;
}

const STATUS_LABEL: Record<
  DevPreviewStatus,
  { label: string; textClass: string; dotClass: string }
> = {
  stopped: {
    label: "Stopped",
    textClass: "text-canopy-text/50",
    dotClass: "bg-canopy-text/40",
  },
  starting: {
    label: "Starting",
    textClass: "text-blue-400",
    dotClass: "bg-blue-400",
  },
  installing: {
    label: "Installing",
    textClass: "text-yellow-400",
    dotClass: "bg-yellow-400",
  },
  running: {
    label: "Running",
    textClass: "text-green-400",
    dotClass: "bg-green-400",
  },
  error: {
    label: "Error",
    textClass: "text-red-400",
    dotClass: "bg-red-400",
  },
};

export function ConsoleDrawer({
  terminalId,
  status = "stopped",
  isOpen: controlledIsOpen,
  onOpenChange,
  defaultOpen = false,
  isRestarting = false,
  onHardRestart,
}: ConsoleDrawerProps) {
  const [uncontrolledIsOpen, setUncontrolledIsOpen] = useState(defaultOpen);
  const isOpen = controlledIsOpen ?? uncontrolledIsOpen;

  const toggleDrawer = useCallback(() => {
    const nextIsOpen = !isOpen;
    if (controlledIsOpen === undefined) {
      setUncontrolledIsOpen(nextIsOpen);
    }
    onOpenChange?.(nextIsOpen);
  }, [isOpen, controlledIsOpen, onOpenChange]);

  useEffect(() => {
    terminalInstanceService.setVisible(terminalId, isOpen);
  }, [terminalId, isOpen]);

  const getRefreshTier = useCallback(() => {
    return isOpen ? TerminalRefreshTier.VISIBLE : TerminalRefreshTier.BACKGROUND;
  }, [isOpen]);

  const statusLabel = isRestarting
    ? { label: "Restarting", textClass: "text-blue-400", dotClass: "bg-blue-400" }
    : (STATUS_LABEL[status] ?? STATUS_LABEL.stopped);
  const toggleLabel = isOpen ? "Hide Terminal" : "Show Terminal";
  const hardRestartDisabled =
    !onHardRestart || isRestarting || status === "starting" || status === "installing";
  const statusClass = cn(
    "inline-flex min-h-8 items-center px-3 text-[10px] font-semibold uppercase tracking-wide",
    onHardRestart && "border-r border-overlay/70",
    statusLabel.textClass
  );

  return (
    <div className="flex flex-col border-t border-overlay bg-[var(--color-surface)]">
      <div className="flex items-stretch bg-black/20">
        <button
          type="button"
          onClick={toggleDrawer}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-2 border-r border-overlay/70 px-3 py-1.5 text-xs font-semibold text-canopy-text/80 transition-colors hover:bg-black/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400"
          aria-expanded={isOpen}
          aria-controls={`console-drawer-${terminalId}`}
          aria-label={toggleLabel}
        >
          <ChevronUp
            className={cn("h-4 w-4 shrink-0 transition-transform", isOpen && "rotate-180")}
            aria-hidden="true"
          />
          <span className="truncate">{toggleLabel}</span>
        </button>

        <div className={statusClass} role="status" aria-live="polite">
          <span className={cn("mr-2 h-1.5 w-1.5 shrink-0 rounded-full", statusLabel.dotClass)} />
          {statusLabel.label}
        </div>

        {onHardRestart && (
          <button
            type="button"
            onClick={onHardRestart}
            disabled={hardRestartDisabled}
            className={cn(
              "flex min-h-8 shrink-0 items-center gap-2 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-canopy-text/80 transition-colors",
              "hover:bg-black/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-40",
              isRestarting && "text-blue-400"
            )}
            title="Hard restart dev preview"
            aria-label="Hard restart dev preview"
            aria-busy={isRestarting}
          >
            <RotateCw className={cn("h-3.5 w-3.5", isRestarting && "animate-spin")} />
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
            className="!rounded-none !px-0 !pt-0 !pb-0"
          />
        </div>
      </div>
    </div>
  );
}
