import { useEffect, useState } from "react";
import { PanelBottom, PanelTopClose } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
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
import { useWorktrees } from "@/hooks/useWorktrees";
import {
  DOCK_STATUS_PILL_CLASS,
  DOCK_STATUS_PILL_OPEN_CLASS,
  DockStatusPillLabel,
  dockStatusScopeDescription,
  useDockPopoverFocusHandoff,
} from "./dockStatusPill";

function getLocationIcon(location: PanelLocation | undefined) {
  if (location === "dock") return <PanelBottom className="w-3 h-3" />;
  return <PanelTopClose className="w-3 h-3" />;
}

export interface StatusContainerConfig {
  icon: ComponentType<{ className?: string }>;
  iconColor: string;
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
  const { worktreeMap } = useWorktrees();
  const focusHandoff = useDockPopoverFocusHandoff();
  const count = terminals.length;
  const hereCount = terminals.filter(
    (t) => (t.worktreeId ?? null) === (activeWorktreeId ?? null)
  ).length;
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
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="pill"
                size="sm"
                className={cn(
                  DOCK_STATUS_PILL_CLASS,
                  compact ? "px-2 min-w-0" : "px-3",
                  isOpen && DOCK_STATUS_PILL_OPEN_CLASS
                )}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
                aria-controls={config.contentId}
                aria-label={`${config.buttonLabel}: ${displayCount} agent${displayCount === 1 ? "" : "s"} ${dockStatusScopeDescription(displayCount, hereCount)}`}
              >
                <DockStatusPillLabel
                  icon={<Icon className={config.iconColor} aria-hidden="true" />}
                  label={config.buttonLabel}
                  count={displayCount}
                  detail={hereCount > 0 ? `${hereCount} here` : "none here"}
                  compact={compact}
                />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {`${config.headerLabel} ${dockStatusScopeDescription(displayCount, hereCount)}`}
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          id={config.contentId}
          role="dialog"
          aria-label={config.contentAriaLabel}
          className="w-96 p-0"
          side="top"
          align="end"
          sideOffset={8}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={focusHandoff.onCloseAutoFocus}
        >
          <div className="flex flex-col">
            <div className="px-3 py-2 border-b border-divider bg-surface-canvas/50 flex justify-between items-center">
              <span className="text-xs font-medium text-text-secondary">{config.headerLabel}</span>
            </div>

            <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
              {terminals.map((terminal) => {
                const worktreeName =
                  terminal.worktreeId && terminal.worktreeId !== activeWorktreeId
                    ? worktreeMap.get(terminal.worktreeId)?.name
                    : undefined;
                return (
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
                      focusHandoff.markHandoff();
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
                      <span className="text-xs truncate font-medium text-text-secondary group-hover:text-text-primary transition-colors">
                        {terminal.title}
                      </span>
                      {worktreeName && (
                        <span className="truncate text-3xs text-text-secondary">
                          {worktreeName}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0">
                      <Icon
                        className={cn("w-3 h-3", config.iconColor)}
                        aria-label={config.statusAriaLabel}
                      />

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="text-text-secondary">
                            {getLocationIcon(terminal.location)}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom">
                          {terminal.location === "dock" ? "Docked" : "On Grid"}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
