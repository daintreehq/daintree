import { useCallback, useMemo, useState } from "react";
import type React from "react";
import { type MenuItemOption, type TerminalLocation, type TerminalType } from "@/types";
import { useTerminalStore } from "@/store";
import { terminalClient } from "@/clients";
import { TerminalInfoDialog } from "./TerminalInfoDialog";
import { useWorktrees } from "@/hooks/useWorktrees";
import { useNativeContextMenu } from "@/hooks";
import { AGENT_IDS, getAgentConfig } from "@/config/agents";
import { isValidBrowserUrl } from "@/components/Browser/browserUtils";

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
      // Handle browser pane duplication specially
      if (terminal.kind === "browser") {
        await addTerminal({
          kind: "browser",
          cwd: terminal.cwd,
          location: terminal.location === "trash" ? "grid" : terminal.location,
          title: `${terminal.title} (copy)`,
          worktreeId: terminal.worktreeId,
          browserUrl: terminal.browserUrl,
        });
        return;
      }

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
      const label = (wt.branch || wt.name).trim() || "Untitled worktree";
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

    const isBrowser = terminal.kind === "browser";

    // Layout section: worktree navigation first (most common workflow), then positioning
    const layoutItems: MenuItemOption[] = [];

    // Move to Worktree as top-level submenu (when multiple worktrees exist)
    if (worktrees.length > 1 && worktreeSubmenu.length > 0) {
      layoutItems.push({
        id: "move-to-worktree",
        label: "Move to Worktree",
        submenu: worktreeSubmenu,
      });
    }

    layoutItems.push(
      currentLocation === "grid"
        ? { id: "move-to-dock", label: "Move to Dock" }
        : { id: "move-to-grid", label: "Move to Grid" }
    );

    if (currentLocation === "grid") {
      layoutItems.push({
        id: "toggle-maximize",
        label: isMaximized ? "Restore Size" : "Maximize",
        sublabel: "^⇧F",
      });
    }

    // Browser-specific actions
    if (isBrowser) {
      const browserActions: MenuItemOption[] = [
        { id: "reload-browser", label: "Reload Page" },
        { id: "open-external", label: "Open in Browser" },
        { id: "copy-url", label: "Copy URL" },
      ];

      const browserManagementItems: MenuItemOption[] = [
        { id: "duplicate", label: "Duplicate Browser" },
        { id: "rename", label: "Rename Browser" },
      ];

      const destructiveItems: MenuItemOption[] = [
        { id: "trash", label: "Close Browser" },
        { id: "kill", label: "Remove Browser" },
      ];

      return [
        ...layoutItems,
        { type: "separator" },
        ...browserActions,
        { type: "separator" },
        ...browserManagementItems,
        { type: "separator" },
        ...destructiveItems,
      ];
    }

    // Terminal actions section
    const terminalActions: MenuItemOption[] = [
      { id: "restart", label: "Restart Terminal" },
      ...(isPaused ? [{ id: "force-resume", label: "Force Resume (Paused)" }] : []),
      {
        id: "toggle-input-lock",
        label: terminal.isInputLocked ? "Unlock Input" : "Lock Input",
      },
      ...(convertToSubmenu.length > 0
        ? [
            {
              id: "convert-to",
              label: "Convert to",
              submenu: convertToSubmenu,
            },
          ]
        : []),
    ];

    // Management actions section
    const managementItems: MenuItemOption[] = [
      { id: "duplicate", label: "Duplicate Terminal" },
      { id: "rename", label: "Rename Terminal" },
      { id: "view-info", label: "View Terminal Info" },
    ];

    // Destructive actions section
    const destructiveItems: MenuItemOption[] = [
      { id: "trash", label: "Trash Terminal" },
      { id: "kill", label: "Kill Terminal" },
    ];

    return [
      ...layoutItems,
      { type: "separator" },
      ...terminalActions,
      { type: "separator" },
      ...managementItems,
      { type: "separator" },
      ...destructiveItems,
    ];
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
        if (targetType === "terminal" || AGENT_IDS.includes(targetType)) {
          void convertTerminalType(terminalId, targetType as TerminalType).catch((error) => {
            console.error("Failed to convert terminal type:", error);
          });
        }
        return;
      }

      if (actionId === "move-to-worktree" || actionId === "convert-to") {
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
          void restartTerminal(terminalId);
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
        case "view-info":
          setIsInfoDialogOpen(true);
          break;
        case "trash":
          trashTerminal(terminalId);
          break;
        case "kill":
          removeTerminal(terminalId);
          break;
        // Browser-specific actions
        case "reload-browser":
          window.dispatchEvent(
            new CustomEvent("canopy:reload-browser", { detail: { id: terminalId } })
          );
          break;
        case "open-external":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            window.electron.system.openExternal(terminal.browserUrl);
          }
          break;
        case "copy-url":
          if (terminal.browserUrl && isValidBrowserUrl(terminal.browserUrl)) {
            navigator.clipboard.writeText(terminal.browserUrl).catch((err) => {
              console.error("Failed to copy URL:", err);
            });
          }
          break;
      }
    },
    [
      convertTerminalType,
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
