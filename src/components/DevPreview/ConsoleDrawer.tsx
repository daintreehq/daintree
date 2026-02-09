import { useState, useCallback, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { XtermAdapter } from "../Terminal/XtermAdapter";
import { terminalInstanceService } from "../../services/TerminalInstanceService";
import { TerminalRefreshTier } from "@/types";

interface ConsoleDrawerProps {
  terminalId: string;
  defaultOpen?: boolean;
}

export function ConsoleDrawer({ terminalId, defaultOpen = false }: ConsoleDrawerProps) {
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

  return (
    <div className="flex flex-col border-t border-overlay">
      <button
        type="button"
        onClick={toggleDrawer}
        className="flex items-center justify-between px-3 py-1.5 text-xs font-medium text-canopy-text/70 hover:bg-white/10 transition-colors"
        aria-expanded={isOpen}
        aria-controls={`console-drawer-${terminalId}`}
      >
        <span>{isOpen ? "Hide Logs" : "Show Logs"}</span>
        <ChevronDown className={cn("w-3.5 h-3.5 transition-transform", isOpen && "rotate-180")} />
      </button>

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
