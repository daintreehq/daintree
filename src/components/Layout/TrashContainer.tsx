import { useState, useMemo } from "react";
import { Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal, TrashedTerminalGroupMetadata } from "@/store/slices";
import { TrashBinItem } from "./TrashBinItem";
import { TrashGroupItem } from "./TrashGroupItem";

interface TrashContainerProps {
  trashedTerminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
  compact?: boolean;
}

interface GroupedTrashItem {
  type: "single";
  terminal: TerminalInstance;
  trashedInfo: TrashedTerminal;
  sortKey: number;
}

interface GroupedTrashGroup {
  type: "group";
  groupRestoreId: string;
  groupMetadata: TrashedTerminalGroupMetadata;
  terminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
  earliestExpiry: number;
  sortKey: number;
}

type TrashDisplayItem = GroupedTrashItem | GroupedTrashGroup;

export function TrashContainer({ trashedTerminals, compact = false }: TrashContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { worktreeMap } = useWorktrees();

  // Group trash items by groupRestoreId
  const displayItems = useMemo((): TrashDisplayItem[] => {
    const groups = new Map<
      string,
      {
        metadata: TrashedTerminalGroupMetadata | undefined;
        terminals: Array<{ terminal: TerminalInstance; trashedInfo: TrashedTerminal }>;
        earliestExpiry: number;
      }
    >();
    const singles: Array<{ terminal: TerminalInstance; trashedInfo: TrashedTerminal }> = [];

    for (const item of trashedTerminals) {
      const { trashedInfo } = item;
      if (trashedInfo.groupRestoreId) {
        const existing = groups.get(trashedInfo.groupRestoreId);
        if (existing) {
          existing.terminals.push(item);
          existing.earliestExpiry = Math.min(existing.earliestExpiry, trashedInfo.expiresAt);
          if (trashedInfo.groupMetadata) {
            existing.metadata = trashedInfo.groupMetadata;
          }
        } else {
          groups.set(trashedInfo.groupRestoreId, {
            metadata: trashedInfo.groupMetadata,
            terminals: [item],
            earliestExpiry: trashedInfo.expiresAt,
          });
        }
      } else {
        singles.push(item);
      }
    }

    const items: TrashDisplayItem[] = [];

    // Add grouped items
    for (const [groupRestoreId, group] of groups) {
      // Only show as group if we have metadata and multiple panels
      if (group.metadata && group.terminals.length > 1) {
        items.push({
          type: "group",
          groupRestoreId,
          groupMetadata: group.metadata,
          terminals: group.terminals,
          earliestExpiry: group.earliestExpiry,
          sortKey: group.earliestExpiry,
        });
      } else {
        // Show as individual items if no metadata or single panel
        for (const item of group.terminals) {
          items.push({
            type: "single",
            terminal: item.terminal,
            trashedInfo: item.trashedInfo,
            sortKey: item.trashedInfo.expiresAt,
          });
        }
      }
    }

    // Add single items
    for (const item of singles) {
      items.push({
        type: "single",
        terminal: item.terminal,
        trashedInfo: item.trashedInfo,
        sortKey: item.trashedInfo.expiresAt,
      });
    }

    // Sort by earliest expiry
    return items.sort((a, b) => a.sortKey - b.sortKey);
  }, [trashedTerminals]);

  if (trashedTerminals.length === 0) return null;

  const count = trashedTerminals.length;
  const contentId = "trash-container-popover";

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="pill"
          size="sm"
          className={cn(
            compact ? "px-1.5 min-w-0" : "px-3",
            isOpen && "bg-canopy-border border-canopy-accent/40 ring-1 ring-canopy-accent/30"
          )}
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-label={`Trash: ${count} terminal${count === 1 ? "" : "s"}`}
        >
          <span className="relative">
            <Trash2 className="w-3.5 h-3.5 text-canopy-text/60" aria-hidden="true" />
            {compact && count > 0 && (
              <span className="absolute -top-1.5 -right-1.5 z-10 flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-canopy-text/40 text-[10px] font-bold text-white">
                {count > 9 ? "9+" : count}
              </span>
            )}
          </span>
          {!compact && <span className="font-medium">Trash ({count})</span>}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        id={contentId}
        role="dialog"
        aria-label="Recently closed terminals"
        className="w-80 p-0"
        side="top"
        align="end"
        sideOffset={8}
      >
        <div className="flex flex-col">
          <div className="px-3 py-2 border-b border-divider bg-canopy-bg/50 flex justify-between items-center">
            <span className="text-xs font-medium text-canopy-text/70">Recently Closed</span>
            <span className="text-[11px] text-canopy-text/40">Auto-clears</span>
          </div>

          <div className="p-1 flex flex-col gap-1 max-h-[300px] overflow-y-auto">
            {displayItems.map((item) => {
              if (item.type === "group") {
                const worktreeName = item.groupMetadata.worktreeId
                  ? worktreeMap.get(item.groupMetadata.worktreeId)?.name
                  : undefined;
                return (
                  <TrashGroupItem
                    key={item.groupRestoreId}
                    groupRestoreId={item.groupRestoreId}
                    groupMetadata={item.groupMetadata}
                    terminals={item.terminals}
                    worktreeName={worktreeName}
                    earliestExpiry={item.earliestExpiry}
                  />
                );
              } else {
                const worktreeName = item.terminal.worktreeId
                  ? worktreeMap.get(item.terminal.worktreeId)?.name
                  : undefined;
                return (
                  <TrashBinItem
                    key={item.terminal.id}
                    terminal={item.terminal}
                    trashedInfo={item.trashedInfo}
                    worktreeName={worktreeName}
                  />
                );
              }
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
