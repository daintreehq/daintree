import { useState } from "react";
import { LayoutGrid, PanelBottom } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { TerminalInstance } from "@/store/terminalStore";
import type { TerminalLocation } from "@shared/types";
import type { KeyAction } from "@shared/types/keymap";
import type { LucideIcon } from "lucide-react";

function getLocationIcon(location: TerminalLocation | undefined) {
  if (location === "dock") return <PanelBottom className="w-3 h-3" />;
  return <LayoutGrid className="w-3 h-3" />;
}

export interface StatusContainerConfig {
  icon: LucideIcon;
  iconColor: string;
  badgeColor: string;
  badgeTextColor: string;
  headerLabel: string;
  buttonTitle: string;
  buttonLabel: string;
  statusAriaLabel: string;
  contentAriaLabel: string;
  keybindingAction: KeyAction;
  contentId: string;
  useTerminals: () => TerminalInstance[];
}

interface StatusContainerProps {
  config: StatusContainerConfig;
  compact?: boolean;
}

export function StatusContainer({ config, compact = false }: StatusContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const terminals = config.useTerminals();
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
  const shortcut = useKeybindingDisplay(config.keybindingAction);

  if (terminals.length === 0) return null;

  const count = terminals.length;
  const Icon = config.icon;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="pill"
          size="sm"
          className={cn(
            compact ? "px-1.5 min-w-0" : "px-3",
            isOpen && "bg-canopy-border border-canopy-accent/40 ring-1 ring-canopy-accent/30"
          )}
          title={`${config.buttonTitle}${shortcut ? ` (${shortcut})` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={config.contentId}
          aria-label={`${config.buttonLabel}: ${count} agent${count === 1 ? "" : "s"}`}
        >
          <span className="relative">
            <Icon className={cn("w-3.5 h-3.5", config.iconColor)} aria-hidden="true" />
            {compact && count > 0 && (
              <span
                className={cn(
                  "absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full text-[10px] font-bold shadow-sm",
                  config.badgeColor,
                  config.badgeTextColor
                )}
              >
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
          {!compact && (
            <span className="font-medium">
              {config.buttonLabel} ({count})
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id={config.contentId}
        role="dialog"
        aria-label={config.contentAriaLabel}
        className="w-80 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-canopy-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-canopy-text/70">{config.headerLabel}</span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            {terminals.map((terminal) => (
              <button
                key={terminal.id}
                type="button"
                onClick={() => {
                  const worktreeId = terminal.worktreeId?.trim();
                  if (worktreeId && worktreeId !== activeWorktreeId) {
                    trackTerminalFocus(worktreeId, terminal.id);
                    selectWorktree(worktreeId);
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
                      detectedProcessId={terminal.detectedProcessId}
                      className="h-3 w-3"
                    />
                  </div>
                  <span className="text-xs truncate font-medium text-canopy-text/70 group-hover:text-canopy-text transition-colors">
                    {terminal.title}
                  </span>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <Icon
                    className={cn("w-3 h-3", config.iconColor)}
                    aria-label={config.statusAriaLabel}
                  />

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
