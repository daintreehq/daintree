import { useState } from "react";
import { XCircle, LayoutGrid, PanelBottom } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useFailedTerminals } from "@/hooks/useTerminalSelectors";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { TerminalLocation } from "@shared/types";

function getLocationIcon(location: TerminalLocation | undefined) {
  if (location === "dock") return <PanelBottom className="w-3 h-3" />;
  return <LayoutGrid className="w-3 h-3" />;
}

export function FailedContainer() {
  const [isOpen, setIsOpen] = useState(false);
  const failedTerminals = useFailedTerminals();
  const { activateTerminal, pingTerminal } = useTerminalStore(
    useShallow((state) => ({
      activateTerminal: state.activateTerminal,
      pingTerminal: state.pingTerminal,
    }))
  );
  const { activeWorktreeId, selectWorktree, trackTerminalFocus } = useWorktreeSelectionStore(
    useShallow((state) => ({
      activeWorktreeId: state.activeWorktreeId,
      selectWorktree: state.selectWorktree,
      trackTerminalFocus: state.trackTerminalFocus,
    }))
  );
  const shortcut = useKeybindingDisplay("agent.focusNextFailed");

  if (failedTerminals.length === 0) return null;

  const count = failedTerminals.length;
  const contentId = "failed-container-popover";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="pill"
          size="sm"
          className={cn(
            "px-3",
            isOpen && "bg-canopy-border border-canopy-accent/40 ring-1 ring-canopy-accent/30"
          )}
          title={`View failed agent sessions${shortcut ? ` (${shortcut})` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-label={`Failed: ${count} agent${count === 1 ? "" : "s"}`}
        >
          <XCircle className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
          <span className="font-medium">Failed ({count})</span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id={contentId}
        role="dialog"
        aria-label="Failed terminals"
        className="w-80 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-canopy-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-canopy-text/70">Failed Sessions</span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            {failedTerminals.map((terminal) => (
              <button
                key={terminal.id}
                onClick={() => {
                  if (terminal.worktreeId && terminal.worktreeId !== activeWorktreeId) {
                    trackTerminalFocus(terminal.worktreeId, terminal.id);
                    selectWorktree(terminal.worktreeId);
                  }
                  activateTerminal(terminal.id);
                  pingTerminal(terminal.id);
                  setIsOpen(false);
                }}
                className="flex items-center justify-between gap-2.5 w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors group text-left outline-none hover:bg-white/5 focus:bg-white/5"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                    <TerminalIcon
                      type={terminal.type}
                      kind={terminal.kind}
                      agentId={terminal.agentId}
                      className="h-3 w-3"
                    />
                  </div>
                  <span className="text-xs truncate font-medium text-canopy-text/70 group-hover:text-canopy-text transition-colors">
                    {terminal.title}
                  </span>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <XCircle className="w-3 h-3 text-red-400" aria-label="Failed" />

                  <div
                    className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors"
                    title={terminal.location === "dock" ? "Docked" : "On Grid"}
                  >
                    {getLocationIcon(terminal.location)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
