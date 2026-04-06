import { useState, useMemo } from "react";
import { Eclipse, Layers, ChevronDown, ChevronRight } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePanelStore, type TerminalInstance } from "@/store";
import type { TrashedTerminalGroupMetadata } from "@/store/slices";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useBackgroundedTerminals } from "@/hooks/useTerminalSelectors";
import { TerminalIcon } from "@/components/Terminal/TerminalIcon";

interface BackgroundContainerProps {
  compact?: boolean;
}

interface BackgroundDisplaySingle {
  type: "single";
  terminal: TerminalInstance;
}

interface BackgroundDisplayGroup {
  type: "group";
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: TerminalInstance[];
}

type BackgroundDisplayItem = BackgroundDisplaySingle | BackgroundDisplayGroup;

export function BackgroundContainer({ compact = false }: BackgroundContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const terminals = useBackgroundedTerminals();
  const backgroundedTerminals = usePanelStore((state) => state.backgroundedTerminals);
  const { restoreBackgroundTerminal, restoreBackgroundGroup, activateTerminal, pingTerminal } =
    usePanelStore(
      useShallow((state) => ({
        restoreBackgroundTerminal: state.restoreBackgroundTerminal,
        restoreBackgroundGroup: state.restoreBackgroundGroup,
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

  const displayItems = useMemo((): BackgroundDisplayItem[] => {
    const groups = new Map<
      string,
      {
        metadata: TrashedTerminalGroupMetadata | undefined;
        terminals: TerminalInstance[];
      }
    >();
    const singles: TerminalInstance[] = [];

    for (const terminal of terminals) {
      const bgInfo = backgroundedTerminals.get(terminal.id);
      if (bgInfo?.groupRestoreId) {
        const existing = groups.get(bgInfo.groupRestoreId);
        if (existing) {
          existing.terminals.push(terminal);
          if (bgInfo.groupMetadata) {
            existing.metadata = bgInfo.groupMetadata;
          }
        } else {
          groups.set(bgInfo.groupRestoreId, {
            metadata: bgInfo.groupMetadata,
            terminals: [terminal],
          });
        }
      } else {
        singles.push(terminal);
      }
    }

    const items: BackgroundDisplayItem[] = [];

    for (const [groupRestoreId, group] of groups) {
      if (group.metadata && group.terminals.length > 1) {
        items.push({
          type: "group",
          groupRestoreId,
          groupMetadata: group.metadata,
          terminals: group.terminals,
        });
      } else {
        for (const terminal of group.terminals) {
          items.push({ type: "single", terminal });
        }
      }
    }

    for (const terminal of singles) {
      items.push({ type: "single", terminal });
    }

    return items;
  }, [terminals, backgroundedTerminals]);

  if (terminals.length === 0) return null;

  const count = terminals.length;

  const handleRestoreSingle = (terminal: TerminalInstance) => {
    const worktreeId = terminal.worktreeId?.trim();
    if (worktreeId && worktreeId !== activeWorktreeId) {
      trackTerminalFocus(worktreeId, terminal.id);
      selectWorktree(worktreeId);
    }
    restoreBackgroundTerminal(terminal.id);
    activateTerminal(terminal.id);
    pingTerminal(terminal.id);
    setIsOpen(false);
  };

  const handleRestoreGroup = (
    groupRestoreId: string,
    groupMetadata: TrashedTerminalGroupMetadata
  ) => {
    const worktreeId = groupMetadata.worktreeId?.trim();
    if (worktreeId && worktreeId !== activeWorktreeId) {
      selectWorktree(worktreeId);
    }
    restoreBackgroundGroup(groupRestoreId);
    const activeId = groupMetadata.activeTabId;
    if (activeId) {
      if (worktreeId) {
        trackTerminalFocus(worktreeId, activeId);
      }
      activateTerminal(activeId);
      pingTerminal(activeId);
    }
    setIsOpen(false);
  };

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
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls="background-container-popover"
          aria-label={`Background: ${count} panel${count === 1 ? "" : "s"}`}
        >
          <span className="relative">
            <Eclipse className="w-3.5 h-3.5 text-canopy-text/50" aria-hidden="true" />
            {compact && count > 0 && (
              <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full text-[10px] font-bold tabular-nums shadow-sm bg-canopy-text/20 text-canopy-text">
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
          {!compact && <span className="font-medium tabular-nums">Background ({count})</span>}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id="background-container-popover"
        role="dialog"
        aria-label="Backgrounded panels"
        className="w-80 p-0"
        side="top"
        align="end"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-canopy-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-canopy-text/70">Background Panels</span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            {displayItems.map((item) => {
              if (item.type === "group") {
                return (
                  <BackgroundGroupItem
                    key={item.groupRestoreId}
                    groupRestoreId={item.groupRestoreId}
                    groupMetadata={item.groupMetadata}
                    terminals={item.terminals}
                    onRestoreGroup={handleRestoreGroup}
                    onRestoreSingle={handleRestoreSingle}
                  />
                );
              }
              return (
                <button
                  key={item.terminal.id}
                  type="button"
                  onClick={() => handleRestoreSingle(item.terminal)}
                  className="flex items-center justify-between gap-2.5 w-full px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors group text-left outline-none hover:bg-tint/5 focus:bg-tint/5"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                      <TerminalIcon
                        type={item.terminal.type}
                        kind={item.terminal.kind}
                        agentId={item.terminal.agentId}
                        detectedProcessId={item.terminal.detectedProcessId}
                        className="h-3 w-3"
                      />
                    </div>
                    <span className="text-xs truncate font-medium text-canopy-text/70 group-hover:text-canopy-text transition-colors">
                      {item.terminal.title}
                    </span>
                  </div>
                  <span className="text-[10px] text-canopy-text/40 shrink-0">Restore</span>
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BackgroundGroupItem({
  groupRestoreId,
  groupMetadata,
  terminals,
  onRestoreGroup,
  onRestoreSingle,
}: {
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: TerminalInstance[];
  onRestoreGroup: (groupRestoreId: string, metadata: TrashedTerminalGroupMetadata) => void;
  onRestoreSingle: (terminal: TerminalInstance) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const tabCount = terminals.length;
  const groupName = `Tab Group (${tabCount} ${tabCount === 1 ? "tab" : "tabs"})`;

  return (
    <div className="rounded-[var(--radius-sm)] bg-transparent hover:bg-tint/5 transition-colors">
      <div className="flex items-center gap-2 px-2.5 py-1.5 group">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 h-4 w-4 p-0 hover:bg-transparent"
          onClick={() => setIsExpanded(!isExpanded)}
          aria-label={isExpanded ? "Collapse group" : "Expand group"}
          aria-expanded={isExpanded}
          aria-controls={`bg-group-${groupRestoreId}`}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-canopy-text/60" />
          ) : (
            <ChevronRight className="w-3 h-3 text-canopy-text/60" />
          )}
        </Button>

        <div className="shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
          <Layers className="w-3 h-3 text-canopy-text/70" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-canopy-text/70 group-hover:text-canopy-text truncate transition-colors">
            {groupName}
          </div>
        </div>

        <button
          type="button"
          className="text-[10px] text-canopy-text/40 shrink-0 hover:text-canopy-text transition-colors"
          onClick={() => onRestoreGroup(groupRestoreId, groupMetadata)}
        >
          Restore All
        </button>
      </div>

      {isExpanded && (
        <div
          id={`bg-group-${groupRestoreId}`}
          role="region"
          aria-label="Group panels"
          className="pl-6 pr-2 pb-1.5 space-y-0.5"
        >
          {[...terminals]
            .sort((a, b) => {
              const aIndex = groupMetadata.panelIds.indexOf(a.id);
              const bIndex = groupMetadata.panelIds.indexOf(b.id);
              if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
              return 0;
            })
            .map((terminal) => {
              const isActiveTab = groupMetadata.activeTabId === terminal.id;
              return (
                <button
                  key={terminal.id}
                  type="button"
                  onClick={() => onRestoreSingle(terminal)}
                  className="flex items-center gap-2 w-full px-2 py-1 text-[11px] rounded hover:bg-tint/5 text-left"
                >
                  <TerminalIcon
                    type={terminal.type}
                    kind={terminal.kind}
                    agentId={terminal.agentId}
                    detectedProcessId={terminal.detectedProcessId}
                    className="w-2.5 h-2.5 opacity-60"
                  />
                  <span
                    className={`truncate flex-1 ${isActiveTab ? "text-canopy-text/70 font-medium" : "text-canopy-text/50"}`}
                  >
                    {terminal.title}
                    {isActiveTab && <span className="ml-1 text-canopy-text/40">(active)</span>}
                  </span>
                  <span className="text-[10px] text-canopy-text/30 shrink-0">Restore</span>
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
