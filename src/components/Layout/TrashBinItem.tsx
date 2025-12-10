import { useState, useEffect, useCallback } from "react";
import { RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTerminalStore, type TerminalInstance } from "@/store";
import type { TrashedTerminal } from "@/store/slices";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";

interface TrashBinItemProps {
  terminal: TerminalInstance;
  trashedInfo: TrashedTerminal;
  worktreeName?: string;
}

export function TrashBinItem({ terminal, trashedInfo, worktreeName }: TrashBinItemProps) {
  const restoreTerminal = useTerminalStore((s) => s.restoreTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);

  const [timeRemaining, setTimeRemaining] = useState(() => {
    return Math.max(0, trashedInfo.expiresAt - Date.now());
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, trashedInfo.expiresAt - Date.now());
      setTimeRemaining(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [trashedInfo.expiresAt]);

  const seconds = Math.ceil(timeRemaining / 1000);

  const handleRestore = useCallback(() => {
    restoreTerminal(terminal.id);
  }, [restoreTerminal, terminal.id]);

  const handleKill = useCallback(() => {
    removeTerminal(terminal.id);
  }, [removeTerminal, terminal.id]);

  const terminalName = terminal.title || terminal.type || "Terminal";

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-sm bg-transparent hover:bg-white/5 transition-colors group">
      <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
        <TerminalIcon type={terminal.type} agentId={terminal.agentId} className="w-3 h-3" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-canopy-text/70 group-hover:text-canopy-text truncate transition-colors">
          {terminalName}
          {worktreeName && (
            <span className="text-canopy-text/50 ml-1 font-normal">({worktreeName})</span>
          )}
        </div>
        <div className="text-[10px] text-canopy-text/40" aria-live="polite">
          {seconds}s remaining
        </div>
      </div>

      <div className="flex gap-1">
        <Button
          variant="ghost-success"
          size="icon-sm"
          onClick={handleRestore}
          aria-label={`Restore ${terminalName}`}
          title={`Restore ${terminalName}`}
        >
          <RotateCcw aria-hidden="true" />
        </Button>
        <Button
          variant="ghost-danger"
          size="icon-sm"
          onClick={handleKill}
          aria-label={`Remove ${terminalName} permanently`}
          title={`Remove ${terminalName} permanently`}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
