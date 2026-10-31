import { useEffect, useState } from "react";
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
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import { LiveTimeAgo } from "@/components/Worktree/LiveTimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { isBuiltInAgentId } from "@shared/config/agentIds";

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
  const worktreeCount = new Set(terminals.map((t) => t.worktreeId ?? null)).size;
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
              <span className="text-3xs font-medium text-text-secondary tabular-nums">
                {pluralize(terminals.length, "agent")}
                {worktreeCount > 1 && ` across ${worktreeCount} worktrees`}
              </span>
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
                        <ErroredAgentRow
                          key={terminal.id}
                          terminal={terminal}
                          worktreeName={worktreeName}
                          fallbackLabel={config.statusAriaLabel}
                          onActivate={() => {
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
                        />
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

interface ErroredAgentRowProps {
  terminal: PtyPanelData;
  worktreeName: string | undefined;
  fallbackLabel: string;
  onActivate: () => void;
}

/**
 * One errored agent, in the Waiting and Unread rows' anatomy: name, then where
 * and what, then the exit and its age. A clipped context shows whole while the
 * row is hovered or holds keyboard focus, as theirs does.
 */
function ErroredAgentRow({
  terminal,
  worktreeName,
  fallbackLabel,
  onActivate,
}: ErroredAgentRowProps) {
  const [revealClipped, setRevealClipped] = useState(false);
  const title = terminal.title || "Terminal";
  // The task it was on when it exited: the shared rules drop an exited agent's
  // task as no longer current, but here "Exit 1" already says it is history.
  const task = getTerminalTaskTitle({
    ...terminal,
    agentState: undefined,
    detectedAgentId:
      terminal.detectedAgentId ??
      (isBuiltInAgentId(terminal.launchAgentId) ? terminal.launchAgentId : undefined),
  });
  const context = [worktreeName, task].filter(Boolean).join(" · ");
  const exitText =
    typeof terminal.exitCode === "number" ? `Exit ${terminal.exitCode}` : fallbackLabel;

  return (
    <button
      type="button"
      data-dock-row=""
      onClick={onActivate}
      onFocus={(e) => setRevealClipped(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setRevealClipped(false)}
      aria-label={`Focus ${title}${task ? `: ${task}` : ""}${worktreeName ? ` in ${worktreeName}` : ""} — ${exitText.toLowerCase()}`}
      className={cn(
        "flex items-center gap-2 w-full h-7 px-2 rounded-[var(--radius-sm)] text-left outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2",
        DOCK_POPOVER_ROW_HOVER_CLASS
      )}
    >
      <TerminalIcon
        kind={terminal.kind}
        chrome={deriveTerminalChrome(terminal)}
        className="h-3 w-3 shrink-0"
      />
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-xs font-medium text-text-primary">{title}</span>
        {context && (
          <TruncatedTooltip
            content={context}
            focusable={false}
            open={revealClipped || undefined}
            onOpenChange={(open) => !open && setRevealClipped(false)}
            side="bottom"
            align="start"
          >
            <span className="min-w-16 flex-1 basis-0 truncate text-xs text-text-secondary">
              {context}
            </span>
          </TruncatedTooltip>
        )}
      </span>
      <span className="shrink-0 text-3xs text-text-secondary tabular-nums">{exitText}</span>
      {terminal.lastStateChange != null && (
        <LiveTimeAgo
          timestamp={terminal.lastStateChange}
          noTooltip
          className="min-w-6 shrink-0 text-right text-3xs text-text-secondary tabular-nums"
        />
      )}
    </button>
  );
}
