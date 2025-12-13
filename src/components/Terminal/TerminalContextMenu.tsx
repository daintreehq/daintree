import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import {
  Maximize2,
  Minimize2,
  Trash2,
  ArrowUp,
  ArrowDownToLine,
  X,
  RotateCcw,
  Copy,
  Eraser,
  Info,
  GitBranch,
  Play,
  PenLine,
} from "lucide-react";
import { useTerminalStore } from "@/store";
import type { TerminalLocation } from "@/types";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { TerminalInfoDialog } from "./TerminalInfoDialog";
import { useWorktrees } from "@/hooks/useWorktrees";

interface TerminalContextMenuProps {
  terminalId: string;
  children: React.ReactNode;
  forceLocation?: TerminalLocation;
}

/**
 * Right-click context menu for terminal components.
 * Used by both DockedTerminalItem and TerminalHeader.
 */
export function TerminalContextMenu({
  terminalId,
  children,
  forceLocation,
}: TerminalContextMenuProps) {
  const [isInfoDialogOpen, setIsInfoDialogOpen] = useState(false);
  const terminal = useTerminalStore((state) => state.terminals.find((t) => t.id === terminalId));

  const moveTerminalToDock = useTerminalStore((s) => s.moveTerminalToDock);
  const moveTerminalToGrid = useTerminalStore((s) => s.moveTerminalToGrid);
  const trashTerminal = useTerminalStore((s) => s.trashTerminal);
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const toggleMaximize = useTerminalStore((s) => s.toggleMaximize);
  const restartTerminal = useTerminalStore((s) => s.restartTerminal);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const moveTerminalToWorktree = useTerminalStore((s) => s.moveTerminalToWorktree);
  const isMaximized = useTerminalStore((s) => s.maximizedId === terminalId);
  const { worktrees } = useWorktrees();

  const handleDuplicate = async () => {
    if (!terminal) return;
    try {
      await addTerminal({
        type: terminal.type,
        cwd: terminal.cwd,
        location: terminal.location === "trash" ? "grid" : terminal.location,
        title: `${terminal.title} (copy)`,
        worktreeId: terminal.worktreeId,
        command: terminal.command,
      });
    } catch (error) {
      console.error("Failed to duplicate terminal:", error);
    }
  };

  const handleClearBuffer = () => {
    const managed = terminalInstanceService.get(terminalId);
    if (managed?.terminal) {
      // VS Code-style clear: clear the frontend buffer only and let the
      // shell decide how to handle `clear`/`reset` commands.
      managed.terminal.clear();
      // Trigger tall canvas sync for frontend-only clear operations
      terminalInstanceService.requestTallCanvasSync(terminalId);
    }
  };

  const handleForceResume = () => {
    terminalClient.forceResume(terminalId).catch((error) => {
      console.error("Failed to force resume terminal:", error);
    });
  };

  if (!terminal) return <>{children}</>;

  const isPaused = terminal.flowStatus === "paused-backpressure";

  const currentLocation: TerminalLocation = forceLocation ?? terminal.location ?? "grid";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {/* Layout Actions */}
        {currentLocation === "grid" ? (
          <ContextMenuItem onClick={() => moveTerminalToDock(terminalId)}>
            <ArrowDownToLine className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Move to Dock
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => moveTerminalToGrid(terminalId)}>
            <ArrowUp className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Move to Grid
          </ContextMenuItem>
        )}

        {currentLocation === "grid" && (
          <ContextMenuItem onClick={() => toggleMaximize(terminalId)}>
            {isMaximized ? (
              <>
                <Minimize2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Restore Size
                <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Maximize
                <ContextMenuShortcut>^⇧F</ContextMenuShortcut>
              </>
            )}
          </ContextMenuItem>
        )}

        {worktrees.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <GitBranch className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Move to Worktree
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              {worktrees.map((wt) => {
                const isCurrent = wt.id === terminal?.worktreeId;
                const label = wt.branch || wt.name;
                return (
                  <ContextMenuItem
                    key={wt.id}
                    onClick={() => moveTerminalToWorktree(terminalId, wt.id)}
                    disabled={isCurrent}
                  >
                    <span className={wt.isMainWorktree ? "font-semibold" : ""}>{label}</span>
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => restartTerminal(terminalId)}>
          <RotateCcw className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Restart Terminal
        </ContextMenuItem>

        {isPaused && (
          <ContextMenuItem onClick={handleForceResume}>
            <Play className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Force Resume (Paused)
          </ContextMenuItem>
        )}

        <ContextMenuItem onClick={handleDuplicate}>
          <Copy className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Duplicate Terminal
        </ContextMenuItem>

        <ContextMenuItem
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("canopy:rename-terminal", { detail: { id: terminalId } })
            )
          }
        >
          <PenLine className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Rename Terminal
        </ContextMenuItem>

        <ContextMenuItem onClick={handleClearBuffer}>
          <Eraser className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Clear Scrollback
        </ContextMenuItem>

        <ContextMenuItem onClick={() => setIsInfoDialogOpen(true)}>
          <Info className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          View Terminal Info
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem
          onClick={() => trashTerminal(terminalId)}
          className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
        >
          <Trash2 className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Trash Terminal
        </ContextMenuItem>

        <ContextMenuItem
          onClick={() => removeTerminal(terminalId)}
          className="text-[var(--color-status-error)] focus:text-[var(--color-status-error)]"
        >
          <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
          Kill Terminal
        </ContextMenuItem>
      </ContextMenuContent>
      <TerminalInfoDialog
        isOpen={isInfoDialogOpen}
        onClose={() => setIsInfoDialogOpen(false)}
        terminalId={terminalId}
      />
    </ContextMenu>
  );
}
