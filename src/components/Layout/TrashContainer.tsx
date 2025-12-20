import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorktrees } from "@/hooks/useWorktrees";
import type { TerminalInstance } from "@/store";
import type { TrashedTerminal } from "@/store/slices";
import { TrashBinItem } from "./TrashBinItem";

interface TrashContainerProps {
  trashedTerminals: Array<{
    terminal: TerminalInstance;
    trashedInfo: TrashedTerminal;
  }>;
}

export function TrashContainer({ trashedTerminals }: TrashContainerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { worktreeMap } = useWorktrees();

  if (trashedTerminals.length === 0) return null;

  const sortedItems = [...trashedTerminals].sort(
    (a, b) => a.trashedInfo.expiresAt - b.trashedInfo.expiresAt
  );

  const count = trashedTerminals.length;
  const contentId = "trash-container-popover";

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
          title="View recently closed terminals"
          aria-haspopup="dialog"
          aria-expanded={isOpen}
          aria-controls={contentId}
          aria-label={`Trash: ${count} terminal${count === 1 ? "" : "s"}`}
        >
          <Trash2 className="w-3.5 h-3.5 text-canopy-text/60" aria-hidden="true" />
          <span className="font-medium">Trash ({count})</span>
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
            {sortedItems.map(({ terminal, trashedInfo }) => {
              const worktreeName = terminal.worktreeId
                ? worktreeMap.get(terminal.worktreeId)?.name
                : undefined;
              return (
                <TrashBinItem
                  key={terminal.id}
                  terminal={terminal}
                  trashedInfo={trashedInfo}
                  worktreeName={worktreeName}
                />
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
