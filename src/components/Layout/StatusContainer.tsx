import { useEffect, useState } from "react";
import { PanelBottom, PanelTopClose } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { AnimatedLabel } from "@/components/ui/AnimatedLabel";
import { cn } from "@/lib/utils";
import { useExitLaggedCount } from "@/hooks/useExitLaggedCount";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";
import type { PtyPanelData } from "@shared/types/panel";
import type { PanelLocation } from "@shared/types";
import type { ComponentType } from "react";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

function getLocationIcon(location: PanelLocation | undefined) {
  if (location === "dock") return <PanelBottom className="w-3 h-3" />;
  return <PanelTopClose className="w-3 h-3" />;
}

export interface StatusContainerConfig {
  icon: ComponentType<{ className?: string }>;
  iconColor: string;
  badgeColor: string;
  badgeTextColor: string;
  headerLabel: string;
  buttonLabel: string;
  statusAriaLabel: string;
  contentAriaLabel: string;
  contentId: string;
}

interface StatusContainerProps {
  config: StatusContainerConfig;
  terminals: PtyPanelData[];
  compact?: boolean;
}

export function StatusContainer({ config, terminals, compact = false }: StatusContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { activateTerminal, pingTerminal } = usePanelStore(
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
  const count = terminals.length;
  // Lagged count keeps the label stable while the pill fades out via the
  // .dock-status-pill exit transition instead of flashing "(0)".
  const displayCount = useExitLaggedCount(count);
  const Icon = config.icon;

  useEffect(() => {
    if (count === 0) setIsOpen(false);
  }, [count]);

  return (
    <span className="dock-status-pill" data-visible={count > 0 ? "true" : "false"}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="pill"
            size="sm"
            className={cn(
              compact ? "px-1.5 min-w-0" : "px-3",
              isOpen && "bg-overlay-emphasis border-border-default"
            )}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={config.contentId}
            aria-label={`${config.buttonLabel}: ${displayCount} agent${displayCount === 1 ? "" : "s"}`}
          >
            <span className="relative">
              <Icon className={cn("w-3.5 h-3.5", config.iconColor)} aria-hidden="true" />
              {compact && displayCount > 0 && (
                <span
                  className={cn(
                    "absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full text-3xs font-bold tabular-nums shadow-sm",
                    config.badgeColor,
                    config.badgeTextColor
                  )}
                >
                  <AnimatedLabel label={displayCount > 9 ? "9+" : String(displayCount)} />
                </span>
              )}
            </span>
            {!compact && (
              <span className="font-medium tabular-nums">
                {config.buttonLabel} (<AnimatedLabel label={String(displayCount)} />)
              </span>
            )}
          </Button>
        </PopoverTrigger>

        <PopoverContent
          id={config.contentId}
          role="dialog"
          aria-label={config.contentAriaLabel}
          className="w-96 p-0"
          side="top"
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <div className="flex flex-col">
            <div className="px-3 py-2 border-b border-divider bg-daintree-bg/50 flex justify-between items-center">
              <span className="text-xs font-medium text-daintree-text/70">
                {config.headerLabel}
              </span>
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
                  className="flex items-center justify-between gap-2.5 w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors group text-left outline-hidden hover:bg-tint/5 focus:bg-tint/5"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                      <TerminalIcon
                        kind={terminal.kind}
                        chrome={deriveTerminalChrome(terminal)}
                        className="h-3 w-3"
                      />
                    </div>
                    <span className="text-xs truncate font-medium text-daintree-text/70 group-hover:text-text-primary transition-colors">
                      {terminal.title}
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <Icon
                      className={cn("w-3 h-3", config.iconColor)}
                      aria-label={config.statusAriaLabel}
                    />

                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors">
                          {getLocationIcon(terminal.location)}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        {terminal.location === "dock" ? "Docked" : "On Grid"}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
