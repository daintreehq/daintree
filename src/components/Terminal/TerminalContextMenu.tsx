import { useCallback, useMemo, useState } from "react";
import type React from "react";
import { type MenuItemOption, type TerminalLocation, type TerminalType } from "@/types";
import { useTerminalStore } from "@/store";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { terminalClient } from "@/clients";
import { TerminalInfoDialog } from "./TerminalInfoDialog";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu } from "@/hooks";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";

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
  const { showMenu } = useNativeContextMenu();
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
  const setFocused = useTerminalStore((s) => s.setFocused);
  const toggleInputLocked = useTerminalStore((s) => s.toggleInputLocked);
  const convertTerminalType = useTerminalStore((s) => s.convertTerminalType);
  const isMaximized = useTerminalStore((s) => s.maximizedId === terminalId);
  const { worktrees } = useWorktrees();

  const handleDuplicate = useCallback(async () => {
    if (!terminal) return;
    try {
      await addTerminal({
        type: terminal.type,
        cwd: terminal.cwd,
        location: terminal.location === "trash" ? "grid" : terminal.location,
        title: `${terminal.title} (copy)`,
        worktreeId: terminal.worktreeId,
        command: terminal.command,
        isInputLocked: terminal.isInputLocked,
      });
    } catch (error) {
      console.error("Failed to duplicate terminal:", error);
    }
  }, [addTerminal, terminal]);

  const handleClearBuffer = useCallback(() => {
    const managed = terminalInstanceService.get(terminalId);
    if (managed?.terminal) {
      // VS Code-style clear: clear the frontend buffer only and let the
      // shell decide how to handle `clear`/`reset` commands.
      managed.terminal.clear();
    }
  }, [terminalId]);

  const handleForceResume = useCallback(() => {
    terminalClient.forceResume(terminalId).catch((error) => {
      console.error("Failed to force resume terminal:", error);
    });
  }, [terminalId]);

  const isPaused = terminal?.flowStatus === "paused-backpressure";

  const currentLocation: TerminalLocation = forceLocation ?? terminal?.location ?? "grid";

  const worktreeSubmenu = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];
    return worktrees.map((wt) => {
      const isCurrent = wt.id === terminal.worktreeId;
      const label = (wt.branch || wt.name).trim();
      return {
        id: `move-to-worktree:${wt.id}`,
        label,
        enabled: !isCurrent,
      };
    });
  }, [terminal, worktrees]);

  const convertToSubmenu = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];
    const currentAgentId =
      terminal.agentId ?? (terminal.type !== "terminal" ? terminal.type : null);
    const isPlainTerminal = terminal.type === "terminal" || terminal.kind === "terminal";

    const items: MenuItemOption[] = [];

    if (!isPlainTerminal || currentAgentId) {
      items.push({
        id: "convert-to:terminal",
        label: "Terminal",
        enabled: !isPlainTerminal || !!currentAgentId,
      });
    }

    for (const agentId of AGENT_IDS) {
      const config = getAgentConfig(agentId);
      if (!config) continue;
      const isCurrent = currentAgentId === agentId;
      items.push({
        id: `convert-to:${agentId}`,
        label: config.name,
        enabled: !isCurrent,
      });
    }

    return items;
  }, [terminal]);

  const template = useMemo((): MenuItemOption[] => {
    if (!terminal) return [];
    const layoutItems: MenuItemOption[] = [
      currentLocation === "grid"
        ? { id: "move-to-dock", label: "Move to Dock" }
        : { id: "move-to-grid", label: "Move to Grid" },
    ];

    if (currentLocation === "grid") {
      layoutItems.push({
        id: "toggle-maximize",
        label: isMaximized ? "Restore Size" : "Maximize",
        sublabel: "^⇧F",
      });
    }

    if (worktrees.length > 1 && worktreeSubmenu.length > 0) {
      layoutItems.push({
        id: "move-to-worktree",
        label: "Move to Worktree",
        submenu: worktreeSubmenu,
      });
    }

    const actions: MenuItemOption[] = [
      ...layoutItems,
      { type: "separator" },
      { id: "restart", label: "Restart Terminal" },
      ...(isPaused ? [{ id: "force-resume", label: "Force Resume (Paused)" }] : []),
      {
        id: "toggle-input-lock",
        label: terminal.isInputLocked ? "Unlock Input" : "Lock Input",
      },
      {
        id: "convert-to",
        label: "Convert to",
        submenu: convertToSubmenu,
      },
      { id: "duplicate", label: "Duplicate Terminal" },
      { id: "rename", label: "Rename Terminal" },
      { id: "clear-scrollback", label: "Clear Scrollback" },
      { id: "view-info", label: "View Terminal Info" },
      { type: "separator" },
      { id: "trash", label: "Trash Terminal" },
      { id: "kill", label: "Kill Terminal" },
    ];

    return actions;
  }, [
    currentLocation,
    isMaximized,
    isPaused,
    terminal,
    worktrees.length,
    worktreeSubmenu,
    convertToSubmenu,
  ]);

  const handleContextMenu = useCallback(
    async (event: React.MouseEvent) => {
      if (!terminal) return;
      const actionId = await showMenu(event, template);
      if (!actionId) return;

      if (actionId.startsWith("move-to-worktree:")) {
        const worktreeId = actionId.slice("move-to-worktree:".length);
        setFocused(null);
        moveTerminalToWorktree(terminalId, worktreeId);
        return;
      }

      if (actionId.startsWith("convert-to:")) {
        const targetType = actionId.slice("convert-to:".length);
        void convertTerminalType(terminalId, targetType as TerminalType);
        return;
      }

      switch (actionId) {
        case "move-to-dock":
          moveTerminalToDock(terminalId);
          break;
        case "move-to-grid":
          moveTerminalToGrid(terminalId);
          break;
        case "toggle-maximize":
          toggleMaximize(terminalId);
          break;
        case "restart":
          restartTerminal(terminalId);
          break;
        case "force-resume":
          handleForceResume();
          break;
        case "toggle-input-lock":
          toggleInputLocked(terminalId);
          break;
        case "duplicate":
          void handleDuplicate();
          break;
        case "rename":
          window.dispatchEvent(
            new CustomEvent("canopy:rename-terminal", { detail: { id: terminalId } })
          );
          break;
        case "clear-scrollback":
          handleClearBuffer();
          break;
        case "view-info":
          setIsInfoDialogOpen(true);
          break;
        case "trash":
          trashTerminal(terminalId);
          break;
        case "kill":
          removeTerminal(terminalId);
          break;
      }
    },
    [
      convertTerminalType,
      handleClearBuffer,
      handleDuplicate,
      handleForceResume,
      moveTerminalToDock,
      moveTerminalToGrid,
      moveTerminalToWorktree,
      removeTerminal,
      restartTerminal,
      setFocused,
      showMenu,
      terminal,
      template,
      terminalId,
      toggleInputLocked,
      toggleMaximize,
      trashTerminal,
    ]
  );

  return (
    <div onContextMenu={handleContextMenu} className="contents">
      {children}
      <TerminalInfoDialog
        isOpen={isInfoDialogOpen}
        onClose={() => setIsInfoDialogOpen(false)}
        terminalId={terminalId}
      />
    </div>
  );
}
