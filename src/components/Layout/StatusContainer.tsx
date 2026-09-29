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
import { useWorktreeNames } from "@/hooks/useWorktrees";
import {
  DOCK_STATUS_PILL_CLASS,
  DOCK_STATUS_PILL_OPEN_CLASS,
  DOCK_POPOVER_HEADER_CLASS,
  DOCK_POPOVER_ROW_HOVER_CLASS,
  DOCK_POPOVER_SECTIONS,
  DockPopoverList,
  DockPopoverSection,
  DockStatusPillLabel,
  dockStatusScopeDescription,
  useDockPopoverFocusHandoff,
} from "./dockStatusPill";
import { pluralize } from "@/lib/pluralize";

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
  const worktreeNames = useWorktreeNames();
  const focusHandoff = useDockPopoverFocusHandoff();
  const count = terminals.length;
  const isHere = (t: PtyPanelData) => (t.worktreeId ?? null) === (activeWorktreeId ?? null);
  const hereTerminals = terminals.filter(isHere);
  const elsewhereTerminals = terminals.filter((t) => !isHere(t));
  const hereCount = hereTerminals.length;
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
                onClick={focusHandoff.onTriggerClick}
                aria-label={`${config.buttonLabel}: ${pluralize(displayCount, "agent")} ${dockStatusScopeDescription(displayCount, hereCount)}`}
              >
                <DockStatusPillLabel
                  icon={<Icon className={config.iconColor} aria-hidden="true" />}
                  label={config.buttonLabel}
                  count={displayCount}
                  hasLocal={hereCount > 0}
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
          onOpenAutoFocus={focusHandoff.onOpenAutoFocus}
          onCloseAutoFocus={focusHandoff.onCloseAutoFocus}
          onKeyDown={focusHandoff.onContentKeyDown}
        >
          <div className="flex flex-col">
            <div className={DOCK_POPOVER_HEADER_CLASS}>
              <span className="text-xs font-medium text-text-secondary">{config.headerLabel}</span>
            </div>

            <DockPopoverList>
              {DOCK_POPOVER_SECTIONS.map((section) => {
                const items = section.key === "here" ? hereTerminals : elsewhereTerminals;
                if (items.length === 0) return null;
                return (
                  <DockPopoverSection key={section.key} label={section.label}>
                    {items.map((terminal) => {
                      const worktreeName =
                        section.key === "elsewhere" && terminal.worktreeId
                          ? worktreeNames.get(terminal.worktreeId)
                          : undefined;
                      return (
                        <button
                          key={terminal.id}
                          type="button"
                          data-dock-row=""
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
                          className={cn(
                            "flex items-center justify-between gap-2.5 w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] group text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
                            DOCK_POPOVER_ROW_HOVER_CLASS
                          )}
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
                  </DockPopoverSection>
                );
              })}
            </DockPopoverList>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}
